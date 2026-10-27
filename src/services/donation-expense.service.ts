import { formatMoney } from "@/lib/currency";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { cols } from "@/lib/collections";
import { withTransaction } from "@/lib/db";
import { audit } from "@/lib/audit";
import { badRequest, conflict, forbidden, isDuplicateKeyError, notFound } from "@/lib/errors";
import { todayIn } from "@/lib/dates";
import type { OrgContext } from "@/lib/auth";
import type { DonationDoc, ExpenseDoc } from "@/types/models";
import { dateOnly, idempotencyKey, money, optText } from "@/validators/common";
import { INCOME_KEYS, REIMBURSEMENTS_PAYABLE, expenseKey, faKey, postTransaction, reverseTransaction } from "./ledger.service";
import { balanceOf, requireAccount } from "./account.service";
import { cancelReceiptFor, issueReceipt } from "./receipt.service";
import { notify, notifyRoles } from "./notification.service";

/* ================================================================ donations */

export const DonationSchema = z.object({
  donorName: z.string().trim().min(2).max(120),
  memberId: z.string().optional().nullable(),
  donorPhone: optText(20),
  amount: money(),
  date: dateOnly,
  method: z.string().min(2).max(30),
  reference: optText(100),
  accountId: z.string(),
  purpose: optText(200),
  eventName: optText(120),
  notes: optText(500),
  idempotencyKey,
});

export const ListQuery = z.object({
  status: z.string().optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  eventName: z.string().optional(),
  categoryKey: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

export async function recordDonation(ctx: OrgContext, input: z.infer<typeof DonationSchema>) {
  if (!ctx.org.settings.paymentMethods.includes(input.method)) throw badRequest(`Payment method "${input.method}" is not enabled`);
  const c = await cols();
  const existing = await c.donations.findOne({ organizationId: ctx.orgId, idempotencyKey: input.idempotencyKey });
  if (existing) return { donation: existing, duplicate: true };
  const account = await requireAccount(ctx.orgId, input.accountId);
  let memberId: ObjectId | null = null;
  if (input.memberId) {
    const m = await c.members.findOne({ _id: new ObjectId(input.memberId), organizationId: ctx.orgId });
    if (!m) throw notFound("Member");
    memberId = m._id;
  }
  const now = new Date();
  const doc: DonationDoc = {
    _id: new ObjectId(),
    organizationId: ctx.orgId,
    donorName: input.donorName,
    memberId,
    donorPhone: input.donorPhone,
    amountPaise: input.amount,
    date: input.date,
    method: input.method,
    reference: input.reference,
    accountId: account._id,
    purpose: input.purpose,
    eventName: input.eventName,
    notes: input.notes,
    status: "pending",
    idempotencyKey: input.idempotencyKey,
    recordedBy: ctx.user._id,
    createdAt: now,
    updatedAt: now,
  };
  const autoVerify = !ctx.org.settings.requirePaymentVerification || ctx.can("payments.verify");
  try {
    const out = await withTransaction(async (session) => {
      await c.donations.insertOne(doc, { session });
      if (autoVerify) return verifyDonationInSession(ctx, doc._id, session);
      return doc;
    });
    return { donation: out, duplicate: false };
  } catch (e) {
    if (isDuplicateKeyError(e)) {
      const d = await c.donations.findOne({ organizationId: ctx.orgId, idempotencyKey: input.idempotencyKey });
      if (d) return { donation: d, duplicate: true };
    }
    throw e;
  }
}

async function verifyDonationInSession(ctx: OrgContext, id: ObjectId, session: import("mongodb").ClientSession): Promise<DonationDoc> {
  const c = await cols();
  const d = await c.donations.findOne({ _id: id, organizationId: ctx.orgId }, { session });
  if (!d) throw notFound("Donation");
  const now = new Date();
  const claimed = await c.donations.updateOne({ _id: id, status: "pending" }, { $set: { status: "verified", verifiedBy: ctx.user._id, verifiedAt: now, updatedAt: now } }, { session });
  if (claimed.modifiedCount !== 1) throw conflict("Donation already processed");
  const txn = await postTransaction(
    {
      org: ctx.org,
      type: "donation",
      date: d.date,
      description: `Donation from ${d.donorName}${d.purpose ? ` — ${d.purpose}` : ""}`,
      lines: [
        { accountKey: faKey(d.accountId), debitPaise: d.amountPaise },
        { accountKey: INCOME_KEYS.donation, creditPaise: d.amountPaise },
      ],
      createdBy: ctx.user._id,
      memberId: d.memberId,
      eventName: d.eventName,
      sourceType: "donation",
      sourceId: d._id,
    },
    session,
  );
  const receipt = await issueReceipt(
    ctx.org,
    {
      sourceType: "donation",
      sourceId: d._id,
      memberId: d.memberId,
      payerName: d.donorName,
      amountPaise: d.amountPaise,
      date: d.date,
      method: d.method,
      reference: d.reference,
      lines: [{ description: `Donation${d.purpose ? ` — ${d.purpose}` : ""}${d.eventName ? ` (${d.eventName})` : ""}`, amountPaise: d.amountPaise }],
      issuedBy: ctx.user._id,
    },
    session,
  );
  await c.donations.updateOne({ _id: id }, { $set: { transactionId: txn._id, receiptId: receipt._id } }, { session });
  await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "donation.verify", entityType: "donation", entityId: id, after: { amountPaise: d.amountPaise, receipt: receipt.receiptNumber } }, session);
  return { ...d, status: "verified", transactionId: txn._id, receiptId: receipt._id };
}

