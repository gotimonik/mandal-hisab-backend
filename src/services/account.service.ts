import { ObjectId, type ClientSession } from "mongodb";
import { z } from "zod";
import { cols } from "@/lib/collections";
import { withTransaction } from "@/lib/db";
import { audit } from "@/lib/audit";
import { badRequest, conflict, isDuplicateKeyError, notFound } from "@/lib/errors";
import { todayIn } from "@/lib/dates";
import type { OrgContext } from "@/lib/auth";
import type { FinancialAccountDoc } from "@/types/models";
import { dateOnly, idempotencyKey, money, optText, reason } from "@/validators/common";
import {
  ADJUSTMENT_EQUITY,
  OPENING_EQUITY,
  accountBalances,
  faKey,
  postTransaction,
  reverseTransaction,
} from "./ledger.service";

export const AccountInputSchema = z.object({
  name: z.string().trim().min(2).max(80),
  type: z.enum(["cash", "bank", "upi", "other"]),
  bankName: optText(100),
  accountNumberLast4: z
    .string()
    .regex(/^\d{4}$/, "Only the last 4 digits")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  ifsc: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, "Invalid IFSC")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  upiId: optText(100),
  openingBalance: money({ allowZero: true }).default(0),
  openingDate: dateOnly.optional(),
});

export const TransferSchema = z.object({
  fromAccountId: z.string(),
  toAccountId: z.string(),
  amount: money(),
  date: dateOnly,
  reference: optText(100),
  notes: optText(300),
  idempotencyKey,
});

export const AdjustmentSchema = z.object({
  accountId: z.string(),
  direction: z.enum(["increase", "decrease"]),
  amount: money(),
  date: dateOnly,
  reason,
  idempotencyKey,
});

export async function requireAccount(orgId: ObjectId, id: string | ObjectId, session?: ClientSession): Promise<FinancialAccountDoc> {
  const c = await cols();
  if (typeof id === "string" && !ObjectId.isValid(id)) throw badRequest("Invalid account");
  const fa = await c.financialAccounts.findOne({ _id: new ObjectId(id), organizationId: orgId }, { session });
  if (!fa) throw notFound("Account");
  if (!fa.isActive) throw badRequest(`Account "${fa.name}" is inactive`);
  return fa;
}

export async function createAccount(ctx: OrgContext, input: z.infer<typeof AccountInputSchema>) {
  const c = await cols();
  const now = new Date();
  const doc: FinancialAccountDoc = {
    _id: new ObjectId(),
    organizationId: ctx.orgId,
    name: input.name,
    type: input.type,
    bankName: input.bankName,
    accountNumberLast4: input.accountNumberLast4,
    ifsc: input.ifsc,
    upiId: input.upiId,
    openingBalancePaise: input.openingBalance,
    openingDate: input.openingDate ?? todayIn(ctx.org.settings.timezone),
    isActive: true,
    createdBy: ctx.user._id,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await withTransaction(async (session) => {
      await c.financialAccounts.insertOne(doc, { session });
      if (doc.openingBalancePaise > 0) {
        await postTransaction(
          {
            org: ctx.org,
            type: "opening_balance",
            date: doc.openingDate,
            description: `Opening balance — ${doc.name}`,
            lines: [
              { accountKey: faKey(doc._id), debitPaise: doc.openingBalancePaise },
              { accountKey: OPENING_EQUITY, creditPaise: doc.openingBalancePaise },
            ],
            createdBy: ctx.user._id,
            sourceType: "account",
            sourceId: doc._id,
          },
          session,
        );
      }
      await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "account.create", entityType: "financialAccount", entityId: doc._id, after: doc }, session);
    });
  } catch (e) {
    if (isDuplicateKeyError(e)) throw conflict("An account with this name already exists");
    throw e;
  }
  return doc;
}

