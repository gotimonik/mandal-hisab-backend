import { describe, expect, it } from "vitest";
import {
  annualFromInput,
  buildLoanSchedule,
  compoundInterest,
  compoundInterestBetween,
  dayCountDays,
  emi,
  scheduleTotals,
  simpleInterest,
  simpleInterestBetween,
} from "@/services/interest";
import { parseDateOnly as d } from "@/lib/dates";

const LAKH = 10_000_000; // ₹1,00,000 in paise

describe("simple interest (I = P × R × T)", () => {
  it("exact values", () => {
    expect(simpleInterest(LAKH, "12", 365)).toBe(1_200_000); // ₹12,000.00
    expect(simpleInterest(LAKH, "12", 90)).toBe(295_890); // ₹2,958.90
    expect(simpleInterest(LAKH, "10.5", 30, "actual_360")).toBe(87_500); // ₹875.00
    expect(simpleInterest(LAKH, "0", 30)).toBe(0);
    expect(simpleInterestBetween(LAKH, "12", d("2028-01-01"), d("2029-01-01")).days).toBe(366);
  });
  it("30/360 day count", () => {
    expect(dayCountDays(d("2026-01-31"), d("2026-02-28"), "30_360")).toBe(28);
    expect(dayCountDays(d("2026-01-01"), d("2027-01-01"), "30_360")).toBe(360);
  });
  it("monthly input rate converts to annual", () => {
    expect(annualFromInput("1", "monthly")).toBe("12");
    expect(annualFromInput("1.25", "monthly")).toBe("15");
    expect(annualFromInput("10.50", "annual")).toBe("10.5");
  });
});

describe("compound interest", () => {
  it("monthly compounding 12% for a year", () => {
    expect(compoundInterest(LAKH, "12", 12, 12)).toBe(1_268_250); // ₹12,682.50
  });
  it("quarterly compounding 10% for two years", () => {
    expect(compoundInterest(LAKH, "10", 4, 8)).toBe(2_184_029); // ₹21,840.29
  });
  it("between dates with stub days", () => {
    const r = compoundInterestBetween(LAKH, "12", 12, d("2026-01-15"), d("2026-04-30"));
    expect(r.periods).toBe(3);
    expect(r.stubDays).toBe(15);
    // 1,00,000 × 1.01^3 = 1,03,030.10 ; × (1 + 0.12×15/365) = 1,03,538.19 (exact, rounded once)
    expect(r.interestPaise).toBe(353_819);
  });
});

describe("reducing-balance loan", () => {
  it("EMI and schedule for ₹1,00,000 at 12% over 12 months", () => {
    expect(emi(LAKH, "12", 12, 12)).toBe(888_488); // ₹8,884.88
    const rows = buildLoanSchedule({
      principalPaise: LAKH,
      annualRate: "12",
      method: "reducing_balance",
      tenure: 12,
      frequency: "monthly",
      disbursedOn: d("2026-04-01"),
      firstDueDate: d("2026-05-01"),
    });
    expect(rows).toHaveLength(12);
    expect(rows[0]).toMatchObject({ principalDuePaise: 788_488, interestDuePaise: 100_000, totalDuePaise: 888_488 });
    expect(rows[11]).toMatchObject({ principalDuePaise: 879_688, interestDuePaise: 8_797 });
    const t = scheduleTotals(rows);
    expect(t.principalPaise).toBe(LAKH);
    expect(t.interestPaise).toBe(661_853);
  });
  it("zero-rate loans split principal", () => {
    const rows = buildLoanSchedule({ principalPaise: 100_000, annualRate: "0", method: "reducing_balance", tenure: 3, frequency: "monthly", disbursedOn: d("2026-01-01"), firstDueDate: d("2026-02-01") });
    expect(scheduleTotals(rows)).toEqual({ principalPaise: 100_000, interestPaise: 0, totalPaise: 100_000 });
  });
});

describe("flat and simple loans", () => {
  it("flat: ₹1,20,000 at 10% for 12 months = ₹11,000 per month", () => {
    const rows = buildLoanSchedule({ principalPaise: 12_000_000, annualRate: "10", method: "flat", tenure: 12, frequency: "monthly", disbursedOn: d("2026-04-01"), firstDueDate: d("2026-05-01") });
    expect(rows.every((r) => r.totalDuePaise === 1_100_000)).toBe(true);
    expect(scheduleTotals(rows).interestPaise).toBe(1_200_000);
  });
  it("simple: equal principal with interest on outstanding for actual days", () => {
    const rows = buildLoanSchedule({ principalPaise: 3_650_000, annualRate: "10", method: "simple", tenure: 2, frequency: "monthly", disbursedOn: d("2026-01-01"), firstDueDate: d("2026-02-01") });
    // 36,500 × 10% × 31/365 = 310.00 ; then 18,250 × 10% × 28/365 = 140.00
    expect(rows.map((r) => r.interestDuePaise)).toEqual([31_000, 14_000]);
    expect(rows.map((r) => r.principalDuePaise)).toEqual([1_825_000, 1_825_000]);
  });
  it("compound: bullet repayment at maturity", () => {
    const rows = buildLoanSchedule({ principalPaise: LAKH, annualRate: "12", method: "compound", compoundingPerYear: 12, tenure: 12, frequency: "monthly", disbursedOn: d("2026-01-01"), firstDueDate: d("2026-02-01") });
    expect(rows).toHaveLength(1);
    expect(rows[0].dueDate.toISOString().slice(0, 10)).toBe("2027-01-01");
    expect(rows[0].interestDuePaise).toBe(1_268_250);
  });
});