export async function verifyDonation(ctx: OrgContext, id: ObjectId) {
  return withTransaction((s) => verifyDonationInSession(ctx, id, s));
}

export async function reverseDonation(ctx: OrgContext, id: ObjectId, reasonText: string) {
  const c = await cols();
  const today = todayIn(ctx.org.settings.timezone);
  return withTransaction(async (session) => {
    const d = await c.donations.findOne({ _id: id, organizationId: ctx.orgId }, { session });
    if (!d) throw notFound("Donation");
    if (d.status === "pending") {
      await c.donations.updateOne({ _id: id, status: "pending" }, { $set: { status: "rejected", reversalReason: reasonText, updatedAt: new Date() } }, { session });
      return { status: "rejected" };
    }
    if (d.status !== "verified" || !d.transactionId) throw conflict("Only verified donations can be reversed");
    const claimed = await c.donations.updateOne({ _id: id, status: "verified" }, { $set: { status: "reversed", reversalReason: reasonText, updatedAt: new Date() } }, { session });
    if (claimed.modifiedCount !== 1) throw conflict("Donation already reversed");
    const rev = await reverseTransaction(ctx.org, d.transactionId, reasonText, ctx.user._id, today, session);
    await c.donations.updateOne({ _id: id }, { $set: { reversalTransactionId: rev._id } }, { session });
    await cancelReceiptFor(ctx.orgId, "donation", id, session);
    await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "donation.reverse", entityType: "donation", entityId: id, reason: reasonText }, session);
    return { status: "reversed" };
  });
}

export async function listDonations(ctx: OrgContext, q: z.infer<typeof ListQuery>) {
  const c = await cols();
  const filter: Record<string, unknown> = { organizationId: ctx.orgId };
  if (q.status) filter.status = q.status;
  if (q.eventName) filter.eventName = q.eventName;
  const d: Record<string, Date> = {};
  if (q.from) d.$gte = q.from;
  if (q.to) d.$lte = q.to;
  if (Object.keys(d).length) filter.date = d;
  const [items, total, sum] = await Promise.all([
    c.donations.find(filter).sort({ date: -1, _id: -1 }).skip((q.page - 1) * q.pageSize).limit(q.pageSize).toArray(),
    c.donations.countDocuments(filter),
    c.donations.aggregate<{ t: number }>([{ $match: { ...filter, status: "verified" } }, { $group: { _id: null, t: { $sum: "$amountPaise" } } }]).toArray(),
  ]);
  return { items, total, verifiedTotalPaise: sum[0]?.t ?? 0, page: q.page, pageSize: q.pageSize };
}

/* ================================================================ expenses */

