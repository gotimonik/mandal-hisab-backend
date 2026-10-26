/**
 * Pure installment-schedule generation (no I/O) — fully unit tested.
 *
 * Month-based schedules compute every due date from the anchor month rather than
 * from the previous due date, so a due day of 31 yields 31 Jan → 28/29 Feb → 31 Mar
 * (never drifting to the 28th forever).
 */
import { clampedDate, financialYear, formatIndianDate, monthLabel, utcAddDays } from "@/lib/dates";
import type { AmountRevision, CustomInterval, Frequency, SchemeOverride } from "@/types/models";

export interface ScheduleParams {
  startDate: Date;
  endDate?: Date | null;
  frequency: Frequency;
  customInterval?: CustomInterval | null;
  dueDay?: number | null;
  numberOfInstallments?: number | null;
  targetAmountPaise?: number | null;
  amountPaise: number;
  financialYearStartMonth: number;
}

export interface ScheduledPeriod {
  sequence: number;
  dueDate: Date;
  periodLabel: string;
}

const MAX_PERIODS = 1200;

type Step = { kind: "month"; months: number } | { kind: "day"; days: number } | { kind: "once" };

export function stepFor(frequency: Frequency, custom?: CustomInterval | null): Step {
  switch (frequency) {
    case "weekly":
      return { kind: "day", days: 7 };
    case "biweekly":
      return { kind: "day", days: 14 };
    case "monthly":
      return { kind: "month", months: 1 };
    case "bimonthly":
      return { kind: "month", months: 2 };
    case "every_three_months":
    case "quarterly":
      return { kind: "month", months: 3 };
    case "half_yearly":
      return { kind: "month", months: 6 };
    case "yearly":
      return { kind: "month", months: 12 };
    case "one_time":
      return { kind: "once" };
    case "custom": {
      if (!custom || custom.count < 1) throw new Error("Custom interval requires a positive count");
      if (custom.unit === "month") return { kind: "month", months: custom.count };
      return { kind: "day", days: custom.unit === "week" ? custom.count * 7 : custom.count };
    }
  }
}

/** Total number of installments implied by count / target amount (null = open ended). */
export function installmentCount(p: ScheduleParams): number | null {
  if (p.frequency === "one_time") return 1;
  if (p.numberOfInstallments) return p.numberOfInstallments;
  if (p.targetAmountPaise && p.amountPaise > 0) return Math.ceil(p.targetAmountPaise / p.amountPaise);
  return null;
}

/** First month-index anchor (absolute months since year 0) and due day for month-based schedules. */
function monthAnchor(p: ScheduleParams, months: number) {
  const day = p.dueDay ?? p.startDate.getUTCDate();
  const sy = p.startDate.getUTCFullYear();
  let m = p.startDate.getUTCMonth();
  if (p.frequency === "quarterly") {
    // Align to the organization's financial-year quarters (e.g. Apr/Jul/Oct/Jan).
    const fyStart = p.financialYearStartMonth - 1;
    while ((((m - fyStart) % 3) + 3) % 3 !== 0) m++;
  }
  let abs = sy * 12 + m;
  if (clampedDate(Math.floor(abs / 12), abs % 12, day) < p.startDate) abs += p.frequency === "quarterly" ? months : 1;
  return { abs, day };
}

export function periodLabelFor(p: ScheduleParams, seq: number, due: Date): string {
  const step = stepFor(p.frequency, p.customInterval);
  if (step.kind === "once") return `One-time (${formatIndianDate(due)})`;
  if (p.frequency === "quarterly") {
    const fy = financialYear(due, p.financialYearStartMonth);
    const q = Math.floor((((due.getUTCMonth() + 1 - p.financialYearStartMonth) % 12) + 12) % 12 / 3) + 1;
    return `Q${q} FY ${fy.label}`;
  }
  if (step.kind === "month") return monthLabel(due);
  return `#${seq} · ${formatIndianDate(due)}`;
}

/** Due date of the nth (1-based) installment. */
export function dueDateFor(p: ScheduleParams, seq: number): Date {
  const step = stepFor(p.frequency, p.customInterval);
  if (step.kind === "once") return p.startDate; // one-time contribution is due on the start date
  if (step.kind === "day") return utcAddDays(p.startDate, (seq - 1) * step.days);
  const { abs, day } = monthAnchor(p, step.months);
  const target = abs + (seq - 1) * step.months;
  return clampedDate(Math.floor(target / 12), target % 12, day);
}

/**
 * Generate periods with sequence > `afterSequence` and due date <= `horizon`
 * (and within endDate / installment count).
 */
export function generatePeriods(p: ScheduleParams, horizon: Date, afterSequence = 0): ScheduledPeriod[] {
  const count = installmentCount(p);
  const out: ScheduledPeriod[] = [];
  for (let seq = afterSequence + 1; seq <= MAX_PERIODS; seq++) {
    if (count !== null && seq > count) break;
    const due = dueDateFor(p, seq);
    if (p.endDate && due > p.endDate) break;
    if (due > horizon) break;
    out.push({ sequence: seq, dueDate: due, periodLabel: periodLabelFor(p, seq, due) });
  }
  return out;
}

export interface AmountContext {
  schemeAmountPaise: number;
  memberAmountPaise?: number | null;
  revisions: AmountRevision[];
  overrides: SchemeOverride[];
}

/** Resolve the amount for an installment: override > member-specific > latest revision > scheme default. */
export function amountFor(
  ctx: AmountContext,
  sequence: number,
  dueDate: Date,
): { amountPaise: number; source: "scheme" | "member" | "override" | "revision" } {
  const ov = ctx.overrides.find((o) => o.sequence === sequence && o.amountPaise !== undefined && o.amountPaise !== null);
  if (ov) return { amountPaise: ov.amountPaise!, source: "override" };
  if (ctx.memberAmountPaise) return { amountPaise: ctx.memberAmountPaise, source: "member" };
  const rev = [...ctx.revisions]
    .filter((r) => r.effectiveFrom <= dueDate)
    .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0];
  if (rev) return { amountPaise: rev.amountPaise, source: "revision" };
  return { amountPaise: ctx.schemeAmountPaise, source: "scheme" };
}

export type DerivedStatus =
  | "upcoming"
  | "pending"
  | "partially_paid"
  | "paid"
  | "overdue"
  | "deferred"
  | "waived"
  | "cancelled";

/**
 * Display status derived from amounts and dates (never trusted from a stored field):
 *  - paid when paid >= amount (+ penalty)
 *  - overdue when past due date + grace and still outstanding
 *  - partially_paid when something is paid but not all, not yet overdue
 *  - pending when due (today >= due date) within grace
 *  - upcoming when the due date is in the future
 */
export function deriveStatus(
  i: { state: string; amountPaise: number; paidPaise: number; penaltyPaise: number; penaltyPaidPaise: number; dueDate: Date },
  today: Date,
  graceDays: number,
): DerivedStatus {
  if (i.state === "deferred" || i.state === "waived" || i.state === "cancelled") return i.state;
  const owed = i.amountPaise + i.penaltyPaise;
  const paid = i.paidPaise + i.penaltyPaidPaise;
  if (paid >= owed) return "paid";
  if (today > utcAddDays(i.dueDate, graceDays)) return "overdue";
  if (paid > 0) return "partially_paid";
  if (today >= i.dueDate) return "pending";
  return "upcoming";
}
