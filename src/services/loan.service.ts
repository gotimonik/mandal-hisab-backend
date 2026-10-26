import { formatMoney } from "@/lib/currency";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { cols } from "@/lib/collections";
import { withTransaction } from "@/lib/db";
import { audit } from "@/lib/audit";
import { badRequest, conflict, forbidden, isDuplicateKeyError, notFound } from "@/lib/errors";
import { roundHalfUp } from "@/lib/money";
import { diffDays, todayIn, utcAddDays } from "@/lib/dates";
import type { OrgContext } from "@/lib/auth";
import type { InterestCalculationDoc, LoanDoc, LoanRepaymentDoc, LoanScheduleRow } from "@/types/models";
import { dateOnly, idempotencyKey, money, optText, rateString, reason } from "@/validators/common";
import {
  annualFromInput,
  buildLoanSchedule,
  compoundInterestBetween,
  emi as emiFor,
  PERIODS_PER_YEAR,
  scheduleTotals,
  simpleInterestBetween,
  type DayCount,
  type LoanTerms,
  type ScheduleRow,
} from "./interest";
import { INCOME_KEYS, LOANS_RECEIVABLE, faKey, fyNumber, postTransaction, reverseTransaction, type LedgerLine } from "./ledger.service";
import { balanceOf, requireAccount } from "./account.service";
import { issueReceipt, cancelReceiptFor } from "./receipt.service";
import { notifyMember } from "./notification.service";

/* ------------------------------------------------------------------ schemas */

const LateFee = z.object({
  enabled: z.boolean(),
  type: z.enum(["fixed", "percent"]),
  value: z.number().int().min(0).max(10_000_000),
  graceDays: z.number().int().min(0).max(90),
});

const TermsFields = {
  interestMethod: z.enum(["simple", "compound", "flat", "reducing_balance"]),
  rate: rateString,
  ratePeriod: z.enum(["annual", "monthly"]).default("annual"),
  compoundingPerYear: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(12)]).optional().nullable(),
  dayCount: z.enum(["actual_365", "actual_360", "30_360"]).default("actual_365"),
  tenure: z.number().int().min(1).max(360),
  repaymentFrequency: z.enum(["weekly", "biweekly", "monthly", "quarterly"]).default("monthly"),
};

export const LoanApplySchema = z.object({
  memberId: z.string(),
  amount: money(),
  purpose: optText(300),
  ...TermsFields,
  graceDays: z.number().int().min(0).max(90).default(0),
  lateFee: LateFee.default({ enabled: false, type: "fixed", value: 0, graceDays: 0 }),
  allocationOrder: z
    .array(z.enum(["penalty", "interest", "principal"]))
    .length(3)
    .refine((a) => new Set(a).size === 3, "Each component once")
    .default(["penalty", "interest", "principal"]),
  prepaymentMode: z.enum(["reduce_tenure", "reduce_emi"]).default("reduce_emi"),
  notes: optText(1000),
});

export const LoanApproveSchema = z.object({
  approvedAmount: money(),
  rate: rateString.optional(),
  ratePeriod: z.enum(["annual", "monthly"]).optional(),
  tenure: z.number().int().min(1).max(360).optional(),
  notes: optText(500),
});

export const LoanDisburseSchema = z.object({
  accountId: z.string(),
  date: dateOnly,
  firstDueDate: dateOnly,
  roundEmiToRupee: z.boolean().default(false),
});

export const LoanPreviewSchema = z.object({
  amount: money(),
  ...TermsFields,
  disbursedOn: dateOnly,
  firstDueDate: dateOnly,
  roundEmiToRupee: z.boolean().default(false),
});

export const RepaySchema = z.object({
  amount: money(),
  date: dateOnly,
  method: z.string().min(2).max(30),
  reference: optText(100),
  accountId: z.string(),
  /** true = amount beyond current dues reduces principal (prepayment); false = pays next installments in advance */
  prepayment: z.boolean().default(false),
  closeLoan: z.boolean().default(false),
  idempotencyKey,
  dryRun: z.boolean().default(false),
});

export const RateChangeSchema = z.object({ rate: rateString, ratePeriod: z.enum(["annual", "monthly"]).default("annual"), effectiveFrom: dateOnly, reason });

/* ------------------------------------------------------------------ helpers */

function termsOf(l: LoanDoc, overrides: Partial<LoanTerms> = {}): LoanTerms {
  return {
    principalPaise: l.principalPaise ?? l.approvedPaise ?? l.requestedPaise,
    annualRate: l.annualRate,
    method: l.interestMethod,
    tenure: l.tenure,
    frequency: l.repaymentFrequency,
    disbursedOn: l.disbursedOn ?? new Date(),
    firstDueDate: l.firstDueDate ?? new Date(),
    dayCount: l.dayCount,
    compoundingPerYear: (l.compoundingPerYear ?? 12) as 1 | 2 | 4 | 12,
    ...overrides,
  };
}

function toRows(rows: ScheduleRow[], rate: string): LoanScheduleRow[] {
  return rows.map((r) => ({
    ...r,
    principalPaidPaise: 0,
    interestPaidPaise: 0,
    penaltyPaise: 0,
    penaltyPaidPaise: 0,
    status: "upcoming",
    rateApplied: rate,
  }));
}

const owedP = (r: LoanScheduleRow) => r.principalDuePaise - r.principalPaidPaise;
const owedI = (r: LoanScheduleRow) => r.interestDuePaise - r.interestPaidPaise;
const owedPen = (r: LoanScheduleRow) => r.penaltyPaise - r.penaltyPaidPaise;
const owedRow = (r: LoanScheduleRow) => owedP(r) + owedI(r) + owedPen(r);

