import { ALLOWED_PAYMENT_METHODS, CASH_ONLY_MESSAGE } from "@/lib/org-defaults";
import { formatMoney } from "@/lib/currency";
import { ObjectId, type AnyBulkWriteOperation, type ClientSession } from "mongodb";
import { z } from "zod";
import { cols } from "@/lib/collections";
import { withTransaction } from "@/lib/db";
import { audit } from "@/lib/audit";
import { badRequest, conflict, isDuplicateKeyError, notFound } from "@/lib/errors";
import { parseDateOnly, todayIn } from "@/lib/dates";
import type { OrgContext } from "@/lib/auth";
import type { FundLoanDoc, FundLoanDueDoc, FundLoanPaymentDoc, OrganizationDoc } from "@/types/models";
import { dateOnly, idempotencyKey, money, optText, rateString } from "@/validators/common";
import { FUND_LOANS, INCOME_KEYS, MEMBER_FUNDS, faKey, fyNumber, postTransaction, reverseTransaction } from "./ledger.service";
import { balanceOf, requireAccount } from "./account.service";
import { postMemberEntry } from "./member-ledger.service";
import { rateInterest } from "./member-interest.service";
import { lastOfMonth, monthOf } from "./monthly.service";
import { cancelReceiptFor, issueReceipt } from "./receipt.service";
import { notifyMember } from "./notification.service";
import { copy } from "./notification-copy";

/**
 * Upad (ઉપાડ): loans from the Mandal fund.
 *
 *  - A member borrows cash from the fund (e.g. ₹3,000 out of ₹5,000).
 *  - From the month after it is given, interest is due every month on the amount still
 *    outstanding at the END OF THE PREVIOUS MONTH: interest = outstanding × monthly rate %,
 *    rounded half-up to the paisa (₹3,000 × 10% = ₹300).
 *  - Unpaid interest carries forward (next month shows both months); no penalty and no
 *    interest on interest.
 *  - The principal can be returned in part or in full at any time; interest from the next
 *    month is on what is left.
 *  - When interest is received it is shared among all members in proportion to their savings
 *    balances (member-savings Mandals), so the fund grows from ₹5,000 to ₹5,300. In Mandals
 *    that treat hapta as income, it is Mandal interest income instead.
 *
 * Books: given → Dr loans given / Cr cash. Payment → Dr cash / Cr member funds (each share)
 * + Cr loans given (principal). Monthly interest dues are memo records (not postings) until paid.
 */

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const nextMonth = (m: string) => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 7);
};
const prevMonth = (m: string) => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 2, 1)).toISOString().slice(0, 7);
};
function dueDateFor(org: Pick<OrganizationDoc, "settings">, period: string) {
  const day = Math.min(28, Math.max(1, org.settings.fundLoans?.dueDay ?? 10));
  return parseDateOnly(`${period}-${String(day).padStart(2, "0")}`);
}

/* ------------------------------------------------------------------ monthly interest dues */

/**
 * Create / refresh the monthly interest dues of loans up to the current month. Idempotent.
 * Unpaid dues are recalculated (e.g. after a principal repayment recorded late); dues that have
 * been (partly) paid are never changed.
 *
 * Done in a fixed number of round trips regardless of how many loans / months there are:
 * one read of the dues, one read of the payments, one bulk write of the changes.
 */
