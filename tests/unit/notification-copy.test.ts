import { describe, expect, it } from "vitest";
import { COPY_KEYS, copy, renderCopy, type Lang } from "@/services/notification-copy";

/** Realistic details for every notification type. */
const SAMPLE = {
  amountPaise: 150_000, payer: "Rahul Patel", member: "Rahul Patel", name: "Asha Desai", purpose: "hapta", note: "Ganpati donation", scheme: "Diwali fund", method: "cash",
  reason: "Amount doesn't match the cash book", days: 3, period: "Nov 2026", dueDate: "2026-11-05T00:00:00.000Z", lateDays: 7, change: "due_date",
  loan: "LN/2026-27/0003", sequence: 4, rate: "12", fromDate: "2026-12-01T00:00:00.000Z", number: "UPAD/2026-27/0002", fromMonth: "2026-12",
  interestPaise: 15_000, principalPaise: 100_000, periodMonth: "2026-10", balancePaise: 820_000, payee: "Shree Decorators", category: "Festival",
  status: "active", netPaise: 1_250_000, savingsPaise: 1_200_000, mandalSharePaise: 80_000, upadOwedPaise: 30_000, upadPaise: 30_000,
};

describe("notification copy", () => {
  for (const lang of ["en", "gu", "hi"] as Lang[]) {
    it(`every notification reads cleanly in ${lang}`, () => {
      for (const key of COPY_KEYS) {
        const w = renderCopy(lang, copy(key, SAMPLE, "INR"));
        expect(w.title, key).toBeTruthy();
        expect(w.body, key).toBeTypeOf("string");
        for (const bad of ["undefined", "NaN", "null", "{", "}", "[object"]) {
          expect(w.title.includes(bad) || w.body.includes(bad), `${lang} ${key}: ${w.title} — ${w.body}`).toBe(false);
        }
      }
    });
  }

  it("fills in amounts, dates and months in the reader's language", () => {
    const en = renderCopy("en", copy("installment.reminder", SAMPLE, "INR"));
    expect(en).toEqual({ title: "Hapta due in 3 days", body: "Diwali fund · Nov 2026: ₹1,500.00 to pay by 05 Nov 2026." });
    const gu = renderCopy("gu", copy("installment.reminder", { ...SAMPLE, days: 0 }, "INR"));
    expect(gu.title).toBe("હપ્તો આજે ભરવાનો છે");
    expect(gu.body).toContain("₹1,500.00");
    const hi = renderCopy("hi", copy("interest.credited", SAMPLE, "INR"));
    expect(hi.body).toMatch(/अक्तूबर|अक्टूबर/); // October 2026
    expect(renderCopy("en", copy("payment.request", { ...SAMPLE, purpose: "other" }, "INR")).body).toBe("₹1,500.00 in cash for “Ganpati donation”. Verify it to issue a receipt.");
    // optional parts drop out cleanly
    expect(renderCopy("en", copy("payment.rejected", { amountPaise: 50_000, reason: "" }, "INR")).body).toBe("Your payment of ₹500.00 couldn't be verified. Speak to your treasurer if this looks wrong.");
  });
});
