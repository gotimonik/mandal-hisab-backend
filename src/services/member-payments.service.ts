import { formatMoney } from "@/lib/currency";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { cols } from "@/lib/collections";
import { audit } from "@/lib/audit";
import { badRequest, conflict, forbidden, isDuplicateKeyError, notFound } from "@/lib/errors";
import { todayIn } from "@/lib/dates";
import type { OrgContext } from "@/lib/auth";
import type { FundLoanPaymentDoc, UpadPaymentClaimDoc } from "@/types/models";
import { dateOnly, idempotencyKey, money, optText } from "@/validators/common";
import { listFundLoans, receiveFundLoanPayment } from "./fund-loan.service";
import { lastOfMonth, monthOf } from "./monthly.service";
import { notifyMember, notifyRoles } from "./notification.service";
import { copy } from "./notification-copy";

/**
 * "I have paid" — what a member can report paying, and the upad side of it.
 * Hapta / other payments go through the existing pending-payment flow (payment.service);
 * upad interest and upad returned are "claims" here that an admin verifies (→ a normal upad
 * payment with receipt and interest shares) or rejects.
 */

function memberOf(ctx: OrgContext) {
  if (!ctx.membership.memberId) throw forbidden("Your login is not linked to a member record yet — ask the admin");
  return ctx.membership.memberId;
}

/** What the member owes right now, to pre-fill the "I have paid" form. */
export async function myPaymentOptions(ctx: OrgContext) {
  const memberId = memberOf(ctx);
  const c = await cols();
  const today = todayIn(ctx.org.settings.timezone);
  const monthEnd = lastOfMonth(monthOf(today));
  const [due] = await c.installments
    .aggregate<{ due: number; months: number }>([
      { $match: { organizationId: ctx.orgId, memberId, state: "active", dueDate: { $lte: monthEnd } } },
      { $project: { owed: { $subtract: [{ $add: ["$amountPaise", "$penaltyPaise"] }, { $add: ["$paidPaise", "$penaltyPaidPaise"] }] } } },
      { $match: { owed: { $gt: 0 } } },
      { $group: { _id: null, due: { $sum: "$owed" }, months: { $sum: 1 } } },
    ])
    .toArray();
  const [pendingHapta] = await c.payments
    .aggregate<{ t: number }>([{ $match: { organizationId: ctx.orgId, memberId, status: "pending" } }, { $group: { _id: null, t: { $sum: "$amountPaise" } } }])
    .toArray();
  const loans = await listFundLoans(ctx, { status: "active" }, memberId);
  // Per scheme: what is due by the end of this month, the next unpaid installment, and what is left overall,
  // so the member can say which scheme the cash was for (and pay ahead).
  const perScheme = await c.installments
    .aggregate<{ _id: ObjectId; due: number; months: number; left: number; next: number | null; nextLabel: string | null; name: string; frequency: string }>([
      { $match: { organizationId: ctx.orgId, memberId, state: "active" } },
      { $project: { schemeId: 1, dueDate: 1, sequence: 1, periodLabel: 1, owed: { $subtract: [{ $add: ["$amountPaise", "$penaltyPaise"] }, { $add: ["$paidPaise", "$penaltyPaidPaise"] }] } } },
      { $match: { owed: { $gt: 0 } } },
      { $sort: { dueDate: 1, sequence: 1 } },
      {
        $group: {
          _id: "$schemeId",
          due: { $sum: { $cond: [{ $lte: ["$dueDate", monthEnd] }, "$owed", 0] } },
          months: { $sum: { $cond: [{ $lte: ["$dueDate", monthEnd] }, 1, 0] } },
          left: { $sum: "$owed" },
          next: { $first: "$owed" },
          nextLabel: { $first: "$periodLabel" },
        },
      },
      { $lookup: { from: "haptaSchemes", localField: "_id", foreignField: "_id", as: "s" } },
      { $unwind: "$s" },
      { $match: { "s.organizationId": ctx.orgId, "s.status": "active" } },
      { $project: { due: 1, months: 1, left: 1, next: 1, nextLabel: 1, name: "$s.name", frequency: "$s.frequency" } },
      { $sort: { due: -1, name: 1 } },
    ])
    .toArray();
  return {
    schemes: perScheme.map((x) => ({ _id: x._id, name: x.name, frequency: x.frequency, duePaise: x.due, months: x.months, remainingPaise: x.left, nextPaise: x.next ?? 0, nextLabel: x.nextLabel })),
    hapta: { duePaise: due?.due ?? 0, months: due?.months ?? 0, pendingPaise: pendingHapta?.t ?? 0 },
    upads: loans.items.map((l) => ({ _id: l._id, number: l.number, interestDuePaise: l.interestDuePaise, outstandingPaise: l.outstandingPaise, monthlyRate: l.monthlyRate, unpaidMonths: l.unpaidMonths })),
    methods: ctx.org.settings.paymentMethods,
  };
}