export const ExpenseSchema = z
  .object({
    categoryKey: z.string().min(2).max(40),
    payeeName: z.string().trim().min(2).max(120),
    description: z.string().trim().min(2).max(500),
    amount: money(),
    date: dateOnly,
    method: z.string().min(2).max(30),
    reference: optText(100),
    paidBy: z.enum(["organization", "out_of_pocket"]).default("organization"),
    accountId: z.string().optional().nullable(),
    reimburseToMemberId: z.string().optional().nullable(),
    eventName: optText(120),
    attachments: z
      .array(z.object({ url: z.string().url(), name: z.string().max(200), contentType: z.string().max(100), size: z.number().int().min(0) }))
      .max(10)
      .optional(),
    idempotencyKey,
  })
  .superRefine((v, ctx) => {
    if (v.paidBy === "organization" && !v.accountId) ctx.addIssue({ code: "custom", path: ["accountId"], message: "Choose the account the money was paid from" });
  });

/**
 * Submit an expense. It is finalized (posted to the ledger) immediately only when the
 * submitter can approve expenses and the amount is within the approval threshold
 * (or the submitter is an admin); otherwise it waits for approval.
 */
export async function submitExpense(ctx: OrgContext, input: z.infer<typeof ExpenseSchema>) {
  const cat = ctx.org.settings.expenseCategories.find((x) => x.key === input.categoryKey && x.isActive);
  if (!cat) throw badRequest("Choose a valid expense category");
  if (!ctx.org.settings.paymentMethods.includes(input.method)) throw badRequest(`Payment method "${input.method}" is not enabled`);
  const c = await cols();
  const existing = await c.expenses.findOne({ organizationId: ctx.orgId, idempotencyKey: input.idempotencyKey });
  if (existing) return { expense: existing, duplicate: true };
  if (input.paidBy === "organization") await requireAccount(ctx.orgId, input.accountId!);
  const now = new Date();
  const doc: ExpenseDoc = {
    _id: new ObjectId(),
    organizationId: ctx.orgId,
    categoryKey: input.categoryKey,
    payeeName: input.payeeName,
    description: input.description,
    amountPaise: input.amount,
    date: input.date,
    method: input.method,
    reference: input.reference,
    accountId: input.paidBy === "organization" ? new ObjectId(input.accountId!) : null,
    paidBy: input.paidBy,
    reimburseToMemberId: input.reimburseToMemberId && ObjectId.isValid(input.reimburseToMemberId) ? new ObjectId(input.reimburseToMemberId) : null,
    reimbursement: input.paidBy === "out_of_pocket" ? { status: "pending" } : undefined,
    eventName: input.eventName,
    attachments: input.attachments,
    status: "pending",
    idempotencyKey: input.idempotencyKey,
    submittedBy: ctx.user._id,
    createdAt: now,
    updatedAt: now,
  };
  const threshold = ctx.org.settings.expenseApprovalThresholdPaise;
  // Admins finalize immediately; approvers finalize immediately only within the threshold.
  const autoApprove = ctx.role === "admin" || (ctx.can("expenses.approve") && threshold > 0 && input.amount <= threshold);
  try {
    const out = await withTransaction(async (session) => {
      await c.expenses.insertOne(doc, { session });
      await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "expense.submit", entityType: "expense", entityId: doc._id, after: { amountPaise: doc.amountPaise, category: doc.categoryKey } }, session);
      if (autoApprove) return approveInSession(ctx, doc._id, session);
      return doc;
    });
    if (out.status === "pending") {
      await notifyRoles(ctx.orgId, ["admin"], {
        type: "expense.pending",
        title: "Expense awaiting approval",
        body: `${formatMoney(doc.amountPaise, ctx.org.settings.currency)} to ${doc.payeeName} (${cat.name}) needs approval.`,
        link: `/org/${ctx.orgId}/expenses?status=pending`,
        dedupeKey: `expense-pending:${doc._id}`,
      });
    }
    return { expense: out, duplicate: false };
  } catch (e) {
    if (isDuplicateKeyError(e)) {
      const x = await c.expenses.findOne({ organizationId: ctx.orgId, idempotencyKey: input.idempotencyKey });
      if (x) return { expense: x, duplicate: true };
    }
    throw e;
  }
}

