/**
 * Interest engine — pure, exact (BigInt rational arithmetic), unit tested.
 * Every result is rounded half-up to whole paise exactly once, at the end of the
 * calculation it belongs to.
 *
 * Rates are decimal strings of a percentage ("12", "10.5", "1.25").
 */
import { roundHalfUp, splitEvenly } from "@/lib/money";
import { diffDays, utcAddDays, utcAddMonths } from "@/lib/dates";

export interface Rational {
  num: bigint;
  den: bigint;
}

/** "10.5" (percent) → 105/1000 as a fraction of 1 */
export function percentToRational(rate: string): Rational {
  const m = /^(\d{1,3})(?:\.(\d{1,6}))?$/.exec(rate.trim());
  if (!m) throw new Error(`Invalid rate ${rate}`);
  const frac = m[2] ?? "";
  const num = BigInt(m[1] + frac);
  const den = 100n * 10n ** BigInt(frac.length);
  return { num, den };
}

/** Annual nominal rate from a monthly input rate: 1% p.m. → 12% p.a. */
export function annualFromInput(value: string, period: "annual" | "monthly"): string {
  if (period === "annual") return normalizeRate(value);
  const r = percentToRational(value);
  // multiply by 12, express back as a decimal string with up to 6 decimals
  return rationalPercentString({ num: r.num * 12n, den: r.den });
}

function normalizeRate(v: string) {
  return rationalPercentString(percentToRational(v));
}

