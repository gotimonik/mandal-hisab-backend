import { formatMoney } from "@/lib/currency";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { cols } from "@/lib/collections";
import { withTransaction } from "@/lib/db";
import { audit } from "@/lib/audit";
import { badRequest, isDuplicateKeyError } from "@/lib/errors";
import { financialYear, todayIn } from "@/lib/dates";
import type { OrgContext } from "@/lib/auth";
import type { TransactionType } from "@/types/models";
import { dateOnly, idempotencyKey, money } from "@/validators/common";
import { INCOME_KEYS, expenseKey, faKey, postTransaction } from "./ledger.service";
import { balanceOf, requireAccount } from "./account.service";

/**
 * Cash book: what the Mandal physically holds. Built only from ledger lines on its
 * cash/bank/UPI accounts — i.e. money actually received or paid — never from expected
 * installments or member balances.
 */

export const CashBookQuery = z.object({
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  accountId: z.string().optional(),
});

const CATEGORY: Record<string, { label: string; side: "in" | "out" | "both" }> = {
  hapta_collection: { label: "Hapta collected", side: "in" },
  other_income: { label: "Other cash receipts", side: "in" },
  donation: { label: "Donations", side: "in" },
  loan_repayment: { label: "Loan repayments received", side: "in" },
  withdrawal: { label: "Withdrawals paid to members", side: "out" },
  expense: { label: "Expenses paid", side: "out" },
  expense_reimbursement: { label: "Reimbursements paid", side: "out" },
  loan_disbursement: { label: "Loans given", side: "out" },
  fund_loan_given: { label: "Upad given", side: "out" },
  fund_loan_payment: { label: "Upad interest & repayments received", side: "in" },
  opening_balance: { label: "Opening cash", side: "in" },
  adjustment: { label: "Adjustments", side: "both" },
  transfer: { label: "Transfers between accounts", side: "both" },
};

export async function cashBook(ctx: OrgContext, q: z.infer<typeof CashBookQuery>) {
  const c = await cols();
  const today = todayIn(ctx.org.settings.timezone);
  const fy = financialYear(today, ctx.org.settings.financialYearStartMonth);
  const from = q.from ?? fy.start;
  const to = q.to ?? today;
  if (from > to) throw badRequest("From date must be before To date");
  const accounts = await c.financialAccounts.find({ organizationId: ctx.orgId }).sort({ createdAt: 1 }).toArray();
  const selected = q.accountId && ObjectId.isValid(q.accountId) ? accounts.filter((a) => a._id.toHexString() === q.accountId) : accounts;
  const keys = selected.map((a) => faKey(a._id));
  const single = selected.length === 1;

  const [openingAgg] = await c.ledgerEntries
    .aggregate<{ v: number }>([{ $match: { organizationId: ctx.orgId, accountKey: { $in: keys }, date: { $lt: from } } }, { $group: { _id: null, v: { $sum: { $subtract: ["$debitPaise", "$creditPaise"] } } } }])
    .toArray();
  const opening = openingAgg?.v ?? 0;
  const raw = await c.ledgerEntries.find({ organizationId: ctx.orgId, accountKey: { $in: keys }, date: { $gte: from, $lte: to } }).sort({ date: 1, createdAt: 1, _id: 1 }).limit(10000).toArray();
  // When showing all accounts, transfers between the Mandal's own accounts net to zero — hide them.
  const lines = single ? raw : raw.filter((l) => (l.originalType ?? l.transactionType) !== "transfer");
  const txns = await c.financialTransactions.find({ _id: { $in: lines.map((l) => l.transactionId) } }, { projection: { number: 1, description: 1, memberId: 1, type: 1, reversalOf: 1 } }).toArray();
  const tm = new Map(txns.map((t) => [t._id.toHexString(), t]));
  const members = await c.members.find({ _id: { $in: txns.map((t) => t.memberId).filter(Boolean) as ObjectId[] } }, { projection: { name: 1 } }).toArray();
  const mm = new Map(members.map((m) => [m._id.toHexString(), m.name]));
  const an = new Map(accounts.map((a) => [faKey(a._id), a.name]));

  let bal = opening;
  const summary = new Map<string, { receiptsPaise: number; paymentsPaise: number }>();
  const out = lines.map((l) => {
    const t = tm.get(l.transactionId.toHexString());
    const type: TransactionType = l.originalType ?? l.transactionType;
    bal += l.debitPaise - l.creditPaise;
    const s = summary.get(type) ?? { receiptsPaise: 0, paymentsPaise: 0 };
    // reversals are netted into the category of what they reverse
    s.receiptsPaise += l.debitPaise;
    s.paymentsPaise += l.creditPaise;
    summary.set(type, s);
    return {
      date: l.date,
      number: t?.number,
      description: t?.description ?? "",
      type,
      isReversal: l.transactionType === "reversal",
      memberName: t?.memberId ? mm.get(t.memberId.toHexString()) ?? null : null,
      accountName: an.get(l.accountKey) ?? "",
      receiptPaise: l.debitPaise,
      paymentPaise: l.creditPaise,
      balancePaise: bal,
    };
  });
  const cat = [...summary.entries()].map(([type, v]) => ({
    type,
    label: CATEGORY[type]?.label ?? type.replace(/_/g, " "),
    receiptsPaise: v.receiptsPaise,
    paymentsPaise: v.paymentsPaise,
    netPaise: v.receiptsPaise - v.paymentsPaise,
  }));
  const net = (t: string) => {
    const s = summary.get(t);
    return s ? s.receiptsPaise - s.paymentsPaise : 0;
  };
  const totalReceipts = out.reduce((s, l) => s + l.receiptPaise, 0);
  const totalPayments = out.reduce((s, l) => s + l.paymentPaise, 0);
  return {
    from,
    to,
    accounts: selected.map((a) => ({ _id: a._id, name: a.name, type: a.type })),
    openingBalancePaise: opening,
    summary: {
      haptaCollectedPaise: net("hapta_collection"),
      otherReceiptsPaise: net("other_income") + net("donation") + net("loan_repayment"),
      withdrawalsPaidPaise: -net("withdrawal"),
      otherExpensesPaise: -(net("expense") + net("expense_reimbursement") + net("loan_disbursement")),
      loansGivenPaise: -net("fund_loan_given"),
      loanPaymentsReceivedPaise: net("fund_loan_payment"),
      totalReceiptsPaise: totalReceipts,
      totalPaymentsPaise: totalPayments,
    },
    categories: cat,
    lines: out,
    closingBalancePaise: opening + totalReceipts - totalPayments,
  };
}