async function approveInSession(ctx: OrgContext, id: ObjectId, session: import("mongodb").ClientSession): Promise<ExpenseDoc> {
  const c = await cols();
  const e = await c.expenses.findOne({ _id: id, organizationId: ctx.orgId }, { session });
  if (!e) throw notFound("Expense");
  if (e.status !== "pending") throw conflict(`Expense is already ${e.status}`);
  const threshold = ctx.org.settings.expenseApprovalThresholdPaise;
  if (ctx.role !== "admin" && threshold > 0 && e.amountPaise > threshold) throw forbidden(`Expenses above ${formatMoney(threshold, ctx.org.settings.currency)} need admin approval`);
  const now = new Date();
  const claimed = await c.expenses.updateOne({ _id: id, status: "pending" }, { $set: { status: "approved", approvedBy: ctx.user._id, approvedAt: now, updatedAt: now } }, { session });
  if (claimed.modifiedCount !== 1) throw conflict("Expense already processed");
  let creditKey: string;
  if (e.paidBy === "organization") {
    const fa = await requireAccount(ctx.orgId, e.accountId!, session);
    const bal = await balanceOf(ctx.orgId, fa._id, session);
    if (bal < e.amountPaise) throw badRequest(`Insufficient balance in ${fa.name} (${formatMoney(bal, ctx.org.settings.currency)})`);
    creditKey = faKey(fa._id);
  } else {
    creditKey = REIMBURSEMENTS_PAYABLE;
  }
  const txn = await postTransaction(
    {
      org: ctx.org,
      type: "expense",
      date: e.date,
      description: `${e.description} — ${e.payeeName}`,
      lines: [
        { accountKey: expenseKey(e.categoryKey), debitPaise: e.amountPaise },
        { accountKey: creditKey, creditPaise: e.amountPaise },
      ],
      createdBy: ctx.user._id,
      eventName: e.eventName,
      sourceType: "expense",
      sourceId: e._id,
    },
    session,
  );
  await c.expenses.updateOne({ _id: id }, { $set: { transactionId: txn._id } }, { session });
  await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "expense.approve", entityType: "expense", entityId: id, after: { transaction: txn.number } }, session);
  return { ...e, status: "approved", approvedBy: ctx.user._id, approvedAt: now, transactionId: txn._id };
}

export async function approveExpense(ctx: OrgContext, id: ObjectId) {
  const e = await withTransaction((s) => approveInSession(ctx, id, s));
  if (!e.submittedBy.equals(ctx.user._id)) {
    await notify({ organizationId: ctx.orgId, userId: e.submittedBy, type: "expense.approved", title: "Expense approved", body: `${formatMoney(e.amountPaise, ctx.org.settings.currency)} to ${e.payeeName} was approved.`, link: `/org/${ctx.orgId}/expenses`, dedupeKey: `expense-approved:${id}` });
  }
  return e;
}

export async function rejectExpense(ctx: OrgContext, id: ObjectId, reasonText: string) {
  const c = await cols();
  const e = await c.expenses.findOneAndUpdate(
    { _id: id, organizationId: ctx.orgId, status: "pending" },
    { $set: { status: "rejected", rejectedBy: ctx.user._id, rejectionReason: reasonText, updatedAt: new Date() } },
    { returnDocument: "after" },
  );
  if (!e) throw conflict("Only pending expenses can be rejected");
  await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "expense.reject", entityType: "expense", entityId: id, reason: reasonText });
  await notify({ organizationId: ctx.orgId, userId: e.submittedBy, type: "expense.rejected", title: "Expense rejected", body: `${formatMoney(e.amountPaise, ctx.org.settings.currency)} to ${e.payeeName}: ${reasonText}`, link: `/org/${ctx.orgId}/expenses`, dedupeKey: `expense-rejected:${id}` });
  return e;
}

export const ReimburseSchema = z.object({ accountId: z.string(), date: dateOnly, reference: optText(100) });