export async function updateAccount(ctx: OrgContext, id: ObjectId, input: { name?: string; isActive?: boolean; bankName?: string; upiId?: string }) {
  const c = await cols();
  const fa = await c.financialAccounts.findOne({ _id: id, organizationId: ctx.orgId });
  if (!fa) throw notFound("Account");
  if (input.isActive === false) {
    const [bal] = await accountBalances(ctx.orgId, { prefix: faKey(id) });
    if (bal && bal.balancePaise !== 0) throw badRequest("Transfer the balance out before deactivating this account");
  }
  const $set: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(input)) if (v !== undefined) $set[k] = v;
  try {
    await c.financialAccounts.updateOne({ _id: id, organizationId: ctx.orgId }, { $set });
  } catch (e) {
    if (isDuplicateKeyError(e)) throw conflict("An account with this name already exists");
    throw e;
  }
  await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "account.update", entityType: "financialAccount", entityId: id, before: { name: fa.name, isActive: fa.isActive }, after: input });
  return { ok: true };
}

/** Accounts with balances computed from the ledger (never stored/editable). */
export async function listAccounts(ctx: OrgContext, asOf?: Date) {
  const c = await cols();
  const [accounts, balances] = await Promise.all([
    c.financialAccounts.find({ organizationId: ctx.orgId }).sort({ isActive: -1, name: 1 }).toArray(),
    accountBalances(ctx.orgId, { asOf, prefix: "fa:" }),
  ]);
  const bm = new Map(balances.map((b) => [b.accountKey, b]));
  return accounts.map((a) => {
    const b = bm.get(faKey(a._id));
    return { ...a, balancePaise: b?.balancePaise ?? 0, totalInPaise: b?.debitPaise ?? 0, totalOutPaise: b?.creditPaise ?? 0 };
  });
}

/** Account balance at a point in time (used to stop overdrawing cash). */
export async function balanceOf(orgId: ObjectId, accountId: ObjectId, session?: ClientSession): Promise<number> {
  const c = await cols();
  const [r] = await c.ledgerEntries
    .aggregate<{ d: number; c: number }>(
      [{ $match: { organizationId: orgId, accountKey: faKey(accountId) } }, { $group: { _id: null, d: { $sum: "$debitPaise" }, c: { $sum: "$creditPaise" } } }],
      { session },
    )
    .toArray();
  return r ? r.d - r.c : 0;
}

async function findByKey(orgId: ObjectId, key: string) {
  const c = await cols();
  return c.financialTransactions.findOne({ organizationId: orgId, idempotencyKey: key });
}

/** Run `fn`; if a concurrent request with the same key won the race, return its result. */
async function onceByKey<T>(orgId: ObjectId, key: string, fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (e) {
    if (isDuplicateKeyError(e)) {
      const t = await findByKey(orgId, key);
      if (t) return { transaction: t, duplicate: true } as T;
    }
    throw e;
  }
}

/** Move money between two org-owned accounts. Asset→asset only: never income or expense. */
export async function transfer(ctx: OrgContext, input: z.infer<typeof TransferSchema>) {
  if (input.fromAccountId === input.toAccountId) throw badRequest("Choose two different accounts");
  const existing = await findByKey(ctx.orgId, input.idempotencyKey);
  if (existing) return { transaction: existing, duplicate: true };
  return onceByKey(ctx.orgId, input.idempotencyKey, () => withTransaction(async (session) => {
    const from = await requireAccount(ctx.orgId, input.fromAccountId, session);
    const to = await requireAccount(ctx.orgId, input.toAccountId, session);
    const bal = await balanceOf(ctx.orgId, from._id, session);
    if (bal < input.amount) throw badRequest(`Insufficient balance in ${from.name}`);
    const txn = await postTransaction(
      {
        org: ctx.org,
        type: "transfer",
        date: input.date,
        description: `Transfer ${from.name} → ${to.name}${input.notes ? ` — ${input.notes}` : ""}`,
        lines: [
          { accountKey: faKey(to._id), debitPaise: input.amount },
          { accountKey: faKey(from._id), creditPaise: input.amount },
        ],
        createdBy: ctx.user._id,
        sourceType: "transfer",
        idempotencyKey: input.idempotencyKey,
      },
      session,
    );
    await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "account.transfer", entityType: "financialTransaction", entityId: txn._id, after: { from: from.name, to: to.name, amountPaise: input.amount } }, session);
    return { transaction: txn, duplicate: false };
  }));
}

