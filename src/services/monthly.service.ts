import { formatMoney } from "@/lib/currency";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { cols } from "@/lib/collections";
import { audit } from "@/lib/audit";
import { AppError, badRequest, notFound } from "@/lib/errors";
import { parseDateOnly, todayIn, utcAddDays, utcAddMonths } from "@/lib/dates";
import type { OrgContext } from "@/lib/auth";
import type { HaptaSchemeDoc } from "@/types/models";
import { dateOnly, idempotencyKey, money, optText } from "@/validators/common";
import { createScheme, enrollMembers, reviseAmount } from "./scheme.service";
import { deriveStatus } from "./schedule";
import { recordPayment } from "./payment.service";

/**
 * The Mandal's monthly hapta: one primary monthly scheme per Mandal, driven by
 * settings.monthlyHapta. Everything else (installment generation, partial payments,
 * statuses, receipts) reuses the scheme/installment/payment engine.
 */

export const month = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM")
  .transform((m) => m);

export const firstOfMonth = (m: string) => parseDateOnly(`${m}-01`);
export const monthOf = (d: Date) => d.toISOString().slice(0, 7);
export const lastOfMonth = (m: string) => utcAddDays(utcAddMonths(firstOfMonth(m), 1), -1);

export const SetupSchema = z.object({
  amount: money(),
  startMonth: month,
  dueDay: z.number().int().min(1).max(28).default(10),
  enrollAllActive: z.boolean().default(true),
});

export const ChangeAmountSchema = z.object({
  amount: money(),
  /** First month the new amount applies to. Defaults to next month; past months are never changed. */
  effectiveMonth: month.optional(),
  reason: optText(300),
});

export async function primaryScheme(orgId: ObjectId): Promise<HaptaSchemeDoc | null> {
  const c = await cols();
  return c.haptaSchemes.findOne({ organizationId: orgId, isPrimary: true });
}

/** Create the Mandal's monthly hapta (once). */
export async function setupMonthlyHapta(ctx: OrgContext, input: z.infer<typeof SetupSchema>) {
  if (await primaryScheme(ctx.orgId)) throw new AppError("CONFLICT", "Monthly hapta is already set up. Change the amount instead.");
  const c = await cols();
  const startDate = firstOfMonth(input.startMonth);
  const scheme = await createScheme(ctx, {
    name: "Monthly hapta",
    description: `${formatMoney(input.amount, ctx.org.settings.currency)} per member every month`,
    startDate,
    endDate: null,
    frequency: "monthly",
    customInterval: null,
    dueDay: input.dueDay,
    amount: input.amount,
    amountMode: "fixed",
    numberOfInstallments: null,
    targetAmount: null,
    graceDays: 0,
    lateFee: { enabled: false, type: "fixed", value: 0, graceDays: 0 },
    status: "active",
    notes: undefined,
  });
  await c.haptaSchemes.updateOne({ _id: scheme._id }, { $set: { isPrimary: true } });
  const settings = { schemeId: scheme._id, amountPaise: input.amount, dueDay: input.dueDay, startDate };
  await c.organizations.updateOne({ _id: ctx.orgId }, { $set: { "settings.monthlyHapta": settings, updatedAt: new Date() } });
  ctx.org.settings.monthlyHapta = settings;
  let enrolled = 0;
  if (input.enrollAllActive) {
    const members = await c.members.find({ organizationId: ctx.orgId, status: "active" }, { projection: { _id: 1, joiningDate: 1 } }).toArray();
    if (members.length) {
      const r = await enrollMembers(ctx, scheme._id, {
        members: members.map((m) => ({ memberId: m._id.toHexString(), amount: null, startDate: m.joiningDate > startDate ? firstOfMonth(monthOf(m.joiningDate)) : startDate })),
      });
      enrolled = r.enrolled;
    }
  }
  await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "monthly_hapta.setup", entityType: "scheme", entityId: scheme._id, after: settings });
  return { schemeId: scheme._id, enrolled };
}