export function rowStatus(r: LoanScheduleRow, today: Date, graceDays: number): LoanScheduleRow["status"] {
  if (r.status === "waived") return "waived";
  if (owedRow(r) <= 0) return "paid";
  if (today > utcAddDays(r.dueDate, graceDays)) return "overdue";
  const paid = r.principalPaidPaise + r.interestPaidPaise + r.penaltyPaidPaise;
  if (paid > 0) return "partially_paid";
  return today >= r.dueDate ? "due" : "upcoming";
}

export function loanSummary(l: LoanDoc, today: Date) {
  const rows = l.schedule.filter((r) => r.status !== "waived");
  const due = rows.filter((r) => r.dueDate <= today);
  const overdueRows = rows.filter((r) => rowStatus(r, today, l.graceDays) === "overdue");
  const next = rows.find((r) => r.dueDate > today && owedRow(r) > 0) ?? rows.find((r) => owedRow(r) > 0);
  return {
    outstandingPrincipalPaise: l.outstandingPrincipalPaise,
    interestChargedPaise: due.reduce((s, r) => s + r.interestDuePaise, 0),
    interestPaidPaise: l.totalInterestPaidPaise,
    interestOutstandingPaise: due.reduce((s, r) => s + owedI(r), 0),
    penaltyOutstandingPaise: rows.reduce((s, r) => s + owedPen(r), 0),
    overdueAmountPaise: overdueRows.reduce((s, r) => s + owedRow(r), 0),
    overdueInstallments: overdueRows.length,
    scheduledInterestPaise: rows.reduce((s, r) => s + r.interestDuePaise, 0),
    nextDue: next ? { sequence: next.sequence, dueDate: next.dueDate, amountPaise: owedRow(next) } : null,
  };
}

function presentLoan(l: LoanDoc, today: Date) {
  return {
    ...l,
    schedule: l.schedule.map((r) => ({ ...r, status: rowStatus(r, today, l.graceDays), outstandingPaise: Math.max(0, owedRow(r)) })),
    summary: loanSummary(l, today),
  };
}

async function getLoanDoc(ctx: OrgContext, id: ObjectId) {
  const c = await cols();
  const l = await c.loans.findOne({ _id: id, organizationId: ctx.orgId });
  if (!l) throw notFound("Loan");
  return l;
}

/* ------------------------------------------------------------------ lifecycle */

export function previewSchedule(input: z.infer<typeof LoanPreviewSchema>) {
  const annualRate = annualFromInput(input.rate, input.ratePeriod);
  if (input.firstDueDate <= input.disbursedOn) throw badRequest("First due date must be after the disbursement date");
  const rows = buildLoanSchedule({
    principalPaise: input.amount,
    annualRate,
    method: input.interestMethod,
    tenure: input.tenure,
    frequency: input.repaymentFrequency,
    disbursedOn: input.disbursedOn,
    firstDueDate: input.firstDueDate,
    dayCount: input.dayCount,
    compoundingPerYear: (input.compoundingPerYear ?? 12) as 1 | 2 | 4 | 12,
    roundEmiToRupee: input.roundEmiToRupee,
  });
  return {
    annualRate,
    method: input.interestMethod,
    emiPaise: input.interestMethod === "reducing_balance" ? emiFor(input.amount, annualRate, input.tenure, PERIODS_PER_YEAR[input.repaymentFrequency], input.roundEmiToRupee) : null,
    rows,
    totals: scheduleTotals(rows),
  };
}

export async function applyLoan(ctx: OrgContext, input: z.infer<typeof LoanApplySchema>) {
  const c = await cols();
  const member = await c.members.findOne({ _id: new ObjectId(input.memberId), organizationId: ctx.orgId });
  if (!member) throw notFound("Member");
  if (member.status !== "active") throw badRequest("Member is not active");
  const now = new Date();
  const annualRate = annualFromInput(input.rate, input.ratePeriod);
  const doc: LoanDoc = {
    _id: new ObjectId(),
    organizationId: ctx.orgId,
    loanNumber: await fyNumber(ctx.org, "LOAN", todayIn(ctx.org.settings.timezone)),
    memberId: member._id,
    purpose: input.purpose,
    requestedPaise: input.amount,
    approvedPaise: null,
    principalPaise: null,
    interestMethod: input.interestMethod,
    annualRate,
    rateInput: { value: input.rate, period: input.ratePeriod },
    compoundingPerYear: input.interestMethod === "compound" ? input.compoundingPerYear ?? 12 : null,
    dayCount: input.dayCount,
    tenure: input.interestMethod === "compound" ? input.tenure : input.tenure,
    repaymentFrequency: input.repaymentFrequency,
    firstDueDate: null,
    disbursedOn: null,
    disbursementAccountId: null,
    graceDays: input.graceDays,
    lateFee: input.lateFee,
    allocationOrder: input.allocationOrder,
    prepaymentMode: input.prepaymentMode,
    status: "applied",
    rateHistory: [],
    schedule: [],
    outstandingPrincipalPaise: 0,
    totalInterestPaidPaise: 0,
    totalPenaltyPaidPaise: 0,
    totalPrincipalPaidPaise: 0,
    appliedBy: ctx.user._id,
    notes: input.notes,
    createdAt: now,
    updatedAt: now,
  };
  await c.loans.insertOne(doc);
  await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "loan.apply", entityType: "loan", entityId: doc._id, after: { requestedPaise: doc.requestedPaise, annualRate, method: doc.interestMethod } });
  return doc;
}

