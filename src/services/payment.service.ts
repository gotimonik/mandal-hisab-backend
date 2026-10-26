import { ObjectId, type ClientSession } from "mongodb";
import { z } from "zod";
import { cols } from "@/lib/collections";
import { withTransaction } from "@/lib/db";
import { audit } from "@/lib/audit";
import { badRequest, conflict, forbidden, isDuplicateKeyError, notFound } from "@/lib/errors";
import { formatINR } from "@/lib/money";
import { todayIn } from "@/lib/dates";
import type { OrgContext } from "@/lib/auth";
import type { OrganizationDoc, PaymentAllocation, PaymentDoc, PaymentKind } from "@/types/models";
import { dateOnly, idempotencyKey, money, optText, reason } from "@/validators/common";
import { postMemberEntry } from "./member-ledger.service";
import { INCOME_KEYS, MEMBER_FUNDS, faKey, postTransaction, reverseTransaction, type LedgerLine } from "./ledger.service";
import { cancelReceiptFor, issueReceipt } from "./receipt.service";
import { requireAccount } from "./account.service";
import { notifyMember, notifyRoles } from "./notification.service";

export const RecordPaymentSchema = z
  .object({
    kind: z.enum(["hapta", "membership_fee", "event", "other_income"]).default("hapta"),
    memberId: z.string().optional().nullable(),
    payerName: optText(120),
    amount: money(),
    date: dateOnly,
    method: z.string().min(2).max(30),
    reference: optText(100),
    accountId: z.string(),
    schemeId: z.string().optional().nullable(),
    allocations: z
      .array(z.object({ installmentId: z.string(), amount: money({ allowZero: true }), penalty: money({ allowZero: true }).default(0) }))
      .max(200)
      .optional(),
    eventName: optText(120),
    notes: optText(500),
    idempotencyKey,
  })
  .superRefine((v, ctx) => {
    if (v.kind === "hapta" && !v.memberId) ctx.addIssue({ code: "custom", path: ["memberId"], message: "Select the member" });
    if (v.kind !== "hapta" && !v.memberId && !v.payerName) ctx.addIssue({ code: "custom", path: ["payerName"], message: "Enter the payer name" });
  });

export const MemberPaymentRequestSchema = z.object({
  /** hapta = applied to the member's oldest dues; other = donation / event / anything else */
  purpose: z.enum(["hapta", "other"]).default("hapta"),
  amount: money(),
  date: dateOnly,
  method: z.string().min(2).max(30),
  reference: optText(100),
  schemeId: z.string().optional().nullable(),
  notes: optText(500),
  idempotencyKey,
});

export const VerifySchema = z.object({ accountId: z.string().optional() });
export const ReverseSchema = z.object({ reason, mode: z.enum(["reversal", "refund"]).default("reversal") });