/** Change the monthly amount for future months. Paid / partly paid installments never change. */
export async function changeMonthlyHapta(ctx: OrgContext, input: z.infer<typeof ChangeAmountSchema>) {
  const s = await primaryScheme(ctx.orgId);
  if (!s) throw badRequest("Set up the monthly hapta first");
  const today = todayIn(ctx.org.settings.timezone);
  const current = monthOf(today);
  const effective = input.effectiveMonth ?? monthOf(utcAddMonths(firstOfMonth(current), 1));
  if (effective < current) throw badRequest("The new amount can only apply from the current month onwards");
  const r = await reviseAmount(ctx, s._id, { effectiveFrom: firstOfMonth(effective), amount: input.amount, reason: input.reason ?? `Monthly hapta changed to ${formatMoney(input.amount, ctx.org.settings.currency)}` });
  const c = await cols();
  await c.organizations.updateOne({ _id: ctx.orgId }, { $set: { "settings.monthlyHapta.amountPaise": input.amount, updatedAt: new Date() } });
  await c.haptaSchemes.updateOne({ _id: s._id }, { $set: { description: `${formatMoney(input.amount, ctx.org.settings.currency)} per member every month (from ${effective})` } });
  return { effectiveMonth: effective, installmentsUpdated: r.installmentsUpdated };
}

/** Enroll members in the monthly hapta from a month (default: current month). Idempotent. */
export async function enrollInMonthlyHapta(ctx: OrgContext, memberIds: ObjectId[], startMonth?: string) {
  const s = await primaryScheme(ctx.orgId);
  if (!s || s.status !== "active" || memberIds.length === 0) return { enrolled: 0, installmentsCreated: 0 };
  const today = todayIn(ctx.org.settings.timezone);
  let start = firstOfMonth(startMonth ?? monthOf(today));
  if (start < s.startDate) start = s.startDate;
  const c = await cols();
  const shares = await c.members.find({ _id: { $in: memberIds }, organizationId: ctx.orgId }, { projection: { haptaShares: 1 } }).toArray();
  const sharesOf = (id: ObjectId) => shares.find((m) => m._id.equals(id))?.haptaShares ?? 1;
  const r = await enrollMembers(ctx, s._id, { members: memberIds.map((id) => ({ memberId: id.toHexString(), amount: null, startDate: start, shares: sharesOf(id) })) });
  // hapta starting after the first month = joining partway through: they owe the price of their shares
  if (start > s.startDate) {
    const { markJoiningDue } = await import("./membership.service");
    await markJoiningDue(ctx.orgId, memberIds);
  }
  return r;
}

/**
 * Change how many haptas a member pays each month, from `fromMonth` (default: this month) onwards.
 * Months in that range are re-priced to hapta × shares even if they were already (part) paid — a
 * month paid at ₹500 becomes ₹1,500 with ₹1,000 still due. An amount never drops below what was
 * already paid. Earlier months are never changed.
 */
export async function setHaptaShares(ctx: OrgContext, memberId: ObjectId, shares: number, fromMonth?: string) {
  const c = await cols();
  const today = todayIn(ctx.org.settings.timezone);
  const current = monthOf(today);
  if (fromMonth && fromMonth < current) throw badRequest("Shares can only change from this month onwards — earlier months stay as they are");
  const from = firstOfMonth(fromMonth ?? current);
  const s = await primaryScheme(ctx.orgId);
  let updated = 0;
  if (s) {
    await c.memberSchemeEnrollments.updateOne({ organizationId: ctx.orgId, schemeId: s._id, memberId }, { $set: { shares, updatedAt: new Date() } });
    const now = new Date();
    const r = await c.installments.updateMany(
      { organizationId: ctx.orgId, schemeId: s._id, memberId, dueDate: { $gte: from }, state: "active", amountSource: { $in: ["scheme", "revision", "override"] }, shares: shares === 1 ? { $exists: true, $ne: 1 } : { $ne: shares } },
      [
        {
          $set: {
            // amountPaise already includes the old shares: back to one hapta, then × the new shares
            // (never below what has already been paid)
            amountPaise: { $max: [{ $multiply: [{ $round: [{ $divide: ["$amountPaise", { $ifNull: ["$shares", 1] }] }, 0] }, shares] }, "$paidPaise"] },
            history: { $concatArrays: ["$history", [{ at: now, by: ctx.user._id, action: "shares_changed", from: { $ifNull: ["$shares", 1] }, to: shares, reason: `Hapta shares set to ${shares}` }]] },
            shares,
            updatedAt: now,
          },
        },
      ],
    );
    updated = r.modifiedCount;
  }
  return { installmentsUpdated: updated };
}

/* ------------------------------------------------------------------ month view */

export const MonthQuery = z.object({ month: month.optional(), schemeId: z.string().optional() });

/**
 * One row per installment due in the month (default: the primary monthly scheme), with
 * expected, collected, outstanding, status, last payment date and who recorded it.
 */