async function refreshDuesFor(org: Pick<OrganizationDoc, "_id" | "settings">, loans: FundLoanDoc[], session?: ClientSession) {
  const live = loans.filter((l) => l.status !== "cancelled");
  if (live.length === 0) return;
  const c = await cols();
  const current = monthOf(todayIn(org.settings.timezone));
  const ids = live.map((l) => l._id);
  const [existing, payments] = await Promise.all([
    c.fundLoanDues.find({ organizationId: org._id, loanId: { $in: ids } }, { session, projection: { loanId: 1, period: 1, paidPaise: 1, interestPaise: 1, principalBasisPaise: 1 } }).toArray(),
    c.fundLoanPayments.find({ organizationId: org._id, loanId: { $in: ids }, status: "valid", principalPaise: { $gt: 0 } }, { session, projection: { loanId: 1, date: 1, principalPaise: 1 } }).toArray(),
  ]);
  const now = new Date();
  const ops: AnyBulkWriteOperation<FundLoanDueDoc>[] = [];
  for (const loan of live) {
    const key = loan._id.toHexString();
    const byPeriod = new Map(existing.filter((d) => d.loanId.toHexString() === key).map((d) => [d.period, d]));
    const repaid = payments.filter((p) => p.loanId.toHexString() === key);
    /** principal still outstanding at the end of `asOf` (inclusive) */
    const outstandingAt = (asOf: Date) => (asOf < loan.date ? 0 : loan.principalPaise - repaid.filter((p) => p.date <= asOf).reduce((t, p) => t + p.principalPaise, 0));
    for (let p = loan.firstInterestMonth; p <= current; p = nextMonth(p)) {
      const basis = outstandingAt(lastOfMonth(prevMonth(p)));
      const interest = rateInterest(basis, loan.monthlyRate);
      const due = byPeriod.get(p);
      if (!due) {
        if (interest <= 0) continue;
        // upsert + $setOnInsert: never overwrites a due created concurrently
        ops.push({
          updateOne: {
            filter: { organizationId: org._id, loanId: loan._id, period: p },
            update: { $setOnInsert: { _id: new ObjectId(), organizationId: org._id, loanId: loan._id, memberId: loan.memberId, period: p, dueDate: dueDateFor(org, p), principalBasisPaise: basis, monthlyRate: loan.monthlyRate, interestPaise: interest, paidPaise: 0, createdAt: now, updatedAt: now } },
            upsert: true,
          },
        });
      } else if (due.paidPaise === 0 && (due.interestPaise !== interest || due.principalBasisPaise !== basis)) {
        if (interest <= 0) ops.push({ deleteOne: { filter: { _id: due._id, paidPaise: 0 } } });
        else ops.push({ updateOne: { filter: { _id: due._id, paidPaise: 0 }, update: { $set: { principalBasisPaise: basis, interestPaise: interest, monthlyRate: loan.monthlyRate, updatedAt: now } } } });
      }
    }
  }
  if (ops.length === 0) return;
  try {
    await c.fundLoanDues.bulkWrite(ops, { ordered: false, session });
  } catch (e) {
    if (!isDuplicateKeyError(e)) throw e; // a concurrent request created the same month first
  }
}

async function refreshLoanDues(org: Pick<OrganizationDoc, "_id" | "settings">, loan: FundLoanDoc, session?: ClientSession) {
  await refreshDuesFor(org, [loan], session);
}

export async function refreshFundLoanDues(org: Pick<OrganizationDoc, "_id" | "settings">, loanId?: ObjectId) {
  const c = await cols();
  const loans = await c.fundLoans.find({ organizationId: org._id, status: "active", ...(loanId ? { _id: loanId } : {}) }).toArray();
  await refreshDuesFor(org, loans);
}

/* ------------------------------------------------------------------ give a loan */

export const GiveLoanSchema = z.object({
  memberId: z.string(),
  amount: money(),
  date: dateOnly,
  /** % per month; defaults to the Mandal setting */
  monthlyRate: rateString.optional(),
  note: optText(300),
  accountId: z.string().optional(),
  idempotencyKey,
});