export async function approveLoan(ctx: OrgContext, id: ObjectId, input: z.infer<typeof LoanApproveSchema>) {
  const c = await cols();
  const l = await getLoanDoc(ctx, id);
  if (l.status !== "applied") throw badRequest(`Loan is ${l.status}`);
  const $set: Partial<LoanDoc> = { status: "approved", approvedPaise: input.approvedAmount, approvedBy: ctx.user._id, approvedAt: new Date(), updatedAt: new Date() };
  if (input.rate) {
    if (!ctx.can("interest.manage")) throw forbidden("You are not allowed to change interest rates");
    $set.annualRate = annualFromInput(input.rate, input.ratePeriod ?? "annual");
    $set.rateInput = { value: input.rate, period: input.ratePeriod ?? "annual" };
  }
  if (input.tenure) $set.tenure = input.tenure;
  if (input.notes) $set.notes = [l.notes, input.notes].filter(Boolean).join("\n");
  const r = await c.loans.updateOne({ _id: id, organizationId: ctx.orgId, status: "applied" }, { $set });
  if (r.modifiedCount !== 1) throw conflict("Loan changed, please reload");
  await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "loan.approve", entityType: "loan", entityId: id, before: { requestedPaise: l.requestedPaise, annualRate: l.annualRate }, after: $set });
  await notifyMember(ctx.orgId, l.memberId, { type: "loan.approved", title: "Loan approved", body: `Your loan ${l.loanNumber} of ${formatMoney(input.approvedAmount, ctx.org.settings.currency)} has been approved.`, link: `/org/${ctx.orgId}/my`, dedupeKey: `loan-approved:${id}` });
  return getLoan(ctx, id);
}

export async function rejectLoan(ctx: OrgContext, id: ObjectId, reasonText: string) {
  const c = await cols();
  const l = await getLoanDoc(ctx, id);
  const r = await c.loans.updateOne({ _id: id, organizationId: ctx.orgId, status: { $in: ["applied", "approved"] } }, { $set: { status: "rejected", rejectionReason: reasonText, updatedAt: new Date() } });
  if (r.modifiedCount !== 1) throw badRequest("Only applied or approved loans can be rejected");
  await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "loan.reject", entityType: "loan", entityId: id, reason: reasonText });
  await notifyMember(ctx.orgId, l.memberId, { type: "loan.rejected", title: "Loan not approved", body: `Your loan application ${l.loanNumber} was not approved: ${reasonText}`, link: `/org/${ctx.orgId}/my`, dedupeKey: `loan-rejected:${id}` });
  return { ok: true };
}

export async function disburseLoan(ctx: OrgContext, id: ObjectId, input: z.infer<typeof LoanDisburseSchema>) {
  const c = await cols();
  const l = await getLoanDoc(ctx, id);
  if (l.status !== "approved" || !l.approvedPaise) throw badRequest("Only approved loans can be disbursed");
  if (input.firstDueDate <= input.date) throw badRequest("First due date must be after the disbursement date");
  const principal = l.approvedPaise;
  const terms = termsOf(l, { principalPaise: principal, disbursedOn: input.date, firstDueDate: input.firstDueDate, roundEmiToRupee: input.roundEmiToRupee });
  const rows = toRows(buildLoanSchedule(terms), l.annualRate);
  const now = new Date();
  await withTransaction(async (session) => {
    const account = await requireAccount(ctx.orgId, input.accountId, session);
    const bal = await balanceOf(ctx.orgId, account._id, session);
    if (bal < principal) throw badRequest(`Insufficient balance in ${account.name} (${formatMoney(bal, ctx.org.settings.currency)})`);
    const claimed = await c.loans.updateOne({ _id: id, status: "approved" }, { $set: { status: "active" } }, { session });
    if (claimed.modifiedCount !== 1) throw conflict("Loan was already disbursed");
    const txn = await postTransaction(
      {
        org: ctx.org,
        type: "loan_disbursement",
        date: input.date,
        description: `Loan ${l.loanNumber} disbursed`,
        lines: [
          { accountKey: LOANS_RECEIVABLE, debitPaise: principal },
          { accountKey: faKey(account._id), creditPaise: principal },
        ],
        createdBy: ctx.user._id,
        memberId: l.memberId,
        sourceType: "loan",
        sourceId: l._id,
      },
      session,
    );
    await c.loans.updateOne(
      { _id: id },
      {
        $set: {
          principalPaise: principal,
          disbursedOn: input.date,
          firstDueDate: input.firstDueDate,
          disbursementAccountId: account._id,
          disbursedBy: ctx.user._id,
          disbursementTransactionId: txn._id,
          schedule: rows,
          outstandingPrincipalPaise: principal,
          rateHistory: [{ annualRate: l.annualRate, effectiveFrom: input.date, setBy: ctx.user._id, at: now }],
          updatedAt: now,
        },
      },
      { session },
    );
    const totals = scheduleTotals(rows);
    await recordCalc(ctx, l, "schedule", {
      method: l.interestMethod,
      annualRate: l.annualRate,
      principalPaise: principal,
      periodStart: input.date,
      periodEnd: rows[rows.length - 1].dueDate,
      periods: rows.length,
      interestPaise: totals.interestPaise,
      details: { rows: rows.map((r) => ({ sequence: r.sequence, dueDate: r.dueDate, principal: r.principalDuePaise, interest: r.interestDuePaise })), dayCount: l.dayCount, compoundingPerYear: l.compoundingPerYear, frequency: l.repaymentFrequency },
    }, session);
    await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "loan.disburse", entityType: "loan", entityId: id, after: { principalPaise: principal, transaction: txn.number } }, session);
  });
  return getLoan(ctx, id);
}