/* ------------------------------------------------------------------ simple cash in / out entries */

export const CashEntrySchema = z.object({
  direction: z.enum(["in", "out"]),
  amount: money(),
  date: dateOnly,
  description: z.string().trim().min(2, "Describe the entry").max(200),
  categoryKey: z.string().max(40).optional(),
  accountId: z.string().optional(),
  idempotencyKey,
});

/**
 * Other cash received (Cr other income) or spent (Dr an expense category) with a description.
 * These are Mandal income/expenses — they never touch any member's balance.
 */
export async function recordCashEntry(ctx: OrgContext, input: z.infer<typeof CashEntrySchema>) {
  const c = await cols();
  const dup = await c.financialTransactions.findOne({ organizationId: ctx.orgId, idempotencyKey: input.idempotencyKey });
  if (dup) return { transaction: dup, duplicate: true };
  let accountId = input.accountId;
  if (!accountId) {
    const cash = await c.financialAccounts.findOne({ organizationId: ctx.orgId, type: "cash", isActive: true }, { sort: { createdAt: 1 } });
    if (!cash) throw badRequest("Create a cash account first");
    accountId = cash._id.toHexString();
  }
  const catKey = input.categoryKey ?? "misc";
  if (input.direction === "out" && !ctx.org.settings.expenseCategories.some((x) => x.key === catKey && x.isActive)) throw badRequest("Choose a valid expense category");
  try {
    return await withTransaction(async (session) => {
      const fa = await requireAccount(ctx.orgId, accountId!, session);
      if (input.direction === "out") {
        const bal = await balanceOf(ctx.orgId, fa._id, session);
        if (bal < input.amount) throw badRequest(`${fa.name} has only ${formatMoney(bal, ctx.org.settings.currency)}`);
      }
      const txn = await postTransaction(
        {
          org: ctx.org,
          type: input.direction === "in" ? "other_income" : "expense",
          date: input.date,
          description: input.description,
          lines:
            input.direction === "in"
              ? [
                  { accountKey: faKey(fa._id), debitPaise: input.amount },
                  { accountKey: INCOME_KEYS.other, creditPaise: input.amount },
                ]
              : [
                  { accountKey: expenseKey(catKey), debitPaise: input.amount },
                  { accountKey: faKey(fa._id), creditPaise: input.amount },
                ],
          createdBy: ctx.user._id,
          sourceType: "cashEntry",
          idempotencyKey: input.idempotencyKey,
        },
        session,
      );
      await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: `cashbook.${input.direction}`, entityType: "financialTransaction", entityId: txn._id, after: { amountPaise: input.amount, description: input.description } }, session);
      return { transaction: txn, duplicate: false };
    });
  } catch (e) {
    if (isDuplicateKeyError(e)) {
      const t = await c.financialTransactions.findOne({ organizationId: ctx.orgId, idempotencyKey: input.idempotencyKey });
      if (t) return { transaction: t, duplicate: true };
    }
    throw e;
  }
}