export async function giveFundLoan(ctx: OrgContext, input: z.infer<typeof GiveLoanSchema>) {
  const c = await cols();
  const prior = await c.fundLoans.findOne({ organizationId: ctx.orgId, idempotencyKey: input.idempotencyKey });
  if (prior) return { loan: prior, duplicate: true };
  if (!ObjectId.isValid(input.memberId)) throw notFound("Member");
  const member = await c.members.findOne({ _id: new ObjectId(input.memberId), organizationId: ctx.orgId });
  if (!member) throw notFound("Member");
  if (member.status !== "active") throw badRequest("Only active members can take upad");
  const today = todayIn(ctx.org.settings.timezone);
  if (input.date > today) throw badRequest("Upad can't be dated in the future");
  const rate = input.monthlyRate ?? ctx.org.settings.fundLoans.defaultMonthlyRate;
  if (Number(rate) <= 0) throw badRequest("Enter the monthly interest rate");

  let accountId = input.accountId;
  if (!accountId) {
    const cash = await c.financialAccounts.findOne({ organizationId: ctx.orgId, type: "cash", isActive: true }, { sort: { createdAt: 1 } });
    if (!cash) throw badRequest("Create a cash account first");
    accountId = cash._id.toHexString();
  }
  try {
    const loan = await withTransaction(async (session) => {
      const account = await requireAccount(ctx.orgId, accountId!, session);
      const cashBal = await balanceOf(ctx.orgId, account._id, session);
      if (cashBal < input.amount) throw badRequest(`${account.name} has only ${formatMoney(cashBal, ctx.org.settings.currency)} — the Mandal can't give more cash than it holds`);
      const id = new ObjectId();
      const number = await fyNumber(ctx.org, "UPAD", input.date, session);
      const txn = await postTransaction(
        {
          org: ctx.org,
          type: "fund_loan_given",
          date: input.date,
          description: `Upad ${number} to ${member.name} @ ${rate}% per month${input.note ? ` (${input.note})` : ""}`,
          lines: [
            { accountKey: FUND_LOANS, debitPaise: input.amount, memberId: member._id },
            { accountKey: faKey(account._id), creditPaise: input.amount },
          ],
          createdBy: ctx.user._id,
          memberId: member._id,
          sourceType: "fundLoan",
          sourceId: id,
        },
        session,
      );
      const now = new Date();
      const doc: FundLoanDoc = {
        _id: id,
        organizationId: ctx.orgId,
        number,
        memberId: member._id,
        principalPaise: input.amount,
        outstandingPaise: input.amount,
        monthlyRate: rate,
        date: input.date,
        firstInterestMonth: nextMonth(monthOf(input.date)),
        accountId: account._id,
        note: input.note,
        status: "active",
        closedAt: null,
        idempotencyKey: input.idempotencyKey,
        transactionId: txn._id,
        createdBy: ctx.user._id,
        createdAt: now,
        updatedAt: now,
      };
      await c.fundLoans.insertOne(doc, { session });
      await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "fundLoan.give", entityType: "fundLoan", entityId: id, after: { number, memberId: member._id, amountPaise: input.amount, monthlyRate: rate } }, session);
      return doc;
    });
    await refreshLoanDues(ctx.org, loan);
    await notifyMember(ctx.orgId, loan.memberId, {
      type: "fundLoan.given",
      copy: copy("fundLoan.given", { amountPaise: loan.principalPaise, number: loan.number, rate: loan.monthlyRate, fromMonth: loan.firstInterestMonth }, ctx.org.settings.currency),
      link: `/org/${ctx.orgId}/my`,
      dedupeKey: `fl:${loan._id}`,
    });
    return { loan, duplicate: false };
  } catch (e) {
    if (isDuplicateKeyError(e)) {
      const again = await c.fundLoans.findOne({ organizationId: ctx.orgId, idempotencyKey: input.idempotencyKey });
      if (again) return { loan: again, duplicate: true };
    }
    throw e;
  }
}

/* ------------------------------------------------------------------ interest shares */

/**
 * Split `amount` among members in proportion to their current savings balances (largest
 * remainder, so the shares add up exactly). Falls back to equal shares when nobody has a
 * positive balance, and to the borrower when there are no active members.
 */
export function splitByWeight(amount: number, weights: { id: string; w: number }[]): Map<string, number> {
  const out = new Map<string, number>();
  const total = weights.reduce((s, x) => s + x.w, 0);
  if (amount <= 0 || total <= 0) return out;
  const parts = weights.map((x) => {
    const exact = (BigInt(amount) * BigInt(x.w)) / BigInt(total);
    const rem = (BigInt(amount) * BigInt(x.w)) % BigInt(total);
    return { id: x.id, base: Number(exact), rem };
  });
  let left = amount - parts.reduce((s, p) => s + p.base, 0);
  parts.sort((a, b) => (a.rem === b.rem ? a.id.localeCompare(b.id) : a.rem > b.rem ? -1 : 1));
  for (const p of parts) {
    const extra = left > 0 ? 1 : 0;
    left -= extra;
    if (p.base + extra > 0) out.set(p.id, p.base + extra);
  }
  return out;
}

async function interestShares(orgId: ObjectId, amount: number, borrower: ObjectId, session: ClientSession) {
  const c = await cols();
  const members = await c.members.find({ organizationId: orgId, status: "active" }, { session, projection: { balancePaise: 1 } }).toArray();
  let weights = members.filter((m) => (m.balancePaise ?? 0) > 0).map((m) => ({ id: m._id.toHexString(), w: m.balancePaise! }));
  if (weights.length === 0) weights = members.map((m) => ({ id: m._id.toHexString(), w: 1 }));
  if (weights.length === 0) weights = [{ id: borrower.toHexString(), w: 1 }];
  return splitByWeight(amount, weights);
}

/* ------------------------------------------------------------------ receive interest / principal */