export const PaymentListQuery = z.object({
  status: z.enum(["pending", "verified", "rejected", "reversed"]).optional(),
  kind: z.enum(["hapta", "membership_fee", "event", "other_income"]).optional(),
  memberId: z.string().optional(),
  method: z.string().optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

const KIND_INCOME: Record<PaymentKind, string> = {
  hapta: INCOME_KEYS.hapta,
  membership_fee: INCOME_KEYS.membership_fee,
  event: INCOME_KEYS.event,
  other_income: INCOME_KEYS.other,
};

const KIND_LABEL: Record<PaymentKind, string> = {
  hapta: "Hapta",
  membership_fee: "Membership fee",
  event: "Event collection",
  other_income: "Other income",
};

/**
 * Oldest-first allocation of an amount across a member's open installments:
 * outstanding late fee first, then the installment amount. Future installments
 * may be paid in advance. Throws if the amount exceeds everything outstanding.
 */
export async function autoAllocate(
  orgId: ObjectId,
  memberId: ObjectId,
  amountPaise: number,
  schemeId?: ObjectId | null,
  session?: ClientSession,
): Promise<PaymentAllocation[]> {
  const c = await cols();
  const q: Record<string, unknown> = {
    organizationId: orgId,
    memberId,
    state: "active",
    $expr: { $lt: [{ $add: ["$paidPaise", "$penaltyPaidPaise"] }, { $add: ["$amountPaise", "$penaltyPaise"] }] },
  };
  if (schemeId) q.schemeId = schemeId;
  const open = await c.installments.find(q, { session }).sort({ dueDate: 1, sequence: 1 }).limit(500).toArray();
  let left = amountPaise;
  const out: PaymentAllocation[] = [];
  for (const i of open) {
    if (left <= 0) break;
    const pen = Math.min(left, i.penaltyPaise - i.penaltyPaidPaise);
    left -= pen;
    const amt = Math.min(left, i.amountPaise - i.paidPaise);
    left -= amt;
    if (pen > 0 || amt > 0) out.push({ installmentId: i._id, amountPaise: amt, penaltyPaise: pen });
  }
  if (left > 0) {
    const total = amountPaise - left;
    throw badRequest(`Amount exceeds the member's outstanding installments (${formatINR(total)}). Record the extra as a donation or other income.`);
  }
  return out;
}

async function resolveMember(orgId: ObjectId, memberId: string | null | undefined, session?: ClientSession) {
  if (!memberId) return null;
  if (!ObjectId.isValid(memberId)) throw badRequest("Invalid member");
  const c = await cols();
  const m = await c.members.findOne({ _id: new ObjectId(memberId), organizationId: orgId }, { session });
  if (!m) throw notFound("Member");
  return m;
}

function assertMethod(org: OrganizationDoc, method: string) {
  if (!org.settings.paymentMethods.includes(method)) throw badRequest(`Payment method "${method}" is not enabled for this organization`);
}

async function findByKey(orgId: ObjectId, key: string) {
  const c = await cols();
  return c.payments.findOne({ organizationId: orgId, idempotencyKey: key });
}

export async function recordPayment(ctx: OrgContext, input: z.infer<typeof RecordPaymentSchema>) {
  assertMethod(ctx.org, input.method);
  const existing = await findByKey(ctx.orgId, input.idempotencyKey);
  if (existing) return { payment: existing, duplicate: true };

  const member = await resolveMember(ctx.orgId, input.memberId);
  if (member && member.status !== "active" && input.kind === "hapta") throw badRequest("Member is not active");
  const account = await requireAccount(ctx.orgId, input.accountId);
  const schemeId = input.schemeId && ObjectId.isValid(input.schemeId) ? new ObjectId(input.schemeId) : null;

  let allocations: PaymentAllocation[] = [];
  if (input.kind === "hapta") {
    if (input.allocations?.length) {
      allocations = input.allocations
        .filter((a) => a.amount > 0 || a.penalty > 0)
        .map((a) => ({ installmentId: new ObjectId(a.installmentId), amountPaise: a.amount, penaltyPaise: a.penalty }));
      const sum = allocations.reduce((s, a) => s + a.amountPaise + a.penaltyPaise, 0);
      if (sum !== input.amount) throw badRequest("Allocations must add up exactly to the payment amount");
      const c = await cols();
      const n = await c.installments.countDocuments({ _id: { $in: allocations.map((a) => a.installmentId) }, organizationId: ctx.orgId, memberId: member!._id });
      if (n !== allocations.length) throw badRequest("Allocations must be this member's installments");
    } else {
      allocations = await autoAllocate(ctx.orgId, member!._id, input.amount, schemeId);
    }
  }

  const autoVerify = !ctx.org.settings.requirePaymentVerification || ctx.can("payments.verify");
  const now = new Date();
  const doc: PaymentDoc = {
    _id: new ObjectId(),
    organizationId: ctx.orgId,
    kind: input.kind,
    memberId: member?._id ?? null,
    payerName: member?.name ?? input.payerName,
    amountPaise: input.amount,
    date: input.date,
    method: input.method,
    reference: input.reference,
    accountId: account._id,
    schemeId,
    allocations,
    autoAllocated: input.kind === "hapta" && !input.allocations?.length,
    eventName: input.eventName,
    notes: input.notes,
    status: "pending",
    source: "staff",
    idempotencyKey: input.idempotencyKey,
    recordedBy: ctx.user._id,
    createdAt: now,
    updatedAt: now,
  };
  try {
    const payment = await withTransaction(async (session) => {
      await cols().then((c) => c.payments.insertOne(doc, { session }));
      await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "payment.record", entityType: "payment", entityId: doc._id, after: { amountPaise: doc.amountPaise, kind: doc.kind, memberId: doc.memberId } }, session);
      if (autoVerify) return verifyInSession(ctx, doc._id, undefined, session);
      return doc;
    });
    if (payment.status === "verified") await afterVerify(ctx, payment);
    else
      await notifyRoles(ctx.orgId, ["admin"], {
        type: "payment.pending",
        title: "Payment awaiting verification",
        body: `${formatINR(doc.amountPaise)} from ${doc.payerName ?? "a member"} needs verification.`,
        link: `/org/${ctx.orgId}/collections?status=pending`,
        dedupeKey: `payment-pending:${doc._id}`,
      });
    return { payment, duplicate: false };
  } catch (e) {
    if (isDuplicateKeyError(e)) {
      const p = await findByKey(ctx.orgId, input.idempotencyKey);
      if (p) return { payment: p, duplicate: true };
    }
    throw e;
  }
}

