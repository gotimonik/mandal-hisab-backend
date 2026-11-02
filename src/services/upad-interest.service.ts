import { ObjectId, type ClientSession } from "mongodb";
import { z } from "zod";
import { formatMoney } from "@/lib/currency";
import { cols } from "@/lib/collections";
import { withTransaction } from "@/lib/db";
import { audit } from "@/lib/audit";
import { badRequest, conflict, isDuplicateKeyError, notFound } from "@/lib/errors";
import { todayIn } from "@/lib/dates";
import type { OrgContext } from "@/lib/auth";
import type { FinancialAccountDoc, FundLoanDoc, FundLoanPaymentDoc, OrganizationDoc, UpadInterestPaymentDoc } from "@/types/models";
import { ALLOWED_PAYMENT_METHODS, CASH_ONLY_MESSAGE } from "@/lib/org-defaults";
import { dateOnly, idempotencyKey, money, optText } from "@/validators/common";
import { INCOME_KEYS, MEMBER_FUNDS, UPAD_ADVANCE, faKey, postTransaction, reverseTransaction } from "./ledger.service";
import { requireAccount } from "./account.service";
import { postMemberEntry } from "./member-ledger.service";
import { rateInterest } from "./member-interest.service";
import { cancelReceiptFor, issueReceipt } from "./receipt.service";
import { closeIfSettled, interestShares, refreshDuesFor } from "./fund-loan.service";

/**
 * Upad interest for a member, across all their upads, and their upad ADVANCE.
 *
 *  - One payment can cover the interest of every upad the member has: it is applied to the
 *    oldest unpaid month first (then the older upad), one receipt lists each upad.
 *  - Paying more than is due (₹200 when ₹187.50 is due, to keep it round) keeps the extra as the
 *    member's advance. It is owed back to the member (liability:upad_advance) and is NOT shared
 *    among members yet.
 *  - When new interest falls due, the advance pays it first, automatically — so next month
 *    ₹187.50 − ₹12.50 = ₹175 is left to pay. Only then is that interest shared among members.
 *  - The advance can be returned in cash (and must be, or used up, before the Mandal closes).
 *  - Pay-ahead is capped at a year of interest, to catch typing mistakes (₹1900 for ₹190).
 */

/** The Mandal's books never let a member pay more than this much interest ahead. */
const MONTHS_AHEAD_LIMIT = 12;
/** Who "recorded" the automatic use of an advance. */
const SYSTEM_ACTOR = new ObjectId("000000000000000000000000");

const advanceOf = (m: { upadAdvancePaise?: number } | null | undefined) => m?.upadAdvancePaise ?? 0;

interface Plan {
  loan: FundLoanDoc;
  takePaise: number;
  allocations: FundLoanPaymentDoc["allocations"];
}

/** Interest still unpaid on these upads, oldest month first (older upad first in a month). */
async function unpaidDues(orgId: ObjectId, loans: FundLoanDoc[], session?: ClientSession) {
  const c = await cols();
  const dues = await c.fundLoanDues
    .find({ organizationId: orgId, loanId: { $in: loans.map((l) => l._id) }, $expr: { $lt: ["$paidPaise", "$interestPaise"] } }, { session })
    .toArray();
  const order = new Map(loans.map((l) => [l._id.toHexString(), l]));
  return dues.sort((a, b) => {
    if (a.period !== b.period) return a.period < b.period ? -1 : 1;
    const la = order.get(a.loanId.toHexString())!;
    const lb = order.get(b.loanId.toHexString())!;
    return la.date.getTime() - lb.date.getTime() || la.number.localeCompare(lb.number);
  });
}