function rationalPercentString(r: Rational): string {
  // r is a fraction of 1; convert to percent with up to 6 decimals (exact for our inputs)
  const scaled = (r.num * 100n * 1_000_000n) / r.den;
  const int = scaled / 1_000_000n;
  const frac = (scaled % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${int}.${frac}` : `${int}`;
}

export type DayCount = "actual_365" | "actual_360" | "30_360";

/** Day count between two dates for the convention. 30/360 uses the US (NASD) rule. */
export function dayCountDays(start: Date, end: Date, dc: DayCount): number {
  if (dc !== "30_360") return diffDays(end, start);
  let d1 = start.getUTCDate();
  let d2 = end.getUTCDate();
  if (d1 === 31) d1 = 30;
  if (d2 === 31 && d1 === 30) d2 = 30;
  return (
    (end.getUTCFullYear() - start.getUTCFullYear()) * 360 + (end.getUTCMonth() - start.getUTCMonth()) * 30 + (d2 - d1)
  );
}

function basis(dc: DayCount): bigint {
  return dc === "actual_365" ? 365n : 360n;
}

/** Simple interest: I = P × R × T, with T = days / basis. */
export function simpleInterest(principalPaise: number, annualRate: string, days: number, dc: DayCount = "actual_365"): number {
  if (days <= 0 || principalPaise <= 0) return 0;
  const r = percentToRational(annualRate);
  return Number(roundHalfUp(BigInt(principalPaise) * r.num * BigInt(days), r.den * basis(dc)));
}

/** Simple interest between two dates. */
export function simpleInterestBetween(principalPaise: number, annualRate: string, start: Date, end: Date, dc: DayCount = "actual_365") {
  const days = dayCountDays(start, end, dc);
  return { days, interestPaise: simpleInterest(principalPaise, annualRate, days, dc) };
}

/**
 * Compound interest: A = P (1 + r/m)^(k) for k whole compounding periods, plus
 * simple interest on the compounded amount for any stub days. Returns interest (A − P).
 */
export function compoundInterest(
  principalPaise: number,
  annualRate: string,
  compoundingPerYear: number,
  wholePeriods: number,
  stubDays = 0,
  dc: DayCount = "actual_365",
): number {
  if (principalPaise <= 0) return 0;
  const r = percentToRational(annualRate);
  const m = BigInt(compoundingPerYear);
  // (1 + num/(den*m))^k = (den*m + num)^k / (den*m)^k — exact
  const base = r.den * m;
  const k = BigInt(wholePeriods);
  let num = BigInt(principalPaise) * (base + r.num) ** k;
  let den = base ** k;
  if (stubDays > 0) {
    // A × (1 + r × d / basis)
    const b = basis(dc);
    num = num * (r.den * b + r.num * BigInt(stubDays));
    den = den * r.den * b;
  }
  const amount = roundHalfUp(num, den);
  return Number(amount) - principalPaise;
}

/** Compound interest between two dates: whole compounding periods by calendar months + stub days. */
export function compoundInterestBetween(
  principalPaise: number,
  annualRate: string,
  compoundingPerYear: 1 | 2 | 4 | 12,
  start: Date,
  end: Date,
  dc: DayCount = "actual_365",
) {
  const monthsPer = 12 / compoundingPerYear;
  let periods = 0;
  let cursor = start;
  while (utcAddMonths(start, (periods + 1) * monthsPer) <= end) periods++;
  cursor = utcAddMonths(start, periods * monthsPer);
  const stub = dayCountDays(cursor, end, dc);
  return { periods, stubDays: stub, interestPaise: compoundInterest(principalPaise, annualRate, compoundingPerYear, periods, stub, dc) };
}

/* ---------------------------------------------------------------- Loan schedules */

export type RepaymentFrequency = "weekly" | "biweekly" | "monthly" | "quarterly";

export const PERIODS_PER_YEAR: Record<RepaymentFrequency, number> = { weekly: 52, biweekly: 26, monthly: 12, quarterly: 4 };

export function nthDueDate(first: Date, freq: RepaymentFrequency, n: number): Date {
  // n is 0-based; month schedules computed from the anchor so the 31st clamps without drift
  switch (freq) {
    case "weekly":
      return utcAddDays(first, 7 * n);
    case "biweekly":
      return utcAddDays(first, 14 * n);
    case "monthly":
      return utcAddMonths(first, n);
    case "quarterly":
      return utcAddMonths(first, 3 * n);
  }
}

export interface ScheduleRow {
  sequence: number;
  dueDate: Date;
  openingPrincipalPaise: number;
  principalDuePaise: number;
  interestDuePaise: number;
  totalDuePaise: number;
}

export interface LoanTerms {
  principalPaise: number;
  annualRate: string;
  method: "simple" | "compound" | "flat" | "reducing_balance";
  tenure: number;
  frequency: RepaymentFrequency;
  disbursedOn: Date;
  firstDueDate: Date;
  dayCount?: DayCount;
  compoundingPerYear?: 1 | 2 | 4 | 12;
  /** Round EMI up to whole rupees (common practice). Default false (paise). */
  roundEmiToRupee?: boolean;
}

/** EMI for a reducing-balance loan: P·i·(1+i)^n / ((1+i)^n − 1), exact then rounded. */
export function emi(principalPaise: number, annualRate: string, n: number, periodsPerYear: number, roundToRupee = false): number {
  const r = percentToRational(annualRate);
  if (r.num === 0n) return Math.ceil(principalPaise / n);
  // periodic rate i = b/a
  const a = r.den * BigInt(periodsPerYear);
  const b = r.num;
  const pow = (a + b) ** BigInt(n);
  const aPow = a ** BigInt(n);
  const num = BigInt(principalPaise) * b * pow;
  const den = a * (pow - aPow);
  if (roundToRupee) {
    // ceil to the next rupee so the loan clears within tenure
    const q = num / (den * 100n);
    return Number((num % (den * 100n) === 0n ? q : q + 1n) * 100n);
  }
  return Number(roundHalfUp(num, den));
}

function periodicInterest(balance: number, annualRate: string, periodsPerYear: number) {
  const r = percentToRational(annualRate);
  return Number(roundHalfUp(BigInt(balance) * r.num, r.den * BigInt(periodsPerYear)));
}

/** Build a repayment schedule. Totals are exact: principal rows always sum to the principal. */
export function buildLoanSchedule(t: LoanTerms): ScheduleRow[] {
  const n = t.tenure;
  const dc = t.dayCount ?? "actual_365";
  const ppy = PERIODS_PER_YEAR[t.frequency];
  const due = (k: number) => nthDueDate(t.firstDueDate, t.frequency, k);
  const rows: ScheduleRow[] = [];

  if (t.method === "reducing_balance") {
    const e = emi(t.principalPaise, t.annualRate, n, ppy, t.roundEmiToRupee);
    let bal = t.principalPaise;
    for (let k = 0; k < n; k++) {
      const interest = periodicInterest(bal, t.annualRate, ppy);
      let principal = Math.min(bal, Math.max(0, e - interest));
      if (k === n - 1) principal = bal; // final row clears rounding residue
      rows.push({ sequence: k + 1, dueDate: due(k), openingPrincipalPaise: bal, principalDuePaise: principal, interestDuePaise: interest, totalDuePaise: principal + interest });
      bal -= principal;
      if (bal === 0 && k < n - 1) break; // rupee-rounded EMI may finish early
    }
    return rows;
  }

  if (t.method === "flat") {
    // Interest on the ORIGINAL principal for the whole tenure, spread evenly.
    const years = { num: BigInt(n), den: BigInt(ppy) };
    const r = percentToRational(t.annualRate);
    const totalInterest = Number(roundHalfUp(BigInt(t.principalPaise) * r.num * years.num, r.den * years.den));
    const ps = splitEvenly(t.principalPaise, n);
    const is = splitEvenly(totalInterest, n);
    let bal = t.principalPaise;
    for (let k = 0; k < n; k++) {
      rows.push({ sequence: k + 1, dueDate: due(k), openingPrincipalPaise: bal, principalDuePaise: ps[k], interestDuePaise: is[k], totalDuePaise: ps[k] + is[k] });
      bal -= ps[k];
    }
    return rows;
  }

  if (t.method === "simple") {
    // Equal principal; simple interest on the outstanding principal for the actual days in each period.
    const ps = splitEvenly(t.principalPaise, n);
    let bal = t.principalPaise;
    let prev = t.disbursedOn;
    for (let k = 0; k < n; k++) {
      const d = due(k);
      const interest = simpleInterestBetween(bal, t.annualRate, prev, d, dc).interestPaise;
      rows.push({ sequence: k + 1, dueDate: d, openingPrincipalPaise: bal, principalDuePaise: ps[k], interestDuePaise: interest, totalDuePaise: ps[k] + interest });
      bal -= ps[k];
      prev = d;
    }
    return rows;
  }

  // compound: bullet repayment at maturity (last due date) with compounded interest
  const maturity = due(n - 1);
  const ci = compoundInterestBetween(t.principalPaise, t.annualRate, t.compoundingPerYear ?? 12, t.disbursedOn, maturity, dc);
  rows.push({ sequence: 1, dueDate: maturity, openingPrincipalPaise: t.principalPaise, principalDuePaise: t.principalPaise, interestDuePaise: ci.interestPaise, totalDuePaise: t.principalPaise + ci.interestPaise });
  return rows;
}

export function scheduleTotals(rows: Pick<ScheduleRow, "principalDuePaise" | "interestDuePaise">[]) {
  let principal = 0;
  let interest = 0;
  for (const r of rows) {
    principal += r.principalDuePaise;
    interest += r.interestDuePaise;
  }
  return { principalPaise: principal, interestPaise: interest, totalPaise: principal + interest };
}