/** A member submits "I have paid" information for staff verification. */
export async function submitMemberPaymentRequest(ctx: OrgContext, input: z.infer<typeof MemberPaymentRequestSchema>) {
  assertMethod(ctx.org, input.method);
  const memberId = ctx.membership.memberId;
  if (!memberId) throw forbidden("Your login is not linked to a member record yet. Please contact your Mandal admin.");
  const existing = await findByKey(ctx.orgId, input.idempotencyKey);
  if (existing) return { payment: existing, duplicate: true };
  const schemeId = input.schemeId && ObjectId.isValid(input.schemeId) ? new ObjectId(input.schemeId) : null;
  const isHapta = input.purpose === "hapta";
  if (!isHapta && !input.notes) throw badRequest("Say what this payment is for");
  const allocations = isHapta ? await autoAllocate(ctx.orgId, memberId, input.amount, schemeId) : [];
  const c = await cols();
  const member = await c.members.findOne({ _id: memberId, organizationId: ctx.orgId });
  const now = new Date();
  const doc: PaymentDoc = {
    _id: new ObjectId(),
    organizationId: ctx.orgId,
    kind: isHapta ? "hapta" : "other_income",
    memberId,
    payerName: member?.name,
    amountPaise: input.amount,
    date: input.date,
    method: input.method,
    reference: input.reference,
    accountId: null,
    schemeId,
    allocations,
    autoAllocated: isHapta,
    notes: input.notes,
    status: "pending",
    source: "member_request",
    idempotencyKey: input.idempotencyKey,
    recordedBy: ctx.user._id,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await c.payments.insertOne(doc);
  } catch (e) {
    if (isDuplicateKeyError(e)) return { payment: (await findByKey(ctx.orgId, input.idempotencyKey))!, duplicate: true };
    throw e;
  }
  await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "payment.member_request", entityType: "payment", entityId: doc._id, after: { amountPaise: doc.amountPaise } });
  await notifyRoles(ctx.orgId, ["admin", "manager"], {
    type: "payment.request",
    title: "Payment submitted by member",
    body: `${member?.name ?? "A member"} reported a payment of ${formatINR(doc.amountPaise)} for ${isHapta ? "monthly hapta" : input.notes} (${doc.method}${doc.reference ? ` ref ${doc.reference}` : ""}).`,
    link: `/org/${ctx.orgId}/collections?status=pending`,
    dedupeKey: `payment-request:${doc._id}`,
  });
  return { payment: doc, duplicate: false };
}

/**
 * Finalize a pending payment inside a transaction:
 *   pending → verified (exactly once), allocate to installments with overpayment guards,
 *   post the balanced ledger entry, issue the receipt.
 */
