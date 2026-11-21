import { ObjectId } from "mongodb";
import { z } from "zod";
import { cols } from "@/lib/collections";
import { badRequest, notFound } from "@/lib/errors";
import { todayIn } from "@/lib/dates";
import type { OrgContext } from "@/lib/auth";
import { assertMethodEnabled, isSupportedMethod, UNSUPPORTED_METHOD_MESSAGE } from "@/lib/org-defaults";
import { dateOnly, idempotencyKey, money, optText } from "@/validators/common";
import { recordPayment } from "./payment.service";
import { memberUpadInterest, receiveMemberInterest } from "./upad-interest.service";
import { receiveFundLoanPayment } from "./fund-loan.service";
import { monthOf } from "./monthly.service";
import { installmentStatus, splitInstallment } from "./upad-installments";
import type { FundLoanDoc } from "@/types/models";

/**
 * Collect from one member on one screen: the hapta still due (oldest month first) and the
 * interest due on their upads — the two amounts are entered together and recorded as their own
 * receipts (a hapta payment and an upad-interest payment), with one date and one way of paying.
 * In Mandals where upad is returned in fixed installments, the upad installment due is collected
 * here too (its own receipt per upad).
 */

/** The member's upads that have an installment plan, with what is due on each now. */
async function plannedUpads(ctx: OrgContext, memberId: ObjectId) {
  const c = await cols();
  const loans = await c.fundLoans.find({ organizationId: ctx.orgId, memberId, status: "active", installmentPlan: { $ne: null, $exists: true } }).sort({ date: 1 }).toArray();
  const today = todayIn(ctx.org.settings.timezone);
  return loans.map((loan: FundLoanDoc) => {
    const st = installmentStatus(loan, { month: monthOf(today), today, dueDay: ctx.org.settings.fundLoans.dueDay });
    return { loan, duePaise: st?.duePaise ?? 0, status: st };
  });
}

/** What the member owes now: hapta months due so far and their upad interest. */
export async function memberDues(ctx: OrgContext, memberId: ObjectId) {
  const c = await cols();
  const member = await c.members.findOne({ _id: memberId, organizationId: ctx.orgId }, { projection: { name: 1, membershipNumber: 1, status: 1 } });
  if (!member) throw notFound("Member");
  const today = todayIn(ctx.org.settings.timezone);
  const open = await c.installments
    .find({ organizationId: ctx.orgId, memberId, state: "active", dueDate: { $lte: today }, $expr: { $lt: [{ $add: ["$paidPaise", "$penaltyPaidPaise"] }, { $add: ["$amountPaise", "$penaltyPaise"] }] } })
    .sort({ dueDate: 1, sequence: 1 })
    .limit(240)
    .toArray();
  const months = open.map((i) => ({
    installmentId: i._id,
    period: i.periodLabel,
    dueDate: i.dueDate,
    outstandingPaise: i.amountPaise + i.penaltyPaise - i.paidPaise - i.penaltyPaidPaise,
    lateFeePaise: Math.max(0, i.penaltyPaise - i.penaltyPaidPaise),
  }));
  const hasUpad = (await c.fundLoans.countDocuments({ organizationId: ctx.orgId, memberId, status: "active" }, { limit: 1 })) > 0;
  const interest = hasUpad ? await memberUpadInterest(ctx, memberId) : null;
  const planned = hasUpad ? await plannedUpads(ctx, memberId) : [];
  const installmentDue = planned.reduce((s, p) => s + p.duePaise, 0);
  return {
    member: { _id: member._id, name: member.name, membershipNumber: member.membershipNumber, status: member.status },
    hapta: { duePaise: months.reduce((s, m) => s + m.outstandingPaise, 0), months },
    interest: interest
      ? { duePaise: interest.interestDuePaise, advancePaise: interest.advancePaise, toPayPaise: interest.toPayPaise, maxPaise: interest.maxPaise, loans: interest.loans.map((l) => ({ _id: l._id, number: l.number, interestDuePaise: l.interestDuePaise, unpaidMonths: l.unpaidMonths })) }
      : null,
    /** upad installments (Mandals with fixed installments): due now, and the most that can be returned */
    installment: planned.length
      ? {
          duePaise: installmentDue,
          maxPaise: planned.reduce((s, p) => s + p.loan.outstandingPaise, 0),
          loans: planned.map((p) => ({ _id: p.loan._id, number: p.loan.number, outstandingPaise: p.loan.outstandingPaise, duePaise: p.duePaise, amountPaise: p.status?.amountPaise ?? 0, paidCount: p.status?.paidCount ?? 0, count: p.status?.count ?? 0, overduePaise: p.status?.overduePaise ?? 0 })),
        }
      : null,
    totalPaise: months.reduce((s, m) => s + m.outstandingPaise, 0) + (interest?.toPayPaise ?? 0) + installmentDue,
    methods: ctx.org.settings.paymentMethods,
  };
}

