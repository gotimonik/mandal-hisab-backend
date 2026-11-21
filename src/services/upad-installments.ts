import { parseDateOnly } from "@/lib/dates";
import type { FundLoanDoc, UpadInstallmentPlan } from "@/types/models";

/**
 * Compulsory upad installments (Mandal setting "Upad in fixed installments").
 *
 * When it is on, a new upad is returned in `count` equal monthly installments, starting the month
 * after it is given — the same month its interest starts. Interest stays as it always was:
 * monthly rate % on what was still outstanding at the end of the previous month. So ₹80,000 at 1%
 * in 10 installments is: month 1 → ₹8,000 + ₹800 interest, month 2 → ₹8,000 + ₹720, …
 *
 *  - The installment is a whole rupee amount (rounded up); the last one is whatever is left.
 *  - Installments are counted cumulatively: returning more than due pays the next installments
 *    ahead; a missed installment stays due (carried forward) — no penalty.
 *  - The plan is fixed when the upad is given; changing the setting later doesn't touch old upads.
 */

const nextMonth = (m: string) => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 7);
};

/** The plan for a new upad, or null when the Mandal doesn't use fixed installments. */
export function makeInstallmentPlan(principalPaise: number, setting: { enabled: boolean; count: number } | undefined, firstMonth: string): UpadInstallmentPlan | null {
  if (!setting?.enabled || principalPaise <= 0) return null;
  const count = Math.max(1, Math.floor(setting.count));
  const amountPaise = Math.ceil(principalPaise / count / 100) * 100;
  return { count, amountPaise, firstMonth };
}

export interface InstallmentRow {
  sequence: number;
  period: string; // YYYY-MM
  dueDate: Date;
  amountPaise: number;
  paidPaise: number;
  status: "paid" | "partially_paid" | "overdue" | "due" | "upcoming";
}

export interface InstallmentStatus {
  count: number;
  amountPaise: number;
  firstMonth: string;
  lastMonth: string;
  rows: InstallmentRow[];
  /** principal returned so far */
  returnedPaise: number;
  /** installments due up to and including `month` that are not yet returned */
  duePaise: number;
  /** of which from months before `month` (missed) */
  overduePaise: number;
  /** this month's installment (part still unpaid) */
  thisMonthPaise: number;
  paidCount: number;
  next: { sequence: number; period: string; dueDate: Date; amountPaise: number } | null;
}

/** The installment rows of a plan for a principal (amounts only). */
export function installmentAmounts(principalPaise: number, plan: UpadInstallmentPlan) {
  const out: { sequence: number; period: string; amountPaise: number }[] = [];
  let left = principalPaise;
  let period = plan.firstMonth;
  for (let k = 1; k <= plan.count && left > 0; k++) {
    const amt = k === plan.count ? left : Math.min(plan.amountPaise, left);
    out.push({ sequence: k, period, amountPaise: amt });
    left -= amt;
    period = nextMonth(period);
  }
  return out;
}

/**
 * Where an upad stands against its installment plan.
 * @param month  the month to judge "due" by (YYYY-MM), normally the current month
 * @param returnedPaise principal returned so far (defaults to principal − outstanding)
 */
export function installmentStatus(
  loan: Pick<FundLoanDoc, "principalPaise" | "outstandingPaise" | "installmentPlan">,
  opts: { month: string; today: Date; dueDay: number; returnedPaise?: number },
): InstallmentStatus | null {
  const plan = loan.installmentPlan;
  if (!plan) return null;
  const day = String(Math.min(28, Math.max(1, opts.dueDay))).padStart(2, "0");
  const returned = Math.max(0, opts.returnedPaise ?? loan.principalPaise - loan.outstandingPaise);
  let covered = returned;
  const rows: InstallmentRow[] = installmentAmounts(loan.principalPaise, plan).map((r) => {
    const paid = Math.min(covered, r.amountPaise);
    covered -= paid;
    const dueDate = parseDateOnly(`${r.period}-${day}`);
    const status: InstallmentRow["status"] =
      paid >= r.amountPaise ? "paid" : dueDate < opts.today ? "overdue" : paid > 0 ? "partially_paid" : r.period <= opts.month ? "due" : "upcoming";
    return { ...r, dueDate, paidPaise: paid, status };
  });
  const owed = (r: InstallmentRow) => r.amountPaise - r.paidPaise;
  const nextRow = rows.find((r) => owed(r) > 0);
  return {
    count: plan.count,
    amountPaise: plan.amountPaise,
    firstMonth: plan.firstMonth,
    lastMonth: rows.length ? rows[rows.length - 1].period : plan.firstMonth,
    rows,
    returnedPaise: returned,
    duePaise: rows.filter((r) => r.period <= opts.month).reduce((s, r) => s + owed(r), 0),
    overduePaise: rows.filter((r) => r.period < opts.month).reduce((s, r) => s + owed(r), 0),
    thisMonthPaise: rows.filter((r) => r.period === opts.month).reduce((s, r) => s + owed(r), 0),
    paidCount: rows.filter((r) => owed(r) <= 0).length,
    next: nextRow ? { sequence: nextRow.sequence, period: nextRow.period, dueDate: nextRow.dueDate, amountPaise: owed(nextRow) } : null,
  };
}

/**
 * Split an installment amount received from a member across their upads that have a plan:
 * first what is due on each (oldest upad first), then the rest returns the oldest upad early.
 * Returns null for the part that can't be placed (more than all of them owe).
 */
export function splitInstallment<T extends { _id: { toHexString(): string }; date: Date; number: string; outstandingPaise: number }>(
  amount: number,
  loans: { loan: T; duePaise: number }[],
): { parts: { loan: T; amountPaise: number }[]; leftPaise: number } {
  const sorted = [...loans].sort((a, b) => a.loan.date.getTime() - b.loan.date.getTime() || a.loan.number.localeCompare(b.loan.number));
  const take = new Map<string, number>();
  let left = amount;
  for (const { loan, duePaise } of sorted) {
    const x = Math.min(left, duePaise, loan.outstandingPaise);
    if (x > 0) take.set(loan._id.toHexString(), x);
    left -= x;
  }
  for (const { loan } of sorted) {
    if (left <= 0) break;
    const already = take.get(loan._id.toHexString()) ?? 0;
    const x = Math.min(left, loan.outstandingPaise - already);
    if (x > 0) take.set(loan._id.toHexString(), already + x);
    left -= x;
  }
  return { parts: sorted.filter((s) => take.has(s.loan._id.toHexString())).map((s) => ({ loan: s.loan, amountPaise: take.get(s.loan._id.toHexString())! })), leftPaise: left };
}