async function verifyInSession(ctx: OrgContext, paymentId: ObjectId, accountOverride: string | undefined, session: ClientSession): Promise<PaymentDoc> {
  const c = await cols();
  const p = await c.payments.findOne({ _id: paymentId, organizationId: ctx.orgId }, { session });
  if (!p) throw notFound("Payment");
  if (p.status !== "pending") throw conflict(`Payment is already ${p.status}`);
  const accountId = accountOverride ?? p.accountId?.toHexString();
  if (!accountId) throw badRequest("Choose the account that received this payment");
  const account = await requireAccount(ctx.orgId, accountId, session);
  const now = new Date();

  const claimed = await c.payments.updateOne(
    { _id: p._id, organizationId: ctx.orgId, status: "pending" },
    { $set: { status: "verified", verifiedBy: ctx.user._id, verifiedAt: now, accountId: account._id, updatedAt: now } },
    { session },
  );
  if (claimed.modifiedCount !== 1) throw conflict("Payment was already processed");

  // System allocations are recomputed against the latest balances inside the
  // transaction, so concurrent payments for the same member never double-allocate.
  if (p.autoAllocated && p.memberId) {
    p.allocations = await autoAllocate(ctx.orgId, p.memberId, p.amountPaise, p.schemeId, session);
    await c.payments.updateOne({ _id: p._id }, { $set: { allocations: p.allocations } }, { session });
  }

  for (const a of p.allocations) {
    const r = await c.installments.updateOne(
      {
        _id: a.installmentId,
        organizationId: ctx.orgId,
        memberId: p.memberId!,
        state: "active",
        $expr: {
          $and: [
            { $lte: [{ $add: ["$paidPaise", a.amountPaise] }, "$amountPaise"] },
            { $lte: [{ $add: ["$penaltyPaidPaise", a.penaltyPaise] }, "$penaltyPaise"] },
          ],
        },
      },
      {
        $inc: { paidPaise: a.amountPaise, penaltyPaidPaise: a.penaltyPaise },
        $set: { updatedAt: now },
        $push: { history: { at: now, by: ctx.user._id, action: "payment_applied", to: { paymentId: p._id, amountPaise: a.amountPaise, penaltyPaise: a.penaltyPaise } } },
      },
      { session },
    );
    if (r.modifiedCount !== 1) {
      throw conflict("This payment would overpay an installment (it may already have been paid). Please re-allocate.");
    }
  }

  const principal = p.allocations.reduce((s, a) => s + a.amountPaise, 0);
  const savings = p.kind === "hapta" && ctx.org.settings.haptaTreatment === "member_savings";
  const penalty = p.allocations.reduce((s, a) => s + a.penaltyPaise, 0);
  const lines: LedgerLine[] = [{ accountKey: faKey(account._id), debitPaise: p.amountPaise }];
  if (p.kind === "hapta") {
    // Member-savings Mandals: hapta belongs to the member (liability), not Mandal income.
    if (savings) for (const a of p.allocations) {
      if (a.amountPaise > 0) lines.push({ accountKey: MEMBER_FUNDS, creditPaise: a.amountPaise, memberId: p.memberId });
    }
    else if (principal > 0) lines.push({ accountKey: INCOME_KEYS.hapta, creditPaise: principal });
    if (penalty > 0) lines.push({ accountKey: INCOME_KEYS.penalty, creditPaise: penalty });
  } else {
    lines.push({ accountKey: KIND_INCOME[p.kind], creditPaise: p.amountPaise });
  }
  const txn = await postTransaction(
    {
      org: ctx.org,
      type: p.kind === "hapta" ? "hapta_collection" : "other_income",
      date: p.date,
      description: `${KIND_LABEL[p.kind]} from ${p.payerName ?? "member"}${p.reference ? ` (ref ${p.reference})` : ""}`,
      lines,
      createdBy: ctx.user._id,
      memberId: p.memberId,
      eventName: p.eventName,
      sourceType: "payment",
      sourceId: p._id,
    },
    session,
  );

  const insts = p.allocations.length
    ? await c.installments.find({ _id: { $in: p.allocations.map((a) => a.installmentId) } }, { session, projection: { periodLabel: 1, schemeId: 1, dueDate: 1 } }).toArray()
    : [];
  const im = new Map(insts.map((i) => [i._id.toHexString(), i]));
  const receiptLines =
    p.kind === "hapta"
      ? p.allocations.flatMap((a) => {
          const label = im.get(a.installmentId.toHexString())?.periodLabel ?? "Installment";
          const out = [];
          if (a.amountPaise) out.push({ description: `Hapta — ${label}`, amountPaise: a.amountPaise });
          if (a.penaltyPaise) out.push({ description: `Late fee — ${label}`, amountPaise: a.penaltyPaise });
          return out;
        })
      : [{ description: `${KIND_LABEL[p.kind]}${p.eventName ? ` — ${p.eventName}` : ""}`, amountPaise: p.amountPaise }];
  const receipt = await issueReceipt(
    ctx.org,
    {
      sourceType: "payment",
      sourceId: p._id,
      memberId: p.memberId,
      payerName: p.payerName ?? "",
      amountPaise: p.amountPaise,
      date: p.date,
      method: p.method,
      reference: p.reference,
      lines: receiptLines,
      issuedBy: ctx.user._id,
    },
    session,
  );
  await c.payments.updateOne({ _id: p._id }, { $set: { transactionId: txn._id, receiptId: receipt._id } }, { session });
  if (savings) {
    for (const a of p.allocations) {
      if (a.amountPaise <= 0) continue;
      const inst = im.get(a.installmentId.toHexString());
      const due = insts.find((i) => i._id.equals(a.installmentId)) as { dueDate?: Date } | undefined;
      await postMemberEntry(
        {
          org: ctx.org,
          memberId: p.memberId!,
          date: p.date,
          kind: "hapta",
          creditPaise: a.amountPaise,
          description: `Hapta — ${inst?.periodLabel ?? "installment"} (receipt ${receipt.receiptNumber})`,
          period: due?.dueDate ? due.dueDate.toISOString().slice(0, 7) : undefined,
          sourceType: "payment",
          sourceId: p._id,
          transactionId: txn._id,
          dedupeKey: `hapta:${p._id.toHexString()}:${a.installmentId.toHexString()}`,
          createdBy: ctx.user._id,
        },
        session,
      );
    }
  }
  await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "payment.verify", entityType: "payment", entityId: p._id, after: { transaction: txn.number, receipt: receipt.receiptNumber } }, session);
  return { ...p, status: "verified", verifiedBy: ctx.user._id, verifiedAt: now, accountId: account._id, transactionId: txn._id, receiptId: receipt._id };
}

