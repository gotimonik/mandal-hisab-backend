import { describe, expect, it } from "vitest";
import { bpsOf, formatINR, roundHalfUp, rupeesToPaise, splitEvenly } from "@/lib/money";
import { financialYear, parseDateOnly, todayIn } from "@/lib/dates";
import { parseCsv, toCsv } from "@/lib/csv";

describe("money", () => {
  it("parses rupee strings exactly into paise", () => {
    expect(rupeesToPaise("1250")).toBe(125000);
    expect(rupeesToPaise("1,25,000.5")).toBe(12500050);
    expect(rupeesToPaise("0.01")).toBe(1);
    expect(rupeesToPaise("0.30")).toBe(30);
    expect(rupeesToPaise(19.99)).toBe(1999);
    expect(() => rupeesToPaise("10.005")).toThrow();
    expect(() => rupeesToPaise("abc")).toThrow();
    expect(() => rupeesToPaise(Number.NaN)).toThrow();
  });
  it("formats INR with Indian grouping", () => {
    expect(formatINR(12500000)).toBe("₹1,25,000.00");
    expect(formatINR(1234567890)).toBe("₹1,23,45,678.90");
    expect(formatINR(-5)).toBe("-₹0.05");
    expect(formatINR(99900)).toBe("₹999.00");
  });
  it("rounds half-up and splits evenly", () => {
    expect(roundHalfUp(5n, 2n)).toBe(3n);
    expect(roundHalfUp(-5n, 2n)).toBe(-3n);
    expect(roundHalfUp(4n, 3n)).toBe(1n);
    expect(splitEvenly(1000, 3)).toEqual([334, 333, 333]);
    expect(bpsOf(100000, 250)).toBe(2500);
  });
});

describe("dates", () => {
  it("indian financial year", () => {
    expect(financialYear(parseDateOnly("2026-03-31"), 4).label).toBe("2025-26");
    expect(financialYear(parseDateOnly("2026-04-01"), 4).label).toBe("2026-27");
    expect(financialYear(parseDateOnly("2026-04-01"), 1).label).toBe("2026");
  });
  it("today in Asia/Kolkata crosses midnight before UTC", () => {
    expect(todayIn("Asia/Kolkata", new Date("2026-04-30T19:00:00Z")).toISOString().slice(0, 10)).toBe("2026-05-01");
  });
  it("rejects impossible dates", () => {
    expect(() => parseDateOnly("2027-02-29")).toThrow();
  });
});

describe("csv", () => {
  it("round trips quoted fields and neutralises formulas", () => {
    expect(parseCsv('name,phone\n"Shah, R",98\r\n"He said ""hi""",1')).toEqual([
      ["name", "phone"],
      ["Shah, R", "98"],
      ['He said "hi"', "1"],
    ]);
    expect(toCsv(["a"], [["=1+1"], ["-5"]])).toBe("a\r\n'=1+1\r\n-5");
  });
});
