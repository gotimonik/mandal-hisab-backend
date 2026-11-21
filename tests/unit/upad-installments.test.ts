import { describe, expect, it } from "vitest";
import { installmentAmounts, installmentStatus, makeInstallmentPlan, splitInstallment } from "@/services/upad-installments";
import { rateInterest } from "@/services/member-interest.service";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const on = { enabled: true, count: 10 };

describe("upad in fixed installments", () => {
  it("no plan when the setting is off", () => {
    expect(makeInstallmentPlan(8_000_000, { enabled: false, count: 10 }, "2026-12")).toBeNull();
    expect(makeInstallmentPlan(8_000_000, undefined, "2026-12")).toBeNull();
  });

  it("₹80,000 in 10: ₹8,000 a month, interest 1% on what is left (₹800, ₹720, …)", () => {
    const plan = makeInstallmentPlan(8_000_000, on, "2026-12")!;
    expect(plan).toEqual({ count: 10, amountPaise: 800_000, firstMonth: "2026-12" });
    const rows = installmentAmounts(8_000_000, plan);
    expect(rows).toHaveLength(10);
    expect(rows.every((r) => r.amountPaise === 800_000)).toBe(true);
    expect(rows[0].period).toBe("2026-12");
    expect(rows[1].period).toBe("2027-01");
    expect(rows[9].period).toBe("2027-09");
    // interest each month on the amount left after the earlier installments
    let left = 8_000_000;
    const interest: number[] = [];
    for (const r of rows) {
      interest.push(rateInterest(left, "1"));
      left -= r.amountPaise;
    }
    expect(interest.slice(0, 3)).toEqual([80_000, 72_000, 64_000]);
    expect(interest[9]).toBe(8_000);
    expect(left).toBe(0);
  });

  it("rounds the installment up to a rupee; the last one is what's left", () => {
    const plan = makeInstallmentPlan(7_555_500, on, "2026-12")!; // ₹75,555
    expect(plan.amountPaise).toBe(755_600);
    const rows = installmentAmounts(7_555_500, plan);
    expect(rows).toHaveLength(10);
    expect(rows[9].amountPaise).toBe(7_555_500 - 9 * 755_600);
    expect(rows.reduce((s, r) => s + r.amountPaise, 0)).toBe(7_555_500);
  });

  it("what is due: missed months carry forward; paying more pays ahead", () => {
    const loan = { principalPaise: 8_000_000, outstandingPaise: 8_000_000, installmentPlan: makeInstallmentPlan(8_000_000, on, "2026-12") };
    const opts = { month: "2027-01", today: d("2027-01-05"), dueDay: 10 };
    const nothing = installmentStatus(loan, opts)!;
    expect(nothing.duePaise).toBe(1_600_000); // Dec missed + Jan
    expect(nothing.overduePaise).toBe(800_000);
    expect(nothing.thisMonthPaise).toBe(800_000);
    expect(nothing.rows[0].status).toBe("overdue");
    expect(nothing.rows[1].status).toBe("due");
    expect(nothing.rows[2].status).toBe("upcoming");

    const ahead = installmentStatus({ ...loan, outstandingPaise: 8_000_000 - 2_000_000 }, opts)!; // ₹20,000 returned
    expect(ahead.duePaise).toBe(0);
    expect(ahead.paidCount).toBe(2);
    expect(ahead.rows[2].status).toBe("partially_paid");
    expect(ahead.next).toMatchObject({ sequence: 3, period: "2027-02", amountPaise: 400_000 });

    expect(installmentStatus({ ...loan, installmentPlan: null }, opts)).toBeNull();
  });

  it("splits an amount across a member's upads: dues first (oldest upad first), then the oldest early", () => {
    const a = { _id: { toHexString: () => "a" }, date: d("2026-10-01"), number: "UPAD/1", outstandingPaise: 1_000_000 };
    const b = { _id: { toHexString: () => "b" }, date: d("2026-11-01"), number: "UPAD/2", outstandingPaise: 500_000 };
    const r = splitInstallment(600_000, [{ loan: b, duePaise: 50_000 }, { loan: a, duePaise: 100_000 }]);
    expect(r.leftPaise).toBe(0);
    expect(r.parts.map((p) => [p.loan.number, p.amountPaise])).toEqual([["UPAD/1", 550_000], ["UPAD/2", 50_000]]);
    expect(splitInstallment(1_600_000, [{ loan: a, duePaise: 0 }, { loan: b, duePaise: 0 }]).leftPaise).toBe(100_000);
  });
});
