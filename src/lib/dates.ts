/**
 * Date-only helpers. A calendar date is represented as a Date at 00:00 UTC of that
 * day ("UTC-midnight date"). This keeps comparisons and month arithmetic exact and
 * independent of the server's timezone.
 */
import { addDays, addMonths, getDaysInMonth } from "date-fns";
import { UTCDate } from "@date-fns/utc";

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseDateOnly(s: string): Date {
  const m = ISO.exec(s);
  if (!m) throw new Error(`Invalid date: ${s} (expected YYYY-MM-DD)`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    throw new Error(`Invalid date: ${s}`);
  }
  return dt;
}

export function toDateOnly(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function formatDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Today's calendar date in an IANA timezone, as a UTC-midnight date. */
export function todayIn(timezone: string, now: Date = new Date()): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return parseDateOnly(parts);
}

export function utcAddDays(d: Date, n: number): Date {
  return toDateOnly(addDays(new UTCDate(d), n));
}

export function utcAddMonths(d: Date, n: number): Date {
  return toDateOnly(addMonths(new UTCDate(d), n));
}

export function daysInMonthUTC(year: number, monthIndex: number): number {
  return getDaysInMonth(new UTCDate(year, monthIndex, 1));
}

/** Date in year/month with `day` clamped to the month's last day (31 → 28/29 Feb). */
export function clampedDate(year: number, monthIndex: number, day: number): Date {
  const y = year + Math.floor(monthIndex / 12);
  const m = ((monthIndex % 12) + 12) % 12;
  const dim = daysInMonthUTC(y, m);
  return new Date(Date.UTC(y, m, Math.min(day, dim)));
}

export function diffDays(a: Date, b: Date): number {
  return Math.round((toDateOnly(a).getTime() - toDateOnly(b).getTime()) / 86_400_000);
}

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** Financial year containing `d` given the FY start month (1-12). Returns {start, end, label}. */
export function financialYear(d: Date, startMonth: number) {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const startYear = m >= startMonth ? y : y - 1;
  const start = new Date(Date.UTC(startYear, startMonth - 1, 1));
  const end = utcAddDays(utcAddMonths(start, 12), -1);
  const label =
    startMonth === 1 ? String(startYear) : `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
  return { start, end, label };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function monthLabel(d: Date): string {
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Indian display format dd-MM-yyyy */
export function formatIndianDate(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${d.getUTCFullYear()}`;
}