export const LoanPaymentSchema = z
  .object({
    interestAmount: money({ allowZero: true }).default(0),
    principalAmount: money({ allowZero: true }).default(0),
    date: dateOnly,
    note: optText(300),
    accountId: z.string().optional(),
    method: z.string().refine((m) => (ALLOWED_PAYMENT_METHODS as readonly string[]).includes(m), CASH_ONLY_MESSAGE).default("cash"),
    reference: optText(100),
    idempotencyKey,
  })
  .refine((v) => v.interestAmount > 0 || v.principalAmount > 0, { message: "Enter the interest and/or upad amount received", path: ["interestAmount"] });

export async function receiveFundLoanPayment(ctx: OrgContext, loanId: ObjectId, input: z.infer<typeof LoanPaymentSchema>) {
  const c = await cols();
  const prior = await c.fundLoanPayments.findOne({ organizationId: ctx.orgId, idempotencyKey: input.idempotencyKey });
  if (prior) return { payment: prior, duplicate: true };
  const loan = await c.fundLoans.findOne({ _id: loanId, organizationId: ctx.orgId });
  if (!loan) throw notFound("Upad");
  if (loan.status !== "active") throw badRequest(`This upad is ${loan.status}`);
  const today = todayIn(ctx.org.settings.timezone);
  if (input.date > today) throw badRequest("A payment can't be dated in the future");
  if (input.date < loan.date) throw badRequest("A payment can't be dated before the upad was given");
  await refreshLoanDues(ctx.org, loan);
  const savings = ctx.org.settings.haptaTreatment === "member_savings";
  const member = await c.members.findOne({ _id: loan.memberId }, { projection: { name: 1 } });

  let accountId = input.accountId;
  if (!accountId) {
    const acc = await c.financialAccounts.findOne({ _id: loan.accountId, organizationId: ctx.orgId, isActive: true });
    const cash = acc ?? (await c.financialAccounts.findOne({ organizationId: ctx.orgId, type: "cash", isActive: true }, { sort: { createdAt: 1 } }));
    if (!cash) throw badRequest("Create a cash account first");
    accountId = cash._id.toHexString();
  }

  try {
    const payment = await withTransaction(async (session) => {
      const account = await requireAccount(ctx.orgId, accountId!, session);
      const id = new ObjectId();

      // interest: oldest unpaid month first
      const allocations: FundLoanPaymentDoc["allocations"] = [];
      if (input.interestAmount > 0) {
        const dues = await c.fundLoanDues.find({ organizationId: ctx.orgId, loanId: loan._id }, { session }).sort({ period: 1 }).toArray();
        const unpaid = dues.reduce((s, d) => s + d.interestPaise - d.paidPaise, 0);
        if (input.interestAmount > unpaid) throw badRequest(unpaid === 0 ? "No interest is due on this upad right now" : `Only ${formatMoney(unpaid, ctx.org.settings.currency)} interest is due on this upad`);
        let left = input.interestAmount;
        for (const d of dues) {
          if (left <= 0) break;
          const take = Math.min(left, d.interestPaise - d.paidPaise);
          if (take <= 0) continue;
          const r = await c.fundLoanDues.updateOne(
            { _id: d._id, $expr: { $lte: [{ $add: ["$paidPaise", take] }, "$interestPaise"] } },
            { $inc: { paidPaise: take }, $set: { updatedAt: new Date() } },
            { session },
          );
          if (r.modifiedCount !== 1) throw conflict("The interest due changed — please try again");
          allocations.push({ dueId: d._id, period: d.period, amountPaise: take });
          left -= take;
        }
      }

      // principal returned
      if (input.principalAmount > 0) {
        const paidLater = await c.fundLoanDues.findOne({ organizationId: ctx.orgId, loanId: loan._id, period: { $gt: monthOf(input.date) }, paidPaise: { $gt: 0 } }, { session });
        if (paidLater) throw badRequest(`Interest for ${paidLater.period} has already been paid on the old amount — record the upad repayment with a date in ${paidLater.period} or later`);
        const r = await c.fundLoans.updateOne(
          { _id: loan._id, status: "active", outstandingPaise: { $gte: input.principalAmount } },
          { $inc: { outstandingPaise: -input.principalAmount }, $set: { updatedAt: new Date() } },
          { session },
        );
        if (r.modifiedCount !== 1) {
          const now = await c.fundLoans.findOne({ _id: loan._id }, { session, projection: { outstandingPaise: 1 } });
          throw badRequest(`Only ${formatMoney(now?.outstandingPaise ?? 0, ctx.org.settings.currency)} of the upad is outstanding`);
        }
      }

      // interest shares
      const shareMap = savings && input.interestAmount > 0 ? await interestShares(ctx.orgId, input.interestAmount, loan.memberId, session) : new Map<string, number>();
      const number = loan.number;
      const periods = allocations.map((a) => a.period);
      const periodText = periods.length ? (periods.length === 1 ? periods[0] : `${periods[0]} to ${periods[periods.length - 1]}`) : "";
      const total = input.interestAmount + input.principalAmount;
      const lines = [
        { accountKey: faKey(account._id), debitPaise: total },
        ...(savings ? [...shareMap.entries()].map(([mid, amt]) => ({ accountKey: MEMBER_FUNDS, creditPaise: amt, memberId: new ObjectId(mid) })) : input.interestAmount > 0 ? [{ accountKey: INCOME_KEYS.interest, creditPaise: input.interestAmount }] : []),
        ...(input.principalAmount > 0 ? [{ accountKey: FUND_LOANS, creditPaise: input.principalAmount, memberId: loan.memberId }] : []),
      ];
      const txn = await postTransaction(
        {
          org: ctx.org,
          type: "fund_loan_payment",
          date: input.date,
          description: `${member?.name ?? "Member"} — upad ${number}: ${[input.interestAmount ? `interest ${formatMoney(input.interestAmount, ctx.org.settings.currency)}${periodText ? ` (${periodText})` : ""}` : "", input.principalAmount ? `upad returned ${formatMoney(input.principalAmount, ctx.org.settings.currency)}` : ""].filter(Boolean).join(", ")}`,
          lines,
          createdBy: ctx.user._id,
          memberId: loan.memberId,
          sourceType: "fundLoanPayment",
          sourceId: id,
          reason: input.note,
        },
        session,
      );
      const shares: FundLoanPaymentDoc["shares"] = [];
      for (const [mid, amt] of shareMap) {
        const { entry } = await postMemberEntry(
          {
            org: ctx.org,
            memberId: new ObjectId(mid),
            date: input.date,
            kind: "interest",
            creditPaise: amt,
            description: `Share of upad interest — ${number} (${member?.name ?? "member"})${periodText ? `, ${periodText}` : ""}`,
            sourceType: "fundLoanPayment",
            sourceId: id,
            transactionId: txn._id,
            dedupeKey: `flp:${id.toHexString()}:${mid}`,
            createdBy: ctx.user._id,
          },
          session,
        );
        shares.push({ memberId: new ObjectId(mid), amountPaise: amt, ledgerEntryId: entry._id });
      }
      const receipt = await issueReceipt(
        ctx.org,
        {
          sourceType: "fundLoanPayment",
          sourceId: id,
          memberId: loan.memberId,
          payerName: member?.name ?? "Member",
          amountPaise: total,
          date: input.date,
          method: input.method,
          reference: input.reference,
          lines: [
            ...(input.interestAmount ? [{ description: `Upad ${number} interest${periodText ? ` — ${periodText}` : ""}`, amountPaise: input.interestAmount }] : []),
            ...(input.principalAmount ? [{ description: `Upad ${number} amount returned`, amountPaise: input.principalAmount }] : []),
          ],
          issuedBy: ctx.user._id,
        },
        session,
      );
      const doc: FundLoanPaymentDoc = {
        _id: id,
        organizationId: ctx.orgId,
        loanId: loan._id,
        memberId: loan.memberId,
        date: input.date,
        interestPaise: input.interestAmount,
        principalPaise: input.principalAmount,
        allocations,
        shares,
        accountId: account._id,
        note: input.note,
        status: "valid",
        receiptId: receipt._id,
        transactionId: txn._id,
        idempotencyKey: input.idempotencyKey,
        recordedBy: ctx.user._id,
        createdAt: new Date(),
      };
      await c.fundLoanPayments.insertOne(doc, { session });
      await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "fundLoan.payment", entityType: "fundLoan", entityId: loan._id, after: { paymentId: id, interestPaise: input.interestAmount, principalPaise: input.principalAmount, periods } }, session);
      return doc;
    });
    const fresh = (await c.fundLoans.findOne({ _id: loan._id }))!;
    await refreshLoanDues(ctx.org, fresh);
    await closeIfSettled(ctx, fresh);
    return { payment, duplicate: false };
  } catch (e) {
    if (isDuplicateKeyError(e)) {
      const again = await c.fundLoanPayments.findOne({ organizationId: ctx.orgId, idempotencyKey: input.idempotencyKey });
      if (again) return { payment: again, duplicate: true };
    }
    throw e;
  }
}