/** Mark `amount` of interest paid on the dues (oldest first) and say how much went to each upad. */
async function allocate(orgId: ObjectId, loans: FundLoanDoc[], amount: number, session: ClientSession): Promise<Plan[]> {
  const c = await cols();
  const plans = new Map<string, Plan>();
  let left = amount;
  for (const d of await unpaidDues(orgId, loans, session)) {
    if (left <= 0) break;
    const take = Math.min(left, d.interestPaise - d.paidPaise);
    if (take <= 0) continue;
    const r = await c.fundLoanDues.updateOne(
      { _id: d._id, $expr: { $lte: [{ $add: ["$paidPaise", take] }, "$interestPaise"] } },
      { $inc: { paidPaise: take }, $set: { updatedAt: new Date() } },
      { session },
    );
    if (r.modifiedCount !== 1) throw conflict("The interest due changed — please try again");
    const key = d.loanId.toHexString();
    const plan = plans.get(key) ?? { loan: loans.find((l) => l._id.equals(d.loanId))!, takePaise: 0, allocations: [] };
    plan.takePaise += take;
    plan.allocations.push({ dueId: d._id, period: d.period, amountPaise: take });
    plans.set(key, plan);
    left -= take;
  }
  if (left > 0) throw conflict("The interest due changed — please try again");
  return [...plans.values()];
}

/** How much a member may pay ahead: a year of their upads' monthly interest. */
export function aheadLimit(loans: Pick<FundLoanDoc, "outstandingPaise" | "monthlyRate">[]) {
  return MONTHS_AHEAD_LIMIT * loans.reduce((s, l) => s + rateInterest(l.outstandingPaise, l.monthlyRate), 0);
}

/** Add to / take from the member's advance, never below zero. */
export async function changeAdvance(orgId: ObjectId, memberId: ObjectId, delta: number, session: ClientSession) {
  if (delta === 0) return;
  const c = await cols();
  const r = await c.members.updateOne(
    { _id: memberId, organizationId: orgId, $expr: { $gte: [{ $add: [{ $ifNull: ["$upadAdvancePaise", 0] }, delta] }, 0] } },
    { $inc: { upadAdvancePaise: delta }, $set: { updatedAt: new Date() } },
    { session },
  );
  if (r.modifiedCount !== 1) throw conflict("The member's upad advance changed — please try again");
}

const periodsText = (allocs: { period: string }[]) => {
  const ps = [...new Set(allocs.map((a) => a.period))];
  return ps.length === 0 ? "" : ps.length === 1 ? ps[0] : `${ps[0]} to ${ps[ps.length - 1]}`;
};

interface SettleInput {
  org: OrganizationDoc;
  actorId: ObjectId;
  member: { _id: ObjectId; name: string };
  kind: UpadInterestPaymentDoc["kind"];
  date: Date;
  amountPaise: number;
  advanceUsedPaise: number;
  advanceAddedPaise: number;
  plans: Plan[];
  account: FinancialAccountDoc | null;
  method?: string;
  reference?: string;
  note?: string;
  idempotencyKey: string;
}