async function afterVerify(ctx: OrgContext, p: PaymentDoc) {
  await notifyMember(ctx.orgId, p.memberId, {
    type: "payment.verified",
    title: "Payment received",
    body: `Your payment of ${formatINR(p.amountPaise)} has been verified. Your receipt is ready.`,
    link: p.receiptId ? `/org/${ctx.orgId}/receipts/${p.receiptId}` : `/org/${ctx.orgId}/my`,
    dedupeKey: `payment-verified:${p._id}`,
  });
}

export async function verifyPayment(ctx: OrgContext, id: ObjectId, input: z.infer<typeof VerifySchema>) {
  const p = await withTransaction((session) => verifyInSession(ctx, id, input.accountId, session));
  await afterVerify(ctx, p);
  return p;
}

export async function rejectPayment(ctx: OrgContext, id: ObjectId, reasonText: string) {
  const c = await cols();
  const r = await c.payments.findOneAndUpdate(
    { _id: id, organizationId: ctx.orgId, status: "pending" },
    { $set: { status: "rejected", rejectedReason: reasonText, verifiedBy: ctx.user._id, updatedAt: new Date() } },
    { returnDocument: "after" },
  );
  if (!r) throw conflict("Only pending payments can be rejected");
  await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "payment.reject", entityType: "payment", entityId: id, reason: reasonText });
  await notifyMember(ctx.orgId, r.memberId, {
    type: "payment.rejected",
    title: "Payment not verified",
    body: `Your payment of ${formatINR(r.amountPaise)} could not be verified: ${reasonText}`,
    link: `/org/${ctx.orgId}/my`,
    dedupeKey: `payment-rejected:${id}`,
  });
  return r;
}

/**
 * Reverse (or refund) a verified payment. The original ledger entry stays; a mirror
 * entry is posted, installment paid amounts are reduced, and the receipt is cancelled.
 */