/** A loan is closed once the full amount is returned and no interest is left unpaid. */
async function closeIfSettled(ctx: OrgContext, loan: FundLoanDoc) {
  if (loan.outstandingPaise > 0 || loan.status !== "active") return;
  const c = await cols();
  const unpaid = await c.fundLoanDues.findOne({ organizationId: ctx.orgId, loanId: loan._id, $expr: { $lt: ["$paidPaise", "$interestPaise"] } });
  if (unpaid) return;
  await c.fundLoans.updateOne({ _id: loan._id, status: "active", outstandingPaise: 0 }, { $set: { status: "closed", closedAt: new Date(), updatedAt: new Date() } });
}

/* ------------------------------------------------------------------ corrections */

/** Reverse the most recent payment on a loan (entered by mistake). */
export async function reverseFundLoanPayment(ctx: OrgContext, paymentId: ObjectId, reasonText: string) {
  const c = await cols();
  const today = todayIn(ctx.org.settings.timezone);
  const p = await c.fundLoanPayments.findOne({ _id: paymentId, organizationId: ctx.orgId });
  if (!p) throw notFound("Payment");
  const latest = await c.fundLoanPayments.findOne({ organizationId: ctx.orgId, loanId: p.loanId, status: "valid" }, { sort: { date: -1, createdAt: -1 } });
  if (p.status === "valid" && latest && !latest._id.equals(p._id)) throw badRequest("Only the latest payment on an upad can be reversed. Reverse the later payments first.");
  await withTransaction(async (session) => {
    const claimed = await c.fundLoanPayments.updateOne({ _id: p._id, status: "valid" }, { $set: { status: "reversed", reversalReason: reasonText } }, { session });
    if (claimed.modifiedCount !== 1) throw conflict("This payment is already reversed");
    const rev = await reverseTransaction(ctx.org, p.transactionId, reasonText, ctx.user._id, today, session);
    for (const a of p.allocations) {
      await c.fundLoanDues.updateOne({ _id: a.dueId }, { $inc: { paidPaise: -a.amountPaise }, $set: { updatedAt: new Date() } }, { session });
    }
    for (const s of p.shares) {
      await postMemberEntry(
        { org: ctx.org, memberId: s.memberId, date: today, kind: "interest", debitPaise: s.amountPaise, description: `Reversed upad interest share: ${reasonText}`, sourceType: "fundLoanPayment", sourceId: p._id, transactionId: rev._id, dedupeKey: `flp-rev:${p._id.toHexString()}:${s.memberId.toHexString()}`, reversalOf: s.ledgerEntryId, createdBy: ctx.user._id },
        session,
      );
    }
    if (p.principalPaise > 0 || p.interestPaise > 0) {
      await c.fundLoans.updateOne({ _id: p.loanId }, { $inc: { outstandingPaise: p.principalPaise }, $set: { status: "active", closedAt: null, updatedAt: new Date() } }, { session });
    }
    await c.fundLoanPayments.updateOne({ _id: p._id }, { $set: { reversalTransactionId: rev._id } }, { session });
    await cancelReceiptFor(ctx.orgId, "fundLoanPayment", p._id, session);
    await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "fundLoan.payment.reverse", entityType: "fundLoan", entityId: p.loanId, reason: reasonText, after: { paymentId: p._id } }, session);
  });
  const loan = await c.fundLoans.findOne({ _id: p.loanId });
  if (loan) await refreshLoanDues(ctx.org, loan);
  return { ok: true };
}