export async function monthView(ctx: OrgContext, q: z.infer<typeof MonthQuery>) {
  const c = await cols();
  const today = todayIn(ctx.org.settings.timezone);
  const m = q.month ?? monthOf(today);
  const from = firstOfMonth(m);
  const to = lastOfMonth(m);
  // round 1: schemes (incl. the primary one) and the month's hapta cash, in parallel
  const [schemes, [cash]] = await Promise.all([
    c.haptaSchemes.find({ organizationId: ctx.orgId }, { projection: { name: 1, graceDays: 1, isPrimary: 1, status: 1 } }).toArray(),
    // Cash actually received during the month for hapta (by payment date, net of reversals).
    c.ledgerEntries
      .aggregate<{ v: number }>([
        { $match: { organizationId: ctx.orgId, date: { $gte: from, $lte: to }, accountKey: { $regex: "^fa:" } } },
        { $match: { $expr: { $eq: [{ $ifNull: ["$originalType", "$transactionType"] }, "hapta_collection"] } } },
        { $group: { _id: null, v: { $sum: { $subtract: ["$debitPaise", "$creditPaise"] } } } },
      ])
      .toArray(),
  ]);
  const primary = schemes.find((x) => x.isPrimary) ?? null;
  const schemeId = q.schemeId && ObjectId.isValid(q.schemeId) ? new ObjectId(q.schemeId) : primary?._id ?? null;
  const filter: Record<string, unknown> = { organizationId: ctx.orgId, dueDate: { $gte: from, $lte: to }, state: { $ne: "cancelled" } };
  if (schemeId) filter.schemeId = schemeId;
  // round 2: the month's installments
  const insts = await c.installments.find(filter, { projection: { history: 0 } }).toArray();
  const sm = new Map(schemes.map((s) => [s._id.toHexString(), s]));
  // round 3: members, payments and not-enrolled members, in parallel
  const [members, payments, notEnrolled] = await Promise.all([
    c.members.find({ organizationId: ctx.orgId, _id: { $in: insts.map((i) => i.memberId) } }, { projection: { name: 1, membershipNumber: 1, phone: 1 } }).toArray(),
    c.payments
      .find({ organizationId: ctx.orgId, status: "verified", "allocations.installmentId": { $in: insts.map((i) => i._id) } }, { projection: { date: 1, allocations: 1, recordedBy: 1, verifiedBy: 1, receiptId: 1, amountPaise: 1 } })
      .sort({ date: 1 })
      .toArray(),
    // Active members who have no installment this month (not enrolled / joined later).
    schemeId && primary && schemeId.equals(primary._id)
      ? c.members.find({ organizationId: ctx.orgId, status: "active", _id: { $nin: insts.map((i) => i.memberId) } }, { projection: { name: 1, membershipNumber: 1 } }).sort({ name: 1 }).toArray()
      : Promise.resolve([]),
  ]);
  const mm = new Map(members.map((x) => [x._id.toHexString(), x]));
  // round 4: names of who recorded the payments
  const users = await c.users.find({ _id: { $in: payments.flatMap((p) => [p.recordedBy, p.verifiedBy].filter(Boolean) as ObjectId[]) } }, { projection: { name: 1 } }).toArray();
  const um = new Map(users.map((u) => [u._id.toHexString(), u.name]));

  const rows = insts
    .map((i) => {
      const ps = payments.filter((p) => p.allocations.some((a) => a.installmentId.equals(i._id)));
      const last = ps[ps.length - 1];
      const scheme = sm.get(i.schemeId.toHexString());
      const expected = i.amountPaise + i.penaltyPaise;
      const collected = i.paidPaise + i.penaltyPaidPaise;
      return {
        installmentId: i._id,
        memberId: i.memberId,
        member: mm.get(i.memberId.toHexString()) ?? null,
        /** hapta shares (e.g. 3 = pays 3 × the monthly amount) */
        shares: i.shares ?? 1,
        schemeName: scheme?.name ?? "",
        periodLabel: i.periodLabel,
        dueDate: i.dueDate,
        expectedPaise: expected,
        collectedPaise: collected,
        outstandingPaise: i.state === "active" ? Math.max(0, expected - collected) : 0,
        status: deriveStatus(i, today, scheme?.graceDays ?? 0),
        state: i.state,
        lastPaymentDate: last?.date ?? null,
        recordedBy: [...new Set(ps.map((p) => um.get(p.recordedBy.toHexString())).filter(Boolean))],
        payments: ps.map((p) => ({ _id: p._id, date: p.date, receiptId: p.receiptId, amountPaise: p.allocations.filter((a) => a.installmentId.equals(i._id)).reduce((s, a) => s + a.amountPaise + a.penaltyPaise, 0) })),
      };
    })
    .sort((a, b) => (a.member?.name ?? "").localeCompare(b.member?.name ?? ""));


  const active = rows.filter((r) => r.state === "active");
  const count = (st: string) => rows.filter((r) => r.status === st).length;

  return {
    month: m,
    from,
    to,
    scheme: schemeId ? { _id: schemeId, name: sm.get(schemeId.toHexString())?.name ?? "", isPrimary: !!sm.get(schemeId.toHexString())?.isPrimary } : null,
    monthlyHapta: ctx.org.settings.monthlyHapta ?? null,
    rows,
    notEnrolled,
    summary: {
      members: rows.length,
      expectedPaise: active.reduce((s, r) => s + r.expectedPaise, 0),
      collectedPaise: active.reduce((s, r) => s + r.collectedPaise, 0),
      outstandingPaise: active.reduce((s, r) => s + r.outstandingPaise, 0),
      paid: count("paid"),
      partiallyPaid: count("partially_paid"),
      pending: count("pending") + count("upcoming"),
      overdue: count("overdue"),
      waived: count("waived"),
      cashReceivedInMonthPaise: cash?.v ?? 0,
    },
  };
}

