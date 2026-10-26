import { ObjectId, type ClientSession } from "mongodb";
import { cols } from "@/lib/collections";
import { assertPaise } from "@/lib/money";
import { financialYear } from "@/lib/dates";
import { badRequest, conflict, notFound } from "@/lib/errors";
import type { FinancialTransactionDoc, LedgerEntryDoc, OrganizationDoc, TransactionType } from "@/types/models";

/**
 * Double-entry ledger.
 *
 * Account keys:
 *   fa:<financialAccountId>        Asset  – cash / bank / UPI accounts owned by the org
 *   asset:loans_receivable         Asset  – principal lent to members
 *   liability:reimbursements_payable  Liability – expenses paid out-of-pocket, owed back
 *   equity:opening_balance         Equity – opening balances brought forward
 *   equity:adjustments             Equity – authorised corrections
 *   income:<kind>                  Income – hapta, donation, interest, penalty, membership_fee, event, other
 *   expense:<categoryKey>          Expense
 *
 * The organization uses cash-basis recognition for contributions: income is recorded
 * when money is actually received and verified. Loan principal is an asset (not an
 * expense) and repaid principal is not income; only interest and penalties are income.
 */

export type AccountClass = "asset" | "liability" | "equity" | "income" | "expense";

export const INCOME_KEYS = {
  hapta: "income:hapta",
  donation: "income:donation",
  interest: "income:interest",
  penalty: "income:penalty",
  membership_fee: "income:membership_fee",
  event: "income:event",
  other: "income:other",
} as const;

export const LOANS_RECEIVABLE = "asset:loans_receivable";
export const REIMBURSEMENTS_PAYABLE = "liability:reimbursements_payable";
/** Money owed to members: their hapta savings + interest credited − withdrawals */
export const MEMBER_FUNDS = "liability:member_funds";
export const MEMBER_INTEREST_EXPENSE = "expense:member_interest";
/** Money lent to members out of the Mandal fund (interest-only loans). */
export const FUND_LOANS = "asset:fund_loans";
export const OPENING_EQUITY = "equity:opening_balance";
export const ADJUSTMENT_EQUITY = "equity:adjustments";

export const faKey = (id: ObjectId) => `fa:${id.toHexString()}`;
export const expenseKey = (cat: string) => `expense:${cat}`;

export function accountClass(key: string): AccountClass {
  if (key.startsWith("fa:") || key.startsWith("asset:")) return "asset";
  if (key.startsWith("liability:")) return "liability";
  if (key.startsWith("equity:")) return "equity";
  if (key.startsWith("income:")) return "income";
  if (key.startsWith("expense:")) return "expense";
  throw new Error(`Unknown ledger account ${key}`);
}

/** Balance in the account's normal direction (assets/expenses debit-positive). */
export function normalBalance(key: string, debit: number, credit: number): number {
  const cls = accountClass(key);
  return cls === "asset" || cls === "expense" ? debit - credit : credit - debit;
}

const LABELS: Record<string, string> = {
  "asset:loans_receivable": "Loans receivable",
  "asset:fund_loans": "Upad given (loans from the fund)",
  "liability:reimbursements_payable": "Reimbursements payable",
  "liability:member_funds": "Member balances (owed to members)",
  "expense:member_interest": "Interest credited to members",
  "equity:opening_balance": "Opening balance equity",
  "equity:adjustments": "Adjustments",
  "income:hapta": "Hapta collections",
  "income:donation": "Donations",
  "income:interest": "Interest income",
  "income:penalty": "Late fees & penalties",
  "income:membership_fee": "Membership fees",
  "income:event": "Event collections",
  "income:other": "Other income",
};

export async function accountLabels(org: OrganizationDoc): Promise<Record<string, string>> {
  const c = await cols();
  const fas = await c.financialAccounts.find({ organizationId: org._id }, { projection: { name: 1 } }).toArray();
  const out: Record<string, string> = { ...LABELS };
  for (const fa of fas) out[faKey(fa._id)] = fa.name;
  for (const cat of org.settings.expenseCategories) out[expenseKey(cat.key)] = cat.name;
  return out;
}

export interface LedgerLine {
  accountKey: string;
  debitPaise?: number;
  creditPaise?: number;
  memberId?: ObjectId | null;
}

export interface PostInput {
  org: Pick<OrganizationDoc, "_id" | "settings">;
  type: TransactionType;
  date: Date;
  description: string;
  lines: LedgerLine[];
  createdBy: ObjectId;
  memberId?: ObjectId | null;
  eventName?: string;
  sourceType?: FinancialTransactionDoc["sourceType"];
  sourceId?: ObjectId;
  reversalOf?: ObjectId | null;
  reason?: string;
  idempotencyKey?: string;
  /** set on reversals */
  originalType?: TransactionType;
}

export function validateLines(lines: LedgerLine[]) {
  if (lines.length < 2) throw badRequest("A transaction needs at least two ledger lines");
  let dr = 0;
  let cr = 0;
  for (const l of lines) {
    const d = l.debitPaise ?? 0;
    const c = l.creditPaise ?? 0;
    assertPaise(d, "debit");
    assertPaise(c, "credit");
    if (d < 0 || c < 0) throw badRequest("Ledger amounts cannot be negative");
    if ((d > 0) === (c > 0)) throw badRequest("Each ledger line must be either a debit or a credit");
    accountClass(l.accountKey);
    dr += d;
    cr += c;
  }
  if (dr !== cr) throw new Error(`Unbalanced transaction: debits ${dr} != credits ${cr}`);
  return dr;
}