async function recordCalc(
  ctx: OrgContext,
  l: LoanDoc,
  purpose: InterestCalculationDoc["purpose"],
  v: Omit<InterestCalculationDoc, "_id" | "organizationId" | "subjectType" | "subjectId" | "purpose" | "createdAt" | "createdBy">,
  session?: import("mongodb").ClientSession,
) {
  const c = await cols();
  await c.interestCalculations.insertOne(
    { _id: new ObjectId(), organizationId: ctx.orgId, subjectType: "loan", subjectId: l._id, purpose, createdBy: ctx.user._id, createdAt: new Date(), ...v },
    { session },
  );
}

/* ------------------------------------------------------------------ repayment allocation */

export interface AllocationResult {
  rows: LoanScheduleRow[];
  allocations: { sequence: number; principalPaise: number; interestPaise: number; penaltyPaise: number }[];
  principalPaise: number;
  interestPaise: number;
  penaltyPaise: number;
  prepaymentPaise: number;
  advancePaise: number;
  unappliedPaise: number;
  outstandingPrincipalAfterPaise: number;
  closed: boolean;
  closureQuote?: ClosureQuote;
}

function payRow(row: LoanScheduleRow, order: LoanDoc["allocationOrder"], left: number) {
  const a = { principalPaise: 0, interestPaise: 0, penaltyPaise: 0 };
  for (const comp of order) {
    if (left <= 0) break;
    if (comp === "penalty") {
      const x = Math.min(left, owedPen(row));
      row.penaltyPaidPaise += x;
      a.penaltyPaise += x;
      left -= x;
    } else if (comp === "interest") {
      const x = Math.min(left, owedI(row));
      row.interestPaidPaise += x;
      a.interestPaise += x;
      left -= x;
    } else {
      const x = Math.min(left, owedP(row));
      row.principalPaidPaise += x;
      a.principalPaise += x;
      left -= x;
    }
  }
  return { a, left };
}

/** Rebuild unpaid future rows after a principal prepayment (or rate change). */
function rebuildFuture(l: LoanDoc, rows: LoanScheduleRow[], fromIndex: number, balance: number, rate: string, mode: "reduce_tenure" | "reduce_emi"): LoanScheduleRow[] {
  const keep = rows.slice(0, fromIndex);
  const future = rows.slice(fromIndex).filter((r) => r.status !== "waived");
  if (balance <= 0) return keep;
  if (future.length === 0) return keep;
  const ppy = PERIODS_PER_YEAR[l.repaymentFrequency];
  const prevDate = fromIndex > 0 ? keep[keep.length - 1].dueDate : l.disbursedOn!;
  const m = future.length;
  let rebuilt: ScheduleRow[];
  if (l.interestMethod === "reducing_balance") {
    if (mode === "reduce_emi") {
      rebuilt = buildLoanSchedule({ ...termsOf(l), principalPaise: balance, annualRate: rate, tenure: m, firstDueDate: future[0].dueDate, disbursedOn: prevDate });
    } else {
      const oldEmi = future[0].totalDuePaise;
      rebuilt = [];
      let bal = balance;
      for (let k = 0; k < m && bal > 0; k++) {
        const r = percentToRat(rate);
        const interest = Number(roundHalfUp(BigInt(bal) * r.num, r.den * BigInt(ppy)));
        const principal = k === m - 1 ? bal : Math.min(bal, Math.max(1, oldEmi - interest));
        rebuilt.push({ sequence: 0, dueDate: future[k].dueDate, openingPrincipalPaise: bal, principalDuePaise: principal, interestDuePaise: interest, totalDuePaise: principal + interest });
        bal -= principal;
      }
    }
  } else if (l.interestMethod === "simple") {
    const n = mode === "reduce_emi" ? m : Math.max(1, Math.min(m, Math.ceil(balance / Math.max(1, future[0].principalDuePaise))));
    rebuilt = buildLoanSchedule({ ...termsOf(l), principalPaise: balance, annualRate: rate, tenure: n, firstDueDate: future[0].dueDate, disbursedOn: prevDate });
  } else {
    // flat: interest is contractual on the original principal; only principal is re-spread
    const ps = mode === "reduce_emi" ? splitPrincipal(balance, m) : greedy(balance, future.map((r) => r.principalDuePaise));
    rebuilt = future.slice(0, ps.length).map((r, k) => ({ sequence: 0, dueDate: r.dueDate, openingPrincipalPaise: 0, principalDuePaise: ps[k], interestDuePaise: r.interestDuePaise, totalDuePaise: ps[k] + r.interestDuePaise }));
    // rows dropped under reduce_tenure keep no obligation (their interest is waived)
  }
  let bal = balance;
  const out = rebuilt.map((r, k) => {
    const row: LoanScheduleRow = {
      ...r,
      sequence: keep.length + k + 1,
      openingPrincipalPaise: bal,
      principalPaidPaise: 0,
      interestPaidPaise: 0,
      penaltyPaise: 0,
      penaltyPaidPaise: 0,
      status: "upcoming",
      rateApplied: rate,
    };
    bal -= r.principalDuePaise;
    return row;
  });
  return [...keep, ...out];
}

function percentToRat(rate: string) {
  const m = /^(\d{1,3})(?:\.(\d{1,6}))?$/.exec(rate)!;
  const frac = m[2] ?? "";
  return { num: BigInt(m[1] + frac), den: 100n * 10n ** BigInt(frac.length) };
}
function splitPrincipal(total: number, n: number) {
  const base = Math.floor(total / n);
  const out = Array(n).fill(base);
  out[n - 1] += total - base * n;
  return out;
}
function greedy(total: number, sizes: number[]) {
  const out: number[] = [];
  let left = total;
  for (const s of sizes) {
    if (left <= 0) break;
    const x = Math.min(left, s);
    out.push(x);
    left -= x;
  }
  if (left > 0) out[out.length - 1] += left;
  return out;
}