/** Books, shares, receipt and records for one interest payment (inside the caller's transaction). */
async function settle(input: SettleInput, session: ClientSession): Promise<UpadInterestPaymentDoc> {
  const c = await cols();
  const { org, member } = input;
  const cur = org.settings.currency;
  const groupId = new ObjectId();
  const savings = org.settings.haptaTreatment === "member_savings";
  const interest = input.plans.reduce((s, p) => s + p.takePaise, 0);
  const withIds = await Promise.all(
    input.plans.map(async (p) => ({ ...p, paymentId: new ObjectId(), shareMap: savings && p.takePaise > 0 ? await interestShares(org._id, p.takePaise, member._id, session) : new Map<string, number>() })),
  );

  const lines = [
    ...(input.amountPaise > 0 && input.account ? [{ accountKey: faKey(input.account._id), debitPaise: input.amountPaise }] : []),
    ...(input.advanceUsedPaise > 0 ? [{ accountKey: UPAD_ADVANCE, debitPaise: input.advanceUsedPaise, memberId: member._id }] : []),
    ...(savings
      ? withIds.flatMap((p) => [...p.shareMap.entries()].map(([mid, amt]) => ({ accountKey: MEMBER_FUNDS, creditPaise: amt, memberId: new ObjectId(mid) })))
      : interest > 0
        ? [{ accountKey: INCOME_KEYS.interest, creditPaise: interest }]
        : []),
    ...(input.advanceAddedPaise > 0 ? [{ accountKey: UPAD_ADVANCE, creditPaise: input.advanceAddedPaise, memberId: member._id }] : []),
  ];
  const what = [
    interest > 0 ? `interest ${formatMoney(interest, cur)} on ${withIds.map((p) => `${p.loan.number} (${periodsText(p.allocations)})`).join(", ")}` : "",
    input.advanceUsedPaise > 0 ? `${formatMoney(input.advanceUsedPaise, cur)} from advance` : "",
    input.advanceAddedPaise > 0 ? `${formatMoney(input.advanceAddedPaise, cur)} kept as advance` : "",
  ].filter(Boolean);
  const txn = await postTransaction(
    {
      org,
      type: "fund_loan_payment",
      date: input.date,
      description: `${member.name} — upad ${input.kind === "advance" ? "interest paid from advance" : "interest"}: ${what.join("; ")}`,
      lines,
      createdBy: input.actorId,
      memberId: member._id,
      sourceType: "fundLoanPayment",
      sourceId: groupId,
      reason: input.note,
    },
    session,
  );

  const receipt =
    input.amountPaise > 0
      ? await issueReceipt(
          org,
          {
            sourceType: "fundLoanPayment",
            sourceId: groupId,
            memberId: member._id,
            payerName: member.name,
            amountPaise: input.amountPaise,
            date: input.date,
            method: input.method ?? "cash",
            reference: input.reference,
            lines: [
              ...withIds.map((p) => ({ description: `Upad ${p.loan.number} interest — ${periodsText(p.allocations)}`, amountPaise: p.takePaise })),
              ...(input.advanceUsedPaise > 0 ? [{ description: "Less: upad advance paid earlier", amountPaise: -input.advanceUsedPaise }] : []),
              ...(input.advanceAddedPaise > 0 ? [{ description: "Advance for the next upad interest", amountPaise: input.advanceAddedPaise }] : []),
            ],
            issuedBy: input.actorId,
          },
          session,
        )
      : null;

  const now = new Date();
  const docs: FundLoanPaymentDoc[] = [];
  for (const p of withIds) {
    const shares: FundLoanPaymentDoc["shares"] = [];
    for (const [mid, amt] of p.shareMap) {
      const { entry } = await postMemberEntry(
        {
          org,
          memberId: new ObjectId(mid),
          date: input.date,
          kind: "interest",
          creditPaise: amt,
          description: `Share of upad interest — ${p.loan.number} (${member.name}), ${periodsText(p.allocations)}`,
          sourceType: "fundLoanPayment",
          sourceId: p.paymentId,
          transactionId: txn._id,
          dedupeKey: `flp:${p.paymentId.toHexString()}:${mid}`,
          createdBy: input.actorId,
        },
        session,
      );
      shares.push({ memberId: new ObjectId(mid), amountPaise: amt, ledgerEntryId: entry._id });
    }
    docs.push({
      _id: p.paymentId,
      organizationId: org._id,
      loanId: p.loan._id,
      memberId: member._id,
      date: input.date,
      interestPaise: p.takePaise,
      principalPaise: 0,
      allocations: p.allocations,
      shares,
      accountId: input.account?._id ?? p.loan.accountId,
      note: input.kind === "advance" ? "Paid from the member's upad advance" : input.note,
      status: "valid",
      receiptId: receipt?._id ?? null,
      transactionId: txn._id,
      idempotencyKey: `${input.idempotencyKey}:${p.loan._id.toHexString()}`,
      recordedBy: input.actorId,
      createdAt: now,
      groupId,
    });
  }
  if (docs.length) await c.fundLoanPayments.insertMany(docs, { session });
  const group: UpadInterestPaymentDoc = {
    _id: groupId,
    organizationId: org._id,
    memberId: member._id,
    kind: input.kind,
    date: input.date,
    amountPaise: input.amountPaise,
    interestPaise: interest,
    advanceUsedPaise: input.advanceUsedPaise,
    advanceAddedPaise: input.advanceAddedPaise,
    loanPaymentIds: docs.map((d) => d._id),
    accountId: input.account?._id ?? null,
    method: input.method,
    reference: input.reference,
    note: input.note,
    status: "valid",
    receiptId: receipt?._id ?? null,
    transactionId: txn._id,
    idempotencyKey: input.idempotencyKey,
    recordedBy: input.actorId,
    createdAt: now,
  };
  await c.upadInterestPayments.insertOne(group, { session });
  return group;
}