/** Pay back an approved out-of-pocket expense: Dr reimbursements payable, Cr account. */
export async function reimburseExpense(ctx: OrgContext, id: ObjectId, input: z.infer<typeof ReimburseSchema>) {
  const c = await cols();
  return withTransaction(async (session) => {
    const e = await c.expenses.findOne({ _id: id, organizationId: ctx.orgId }, { session });
    if (!e) throw notFound("Expense");
    if (e.status !== "approved" || e.paidBy !== "out_of_pocket" || e.reimbursement?.status !== "pending") throw badRequest("This expense is not awaiting reimbursement");
    const fa = await requireAccount(ctx.orgId, input.accountId, session);
    const bal = await balanceOf(ctx.orgId, fa._id, session);
    if (bal < e.amountPaise) throw badRequest(`Insufficient balance in ${fa.name}`);
    const claimed = await c.expenses.updateOne({ _id: id, "reimbursement.status": "pending" }, { $set: { "reimbursement.status": "reimbursed" } }, { session });
    if (claimed.modifiedCount !== 1) throw conflict("Already reimbursed");
    const txn = await postTransaction(
      {
        org: ctx.org,
        type: "expense_reimbursement",
        date: input.date,
        description: `Reimbursement to ${e.payeeName}: ${e.description}`,
        lines: [
          { accountKey: REIMBURSEMENTS_PAYABLE, debitPaise: e.amountPaise },
          { accountKey: faKey(fa._id), creditPaise: e.amountPaise },
        ],
        createdBy: ctx.user._id,
        sourceType: "expense",
        sourceId: e._id,
      },
      session,
    );
    await c.expenses.updateOne({ _id: id }, { $set: { reimbursement: { status: "reimbursed", transactionId: txn._id, accountId: fa._id, at: new Date() }, updatedAt: new Date() } }, { session });
    await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "expense.reimburse", entityType: "expense", entityId: id, after: { transaction: txn.number } }, session);
    return { ok: true };
  });
}

export async function reverseExpense(ctx: OrgContext, id: ObjectId, reasonText: string) {
  const c = await cols();
  const today = todayIn(ctx.org.settings.timezone);
  return withTransaction(async (session) => {
    const e = await c.expenses.findOne({ _id: id, organizationId: ctx.orgId }, { session });
    if (!e) throw notFound("Expense");
    if (e.status !== "approved" || !e.transactionId) throw conflict("Only approved expenses can be reversed");
    if (e.reimbursement?.status === "reimbursed") throw badRequest("Reverse the reimbursement first");
    const claimed = await c.expenses.updateOne({ _id: id, status: "approved" }, { $set: { status: "reversed", reversalReason: reasonText, updatedAt: new Date() } }, { session });
    if (claimed.modifiedCount !== 1) throw conflict("Already reversed");
    const rev = await reverseTransaction(ctx.org, e.transactionId, reasonText, ctx.user._id, today, session);
    await c.expenses.updateOne({ _id: id }, { $set: { reversalTransactionId: rev._id } }, { session });
    await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "expense.reverse", entityType: "expense", entityId: id, reason: reasonText }, session);
    return { ok: true };
  });
}

export async function listExpenses(ctx: OrgContext, q: z.infer<typeof ListQuery>) {
  const c = await cols();
  const filter: Record<string, unknown> = { organizationId: ctx.orgId };
  if (q.status) filter.status = q.status;
  if (q.categoryKey) filter.categoryKey = q.categoryKey;
  if (q.eventName) filter.eventName = q.eventName;
  const d: Record<string, Date> = {};
  if (q.from) d.$gte = q.from;
  if (q.to) d.$lte = q.to;
  if (Object.keys(d).length) filter.date = d;
  // Managers without approval rights only see their own pending submissions plus finalized ones.
  const [items, total, sum] = await Promise.all([
    c.expenses.find(filter).sort({ date: -1, _id: -1 }).skip((q.page - 1) * q.pageSize).limit(q.pageSize).toArray(),
    c.expenses.countDocuments(filter),
    c.expenses.aggregate<{ t: number }>([{ $match: { ...filter, status: "approved" } }, { $group: { _id: null, t: { $sum: "$amountPaise" } } }]).toArray(),
  ]);
  const users = await c.users.find({ _id: { $in: items.map((i) => i.submittedBy) } }, { projection: { name: 1 } }).toArray();
  const um = new Map(users.map((u) => [u._id.toHexString(), u.name]));
  return { items: items.map((i) => ({ ...i, submittedByName: um.get(i.submittedBy.toHexString()) ?? null })), total, approvedTotalPaise: sum[0]?.t ?? 0, page: q.page, pageSize: q.pageSize };
}