/** Cancel a loan given by mistake (only while nothing has been paid on it). */
export async function cancelFundLoan(ctx: OrgContext, loanId: ObjectId, reasonText: string) {
  const c = await cols();
  const today = todayIn(ctx.org.settings.timezone);
  const loan = await c.fundLoans.findOne({ _id: loanId, organizationId: ctx.orgId });
  if (!loan) throw notFound("Upad");
  if (await c.fundLoanPayments.findOne({ organizationId: ctx.orgId, loanId, status: "valid" })) throw badRequest("Payments have been recorded on this upad — reverse them first");
  await withTransaction(async (session) => {
    const r = await c.fundLoans.updateOne({ _id: loanId, status: "active" }, { $set: { status: "cancelled", cancelReason: reasonText, updatedAt: new Date() } }, { session });
    if (r.modifiedCount !== 1) throw conflict(`This upad is already ${loan.status}`);
    await reverseTransaction(ctx.org, loan.transactionId, reasonText, ctx.user._id, today, session);
    await c.fundLoanDues.deleteMany({ organizationId: ctx.orgId, loanId, paidPaise: 0 }, { session });
    await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "fundLoan.cancel", entityType: "fundLoan", entityId: loanId, reason: reasonText }, session);
  });
  return { ok: true };
}

/* ------------------------------------------------------------------ queries */