export interface ClosureQuote {
  date: Date;
  outstandingPrincipalPaise: number;
  unpaidDueInterestPaise: number;
  accruedInterestPaise: number;
  accruedDays: number;
  accruedFrom: Date;
  penaltyPaise: number;
  waivedFutureInterestPaise: number;
  totalPaise: number;
  method: string;
  annualRate: string;
}

/** Amount needed to close the loan today: principal + unpaid due interest + accrued + penalties. */
export function closureQuote(l: LoanDoc, date: Date): ClosureQuote {
  if (l.status !== "active") throw badRequest("Only active loans can be closed");
  if (l.disbursedOn && date < l.disbursedOn) throw badRequest("Closure date is before disbursement");
  const rows = l.schedule.filter((r) => r.status !== "waived");
  const dueRows = rows.filter((r) => r.dueDate <= date);
  const futureRows = rows.filter((r) => r.dueDate > date);
  const lastDue = dueRows.length ? dueRows[dueRows.length - 1].dueDate : l.disbursedOn!;
  const unpaidDueInterest = dueRows.reduce((s, r) => s + owedI(r), 0);
  const penalty = rows.reduce((s, r) => s + owedPen(r), 0);
  let accrued = 0;
  let days = 0;
  const rate = l.rateHistory.length ? l.rateHistory[l.rateHistory.length - 1].annualRate : l.annualRate;
  if (futureRows.length) {
    const cur = futureRows[0];
    if (l.interestMethod === "flat") {
      const periodDays = Math.max(1, diffDays(cur.dueDate, lastDue));
      days = Math.max(0, diffDays(date, lastDue));
      accrued = Number(roundHalfUp(BigInt(cur.interestDuePaise) * BigInt(days), BigInt(periodDays))) - cur.interestPaidPaise;
    } else if (l.interestMethod === "compound") {
      const ci = compoundInterestBetween(l.outstandingPrincipalPaise, rate, (l.compoundingPerYear ?? 12) as 1 | 2 | 4 | 12, l.disbursedOn!, date, l.dayCount as DayCount);
      days = diffDays(date, l.disbursedOn!);
      accrued = ci.interestPaise - cur.interestPaidPaise;
    } else {
      const si = simpleInterestBetween(l.outstandingPrincipalPaise, rate, lastDue, date, l.dayCount as DayCount);
      days = si.days;
      accrued = si.interestPaise - cur.interestPaidPaise;
    }
    accrued = Math.max(0, accrued);
  }
  const waived = futureRows.reduce((s, r) => s + owedI(r), 0) - accrued;
  return {
    date,
    outstandingPrincipalPaise: l.outstandingPrincipalPaise,
    unpaidDueInterestPaise: unpaidDueInterest,
    accruedInterestPaise: accrued,
    accruedDays: days,
    accruedFrom: lastDue,
    penaltyPaise: penalty,
    waivedFutureInterestPaise: Math.max(0, waived),
    totalPaise: l.outstandingPrincipalPaise + unpaidDueInterest + accrued + penalty,
    method: l.interestMethod,
    annualRate: rate,
  };
}

/**
 * Pure allocation of a repayment against the schedule (no I/O):
 * 1. Due rows (oldest first) by the loan's allocation order (default penalty → interest → principal)
 * 2. Remainder → either advance payment of upcoming rows, or principal prepayment (reschedules)
 * 3. closeLoan: amount must equal the closure quote; future interest is waived.
 */