async function closeSettledLoans(orgId: ObjectId, loanIds: ObjectId[]) {
  const c = await cols();
  for (const l of await c.fundLoans.find({ _id: { $in: loanIds } }).toArray()) await closeIfSettled(orgId, l);
}

/* ------------------------------------------------------------------ what a member owes */

/** A member's upads, interest due, advance and what's left to pay — for "Receive interest". */
export async function memberUpadInterest(ctx: OrgContext, memberId: ObjectId) {
  const c = await cols();
  const member = await c.members.findOne({ _id: memberId, organizationId: ctx.orgId }, { projection: { name: 1, membershipNumber: 1, upadAdvancePaise: 1 } });
  if (!member) throw notFound("Member");
  const loans = await c.fundLoans.find({ organizationId: ctx.orgId, memberId, status: "active" }).sort({ date: 1 }).toArray();
  await refreshDuesFor(ctx.org, loans);
  const dues = await unpaidDues(ctx.orgId, loans);
  const items = loans.map((l) => {
    const ld = dues.filter((d) => d.loanId.equals(l._id));
    return {
      _id: l._id,
      number: l.number,
      outstandingPaise: l.outstandingPaise,
      monthlyRate: l.monthlyRate,
      interestDuePaise: ld.reduce((s, d) => s + d.interestPaise - d.paidPaise, 0),
      unpaidMonths: [...new Set(ld.map((d) => d.period))],
      monthlyInterestPaise: rateInterest(l.outstandingPaise, l.monthlyRate),
    };
  });
  const interestDuePaise = items.reduce((s, x) => s + x.interestDuePaise, 0);
  const advancePaise = advanceOf(member);
  const toPayPaise = Math.max(0, interestDuePaise - advancePaise);
  return {
    member: { _id: member._id, name: member.name, membershipNumber: member.membershipNumber },
    loans: items,
    interestDuePaise,
    advancePaise,
    toPayPaise,
    monthlyInterestPaise: items.reduce((s, x) => s + x.monthlyInterestPaise, 0),
    /** the most that can be received now (due + a year ahead) */
    maxPaise: toPayPaise + aheadLimit(loans),
  };
}

/* ------------------------------------------------------------------ receive interest for all upads */

export const MemberInterestPaymentSchema = z.object({
  amount: money(),
  date: dateOnly,
  method: z.string().refine((m) => (ALLOWED_PAYMENT_METHODS as readonly string[]).includes(m), CASH_ONLY_MESSAGE).default("cash"),
  reference: optText(100),
  note: optText(300),
  accountId: z.string().optional(),
  idempotencyKey,
});