type LoanSummary = FundLoanDoc & {
  member: { _id: ObjectId; name: string; membershipNumber: string } | null;
  interestDuePaise: number;
  unpaidMonths: string[];
  interestPaidPaise: number;
  nextInterestPaise: number;
};

async function summarize(orgId: ObjectId, loans: FundLoanDoc[]): Promise<LoanSummary[]> {
  const c = await cols();
  const ids = loans.map((l) => l._id);
  const [dues, members] = await Promise.all([
    c.fundLoanDues.find({ organizationId: orgId, loanId: { $in: ids } }).sort({ period: 1 }).toArray(),
    c.members.find({ _id: { $in: loans.map((l) => l.memberId) } }, { projection: { name: 1, membershipNumber: 1 } }).toArray(),
  ]);
  return loans.map((l) => {
    const ld = dues.filter((d) => d.loanId.equals(l._id));
    const unpaid = ld.filter((d) => d.paidPaise < d.interestPaise);
    return {
      ...l,
      member: members.find((m) => m._id.equals(l.memberId)) ?? null,
      interestDuePaise: unpaid.reduce((s, d) => s + d.interestPaise - d.paidPaise, 0),
      unpaidMonths: unpaid.map((d) => d.period),
      interestPaidPaise: ld.reduce((s, d) => s + d.paidPaise, 0),
      nextInterestPaise: l.status === "active" ? rateInterest(l.outstandingPaise, l.monthlyRate) : 0,
    };
  });
}

export const FundLoanListQuery = z.object({ status: z.enum(["active", "closed", "cancelled", "all"]).default("active"), memberId: z.string().optional() });

export async function listFundLoans(ctx: OrgContext, q: z.infer<typeof FundLoanListQuery>, restrictMemberId?: ObjectId) {
  const c = await cols();
  const filter: Record<string, unknown> = { organizationId: ctx.orgId };
  if (q.status !== "all") filter.status = q.status;
  if (restrictMemberId) filter.memberId = restrictMemberId;
  else if (q.memberId && ObjectId.isValid(q.memberId)) filter.memberId = new ObjectId(q.memberId);
  // the dues refresh only writes dues, so the loans can be read at the same time
  const [, loans] = await Promise.all([refreshFundLoanDues(ctx.org), c.fundLoans.find(filter).sort({ status: 1, date: -1 }).limit(500).toArray()]);
  const items = await summarize(ctx.orgId, loans);
  const active = items.filter((l) => l.status === "active");
  return {
    items,
    totals: {
      outstandingPaise: active.reduce((s, l) => s + l.outstandingPaise, 0),
      interestDuePaise: items.reduce((s, l) => s + l.interestDuePaise, 0),
      interestPaidPaise: items.reduce((s, l) => s + l.interestPaidPaise, 0),
      activeLoans: active.length,
    },
    defaultMonthlyRate: ctx.org.settings.fundLoans.defaultMonthlyRate,
  };
}

export async function getFundLoan(ctx: OrgContext, loanId: ObjectId, restrictMemberId?: ObjectId | null) {
  const c = await cols();
  const loan = await c.fundLoans.findOne({ _id: loanId, organizationId: ctx.orgId });
  if (!loan) throw notFound("Upad");
  if (restrictMemberId !== undefined && (!restrictMemberId || !loan.memberId.equals(restrictMemberId))) throw notFound("Upad");
  await refreshLoanDues(ctx.org, loan);
  const [summary] = await summarize(ctx.orgId, [loan]);
  const [dues, payments] = await Promise.all([
    c.fundLoanDues.find({ organizationId: ctx.orgId, loanId }).sort({ period: 1 }).toArray(),
    c.fundLoanPayments.find({ organizationId: ctx.orgId, loanId }, { projection: { shares: 0 } }).sort({ date: -1, createdAt: -1 }).toArray(),
  ]);
  const users = await c.users.find({ _id: { $in: payments.map((p) => p.recordedBy) } }, { projection: { name: 1 } }).toArray();
  const today = todayIn(ctx.org.settings.timezone);
  return {
    loan: summary,
    dues: dues.map((d) => ({ ...d, unpaidPaise: d.interestPaise - d.paidPaise, status: d.paidPaise >= d.interestPaise ? "paid" : d.dueDate < today ? "overdue" : d.paidPaise > 0 ? "partially_paid" : "pending" })),
    payments: payments.map((p) => ({ ...p, recordedByName: users.find((u) => u._id.equals(p.recordedBy))?.name ?? null })),
  };
}