export const MemberCollectSchema = z
  .object({
    /** hapta received: applied to the oldest months first (more than is due pays months ahead) */
    hapta: money({ allowZero: true }).default(0),
    /** upad interest received: oldest month first; more than is due is kept as their advance */
    interest: money({ allowZero: true }).default(0),
    /** upad installment returned: what is due on each upad first (oldest upad first), the rest returns the oldest upad early */
    installment: money({ allowZero: true }).default(0),
    date: dateOnly,
    method: z.string().refine(isSupportedMethod, UNSUPPORTED_METHOD_MESSAGE).default("cash"),
    reference: optText(100),
    note: optText(300),
    idempotencyKey,
  })
  .refine((v) => v.hapta > 0 || v.interest > 0 || v.installment > 0, { message: "Enter the hapta, interest or upad installment received", path: ["hapta"] });

export async function collectFromMember(ctx: OrgContext, memberId: ObjectId, input: z.infer<typeof MemberCollectSchema>) {
  assertMethodEnabled(ctx.org, input.method);
  const c = await cols();
  const member = await c.members.findOne({ _id: memberId, organizationId: ctx.orgId }, { projection: { name: 1, status: 1 } });
  if (!member) throw notFound("Member");
  if (input.date > todayIn(ctx.org.settings.timezone)) throw badRequest("A payment can't be dated in the future");
  if (input.hapta > 0 && member.status !== "active") throw badRequest(`${member.name} is not an active member — hapta can't be collected`);

  // the account the money went into: the Mandal's UPI account for UPI, else the cash box
  let accountId = input.method === "upi" ? ctx.org.settings.upi?.accountId?.toHexString() : undefined;
  if (!accountId) {
    const cash = await c.financialAccounts.findOne({ organizationId: ctx.orgId, type: "cash", isActive: true }, { sort: { createdAt: 1 } });
    if (!cash) throw badRequest("Create a cash account first");
    accountId = cash._id.toHexString();
  }
  // Two receipts from one form. Each has its own key, so a retry finishes whichever is missing
  // and never records one twice. A UPI reference (UTR) is unique: it goes on the hapta receipt,
  // and the interest receipt mentions it in its note.
  // check the installment fits before recording anything
  let installmentParts: { loan: FundLoanDoc; amountPaise: number }[] = [];
  if (input.installment > 0) {
    const planned = await plannedUpads(ctx, memberId);
    if (planned.length === 0) throw badRequest(`${member.name} has no upad that is returned in installments`);
    const split = splitInstallment(input.installment, planned.map((p) => ({ loan: p.loan, duePaise: p.duePaise })));
    if (split.leftPaise > 0) throw badRequest(`That's more than ${member.name}'s upad still outstanding — check the installment amount`);
    installmentParts = split.parts;
  }
  const out: { hapta: unknown; interest: unknown; installments: unknown[] } = { hapta: null, interest: null, installments: [] };
  if (input.hapta > 0) {
    out.hapta = await recordPayment(ctx, {
      kind: "hapta",
      memberId: memberId.toHexString(),
      payerName: undefined,
      amount: input.hapta,
      date: input.date,
      method: input.method,
      reference: input.reference,
      accountId,
      schemeId: null,
      allocations: undefined,
      eventName: undefined,
      notes: input.note,
      idempotencyKey: `${input.idempotencyKey}:hapta`,
    });
  }
  if (input.interest > 0) {
    const both = input.hapta > 0 && input.reference;
    const note = both ? [input.note, `Paid with the hapta (UPI ${input.reference})`].filter(Boolean).join(" — ") : input.note;
    out.interest = await receiveMemberInterest(ctx, memberId, {
      amount: input.interest,
      date: input.date,
      method: input.method,
      reference: both ? undefined : input.reference,
      note,
      accountId,
      idempotencyKey: `${input.idempotencyKey}:interest`,
    });
  }
  // after the interest, so this month's interest is still worked out on last month's upad
  for (const [i, part] of installmentParts.entries()) {
    const earlier = input.hapta > 0 || input.interest > 0 || i > 0;
    const note = earlier && input.reference ? [input.note, `Paid with the hapta/interest (UPI ${input.reference})`].filter(Boolean).join(" — ") : input.note;
    out.installments.push(
      await receiveFundLoanPayment(ctx, part.loan._id, {
        interestAmount: 0,
        principalAmount: part.amountPaise,
        date: input.date,
        method: input.method,
        reference: earlier ? undefined : input.reference,
        note,
        accountId,
        idempotencyKey: `${input.idempotencyKey}:installment:${part.loan._id.toHexString()}`,
      }),
    );
  }
  return { ok: true, ...out };
}