export async function nextNumber(
  orgId: ObjectId,
  name: string,
  session?: ClientSession,
): Promise<number> {
  const c = await cols();
  const r = await c.counters.findOneAndUpdate(
    { _id: `${orgId.toHexString()}:${name}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after", session },
  );
  return r!.seq;
}

export async function fyNumber(
  org: Pick<OrganizationDoc, "_id" | "settings">,
  prefix: string,
  date: Date,
  session?: ClientSession,
) {
  const fy = financialYear(date, org.settings.financialYearStartMonth);
  const seq = await nextNumber(org._id, `${prefix}:${fy.label}`, session);
  return `${prefix}/${fy.label}/${String(seq).padStart(6, "0")}`;
}

/** Post a balanced journal entry. Must be called inside a MongoDB transaction. */
export async function postTransaction(input: PostInput, session: ClientSession): Promise<FinancialTransactionDoc> {
  const amount = validateLines(input.lines);
  const c = await cols();
  const now = new Date();
  const txn: FinancialTransactionDoc = {
    _id: new ObjectId(),
    organizationId: input.org._id,
    number: await fyNumber(input.org, "TXN", input.date, session),
    type: input.type,
    date: input.date,
    amountPaise: amount,
    description: input.description,
    memberId: input.memberId ?? null,
    eventName: input.eventName,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    reversalOf: input.reversalOf ?? null,
    reversedBy: null,
    reason: input.reason,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    createdBy: input.createdBy,
    createdAt: now,
  };
  await c.financialTransactions.insertOne(txn, { session });
  const entries: LedgerEntryDoc[] = input.lines.map((l) => ({
    _id: new ObjectId(),
    organizationId: input.org._id,
    transactionId: txn._id,
    date: input.date,
    accountKey: l.accountKey,
    financialAccountId: l.accountKey.startsWith("fa:") ? new ObjectId(l.accountKey.slice(3)) : null,
    debitPaise: l.debitPaise ?? 0,
    creditPaise: l.creditPaise ?? 0,
    memberId: l.memberId ?? input.memberId ?? null,
    transactionType: input.type,
    ...(input.originalType ? { originalType: input.originalType } : {}),
    createdAt: now,
  }));
  await c.ledgerEntries.insertMany(entries, { session });
  return txn;
}

/**
 * Reverse a finalized transaction by posting the mirror entry. The original is
 * kept untouched except for the `reversedBy` pointer (set exactly once).
 */
export async function reverseTransaction(
  org: Pick<OrganizationDoc, "_id" | "settings">,
  transactionId: ObjectId,
  reasonText: string,
  by: ObjectId,
  date: Date,
  session: ClientSession,
): Promise<FinancialTransactionDoc> {
  const c = await cols();
  const original = await c.financialTransactions.findOne({ _id: transactionId, organizationId: org._id }, { session });
  if (!original) throw notFound("Transaction");
  if (original.type === "reversal") throw badRequest("A reversal cannot itself be reversed");
  const lines = await c.ledgerEntries.find({ transactionId, organizationId: org._id }, { session }).toArray();
  const reversalId = new ObjectId();
  const claimed = await c.financialTransactions.updateOne(
    { _id: transactionId, organizationId: org._id, reversedBy: null },
    { $set: { reversedBy: reversalId } },
    { session },
  );
  if (claimed.modifiedCount !== 1) throw conflict("This transaction has already been reversed");
  const rev = await postTransaction(
    {
      org,
      type: "reversal",
      date,
      description: `Reversal of ${original.number}: ${original.description}`,
      lines: lines.map((l) => ({
        accountKey: l.accountKey,
        debitPaise: l.creditPaise || undefined,
        creditPaise: l.debitPaise || undefined,
        memberId: l.memberId,
      })),
      createdBy: by,
      memberId: original.memberId,
      eventName: original.eventName,
      sourceType: original.sourceType,
      sourceId: original.sourceId,
      reversalOf: original._id,
      reason: reasonText,
      originalType: original.type,
    },
    session,
  );
  // postTransaction generated its own id; point the original at the real reversal.
  await c.financialTransactions.updateOne({ _id: transactionId }, { $set: { reversedBy: rev._id } }, { session });
  return rev;
}

export interface AccountBalanceRow {
  accountKey: string;
  debitPaise: number;
  creditPaise: number;
  balancePaise: number;
}

/** Aggregated debit/credit totals per ledger account (optionally up to and including `asOf`). */
export async function accountBalances(
  orgId: ObjectId,
  opts: { asOf?: Date; from?: Date; prefix?: string } = {},
): Promise<AccountBalanceRow[]> {
  const c = await cols();
  const match: Record<string, unknown> = { organizationId: orgId };
  const date: Record<string, Date> = {};
  if (opts.asOf) date.$lte = opts.asOf;
  if (opts.from) date.$gte = opts.from;
  if (Object.keys(date).length) match.date = date;
  if (opts.prefix) match.accountKey = { $regex: `^${opts.prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` };
  const rows = await c.ledgerEntries
    .aggregate<{ _id: string; debit: number; credit: number }>([
      { $match: match },
      { $group: { _id: "$accountKey", debit: { $sum: "$debitPaise" }, credit: { $sum: "$creditPaise" } } },
      { $sort: { _id: 1 } },
    ])
    .toArray();
  return rows.map((r) => ({
    accountKey: r._id,
    debitPaise: r.debit,
    creditPaise: r.credit,
    balancePaise: normalBalance(r._id, r.debit, r.credit),
  }));
}