export function allocateRepayment(l: LoanDoc, amount: number, date: Date, opts: { prepayment: boolean; closeLoan: boolean; currency?: string }): AllocationResult {
  if (l.status !== "active") throw badRequest("Repayments can only be recorded on active loans");
  const rows: LoanScheduleRow[] = structuredClone(l.schedule);
  const allocs = new Map<number, { sequence: number; principalPaise: number; interestPaise: number; penaltyPaise: number }>();
  const add = (seq: number, a: { principalPaise: number; interestPaise: number; penaltyPaise: number }) => {
    const cur = allocs.get(seq) ?? { sequence: seq, principalPaise: 0, interestPaise: 0, penaltyPaise: 0 };
    cur.principalPaise += a.principalPaise;
    cur.interestPaise += a.interestPaise;
    cur.penaltyPaise += a.penaltyPaise;
    allocs.set(seq, cur);
  };
  let left = amount;
  let prepayment = 0;
  let advance = 0;
  let quote: ClosureQuote | undefined;
  let closed = false;

  if (opts.closeLoan) {
    quote = closureQuote(l, date);
    if (amount !== quote.totalPaise) throw badRequest(`Closure amount must be exactly ${formatMoney(quote.totalPaise, opts.currency)}`);
    for (const r of rows.filter((x) => x.status !== "waived")) {
      if (r.dueDate <= date) {
        const { a, left: l2 } = payRow(r, ["penalty", "interest", "principal"], left);
        left = l2;
        add(r.sequence, a);
      }
    }
    // the current period: accrued interest only; later periods: interest waived
    const future = rows.filter((x) => x.status !== "waived" && x.dueDate > date);
    future.forEach((r, idx) => {
      const pen = Math.min(left, owedPen(r));
      r.penaltyPaidPaise += pen;
      left -= pen;
      r.interestDuePaise = idx === 0 ? r.interestPaidPaise + quote!.accruedInterestPaise : r.interestPaidPaise;
      const i = Math.min(left, owedI(r));
      r.interestPaidPaise += i;
      left -= i;
      const p = Math.min(left, owedP(r));
      r.principalPaidPaise += p;
      left -= p;
      r.totalDuePaise = r.principalDuePaise + r.interestDuePaise;
      add(r.sequence, { principalPaise: p, interestPaise: i, penaltyPaise: pen });
    });
    if (left !== 0) throw new Error("Closure allocation mismatch");
    closed = true;
  } else {
    for (const r of rows) {
      if (left <= 0) break;
      if (r.status === "waived" || r.dueDate > date || owedRow(r) <= 0) continue;
      const { a, left: l2 } = payRow(r, l.allocationOrder, left);
      left = l2;
      add(r.sequence, a);
    }
    if (left > 0 && !opts.prepayment) {
      for (const r of rows) {
        if (left <= 0) break;
        if (r.status === "waived" || owedRow(r) <= 0) continue;
        const before = left;
        const { a, left: l2 } = payRow(r, l.allocationOrder, left);
        left = l2;
        advance += before - left;
        add(r.sequence, a);
      }
    }
    if (left > 0 && opts.prepayment) {
      if (l.interestMethod === "compound") throw badRequest("Part-prepayment is not supported for compound (bullet) loans; close the loan instead");
      const outstandingAfterDues = rows.reduce((s, r) => s + (r.status === "waived" ? 0 : owedP(r)), 0);
      prepayment = Math.min(left, outstandingAfterDues);
      left -= prepayment;
    }
  }

  const principalPaid = [...allocs.values()].reduce((s, a) => s + a.principalPaise, 0) + prepayment;
  const interestPaid = [...allocs.values()].reduce((s, a) => s + a.interestPaise, 0);
  const penaltyPaid = [...allocs.values()].reduce((s, a) => s + a.penaltyPaise, 0);
  let outstanding = l.outstandingPrincipalPaise - principalPaid;
  let newRows = rows;
  if (prepayment > 0) {
    // rebuild from the first row that has nothing paid and is not yet due
    const idx = rows.findIndex((r) => r.status !== "waived" && r.dueDate > date && r.principalPaidPaise + r.interestPaidPaise + r.penaltyPaidPaise === 0);
    const remainingOnKept = rows.slice(0, idx === -1 ? rows.length : idx).reduce((s, r) => s + (r.status === "waived" ? 0 : owedP(r)), 0);
    const futureBalance = outstanding - remainingOnKept;
    const rate = l.rateHistory.length ? l.rateHistory[l.rateHistory.length - 1].annualRate : l.annualRate;
    newRows = idx === -1 ? rows : rebuildFuture(l, rows, idx, futureBalance, rate, l.prepaymentMode);
  }
  if (outstanding <= 0 && newRows.every((r) => r.status === "waived" || owedRow(r) <= 0)) closed = true;
  if (closed) outstanding = 0;
  return {
    rows: newRows,
    allocations: [...allocs.values()],
    principalPaise: principalPaid,
    interestPaise: interestPaid,
    penaltyPaise: penaltyPaid,
    prepaymentPaise: prepayment,
    advancePaise: advance,
    unappliedPaise: left,
    outstandingPrincipalAfterPaise: outstanding,
    closed,
    closureQuote: quote,
  };
}