/**
 * Loan interest for a month (for the Monthly hapta screen): every loan with interest due for
 * the month, plus any interest still unpaid from earlier months.
 */
export async function fundLoanMonth(ctx: OrgContext, monthParam?: string) {
  const month = monthParam ?? monthOf(todayIn(ctx.org.settings.timezone));
  if (!MONTH.test(month)) throw badRequest("Use YYYY-MM");
  await refreshFundLoanDues(ctx.org);
  const c = await cols();
  const dues = await c.fundLoanDues.find({ organizationId: ctx.orgId, period: { $lte: month } }).toArray();
  const relevant = dues.filter((d) => d.period === month || d.paidPaise < d.interestPaise);
  const loanIds = [...new Set(relevant.map((d) => d.loanId.toHexString()))].map((x) => new ObjectId(x));
  const loans = await c.fundLoans.find({ _id: { $in: loanIds } }).toArray();
  const items = await summarize(ctx.orgId, loans);
  const today = todayIn(ctx.org.settings.timezone);
  const rows = items
    .map((l) => {
      const ld = relevant.filter((d) => d.loanId.equals(l._id));
      const thisMonth = ld.find((d) => d.period === month) ?? null;
      const earlier = ld.filter((d) => d.period < month);
      const unpaidEarlier = earlier.reduce((s, d) => s + d.interestPaise - d.paidPaise, 0);
      const unpaidThis = thisMonth ? thisMonth.interestPaise - thisMonth.paidPaise : 0;
      return {
        loanId: l._id,
        number: l.number,
        member: l.member,
        memberId: l.memberId,
        outstandingPaise: l.outstandingPaise,
        monthlyRate: l.monthlyRate,
        thisMonth: thisMonth ? { period: thisMonth.period, principalBasisPaise: thisMonth.principalBasisPaise, interestPaise: thisMonth.interestPaise, paidPaise: thisMonth.paidPaise, dueDate: thisMonth.dueDate } : null,
        carriedForwardPaise: unpaidEarlier,
        carriedForwardMonths: earlier.map((d) => d.period),
        totalDuePaise: unpaidEarlier + unpaidThis,
        status: unpaidEarlier + unpaidThis === 0 ? "paid" : thisMonth && thisMonth.paidPaise > 0 && unpaidEarlier === 0 ? "partially_paid" : (thisMonth ? thisMonth.dueDate < today : true) ? "overdue" : "pending",
      };
    })
    .sort((a, b) => (a.member?.name ?? "").localeCompare(b.member?.name ?? ""));
  return {
    month,
    rows,
    summary: {
      loans: rows.length,
      interestThisMonthPaise: rows.reduce((s, r) => s + (r.thisMonth?.interestPaise ?? 0), 0),
      collectedThisMonthPaise: rows.reduce((s, r) => s + (r.thisMonth?.paidPaise ?? 0), 0),
      totalDuePaise: rows.reduce((s, r) => s + r.totalDuePaise, 0),
    },
  };
}

/** For dashboards. */
export async function fundLoanTotals(org: Pick<OrganizationDoc, "_id" | "settings">, memberId?: ObjectId) {
  await refreshFundLoanDues(org);
  const c = await cols();
  const match: Record<string, unknown> = { organizationId: org._id };
  if (memberId) match.memberId = memberId;
  const [loans, dues] = await Promise.all([
    c.fundLoans.find({ ...match, status: "active" }, { projection: { outstandingPaise: 1, monthlyRate: 1, number: 1 } }).toArray(),
    c.fundLoanDues.aggregate<{ t: number }>([{ $match: match }, { $group: { _id: null, t: { $sum: { $subtract: ["$interestPaise", "$paidPaise"] } } } }]).toArray(),
  ]);
  return {
    activeLoans: loans.length,
    outstandingPaise: loans.reduce((s, l) => s + l.outstandingPaise, 0),
    interestDuePaise: dues[0]?.t ?? 0,
  };
}