/* ------------------------------------------------------------------ upad payment claims */

export const UpadClaimSchema = z
  .object({
    loanId: z.string(),
    interestAmount: money({ allowZero: true }).default(0),
    principalAmount: money({ allowZero: true }).default(0),
    date: dateOnly,
    method: z.string().min(2).max(30),
    reference: optText(100),
    notes: optText(500),
    idempotencyKey,
  })
  .refine((v) => v.interestAmount > 0 || v.principalAmount > 0, { message: "Enter the interest and/or upad amount you paid", path: ["interestAmount"] });

export async function submitUpadClaim(ctx: OrgContext, input: z.infer<typeof UpadClaimSchema>) {
  const memberId = memberOf(ctx);
  if (!ctx.org.settings.paymentMethods.includes(input.method)) throw badRequest("Choose a valid payment method");
  const c = await cols();
  const prior = await c.upadPaymentClaims.findOne({ organizationId: ctx.orgId, idempotencyKey: input.idempotencyKey });
  if (prior) return { claim: prior, duplicate: true };
  if (!ObjectId.isValid(input.loanId)) throw notFound("Upad");
  const today = todayIn(ctx.org.settings.timezone);
  if (input.date > today) throw badRequest("The payment date can't be in the future");
  const { items } = await listFundLoans(ctx, { status: "active" }, memberId);
  const loan = items.find((l) => l._id.toHexString() === input.loanId);
  if (!loan) throw notFound("Upad");
  // what's already reported but not yet verified counts against what is due
  const open = await c.upadPaymentClaims.find({ organizationId: ctx.orgId, loanId: loan._id, status: "pending" }).toArray();
  const openInterest = open.reduce((s, x) => s + x.interestPaise, 0);
  const openPrincipal = open.reduce((s, x) => s + x.principalPaise, 0);
  if (input.interestAmount > loan.interestDuePaise - openInterest) throw badRequest(`Interest due on ${loan.number} is ${formatMoney(Math.max(0, loan.interestDuePaise - openInterest), ctx.org.settings.currency)}${openInterest ? " (after payments waiting for verification)" : ""}`);
  if (input.principalAmount > loan.outstandingPaise - openPrincipal) throw badRequest(`Only ${formatMoney(Math.max(0, loan.outstandingPaise - openPrincipal), ctx.org.settings.currency)} of ${loan.number} is outstanding`);
  const now = new Date();
  const doc: UpadPaymentClaimDoc = {
    _id: new ObjectId(),
    organizationId: ctx.orgId,
    memberId,
    loanId: loan._id,
    interestPaise: input.interestAmount,
    principalPaise: input.principalAmount,
    date: input.date,
    method: input.method,
    reference: input.reference,
    notes: input.notes,
    status: "pending",
    paymentId: null,
    decidedBy: null,
    decidedAt: null,
    submittedBy: ctx.user._id,
    idempotencyKey: input.idempotencyKey,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await c.upadPaymentClaims.insertOne(doc);
  } catch (e) {
    if (isDuplicateKeyError(e)) {
      const again = await c.upadPaymentClaims.findOne({ organizationId: ctx.orgId, idempotencyKey: input.idempotencyKey });
      if (again) return { claim: again, duplicate: true };
    }
    throw e;
  }
  const member = await c.members.findOne({ _id: memberId }, { projection: { name: 1 } });
  await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "upadClaim.submit", entityType: "upadPaymentClaim", entityId: doc._id, after: { loanId: loan._id, interestPaise: doc.interestPaise, principalPaise: doc.principalPaise } });
  await notifyRoles(ctx.orgId, ["admin", "manager"], {
    type: "upadClaim.new",
    copy: copy("upadClaim.new", { member: member?.name ?? "A member", interestPaise: doc.interestPaise, principalPaise: doc.principalPaise, loan: loan.number, method: doc.method }, ctx.org.settings.currency),
    link: `/org/${ctx.orgId}/fund-loans`,
    dedupeKey: `upadclaim:${doc._id}`,
  });
  return { claim: doc, duplicate: false };
}

export async function myUpadClaims(ctx: OrgContext) {
  const memberId = memberOf(ctx);
  const c = await cols();
  const items = await c.upadPaymentClaims.find({ organizationId: ctx.orgId, memberId }).sort({ createdAt: -1 }).limit(50).toArray();
  const loans = await c.fundLoans.find({ _id: { $in: items.map((i) => i.loanId) } }, { projection: { number: 1 } }).toArray();
  return items.map((i) => ({ ...i, loanNumber: loans.find((l) => l._id.equals(i.loanId))?.number ?? "" }));
}