/* ------------------------------------------------------------------ quick cash collection */

export const QuickCollectSchema = z.object({
  installmentId: z.string(),
  amount: money(),
  date: dateOnly,
  note: optText(300),
  accountId: z.string().optional(),
  idempotencyKey,
  /** Required when an identical payment (same installment, amount and date) already exists */
  confirmDuplicate: z.boolean().default(false),
});

/**
 * Record a cash payment against one member's installment for a month.
 * Late fee (if any) is paid first, then the installment amount; overpaying is refused.
 */
export async function quickCollect(ctx: OrgContext, input: z.infer<typeof QuickCollectSchema>) {
  const c = await cols();
  if (!ObjectId.isValid(input.installmentId)) throw notFound("Installment");
  const inst = await c.installments.findOne({ _id: new ObjectId(input.installmentId), organizationId: ctx.orgId });
  if (!inst) throw notFound("Installment");
  // A retried request (same idempotency key) returns the original payment instead of re-validating.
  const retry = await c.payments.findOne({ organizationId: ctx.orgId, idempotencyKey: input.idempotencyKey }, { projection: { _id: 1 } });
  if (inst.state !== "active" && !retry) throw badRequest(`This installment is ${inst.state}`);
  const outstanding = inst.amountPaise + inst.penaltyPaise - inst.paidPaise - inst.penaltyPaidPaise;
  if (!retry && outstanding <= 0) throw badRequest("This month is already fully paid");
  if (!retry && input.amount > outstanding) throw badRequest(`Amount is more than the outstanding ${formatMoney(outstanding, ctx.org.settings.currency)} for ${inst.periodLabel}`);

  if (!input.confirmDuplicate && !retry) {
    const same = await c.payments.findOne({
      organizationId: ctx.orgId,
      status: { $in: ["verified", "pending"] },
      date: input.date,
      amountPaise: input.amount,
      "allocations.installmentId": inst._id,
      idempotencyKey: { $ne: input.idempotencyKey },
    });
    if (same) throw new AppError("CONFLICT", `A payment of ${formatMoney(input.amount, ctx.org.settings.currency)} on this date is already recorded for this month. Confirm if this is a second payment.`, { code: "DUPLICATE_SUSPECTED" });
  }

  let accountId = input.accountId;
  if (!accountId) {
    const cash = await c.financialAccounts.findOne({ organizationId: ctx.orgId, type: "cash", isActive: true }, { sort: { createdAt: 1 } });
    if (!cash) throw badRequest("Create a cash account first");
    accountId = cash._id.toHexString();
  }
  const penalty = Math.min(input.amount, inst.penaltyPaise - inst.penaltyPaidPaise);
  return recordPayment(ctx, {
    kind: "hapta",
    memberId: inst.memberId.toHexString(),
    payerName: undefined,
    amount: input.amount,
    date: input.date,
    method: "cash",
    reference: undefined,
    accountId,
    schemeId: inst.schemeId.toHexString(),
    allocations: [{ installmentId: inst._id.toHexString(), amount: input.amount - penalty, penalty }],
    eventName: undefined,
    notes: input.note,
    idempotencyKey: input.idempotencyKey,
  });
}