/** Money received for a member's upad interest: all upads, oldest month first; the extra is kept as advance. */
export async function receiveMemberInterest(ctx: OrgContext, memberId: ObjectId, input: z.infer<typeof MemberInterestPaymentSchema>, actorId: ObjectId = ctx.user._id) {
  const c = await cols();
  const prior = await c.upadInterestPayments.findOne({ organizationId: ctx.orgId, idempotencyKey: input.idempotencyKey });
  if (prior) return { payment: prior, duplicate: true };
  const member = await c.members.findOne({ _id: memberId, organizationId: ctx.orgId }, { projection: { name: 1 } });
  if (!member) throw notFound("Member");
  const today = todayIn(ctx.org.settings.timezone);
  if (input.date > today) throw badRequest("A payment can't be dated in the future");
  const loans = await c.fundLoans.find({ organizationId: ctx.orgId, memberId, status: "active" }).toArray();
  if (loans.length === 0) throw badRequest(`${member.name} has no upad to pay interest on`);
  if (loans.every((l) => input.date < l.date)) throw badRequest("A payment can't be dated before the upad was given");
  await refreshDuesFor(ctx.org, loans);

  let accountId = input.accountId;
  if (!accountId) {
    const cash = await c.financialAccounts.findOne({ organizationId: ctx.orgId, type: "cash", isActive: true }, { sort: { createdAt: 1 } });
    if (!cash) throw badRequest("Create a cash account first");
    accountId = cash._id.toHexString();
  }
  const cur = ctx.org.settings.currency;
  try {
    const payment = await withTransaction(async (session) => {
      const account = await requireAccount(ctx.orgId, accountId!, session);
      const fresh = await c.members.findOne({ _id: memberId }, { session, projection: { upadAdvancePaise: 1 } });
      const advance = advanceOf(fresh);
      const unpaid = (await unpaidDues(ctx.orgId, loans, session)).reduce((s, d) => s + d.interestPaise - d.paidPaise, 0);
      const max = Math.max(0, unpaid - advance) + aheadLimit(loans);
      if (max === 0) throw badRequest("No interest is due, and these upads don't charge interest");
      if (input.amount > max) throw badRequest(`That's more than the interest due plus a year ahead (${formatMoney(max, cur)}). Check the amount.`);
      const apply = Math.min(input.amount + advance, unpaid);
      const used = Math.min(advance, apply);
      const fromCash = apply - used;
      const added = input.amount - fromCash;
      const plans = await allocate(ctx.orgId, loans, apply, session);
      await changeAdvance(ctx.orgId, memberId, added - used, session);
      const group = await settle(
        { org: ctx.org, actorId, member: { _id: memberId, name: member.name }, kind: "payment", date: input.date, amountPaise: input.amount, advanceUsedPaise: used, advanceAddedPaise: added, plans, account, method: input.method, reference: input.reference, note: input.note, idempotencyKey: input.idempotencyKey },
        session,
      );
      await audit({ organizationId: ctx.orgId, actorId, action: "upadInterest.payment", entityType: "member", entityId: memberId, after: { paymentId: group._id, amountPaise: input.amount, interestPaise: apply, advanceUsedPaise: used, advanceAddedPaise: added } }, session);
      return group;
    });
    await closeSettledLoans(ctx.orgId, loans.map((l) => l._id));
    return { payment, duplicate: false };
  } catch (e) {
    if (isDuplicateKeyError(e)) {
      const again = await c.upadInterestPayments.findOne({ organizationId: ctx.orgId, idempotencyKey: input.idempotencyKey });
      if (again) return { payment: again, duplicate: true };
    }
    throw e;
  }
}

/* ------------------------------------------------------------------ the advance pays new interest */

/**
 * Use a member's advance for the interest now due on their upads (oldest first). Called when new
 * interest falls due, after a payment that left an advance, and by the daily job. Safe to call
 * any time: does nothing without both an advance and interest due; concurrent calls can't double-use.
 */