/**
 * A payment the admin already recorded directly ("Receive") that covers this claim: same upad,
 * recorded after the member reported it, at least the same interest and upad amounts, and not
 * already used for another claim.
 */
function findCoveringPayment(claim: UpadPaymentClaimDoc, payments: FundLoanPaymentDoc[], usedIds: Set<string>) {
  return payments.find(
    (p) =>
      p.loanId.equals(claim.loanId) &&
      p.status === "valid" &&
      p.createdAt >= claim.createdAt &&
      p.interestPaise >= claim.interestPaise &&
      p.principalPaise >= claim.principalPaise &&
      !usedIds.has(p._id.toHexString()),
  );
}

export async function listUpadClaims(ctx: OrgContext, status: "pending" | "all" = "pending") {
  const c = await cols();
  const filter: Record<string, unknown> = { organizationId: ctx.orgId };
  if (status !== "all") filter.status = status;
  const items = await c.upadPaymentClaims.find(filter).sort({ createdAt: -1 }).limit(200).toArray();
  const pendingLoanIds = items.filter((i) => i.status === "pending").map((i) => i.loanId);
  const [members, loans, payments, used] = await Promise.all([
    c.members.find({ _id: { $in: items.map((i) => i.memberId) } }, { projection: { name: 1, membershipNumber: 1 } }).toArray(),
    c.fundLoans.find({ _id: { $in: items.map((i) => i.loanId) } }, { projection: { number: 1, outstandingPaise: 1 } }).toArray(),
    pendingLoanIds.length ? c.fundLoanPayments.find({ organizationId: ctx.orgId, loanId: { $in: pendingLoanIds }, status: "valid" }).sort({ createdAt: 1 }).toArray() : Promise.resolve([] as FundLoanPaymentDoc[]),
    pendingLoanIds.length ? c.upadPaymentClaims.find({ organizationId: ctx.orgId, loanId: { $in: pendingLoanIds }, paymentId: { $ne: null } }, { projection: { paymentId: 1 } }).toArray() : Promise.resolve([]),
  ]);
  const usedIds = new Set(used.map((u) => u.paymentId!.toHexString()));
  return items.map((i) => {
    const cover = i.status === "pending" ? findCoveringPayment(i, payments, usedIds) : undefined;
    return {
      ...i,
      member: members.find((m) => m._id.equals(i.memberId)) ?? null,
      loanNumber: loans.find((l) => l._id.equals(i.loanId))?.number ?? "",
      /** the admin already recorded this money with "Receive" — settle instead of verifying again */
      alreadyRecorded: cover ? { paymentId: cover._id, date: cover.date, interestPaise: cover.interestPaise, principalPaise: cover.principalPaise, receiptId: cover.receiptId } : null,
    };
  });
}

/**
 * The member reported a payment that the admin had already recorded directly: close the claim
 * against that payment (no second payment, no double interest share) and tell the member.
 */
export async function settleUpadClaim(ctx: OrgContext, id: ObjectId, paymentIdHint?: ObjectId) {
  const c = await cols();
  const claim = await c.upadPaymentClaims.findOne({ _id: id, organizationId: ctx.orgId });
  if (!claim) throw notFound("Payment");
  if (claim.status !== "pending") throw conflict(`This payment is already ${claim.status}`);
  const [payments, used] = await Promise.all([
    c.fundLoanPayments.find({ organizationId: ctx.orgId, loanId: claim.loanId, status: "valid", ...(paymentIdHint ? { _id: paymentIdHint } : {}) }).sort({ createdAt: 1 }).toArray(),
    c.upadPaymentClaims.find({ organizationId: ctx.orgId, loanId: claim.loanId, paymentId: { $ne: null } }, { projection: { paymentId: 1 } }).toArray(),
  ]);
  const payment = findCoveringPayment(claim, payments, new Set(used.map((u) => u.paymentId!.toHexString())));
  if (!payment) throw badRequest("No recorded payment on this upad covers it. Verify it to record the money, or reject it.");
  const r = await c.upadPaymentClaims.updateOne(
    { _id: id, status: "pending" },
    { $set: { status: "verified", paymentId: payment._id, decidedBy: ctx.user._id, decidedAt: new Date(), updatedAt: new Date() } },
  );
  if (r.modifiedCount !== 1) throw conflict("This payment was just changed — refresh and try again");
  await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "upadClaim.settle", entityType: "upadPaymentClaim", entityId: id, after: { paymentId: payment._id } });
  await notifyMember(ctx.orgId, claim.memberId, { type: "upadClaim.verified", copy: copy("upadClaim.verified", { amountPaise: claim.interestPaise + claim.principalPaise }, ctx.org.settings.currency), link: `/org/${ctx.orgId}/receipts/${payment.receiptId}`, dedupeKey: `upadclaim-ok:${id}` });
  return { ok: true, paymentId: payment._id, receiptId: payment.receiptId };
}

