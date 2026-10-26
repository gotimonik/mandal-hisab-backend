import { describe, expect, it } from "vitest";
import { amountFor, deriveStatus, generatePeriods, type ScheduleParams } from "@/services/schedule";
import { parseDateOnly as d, formatDateOnly } from "@/lib/dates";

const base = (o: Partial<ScheduleParams>): ScheduleParams => ({
  startDate: d("2026-04-01"),
  frequency: "monthly",
  amountPaise: 100000,
  financialYearStartMonth: 4,
  ...o,
});
const dates = (p: ScheduleParams, horizon = "2030-12-31") => generatePeriods(p, d(horizon)).map((x) => formatDateOnly(x.dueDate));

describe("installment schedule generation", () => {
  it("monthly ₹1,000 on the 10th for 6 months", () => {
    const p = base({ dueDay: 10, numberOfInstallments: 6 });
    const out = generatePeriods(p, d("2030-01-01"));
    expect(out.map((x) => formatDateOnly(x.dueDate))).toEqual([
      "2026-04-10",
      "2026-05-10",
      "2026-06-10",
      "2026-07-10",
      "2026-08-10",
      "2026-09-10",
    ]);
    expect(out[0].periodLabel).toBe("Apr 2026");
    expect(out.map((x) => x.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("first due date moves to next month when the due day already passed", () => {
    expect(dates(base({ startDate: d("2026-04-15"), dueDay: 10, numberOfInstallments: 2 }))).toEqual(["2026-05-10", "2026-06-10"]);
  });

  it("every two months and every three months", () => {
    expect(dates(base({ frequency: "bimonthly", dueDay: 5, numberOfInstallments: 4 }))).toEqual(["2026-04-05", "2026-06-05", "2026-08-05", "2026-10-05"]);
    expect(dates(base({ frequency: "every_three_months", dueDay: 5, numberOfInstallments: 4 }))).toEqual(["2026-04-05", "2026-07-05", "2026-10-05", "2027-01-05"]);
  });

  it("quarterly aligns to financial-year quarters and labels them", () => {
    const p = base({ startDate: d("2026-05-20"), frequency: "quarterly", dueDay: 1, numberOfInstallments: 3 });
    const out = generatePeriods(p, d("2030-01-01"));
    expect(out.map((x) => formatDateOnly(x.dueDate))).toEqual(["2026-07-01", "2026-10-01", "2027-01-01"]);
    expect(out.map((x) => x.periodLabel)).toEqual(["Q2 FY 2026-27", "Q3 FY 2026-27", "Q4 FY 2026-27"]);
  });

  it("₹3,000 every three months produces quarterly obligations, not monthly", () => {
    const p = base({ frequency: "every_three_months", dueDay: 1, amountPaise: 300000, targetAmountPaise: 1200000 });
    expect(generatePeriods(p, d("2035-01-01"))).toHaveLength(4);
  });

  it("month-end due day clamps without drifting (31st)", () => {
    expect(dates(base({ startDate: d("2027-01-01"), dueDay: 31, numberOfInstallments: 5 }))).toEqual([
      "2027-01-31",
      "2027-02-28",
      "2027-03-31",
      "2027-04-30",
      "2027-05-31",
    ]);
  });

  it("leap year February", () => {
    expect(dates(base({ startDate: d("2028-01-01"), dueDay: 30, numberOfInstallments: 3 }))).toEqual(["2028-01-30", "2028-02-29", "2028-03-30"]);
    expect(dates(base({ startDate: d("2100-02-01"), dueDay: 29, numberOfInstallments: 1 }), "2101-01-01")).toEqual(["2100-02-28"]);
  });

  it("weekly, biweekly, custom and one-time", () => {
    expect(dates(base({ frequency: "weekly", numberOfInstallments: 3 }))).toEqual(["2026-04-01", "2026-04-08", "2026-04-15"]);
    expect(dates(base({ frequency: "biweekly", numberOfInstallments: 3 }))).toEqual(["2026-04-01", "2026-04-15", "2026-04-29"]);
    expect(dates(base({ frequency: "custom", customInterval: { unit: "day", count: 10 }, numberOfInstallments: 3 }))).toEqual(["2026-04-01", "2026-04-11", "2026-04-21"]);
    expect(dates(base({ frequency: "custom", customInterval: { unit: "month", count: 4 }, dueDay: 15, numberOfInstallments: 3 }))).toEqual(["2026-04-15", "2026-08-15", "2026-12-15"]);
    expect(dates(base({ frequency: "one_time", startDate: d("2026-09-01") }))).toEqual(["2026-09-01"]);
  });

  it("respects end date and horizon; continues from a sequence without duplicates", () => {
    const p = base({ dueDay: 1, endDate: d("2026-08-15") });
    expect(dates(p)).toHaveLength(5);
    const open = base({ dueDay: 1 });
    expect(generatePeriods(open, d("2026-06-30"))).toHaveLength(3);
    const next = generatePeriods(open, d("2026-09-30"), 3);
    expect(next.map((x) => x.sequence)).toEqual([4, 5, 6]);
  });

  it("target amount determines count (rounded up)", () => {
    expect(generatePeriods(base({ targetAmountPaise: 250000 }), d("2040-01-01"))).toHaveLength(3);
  });
});

describe("installment amounts", () => {
  const rev = (date: string, amt: number) => ({ effectiveFrom: d(date), amountPaise: amt, createdBy: null as never, createdAt: new Date() });
  it("override > member amount > revision > scheme default", () => {
    const ctx = { schemeAmountPaise: 50000, revisions: [rev("2026-07-01", 75000), rev("2026-10-01", 100000)], overrides: [] };
    expect(amountFor(ctx, 1, d("2026-06-10"))).toEqual({ amountPaise: 50000, source: "scheme" });
    expect(amountFor(ctx, 4, d("2026-07-10"))).toEqual({ amountPaise: 75000, source: "revision" });
    expect(amountFor(ctx, 8, d("2026-11-10"))).toEqual({ amountPaise: 100000, source: "revision" });
    expect(amountFor({ ...ctx, memberAmountPaise: 200000 }, 8, d("2026-11-10")).source).toBe("member");
    const ov = { ...ctx, overrides: [{ sequence: 8, amountPaise: 1, reason: "x", createdBy: null as never, createdAt: new Date() }] };
    expect(amountFor(ov, 8, d("2026-11-10"))).toEqual({ amountPaise: 1, source: "override" });
  });
});

describe("derived installment status", () => {
  const inst = (paid: number, due = "2026-05-10", state = "active") => ({
    state,
    amountPaise: 100000,
    paidPaise: paid,
    penaltyPaise: 0,
    penaltyPaidPaise: 0,
    dueDate: d(due),
  });
  it("covers upcoming, pending, partial, paid, overdue, terminal states", () => {
    expect(deriveStatus(inst(0), d("2026-05-01"), 0)).toBe("upcoming");
    expect(deriveStatus(inst(0), d("2026-05-10"), 0)).toBe("pending");
    expect(deriveStatus(inst(0), d("2026-05-12"), 5)).toBe("pending");
    expect(deriveStatus(inst(0), d("2026-05-16"), 5)).toBe("overdue");
    expect(deriveStatus(inst(40000), d("2026-05-01"), 0)).toBe("partially_paid");
    expect(deriveStatus(inst(40000), d("2026-06-01"), 0)).toBe("overdue");
    expect(deriveStatus(inst(100000), d("2026-06-01"), 0)).toBe("paid");
    expect(deriveStatus(inst(0, "2026-05-10", "waived"), d("2026-06-01"), 0)).toBe("waived");
  });
});