export async function reversePayment(ctx: OrgContext, id: ObjectId, input: z.infer<typeof ReverseSchema>) {
  const c = await cols();
  const today = todayIn(ctx.org.settings.timezone);
  const result = await withTransaction(async (session) => {
    const p = await c.payments.findOne({ _id: id, organizationId: ctx.orgId }, { session });
    if (!p) throw notFound("Payment");
    if (p.status !== "verified" || !p.transactionId) throw conflict("Only verified payments can be reversed");
    const now = new Date();
    const claimed = await c.payments.updateOne(
      { _id: id, status: "verified" },
      { $set: { status: "reversed", reversalReason: `${input.mode}: ${input.reason}`, updatedAt: now } },
      { session },
    );
    if (claimed.modifiedCount !== 1) throw conflict("Payment was already reversed");
    for (const a of p.allocations) {
      const r = await c.installments.updateOne(
        { _id: a.installmentId, organizationId: ctx.orgId, paidPaise: { $gte: a.amountPaise }, penaltyPaidPaise: { $gte: a.penaltyPaise } },
        {
          $inc: { paidPaise: -a.amountPaise, penaltyPaidPaise: -a.penaltyPaise },
          $set: { updatedAt: now },
          $push: { history: { at: now, by: ctx.user._id, action: "payment_reversed", from: { paymentId: p._id, amountPaise: a.amountPaise }, reason: input.reason } },
        },
        { session },
      );
      if (r.modifiedCount !== 1) throw conflict("Installment totals are inconsistent; reversal aborted");
    }
    const rev = await reverseTransaction(ctx.org, p.transactionId, `${input.mode}: ${input.reason}`, ctx.user._id, today, session);
    // Undo the member's savings credit(s) for this payment, if any (history kept: debit entries).
    const credits = await c.memberLedger.find({ organizationId: ctx.orgId, sourceType: "payment", sourceId: p._id, creditPaise: { $gt: 0 } }, { session }).toArray();
    for (const e of credits) {
      await postMemberEntry(
        { org: ctx.org, memberId: e.memberId, date: today, kind: e.kind, debitPaise: e.creditPaise, description: `Reversed: ${e.description} — ${input.reason}`, period: e.period, sourceType: "payment", sourceId: p._id, transactionId: rev._id, dedupeKey: `rev:${e._id.toHexString()}`, reversalOf: e._id, createdBy: ctx.user._id },
        session,
      );
    }
    await c.payments.updateOne({ _id: id }, { $set: { reversalTransactionId: rev._id } }, { session });
    await cancelReceiptFor(ctx.orgId, "payment", id, session);
    await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: `payment.${input.mode}`, entityType: "payment", entityId: id, before: { status: "verified" }, after: { status: "reversed", reversal: rev.number }, reason: input.reason }, session);
    return { ...p, status: "reversed" as const, reversalTransactionId: rev._id };
  });
  return result;
}

export async function listPayments(ctx: OrgContext, q: z.infer<typeof PaymentListQuery>, restrictMemberId?: ObjectId) {
  const c = await cols();
  const filter: Record<string, unknown> = { organizationId: ctx.orgId };
  if (q.status) filter.status = q.status;
  if (q.kind) filter.kind = q.kind;
  if (q.method) filter.method = q.method;
  if (restrictMemberId) filter.memberId = restrictMemberId;
  else if (q.memberId && ObjectId.isValid(q.memberId)) filter.memberId = new ObjectId(q.memberId);
  const d: Record<string, Date> = {};
  if (q.from) d.$gte = q.from;
  if (q.to) d.$lte = q.to;
  if (Object.keys(d).length) filter.date = d;
  const [items, total, sum] = await Promise.all([
    c.payments.find(filter).sort({ date: -1, _id: -1 }).skip((q.page - 1) * q.pageSize).limit(q.pageSize).toArray(),
    c.payments.countDocuments(filter),
    c.payments.aggregate<{ t: number }>([{ $match: filter }, { $group: { _id: null, t: { $sum: "$amountPaise" } } }]).toArray(),
  ]);
  const accounts = await c.financialAccounts.find({ organizationId: ctx.orgId }, { projection: { name: 1 } }).toArray();
  const am = new Map(accounts.map((a) => [a._id.toHexString(), a.name]));
  return {
    items: items.map((p) => ({ ...p, accountName: p.accountId ? am.get(p.accountId.toHexString()) ?? null : null })),
    total,
    totalAmountPaise: sum[0]?.t ?? 0,
    page: q.page,
    pageSize: q.pageSize,
  };
}

export async function getPayment(ctx: OrgContext, id: ObjectId, restrictMemberId?: ObjectId) {
  const c = await cols();
  const p = await c.payments.findOne({ _id: id, organizationId: ctx.orgId });
  if (!p || (restrictMemberId && !p.memberId?.equals(restrictMemberId))) throw notFound("Payment");
  const insts = await c.installments
    .find({ _id: { $in: p.allocations.map((a) => a.installmentId) } }, { projection: { periodLabel: 1, dueDate: 1, amountPaise: 1, paidPaise: 1, schemeId: 1 } })
    .toArray();
  return { payment: p, installments: insts };
}
