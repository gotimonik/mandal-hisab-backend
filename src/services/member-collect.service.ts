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

/**
 * Collect from one member on one screen: the hapta still due (oldest month first) and the
 * interest due on their upads — the two amounts are entered together and recorded as their own
 * receipts (a hapta payment and an upad-interest payment), with one date and one way of paying.
 */

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
  return {
    member: { _id: member._id, name: member.name, membershipNumber: member.membershipNumber, status: member.status },
    hapta: { duePaise: months.reduce((s, m) => s + m.outstandingPaise, 0), months },
    interest: interest
      ? { duePaise: interest.interestDuePaise, advancePaise: interest.advancePaise, toPayPaise: interest.toPayPaise, maxPaise: interest.maxPaise, loans: interest.loans.map((l) => ({ _id: l._id, number: l.number, interestDuePaise: l.interestDuePaise, unpaidMonths: l.unpaidMonths })) }
      : null,
    totalPaise: months.reduce((s, m) => s + m.outstandingPaise, 0) + (interest?.toPayPaise ?? 0),
    methods: ctx.org.settings.paymentMethods,
  };
}

export const MemberCollectSchema = z
  .object({
    /** hapta received: applied to the oldest months first (more than is due pays months ahead) */
    hapta: money({ allowZero: true }).default(0),
    /** upad interest received: oldest month first; more than is due is kept as their advance */
    interest: money({ allowZero: true }).default(0),
    date: dateOnly,
    method: z.string().refine(isSupportedMethod, UNSUPPORTED_METHOD_MESSAGE).default("cash"),
    reference: optText(100),
    note: optText(300),
    idempotencyKey,
  })
  .refine((v) => v.hapta > 0 || v.interest > 0, { message: "Enter the hapta or the interest received", path: ["hapta"] });

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
  const out: { hapta: unknown; interest: unknown } = { hapta: null, interest: null };
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
  return { ok: true, ...out };
}