/** Authorised correction of an account balance via an adjustment entry (with reason). */
export async function adjust(ctx: OrgContext, input: z.infer<typeof AdjustmentSchema>) {
  const existing = await findByKey(ctx.orgId, input.idempotencyKey);
  if (existing) return { transaction: existing, duplicate: true };
  return onceByKey(ctx.orgId, input.idempotencyKey, () => withTransaction(async (session) => {
    const fa = await requireAccount(ctx.orgId, input.accountId, session);
    const inc = input.direction === "increase";
    const txn = await postTransaction(
      {
        org: ctx.org,
        type: "adjustment",
        date: input.date,
        description: `Balance adjustment (${input.direction}) — ${fa.name}`,
        lines: [
          { accountKey: faKey(fa._id), debitPaise: inc ? input.amount : undefined, creditPaise: inc ? undefined : input.amount },
          { accountKey: ADJUSTMENT_EQUITY, debitPaise: inc ? undefined : input.amount, creditPaise: inc ? input.amount : undefined },
        ],
        createdBy: ctx.user._id,
        sourceType: "adjustment",
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      },
      session,
    );
    await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "account.adjustment", entityType: "financialTransaction", entityId: txn._id, after: { account: fa.name, direction: input.direction, amountPaise: input.amount }, reason: input.reason }, session);
    return { transaction: txn, duplicate: false };
  }));
}

/** Reverse a transfer or adjustment (other types are reversed through their source module). */
export async function reverseGeneric(ctx: OrgContext, txnId: ObjectId, reasonText: string) {
  const c = await cols();
  const t = await c.financialTransactions.findOne({ _id: txnId, organizationId: ctx.orgId });
  if (!t) throw notFound("Transaction");
  if (!["transfer", "adjustment", "opening_balance"].includes(t.type) && t.sourceType !== "cashEntry") {
    throw badRequest("Reverse this transaction from its payment, donation, expense or loan screen");
  }
  const today = todayIn(ctx.org.settings.timezone);
  return withTransaction(async (session) => {
    const rev = await reverseTransaction(ctx.org, txnId, reasonText, ctx.user._id, today, session);
    await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "transaction.reverse", entityType: "financialTransaction", entityId: txnId, after: { reversal: rev.number }, reason: reasonText }, session);
    return rev;
  });
}

export const TxnListQuery = z.object({
  type: z.string().optional(),
  accountId: z.string().optional(),
  memberId: z.string().optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export async function listTransactions(ctx: OrgContext, q: z.infer<typeof TxnListQuery>) {
  const c = await cols();
  const filter: Record<string, unknown> = { organizationId: ctx.orgId };
  if (q.type) filter.type = q.type;
  if (q.memberId && ObjectId.isValid(q.memberId)) filter.memberId = new ObjectId(q.memberId);
  const d: Record<string, Date> = {};
  if (q.from) d.$gte = q.from;
  if (q.to) d.$lte = q.to;
  if (Object.keys(d).length) filter.date = d;
  if (q.accountId && ObjectId.isValid(q.accountId)) {
    const ids = await c.ledgerEntries.distinct("transactionId", { organizationId: ctx.orgId, accountKey: faKey(new ObjectId(q.accountId)), ...(filter.date ? { date: filter.date } : {}) });
    filter._id = { $in: ids };
  }
  const [items, total] = await Promise.all([
    c.financialTransactions.find(filter).sort({ date: -1, _id: -1 }).skip((q.page - 1) * q.pageSize).limit(q.pageSize).toArray(),
    c.financialTransactions.countDocuments(filter),
  ]);
  const lines = await c.ledgerEntries.find({ organizationId: ctx.orgId, transactionId: { $in: items.map((i) => i._id) } }).toArray();
  const byTxn = new Map<string, typeof lines>();
  for (const l of lines) {
    const k = l.transactionId.toHexString();
    if (!byTxn.has(k)) byTxn.set(k, []);
    byTxn.get(k)!.push(l);
  }
  return {
    items: items.map((t) => ({
      ...t,
      lines: (byTxn.get(t._id.toHexString()) ?? []).map((l) => ({ accountKey: l.accountKey, debitPaise: l.debitPaise, creditPaise: l.creditPaise })),
    })),
    total,
    page: q.page,
    pageSize: q.pageSize,
  };
}