/** After an admin records money with "Receive": close a pending claim for exactly that amount. */
export async function settleMatchingClaim(ctx: OrgContext, payment: FundLoanPaymentDoc) {
  const c = await cols();
  const claim = await c.upadPaymentClaims.findOne(
    { organizationId: ctx.orgId, loanId: payment.loanId, status: "pending", interestPaise: payment.interestPaise, principalPaise: payment.principalPaise, createdAt: { $lte: payment.createdAt } },
    { sort: { createdAt: 1 } },
  );
  if (!claim) return null;
  try {
    await settleUpadClaim(ctx, claim._id, payment._id);
    return claim._id;
  } catch {
    return null;
  }
}

const ALREADY_RECORDED = 'This money was already recorded with Receive — use "Already recorded" to close it without counting it twice.';

export const VerifyClaimSchema = z.object({
  accountId: z.string().optional(),
  /** record it even though a matching payment was already recorded with Receive (two separate payments) */
  recordAgain: z.boolean().default(false),
});

/** Verify → records the upad payment exactly as "Receive" would (receipt, interest shared among members). */
export async function verifyUpadClaim(ctx: OrgContext, id: ObjectId, input: z.infer<typeof VerifyClaimSchema>) {
  const c = await cols();
  const claim = await c.upadPaymentClaims.findOne({ _id: id, organizationId: ctx.orgId });
  if (!claim) throw notFound("Payment");
  if (claim.status !== "pending") throw conflict(`This payment is already ${claim.status}`);
  if (!input.recordAgain) {
    const [listed] = (await listUpadClaims(ctx, "pending")).filter((x) => x._id.equals(id));
    if (listed?.alreadyRecorded) throw conflict(ALREADY_RECORDED);
  }
  const claimed = await c.upadPaymentClaims.updateOne({ _id: id, status: "pending" }, { $set: { status: "verified", decidedBy: ctx.user._id, decidedAt: new Date(), updatedAt: new Date() } });
  if (claimed.modifiedCount !== 1) throw conflict("This payment was just changed — refresh and try again");
  try {
    const { payment } = await receiveFundLoanPayment(ctx, claim.loanId, {
      interestAmount: claim.interestPaise,
      principalAmount: claim.principalPaise,
      date: claim.date,
      note: [`Reported by member`, claim.notes].filter(Boolean).join(": "),
      accountId: input.accountId,
      method: claim.method,
      reference: claim.reference,
      idempotencyKey: `upadclaim:${id.toHexString()}`,
    });
    await c.upadPaymentClaims.updateOne({ _id: id }, { $set: { paymentId: payment._id, updatedAt: new Date() } });
    await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "upadClaim.verify", entityType: "upadPaymentClaim", entityId: id, after: { paymentId: payment._id } });
    await notifyMember(ctx.orgId, claim.memberId, { type: "upadClaim.verified", copy: copy("upadClaim.verified", { amountPaise: claim.interestPaise + claim.principalPaise }, ctx.org.settings.currency), link: `/org/${ctx.orgId}/receipts/${payment.receiptId}`, dedupeKey: `upadclaim-ok:${id}` });
    return { ok: true, paymentId: payment._id, receiptId: payment.receiptId };
  } catch (e) {
    await c.upadPaymentClaims.updateOne({ _id: id, status: "verified", paymentId: null }, { $set: { status: "pending", decidedBy: null, decidedAt: null, updatedAt: new Date() } });
    throw e;
  }
}

export async function rejectUpadClaim(ctx: OrgContext, id: ObjectId, reasonText: string) {
  const c = await cols();
  const claim = await c.upadPaymentClaims.findOneAndUpdate(
    { _id: id, organizationId: ctx.orgId, status: "pending" },
    { $set: { status: "rejected", rejectedReason: reasonText, decidedBy: ctx.user._id, decidedAt: new Date(), updatedAt: new Date() } },
    { returnDocument: "after" },
  );
  if (!claim) throw conflict("Only payments waiting for verification can be rejected");
  await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "upadClaim.reject", entityType: "upadPaymentClaim", entityId: id, reason: reasonText });
  await notifyMember(ctx.orgId, claim.memberId, { type: "upadClaim.rejected", copy: copy("upadClaim.rejected", { amountPaise: claim.interestPaise + claim.principalPaise, reason: reasonText }, ctx.org.settings.currency), link: `/org/${ctx.orgId}/my?tab=upad`, dedupeKey: `upadclaim-rej:${id}` });
  return { ok: true };
}