export async function applyUpadAdvance(org: OrganizationDoc, memberId: ObjectId): Promise<UpadInterestPaymentDoc | null> {
  const c = await cols();
  const member = await c.members.findOne({ _id: memberId, organizationId: org._id }, { projection: { name: 1, upadAdvancePaise: 1 } });
  if (!member || advanceOf(member) <= 0) return null;
  const loans = await c.fundLoans.find({ organizationId: org._id, memberId, status: "active" }).toArray();
  if (loans.length === 0) return null;
  try {
    const group = await withTransaction(async (session) => {
      const fresh = await c.members.findOne({ _id: memberId }, { session, projection: { upadAdvancePaise: 1 } });
      const unpaid = (await unpaidDues(org._id, loans, session)).reduce((s, d) => s + d.interestPaise - d.paidPaise, 0);
      const use = Math.min(advanceOf(fresh), unpaid);
      if (use <= 0) return null;
      const plans = await allocate(org._id, loans, use, session);
      await changeAdvance(org._id, memberId, -use, session);
      const g = await settle(
        { org, actorId: SYSTEM_ACTOR, member: { _id: memberId, name: member.name }, kind: "advance", date: todayIn(org.settings.timezone), amountPaise: 0, advanceUsedPaise: use, advanceAddedPaise: 0, plans, account: null, idempotencyKey: `advance:${new ObjectId().toHexString()}` },
        session,
      );
      await audit({ organizationId: org._id, actorId: null, action: "upadInterest.advanceUsed", entityType: "member", entityId: memberId, after: { paymentId: g._id, amountPaise: use } }, session);
      return g;
    });
    if (group) await closeSettledLoans(org._id, loans.map((l) => l._id));
    return group;
  } catch (e) {
    // someone else used it at the same moment: nothing left to do
    if ((e as { status?: number; code?: string })?.code === "CONFLICT") return null;
    throw e;
  }
}

/** Use the advances of these members (after new interest dues were created). */
export async function applyAdvancesFor(org: Pick<OrganizationDoc, "_id" | "settings">, memberIds: ObjectId[]) {
  const c = await cols();
  const withAdvance = await c.members.find({ _id: { $in: memberIds }, organizationId: org._id, upadAdvancePaise: { $gt: 0 } }, { projection: { _id: 1 } }).toArray();
  if (withAdvance.length === 0) return;
  const full = await c.organizations.findOne({ _id: org._id });
  if (!full) return;
  for (const m of withAdvance) await applyUpadAdvance(full, m._id);
}

/* ------------------------------------------------------------------ corrections */

/** Undo a whole interest payment (all upads it covered, its advance, shares and receipt). */
export async function reverseInterestPayment(ctx: OrgContext, groupId: ObjectId, reasonText: string) {
  const c = await cols();
  const g = await c.upadInterestPayments.findOne({ _id: groupId, organizationId: ctx.orgId });
  if (!g) throw notFound("Payment");
  if (g.status !== "valid") throw conflict("This payment is already reversed");
  const docs = await c.fundLoanPayments.find({ organizationId: ctx.orgId, groupId }).toArray();
  for (const d of docs) {
    const latest = await c.fundLoanPayments.findOne({ organizationId: ctx.orgId, loanId: d.loanId, status: "valid" }, { sort: { date: -1, createdAt: -1 } });
    if (latest && !latest._id.equals(d._id) && !latest.groupId?.equals(groupId)) {
      const loan = await c.fundLoans.findOne({ _id: d.loanId }, { projection: { number: 1 } });
      throw badRequest(`A later payment on upad ${loan?.number ?? ""} has to be reversed first.`);
    }
  }
  const net = g.advanceAddedPaise - g.advanceUsedPaise;
  const today = todayIn(ctx.org.settings.timezone);
  await withTransaction(async (session) => {
    const claimed = await c.upadInterestPayments.updateOne({ _id: groupId, status: "valid" }, { $set: { status: "reversed", reversalReason: reasonText } }, { session });
    if (claimed.modifiedCount !== 1) throw conflict("This payment is already reversed");
    try {
      await changeAdvance(ctx.orgId, g.memberId, -net, session);
    } catch {
      throw badRequest("The advance from this payment has already been used for later interest — reverse that first.");
    }
    const rev = await reverseTransaction(ctx.org, g.transactionId, reasonText, ctx.user._id, today, session);
    for (const d of docs) {
      await c.fundLoanPayments.updateOne({ _id: d._id }, { $set: { status: "reversed", reversalReason: reasonText, reversalTransactionId: rev._id } }, { session });
      for (const a of d.allocations) await c.fundLoanDues.updateOne({ _id: a.dueId }, { $inc: { paidPaise: -a.amountPaise }, $set: { updatedAt: new Date() } }, { session });
      for (const s of d.shares) {
        await postMemberEntry(
          { org: ctx.org, memberId: s.memberId, date: today, kind: "interest", debitPaise: s.amountPaise, description: `Reversed upad interest share: ${reasonText}`, sourceType: "fundLoanPayment", sourceId: d._id, transactionId: rev._id, dedupeKey: `flp-rev:${d._id.toHexString()}:${s.memberId.toHexString()}`, reversalOf: s.ledgerEntryId, createdBy: ctx.user._id },
          session,
        );
      }
      await c.fundLoans.updateOne({ _id: d.loanId, status: "closed" }, { $set: { status: "active", closedAt: null, updatedAt: new Date() } }, { session });
    }
    await c.upadInterestPayments.updateOne({ _id: groupId }, { $set: { reversalTransactionId: rev._id } }, { session });
    if (g.receiptId) await cancelReceiptFor(ctx.orgId, "fundLoanPayment", groupId, session);
    await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "upadInterest.reverse", entityType: "member", entityId: g.memberId, reason: reasonText, after: { paymentId: groupId } }, session);
  });
  const loans = await c.fundLoans.find({ _id: { $in: docs.map((d) => d.loanId) } }).toArray();
  await refreshDuesFor(ctx.org, loans);
  return { ok: true };
}