export async function repayLoan(ctx: OrgContext, id: ObjectId, input: z.infer<typeof RepaySchema>) {
  const c = await cols();
  if (!ctx.org.settings.paymentMethods.includes(input.method)) throw badRequest(`Payment method "${input.method}" is not enabled`);
  const existing = await c.loanRepayments.findOne({ organizationId: ctx.orgId, idempotencyKey: input.idempotencyKey });
  if (existing) return { repayment: existing, duplicate: true };
  const l0 = await getLoanDoc(ctx, id);
  const preview = allocateRepayment(l0, input.amount, input.date, { ...input, currency: ctx.org.settings.currency });
  if (preview.unappliedPaise > 0) {
    throw badRequest(`Amount exceeds everything owed on this loan by ${formatMoney(preview.unappliedPaise, ctx.org.settings.currency)}`);
  }
  if (input.dryRun) return { preview, duplicate: false };
  if (l0.disbursedOn && input.date < l0.disbursedOn) throw badRequest("Repayment date is before disbursement");

  try {
    return await withTransaction(async (session) => {
      const l = await c.loans.findOne({ _id: id, organizationId: ctx.orgId }, { session });
      if (!l) throw notFound("Loan");
      const res = allocateRepayment(l, input.amount, input.date, { ...input, currency: ctx.org.settings.currency }); // recompute against fresh state
      const account = await requireAccount(ctx.orgId, input.accountId, session);
      const now = new Date();
      const upd = await c.loans.updateOne(
        { _id: id, organizationId: ctx.orgId, updatedAt: l.updatedAt, status: "active" },
        {
          $set: {
            schedule: res.rows,
            outstandingPrincipalPaise: res.outstandingPrincipalAfterPaise,
            status: res.closed ? "closed" : "active",
            ...(res.closed ? { closedAt: now } : {}),
            updatedAt: now,
          },
          $inc: { totalPrincipalPaidPaise: res.principalPaise, totalInterestPaidPaise: res.interestPaise, totalPenaltyPaidPaise: res.penaltyPaise },
        },
        { session },
      );
      if (upd.modifiedCount !== 1) throw conflict("Loan was updated by someone else, please retry");
      const lines: LedgerLine[] = [{ accountKey: faKey(account._id), debitPaise: input.amount }];
      if (res.principalPaise) lines.push({ accountKey: LOANS_RECEIVABLE, creditPaise: res.principalPaise });
      if (res.interestPaise) lines.push({ accountKey: INCOME_KEYS.interest, creditPaise: res.interestPaise });
      if (res.penaltyPaise) lines.push({ accountKey: INCOME_KEYS.penalty, creditPaise: res.penaltyPaise });
      const repId = new ObjectId();
      const txn = await postTransaction(
        {
          org: ctx.org,
          type: "loan_repayment",
          date: input.date,
          description: `Loan ${l.loanNumber} repayment${res.closed ? " (closure)" : res.prepaymentPaise ? " (prepayment)" : ""}`,
          lines,
          createdBy: ctx.user._id,
          memberId: l.memberId,
          sourceType: "loanRepayment",
          sourceId: repId,
        },
        session,
      );
      const member = await c.members.findOne({ _id: l.memberId }, { session, projection: { name: 1 } });
      const receipt = await issueReceipt(
        ctx.org,
        {
          sourceType: "loanRepayment",
          sourceId: repId,
          memberId: l.memberId,
          payerName: member?.name ?? "",
          amountPaise: input.amount,
          date: input.date,
          method: input.method,
          reference: input.reference,
          lines: [
            ...(res.principalPaise ? [{ description: `Loan ${l.loanNumber} — principal`, amountPaise: res.principalPaise }] : []),
            ...(res.interestPaise ? [{ description: `Loan ${l.loanNumber} — interest`, amountPaise: res.interestPaise }] : []),
            ...(res.penaltyPaise ? [{ description: `Loan ${l.loanNumber} — late fee`, amountPaise: res.penaltyPaise }] : []),
          ],
          issuedBy: ctx.user._id,
        },
        session,
      );
      const rep: LoanRepaymentDoc & { snapshot: unknown } = {
        _id: repId,
        organizationId: ctx.orgId,
        loanId: l._id,
        memberId: l.memberId,
        amountPaise: input.amount,
        principalPaise: res.principalPaise,
        interestPaise: res.interestPaise,
        penaltyPaise: res.penaltyPaise,
        date: input.date,
        method: input.method,
        reference: input.reference,
        accountId: account._id,
        kind: res.closed && input.closeLoan ? "closure" : res.prepaymentPaise ? "prepayment" : "installment",
        allocations: res.allocations,
        idempotencyKey: input.idempotencyKey,
        status: "verified",
        transactionId: txn._id,
        receiptId: receipt._id,
        recordedBy: ctx.user._id,
        createdAt: now,
        // state before this repayment, so the latest repayment can be reversed exactly
        snapshot: { schedule: l.schedule, outstandingPrincipalPaise: l.outstandingPrincipalPaise, status: l.status, updatedAt: now },
      };
      await c.loanRepayments.insertOne(rep, { session });
      if (res.closureQuote || res.prepaymentPaise) {
        await recordCalc(ctx, l, res.closureQuote ? "closure_quote" : "prepayment_reschedule", {
          method: l.interestMethod,
          annualRate: res.closureQuote?.annualRate ?? l.annualRate,
          principalPaise: l.outstandingPrincipalPaise,
          periodStart: res.closureQuote?.accruedFrom ?? input.date,
          periodEnd: input.date,
          days: res.closureQuote?.accruedDays,
          dayCount: l.dayCount,
          interestPaise: res.closureQuote?.accruedInterestPaise ?? 0,
          details: { quote: res.closureQuote, prepaymentPaise: res.prepaymentPaise, mode: l.prepaymentMode },
        }, session);
      }
      await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "loan.repay", entityType: "loan", entityId: id, after: { amountPaise: input.amount, principal: res.principalPaise, interest: res.interestPaise, penalty: res.penaltyPaise, closed: res.closed } }, session);
      return { repayment: rep, receiptId: receipt._id, closed: res.closed, duplicate: false };
    });
  } catch (e) {
    if (isDuplicateKeyError(e)) {
      const r = await c.loanRepayments.findOne({ organizationId: ctx.orgId, idempotencyKey: input.idempotencyKey });
      if (r) return { repayment: r, duplicate: true };
    }
    throw e;
  }
}

/** Reverse the most recent repayment on a loan (restores the exact prior schedule). */
export async function reverseRepayment(ctx: OrgContext, loanId: ObjectId, repaymentId: ObjectId, reasonText: string) {
  const c = await cols();
  const today = todayIn(ctx.org.settings.timezone);
  return withTransaction(async (session) => {
    const rep = (await c.loanRepayments.findOne({ _id: repaymentId, loanId, organizationId: ctx.orgId }, { session })) as (LoanRepaymentDoc & { snapshot?: { schedule: LoanScheduleRow[]; outstandingPrincipalPaise: number; status: LoanDoc["status"] } }) | null;
    if (!rep || rep.status !== "verified") throw notFound("Repayment");
    const latest = await c.loanRepayments.find({ loanId, organizationId: ctx.orgId, status: "verified" }, { session }).sort({ createdAt: -1, _id: -1 }).limit(1).toArray();
    if (!latest[0]._id.equals(rep._id)) throw badRequest("Only the most recent repayment can be reversed; reverse later repayments first");
    if (!rep.snapshot) throw badRequest("This repayment cannot be reversed automatically");
    await c.loanRepayments.updateOne({ _id: rep._id, status: "verified" }, { $set: { status: "reversed" } }, { session });
    await c.loans.updateOne(
      { _id: loanId, organizationId: ctx.orgId },
      {
        $set: { schedule: rep.snapshot.schedule, outstandingPrincipalPaise: rep.snapshot.outstandingPrincipalPaise, status: rep.snapshot.status, closedAt: undefined, updatedAt: new Date() },
        $inc: { totalPrincipalPaidPaise: -rep.principalPaise, totalInterestPaidPaise: -rep.interestPaise, totalPenaltyPaidPaise: -rep.penaltyPaise },
      },
      { session },
    );
    const rev = await reverseTransaction(ctx.org, rep.transactionId, reasonText, ctx.user._id, today, session);
    await cancelReceiptFor(ctx.orgId, "loanRepayment", rep._id, session);
    await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "loan.repayment_reverse", entityType: "loanRepayment", entityId: rep._id, after: { reversal: rev.number }, reason: reasonText }, session);
    return { ok: true };
  });
}

