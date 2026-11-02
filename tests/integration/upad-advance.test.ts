import { describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { addUser, api, ok, setupOrg, uniq } from "../helpers/api";
import { cols } from "@/lib/collections";

/**
 * Upad interest for all of a member's upads at once, and the upad advance:
 * ₹1,250 at 15% a month → ₹187.50 interest. The member pays a round ₹200: ₹187.50 settles the
 * interest, ₹12.50 is kept as their advance and pays the next interest that falls due.
 */

const IST = () => new Date(Date.now() + 5.5 * 3600_000);
const today = () => IST().toISOString().slice(0, 10);
/** 1st of last month: interest for this month is due on an upad given then */
const lastMonth = () => {
  const d = IST();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
};

async function mandal(name: string) {
  const o = await setupOrg(name);
  const t = o.admin.token;
  await ok(api("POST", `/orgs/${o.orgId}/cashbook/entries`, { token: t, body: { direction: "in", amount: "20000", date: today(), description: "Opening cash", idempotencyKey: uniq("ce") } }));
  const kiran = (await ok(api("POST", `/orgs/${o.orgId}/members`, { token: t, body: { name: "Kiran Borrower" } })))._id as string;
  const give = async (amount: string, rate: string) =>
    (await ok(api("POST", `/orgs/${o.orgId}/fund-loans`, { token: t, body: { memberId: kiran, amount, date: lastMonth(), monthlyRate: rate, idempotencyKey: uniq("fl") } }))).loan._id as string;
  const loan = (id: string) => ok(api("GET", `/orgs/${o.orgId}/fund-loans/${id}`, { token: t })).then((r) => r.loan);
  const summary = () => ok(api("GET", `/orgs/${o.orgId}/members/${kiran}/upad-interest`, { token: t }));
  const receipt = (id: string) => ok(api("GET", `/orgs/${o.orgId}/receipts/${id}`, { token: t })).then((r) => r.receipt);
  const advance = async () => (await (await cols()).members.findOne({ _id: new ObjectId(kiran) }))?.upadAdvancePaise ?? 0;
  /** every share of interest across all members' savings */
  const sharedInterest = async () => {
    const rows = await (await cols()).memberLedger.find({ organizationId: new ObjectId(o.orgId), kind: "interest" }).toArray();
    return rows.reduce((s, r) => s + r.creditPaise - r.debitPaise, 0);
  };
  return { o, t, kiran, give, loan, summary, receipt, advance, sharedInterest };
}

describe("upad advance", () => {
  it("₹200 paid when ₹187.50 is due: ₹12.50 is kept as advance, not shared, and pays the next interest due", async () => {
    const m = await mandal("Advance Mandal");
    const first = await m.give("1250", "15");
    expect((await m.loan(first)).interestDuePaise).toBe(18_750);

    const surplusBefore = (await ok(api("GET", `/orgs/${m.o.orgId}/dashboard`, { token: m.t }))).totals.mandalSurplusPaise;
    const r = await ok(api("POST", `/orgs/${m.o.orgId}/fund-loans/${first}/payments`, { token: m.t, body: { interestAmount: "200", date: today(), idempotencyKey: uniq("flp") } }));
    expect(r.payment).toMatchObject({ interestPaise: 18_750, advanceAddedPaise: 1_250 });
    expect((await m.loan(first)).interestDuePaise).toBe(0);
    expect(await m.advance()).toBe(1_250);
    expect(await m.sharedInterest()).toBe(18_750); // only the interest that was due is shared
    const rc = await m.receipt(r.payment.receiptId);
    expect(rc.amountPaise).toBe(20_000);
    expect(rc.lines.map((l: any) => [l.description, l.amountPaise])).toEqual([
      [expect.stringMatching(/interest/), 18_750],
      ["Advance for the next upad interest", 1_250],
    ]);
    // the books: cash +200, the advance is held for the member
    const dash = await ok(api("GET", `/orgs/${m.o.orgId}/dashboard`, { token: m.t }));
    expect(dash.totals.upadAdvancePaise).toBe(1_250);
    // the ₹200 isn't the Mandal's own money: ₹187.50 went to members' savings, ₹12.50 is owed back to Kiran
    expect(dash.totals.mandalSurplusPaise).toBe(surplusBefore);

    // new interest falls due (a second upad's first month) → the advance pays it first
    const second = await m.give("1000", "10"); // ₹100 interest due
    const s = await m.summary();
    expect(s.advancePaise).toBe(0);
    expect(s.interestDuePaise).toBe(10_000 - 1_250);
    expect(s.toPayPaise).toBe(8_750);
    expect((await m.loan(second)).interestDuePaise).toBe(8_750);
    expect(await m.sharedInterest()).toBe(18_750 + 1_250); // shared once it's used
    const viaAdvance = await (await cols()).upadInterestPayments.findOne({ memberId: new ObjectId(m.kiran), kind: "advance" });
    expect(viaAdvance).toMatchObject({ amountPaise: 0, advanceUsedPaise: 1_250, receiptId: null });

    // the first payment can't be undone any more: its advance was used
    const rev = await api("POST", `/orgs/${m.o.orgId}/fund-loan-payments/${r.payment._id}/reverse`, { token: m.t, body: { reason: "Entered twice" } });
    expect(rev.status).toBe(400);
    expect(rev.error?.message).toMatch(/already been used/);
  });

  it("one payment for all the member's upads: oldest first, one receipt, extra kept; reversed as a whole", async () => {
    const m = await mandal("All Interest Mandal");
    const a = await m.give("1250", "15"); // ₹187.50
    const b = await m.give("1000", "10"); // ₹100
    const s = await m.summary();
    expect(s).toMatchObject({ interestDuePaise: 28_750, advancePaise: 0, toPayPaise: 28_750, monthlyInterestPaise: 28_750 });
    expect(s.loans.map((l: any) => l.interestDuePaise)).toEqual([18_750, 10_000]);

    // a typing mistake (₹30,000) is refused: more than a year ahead
    expect((await api("POST", `/orgs/${m.o.orgId}/members/${m.kiran}/upad-interest`, { token: m.t, body: { amount: "30000", date: today(), idempotencyKey: uniq("ui") } })).status).toBe(400);

    const key = uniq("ui");
    const pay = await ok(api("POST", `/orgs/${m.o.orgId}/members/${m.kiran}/upad-interest`, { token: m.t, body: { amount: "300", date: today(), idempotencyKey: key } }));
    expect(pay.payment).toMatchObject({ kind: "payment", amountPaise: 30_000, interestPaise: 28_750, advanceUsedPaise: 0, advanceAddedPaise: 1_250 });
    expect(pay.payment.loanPaymentIds).toHaveLength(2);
    // sent twice → recorded once
    expect((await ok(api("POST", `/orgs/${m.o.orgId}/members/${m.kiran}/upad-interest`, { token: m.t, body: { amount: "300", date: today(), idempotencyKey: key } }))).duplicate).toBe(true);
    expect((await m.loan(a)).interestDuePaise).toBe(0);
    expect((await m.loan(b)).interestDuePaise).toBe(0);
    expect(await m.advance()).toBe(1_250);
    const rc = await m.receipt(pay.payment.receiptId);
    expect(rc.amountPaise).toBe(30_000);
    expect(rc.lines.map((l: any) => l.amountPaise)).toEqual([18_750, 10_000, 1_250]);
    // each upad shows its part, from the same receipt
    const detail = await ok(api("GET", `/orgs/${m.o.orgId}/fund-loans/${b}`, { token: m.t }));
    expect(detail.payments.find((p: any) => p.status === "valid")).toMatchObject({ interestPaise: 10_000, receiptId: pay.payment.receiptId });

    // reversing one upad's part reverses the whole payment
    await ok(api("POST", `/orgs/${m.o.orgId}/fund-loan-payments/${pay.payment.loanPaymentIds[1]}/reverse`, { token: m.t, body: { reason: "Wrong member" } }));
    expect((await m.loan(a)).interestDuePaise).toBe(18_750);
    expect((await m.loan(b)).interestDuePaise).toBe(10_000);
    expect(await m.advance()).toBe(0);
    expect(await m.sharedInterest()).toBe(0);
    expect((await m.receipt(pay.payment.receiptId)).status).toBe("cancelled");
  });

  it("an advance paid earlier is used first when paying; leftover can be returned; closing waits for it", async () => {
    const m = await mandal("Return Mandal");
    const a = await m.give("1250", "15");
    await ok(api("POST", `/orgs/${m.o.orgId}/fund-loans/${a}/payments`, { token: m.t, body: { interestAmount: "400", date: today(), idempotencyKey: uniq("flp") } }));
    expect(await m.advance()).toBe(21_250);

    // closing the Mandal is blocked while an advance is held
    const prev = await ok(api("GET", `/orgs/${m.o.orgId}/settlement`, { token: m.t }));
    expect(prev.blockers.map((b: any) => b.key)).toContain("upadAdvance");
    const held = await ok(api("GET", `/orgs/${m.o.orgId}/upad-advances`, { token: m.t }));
    expect(held).toMatchObject({ totalPaise: 21_250, members: [{ name: "Kiran Borrower", advancePaise: 21_250 }] });

    // return it in cash
    const cashBefore = (await ok<any[]>(api("GET", `/orgs/${m.o.orgId}/accounts`, { token: m.t })))[0].balancePaise;
    const ret = await ok(api("POST", `/orgs/${m.o.orgId}/members/${m.kiran}/upad-advance/return`, { token: m.t, body: {} }));
    expect(ret.amountPaise).toBe(21_250);
    expect(await m.advance()).toBe(0);
    expect((await ok<any[]>(api("GET", `/orgs/${m.o.orgId}/accounts`, { token: m.t })))[0].balancePaise).toBe(cashBefore - 21_250);
    expect((await api("POST", `/orgs/${m.o.orgId}/members/${m.kiran}/upad-advance/return`, { token: m.t, body: {} })).status).toBe(400);
    expect((await ok(api("GET", `/orgs/${m.o.orgId}/settlement`, { token: m.t }))).blockers.map((b: any) => b.key)).not.toContain("upadAdvance");
  });

  it("members report one payment for all their upads with 'I have paid'; verifying records it with the advance", async () => {
    const m = await mandal("Claim Mandal");
    const u = await addUser(m.o.orgId, m.o.code, m.t, "member", m.kiran);
    await m.give("1250", "15");
    await m.give("1000", "10");
    const opts = await ok(api("GET", `/orgs/${m.o.orgId}/me/payment-options`, { token: u.token }));
    expect(opts.upadAdvancePaise).toBe(0);
    expect(opts.upads).toHaveLength(2);
    const claim = (await ok(api("POST", `/orgs/${m.o.orgId}/me/upad-payments`, { token: u.token, body: { loanId: "all", interestAmount: "300", date: today(), method: "cash", idempotencyKey: uniq("uc") } }))).claim;
    expect(claim.loanId).toBeNull();
    // can't also return an upad in an "all upads" report
    expect((await api("POST", `/orgs/${m.o.orgId}/me/upad-payments`, { token: u.token, body: { loanId: "all", interestAmount: "10", principalAmount: "5", date: today(), method: "cash", idempotencyKey: uniq("uc") } })).status).toBe(400);
    const listed = await ok<any[]>(api("GET", `/orgs/${m.o.orgId}/upad-payments`, { token: m.t }));
    expect(listed[0]).toMatchObject({ _id: claim._id, loanNumber: "", alreadyRecorded: null });
    const v = await ok(api("POST", `/orgs/${m.o.orgId}/upad-payments/${claim._id}/verify`, { token: m.t, body: {} }));
    expect(v.receiptId).toBeTruthy();
    expect(await m.advance()).toBe(1_250);
    expect((await m.summary()).interestDuePaise).toBe(0);
    const mine = await ok<any[]>(api("GET", `/orgs/${m.o.orgId}/me/upad-payments`, { token: u.token }));
    expect(mine[0]).toMatchObject({ status: "verified", loanNumber: "" });
  });
});