/* ------------------------------------------------------------------ give the advance back */

export const ReturnAdvanceSchema = z.object({ date: dateOnly.optional(), accountId: z.string().optional(), note: optText(300) });

/** Pay the member's advance back in cash (e.g. their upad is closed, or before the Mandal closes). */
export async function returnUpadAdvance(ctx: OrgContext, memberId: ObjectId, input: z.infer<typeof ReturnAdvanceSchema>) {
  const c = await cols();
  const member = await c.members.findOne({ _id: memberId, organizationId: ctx.orgId }, { projection: { name: 1, upadAdvancePaise: 1 } });
  if (!member) throw notFound("Member");
  const amount = advanceOf(member);
  if (amount <= 0) throw badRequest(`${member.name} has no upad advance`);
  const date = input.date ?? todayIn(ctx.org.settings.timezone);
  if (date > todayIn(ctx.org.settings.timezone)) throw badRequest("The date can't be in the future");
  let accountId = input.accountId;
  if (!accountId) {
    const cash = await c.financialAccounts.findOne({ organizationId: ctx.orgId, type: "cash", isActive: true }, { sort: { createdAt: 1 } });
    if (!cash) throw badRequest("Create a cash account first");
    accountId = cash._id.toHexString();
  }
  const txn = await withTransaction(async (session) => {
    const account = await requireAccount(ctx.orgId, accountId!, session);
    await changeAdvance(ctx.orgId, memberId, -amount, session);
    const t = await postTransaction(
      {
        org: ctx.org,
        type: "upad_advance_return",
        date,
        description: `${member.name} — upad advance returned`,
        lines: [
          { accountKey: UPAD_ADVANCE, debitPaise: amount, memberId },
          { accountKey: faKey(account._id), creditPaise: amount },
        ],
        createdBy: ctx.user._id,
        memberId,
        reason: input.note,
      },
      session,
    );
    await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "upadInterest.advanceReturned", entityType: "member", entityId: memberId, after: { amountPaise: amount, transactionId: t._id } }, session);
    return t;
  });
  return { ok: true, amountPaise: amount, transactionId: txn._id };
}

/** Members holding an advance (settlement blocker, upad page). */
export async function advancesHeld(orgId: ObjectId) {
  const c = await cols();
  const ms = await c.members.find({ organizationId: orgId, upadAdvancePaise: { $gt: 0 } }, { projection: { name: 1, upadAdvancePaise: 1 } }).toArray();
  return { totalPaise: ms.reduce((s, m) => s + advanceOf(m), 0), members: ms.map((m) => ({ _id: m._id, name: m.name, advancePaise: advanceOf(m) })) };
}