/** Change the rate from a date: only rows due on/after that date and not yet paid are recomputed. */
export async function changeRate(ctx: OrgContext, id: ObjectId, input: z.infer<typeof RateChangeSchema>) {
  const c = await cols();
  const l = await getLoanDoc(ctx, id);
  if (l.status !== "active") throw badRequest("Rates can only be changed on active loans");
  if (!["reducing_balance", "simple"].includes(l.interestMethod)) throw badRequest("Rate changes are supported for reducing-balance and simple-interest loans");
  const rate = annualFromInput(input.rate, input.ratePeriod);
  const idx = l.schedule.findIndex((r) => r.status !== "waived" && r.dueDate >= input.effectiveFrom && r.principalPaidPaise + r.interestPaidPaise + r.penaltyPaidPaise === 0);
  if (idx === -1) throw badRequest("No unpaid installments on or after that date");
  const keptPrincipal = l.schedule.slice(0, idx).reduce((s, r) => s + (r.status === "waived" ? 0 : owedP(r)), 0);
  const balance = l.outstandingPrincipalPaise - keptPrincipal;
  const rows = rebuildFuture(l, l.schedule, idx, balance, rate, "reduce_emi");
  const now = new Date();
  await c.loans.updateOne(
    { _id: id, organizationId: ctx.orgId, updatedAt: l.updatedAt },
    { $set: { schedule: rows, annualRate: rate, updatedAt: now }, $push: { rateHistory: { annualRate: rate, effectiveFrom: input.effectiveFrom, setBy: ctx.user._id, at: now, reason: input.reason } } },
  );
  await recordCalc(ctx, l, "prepayment_reschedule", { method: l.interestMethod, annualRate: rate, principalPaise: balance, periodStart: input.effectiveFrom, periodEnd: rows[rows.length - 1].dueDate, interestPaise: rows.slice(idx).reduce((s, r) => s + r.interestDuePaise, 0), details: { reason: "rate_change", previousRate: l.annualRate } });
  await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "loan.rate_change", entityType: "loan", entityId: id, before: { annualRate: l.annualRate }, after: { annualRate: rate, effectiveFrom: input.effectiveFrom }, reason: input.reason });
  await notifyMember(ctx.orgId, l.memberId, { type: "loan.rate_changed", title: "Loan schedule updated", body: `The interest rate on ${l.loanNumber} changes to ${rate}% p.a. from ${input.effectiveFrom.toISOString().slice(0, 10)}.`, link: `/org/${ctx.orgId}/my`, dedupeKey: `loan-rate:${id}:${now.getTime()}` });
  return getLoan(ctx, id);
}

/* ------------------------------------------------------------------ queries */

export const LoanListQuery = z.object({
  status: z.enum(["applied", "approved", "rejected", "active", "closed"]).optional(),
  memberId: z.string().optional(),
});

export async function listLoans(ctx: OrgContext, q: z.infer<typeof LoanListQuery>, restrictMemberId?: ObjectId) {
  const c = await cols();
  const filter: Record<string, unknown> = { organizationId: ctx.orgId };
  if (q.status) filter.status = q.status;
  if (restrictMemberId) filter.memberId = restrictMemberId;
  else if (q.memberId && ObjectId.isValid(q.memberId)) filter.memberId = new ObjectId(q.memberId);
  const loans = await c.loans.find(filter).sort({ createdAt: -1 }).limit(500).toArray();
  const members = await c.members.find({ _id: { $in: loans.map((l) => l.memberId) } }, { projection: { name: 1, membershipNumber: 1 } }).toArray();
  const mm = new Map(members.map((m) => [m._id.toHexString(), m]));
  const today = todayIn(ctx.org.settings.timezone);
  return loans.map((l) => {
    const { schedule: _s, ...rest } = l;
    return { ...rest, member: mm.get(l.memberId.toHexString()) ?? null, summary: l.status === "active" || l.status === "closed" ? loanSummary(l, today) : null };
  });
}

export async function getLoan(ctx: OrgContext, id: ObjectId, restrictMemberId?: ObjectId) {
  const c = await cols();
  const l = await getLoanDoc(ctx, id);
  if (restrictMemberId && !l.memberId.equals(restrictMemberId)) throw notFound("Loan");
  const today = todayIn(ctx.org.settings.timezone);
  const [member, repayments, calcs] = await Promise.all([
    c.members.findOne({ _id: l.memberId }, { projection: { name: 1, membershipNumber: 1, phone: 1 } }),
    c.loanRepayments.find({ loanId: id, organizationId: ctx.orgId }, { projection: { snapshot: 0 } }).sort({ date: 1, createdAt: 1 }).toArray(),
    c.interestCalculations.find({ subjectId: id, organizationId: ctx.orgId }).sort({ createdAt: -1 }).limit(20).toArray(),
  ]);
  return { loan: presentLoan(l, today), member, repayments, interestCalculations: calcs };
}

export async function getClosureQuote(ctx: OrgContext, id: ObjectId, date?: Date) {
  const l = await getLoanDoc(ctx, id);
  return closureQuote(l, date ?? todayIn(ctx.org.settings.timezone));
}
