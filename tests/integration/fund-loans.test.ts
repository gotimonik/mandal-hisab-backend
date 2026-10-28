import { beforeAll, describe, expect, it } from "vitest";
import { api, makePlatformAdmin, ok, registerAndLogin, uniq } from "../helpers/api";
import { splitByWeight } from "@/services/fund-loan.service";

/**
 * Loans from the Mandal fund — the scenario: 5 members have saved ₹5,000; member 1 borrows
 * ₹3,000 at 10% a month → ₹300 interest due every month (unpaid months carry forward); when it
 * is paid it is shared among the members and the fund grows to ₹5,300.
 */

async function createMandal(name: string, hapta: string, startMonth: string) {
  const admin = await registerAndLogin(`${name} Admin`);
  const org = await ok(api("POST", "/organizations", { token: admin.token, body: { name, monthlyHaptaAmount: hapta, haptaStartMonth: startMonth } }));
  if (org.status === "pending") {
    const pa = await registerAndLogin("Platform Admin");
    await makePlatformAdmin(pa.userId);
    await ok(api("PATCH", `/platform/organizations/${org.id}`, { token: pa.token, body: { action: "approve" } }));
  }
  return { orgId: org.id as string, code: org.code as string, admin };
}
type Mandal = Awaited<ReturnType<typeof createMandal>>;

const JUL = "2026-07";
const balance = async (o: Mandal, memberId: string) => (await ok(api("GET", `/orgs/${o.orgId}/members/${memberId}/ledger`, { token: o.admin.token }))).currentBalancePaise as number;
const dash = (o: Mandal) => ok(api("GET", `/orgs/${o.orgId}/dashboard`, { token: o.admin.token }));
const pay = (o: Mandal, loanId: string, body: Record<string, unknown>) => api("POST", `/orgs/${o.orgId}/fund-loans/${loanId}/payments`, { token: o.admin.token, body: { idempotencyKey: uniq("flp"), ...body } });

describe("splitting interest among members", () => {
  it("shares exactly, in proportion to savings", () => {
    const s = splitByWeight(30_000, [{ id: "a", w: 100_000 }, { id: "b", w: 100_000 }, { id: "c", w: 100_000 }, { id: "d", w: 100_000 }, { id: "e", w: 100_000 }]);
    expect([...s.values()]).toEqual([6_000, 6_000, 6_000, 6_000, 6_000]);
    const u = splitByWeight(100, [{ id: "a", w: 1 }, { id: "b", w: 1 }, { id: "c", w: 1 }]);
    expect([...u.values()].reduce((x, y) => x + y, 0)).toBe(100);
    expect([...u.values()].sort()).toEqual([33, 33, 34]);
    const w = splitByWeight(1_000, [{ id: "big", w: 300_000 }, { id: "small", w: 100_000 }]);
    expect(Object.fromEntries(w)).toEqual({ big: 750, small: 250 });
  });
});

describe("loans from the Mandal fund", () => {
  let o: Mandal;
  const m: string[] = []; // 5 members; m[0] borrows
  let loanId: string;

  beforeAll(async () => {
    o = await createMandal("Loan Fund Mandal", "1000", JUL);
    const list = await ok(api("GET", `/orgs/${o.orgId}/members`, { token: o.admin.token }));
    m.push(list.items[0]._id); // the admin (also a member)
    for (const n of ["Bhavna", "Chetan", "Daksha", "Esha"]) m.push((await ok(api("POST", `/orgs/${o.orgId}/members`, { token: o.admin.token, body: { name: `${n} Saver`, joiningDate: "2026-07-01" } })))._id);
    const jul = await ok(api("GET", `/orgs/${o.orgId}/monthly?month=${JUL}`, { token: o.admin.token }));
    for (const r of jul.rows) await ok(api("POST", `/orgs/${o.orgId}/monthly/collect`, { token: o.admin.token, body: { installmentId: r.installmentId, amount: "1000", date: "2026-07-05", idempotencyKey: uniq("c") } }));
    const d = await dash(o);
    expect(d.totals.mandalCashPaise).toBe(500_000);
    expect(d.totals.totalMemberBalancesPaise).toBe(500_000);
  });

  it("gives ₹3,000 from the fund: cash goes down, the fund and member balances don't", async () => {
    expect((await api("POST", `/orgs/${o.orgId}/fund-loans`, { token: o.admin.token, body: { memberId: m[0], amount: "6000", date: "2026-07-20", monthlyRate: "10", idempotencyKey: uniq("fl") } })).status).toBe(400); // more than the cash
    const r = await ok(api("POST", `/orgs/${o.orgId}/fund-loans`, { token: o.admin.token, body: { memberId: m[0], amount: "3000", date: "2026-07-20", monthlyRate: "10", idempotencyKey: uniq("fl") } }));
    loanId = r.loan._id;
    expect(r.loan).toMatchObject({ principalPaise: 300_000, outstandingPaise: 300_000, monthlyRate: "10", firstInterestMonth: "2026-08", status: "active" });
    expect(r.loan.number).toMatch(/^UPAD\//);
    const d = await dash(o);
    expect(d.totals.mandalCashPaise).toBe(200_000);
    expect(d.totals.fundLoansOutstandingPaise).toBe(300_000);
    expect(d.totals.mandalFundPaise).toBe(500_000);
    expect(d.totals.totalMemberBalancesPaise).toBe(500_000);
    expect(await balance(o, m[0])).toBe(100_000); // borrowing is not a withdrawal
  });

  it("charges ₹300 interest from the next month and shows it on the month screen", async () => {
    const jul = await ok(api("GET", `/orgs/${o.orgId}/fund-loans/month?month=2026-07`, { token: o.admin.token }));
    expect(jul.rows).toHaveLength(0); // nothing in the month it was given
    const aug = await ok(api("GET", `/orgs/${o.orgId}/fund-loans/month?month=2026-08`, { token: o.admin.token }));
    expect(aug.rows).toHaveLength(1);
    expect(aug.rows[0]).toMatchObject({ number: expect.stringMatching(/^UPAD\//), outstandingPaise: 300_000, carriedForwardPaise: 0, totalDuePaise: 30_000 });
    expect(aug.rows[0].thisMonth).toMatchObject({ principalBasisPaise: 300_000, interestPaise: 30_000, paidPaise: 0 });
  });

  it("paying ₹300 shares it among the members — the fund becomes ₹5,300", async () => {
    const tooMuch = await pay(o, loanId, { interestAmount: "100000", date: "2026-08-15" }); // more than all interest due so far
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.error?.message).toMatch(/interest is due/);
    await ok(pay(o, loanId, { interestAmount: "300", date: "2026-08-15" }));
    for (const id of m) expect(await balance(o, id)).toBe(106_000); // ₹60 each (equal savings)
    const d = await dash(o);
    expect(d.totals.mandalCashPaise).toBe(230_000);
    expect(d.totals.fundLoansOutstandingPaise).toBe(300_000);
    expect(d.totals.mandalFundPaise).toBe(530_000);
    expect(d.totals.totalMemberBalancesPaise).toBe(530_000);
    // upad interest shared to members shows as interest in the balance breakdown
    expect(d.totals.memberBalanceParts).toMatchObject({ haptaPaise: 500_000, interestPaise: 30_000, withdrawalsPaise: 0 });
    expect((await ok(api("GET", `/orgs/${o.orgId}/member-funds/reconcile`, { token: o.admin.token }))).reconciled).toBe(true);
    const aug = await ok(api("GET", `/orgs/${o.orgId}/fund-loans/month?month=2026-08`, { token: o.admin.token }));
    expect(aug.rows[0]).toMatchObject({ status: "paid", totalDuePaise: 0 });
  });

  it("unpaid interest carries forward and can be paid together", async () => {
    const oct = await ok(api("GET", `/orgs/${o.orgId}/fund-loans/month?month=2026-10`, { token: o.admin.token }));
    expect(oct.rows[0]).toMatchObject({ carriedForwardPaise: 30_000, carriedForwardMonths: ["2026-09"], totalDuePaise: 60_000 });
    const r = await ok(pay(o, loanId, { interestAmount: "600", date: "2026-10-05" }));
    expect(r.payment.allocations.map((a: { period: string; amountPaise: number }) => [a.period, a.amountPaise])).toEqual([["2026-09", 30_000], ["2026-10", 30_000]]);
    const d = await dash(o);
    expect(d.totals.mandalFundPaise).toBe(590_000);
    expect(d.totals.totalMemberBalancesPaise).toBe(590_000);
  });

  it("returning part of the loan lowers next month's interest; back-dating over paid months is refused", async () => {
    expect((await pay(o, loanId, { principalAmount: "1000", date: "2026-08-20" })).status).toBe(400); // Sep/Oct interest already paid on ₹3,000
    expect((await pay(o, loanId, { principalAmount: "4000", date: "2026-10-10" })).status).toBe(400); // more than outstanding
    await ok(pay(o, loanId, { principalAmount: "1000", date: "2026-10-10" }));
    const l = await ok(api("GET", `/orgs/${o.orgId}/fund-loans/${loanId}`, { token: o.admin.token }));
    expect(l.loan.outstandingPaise).toBe(200_000);
    expect(l.loan.nextInterestPaise).toBe(20_000); // 10% of ₹2,000
    const d = await dash(o);
    expect(d.totals.mandalFundPaise).toBe(590_000); // cash up ₹1,000, loans down ₹1,000
  });

  it("only the latest payment can be reversed, and reversal restores everything", async () => {
    const l = await ok(api("GET", `/orgs/${o.orgId}/fund-loans/${loanId}`, { token: o.admin.token }));
    const [latest, older] = l.payments;
    expect((await api("POST", `/orgs/${o.orgId}/fund-loan-payments/${older._id}/reverse`, { token: o.admin.token, body: { reason: "Testing order" } })).status).toBe(400);
    await ok(api("POST", `/orgs/${o.orgId}/fund-loan-payments/${latest._id}/reverse`, { token: o.admin.token, body: { reason: "Entered twice" } }));
    const after = await ok(api("GET", `/orgs/${o.orgId}/fund-loans/${loanId}`, { token: o.admin.token }));
    expect(after.loan.outstandingPaise).toBe(300_000);
    // reverse the ₹600 interest too → Sep and Oct due again, member shares taken back
    await ok(api("POST", `/orgs/${o.orgId}/fund-loan-payments/${older._id}/reverse`, { token: o.admin.token, body: { reason: "Wrong month" } }));
    const oct = await ok(api("GET", `/orgs/${o.orgId}/fund-loans/month?month=2026-10`, { token: o.admin.token }));
    expect(oct.rows[0].totalDuePaise).toBe(60_000);
    for (const id of m) expect(await balance(o, id)).toBe(106_000);
    expect((await ok(api("GET", `/orgs/${o.orgId}/member-funds/reconcile`, { token: o.admin.token }))).reconciled).toBe(true);
  });

  it("the borrower sees their own loan; other members can't", async () => {
    const borrower = await registerAndLogin("Borrower Login");
    const other = await registerAndLogin("Other Login");
    // link logins to member records m[1] (borrower of a new small loan) and m[2]
    for (const [u, mid] of [[borrower, m[1]], [other, m[2]]] as const) {
      await ok(api("POST", "/organizations/join", { token: u.token, body: { code: o.code } }));
      const pending = await ok<any[]>(api("GET", `/orgs/${o.orgId}/memberships?status=pending`, { token: o.admin.token }));
      await ok(api("PATCH", `/orgs/${o.orgId}/memberships/${pending.find((x) => x.user._id === u.userId)._id}`, { token: o.admin.token, body: { action: "approve", role: "member", memberId: mid } }));
    }
    const small = await ok(api("POST", `/orgs/${o.orgId}/fund-loans`, { token: o.admin.token, body: { memberId: m[1], amount: "500", date: "2026-09-02", idempotencyKey: uniq("fl") } }));
    expect(small.loan.monthlyRate).toBe("2"); // Mandal default
    const mine = await ok(api("GET", `/orgs/${o.orgId}/me/fund-loans`, { token: borrower.token }));
    expect(mine.items.map((x: any) => x._id)).toEqual([small.loan._id]);
    expect(mine.items[0].interestDuePaise).toBeGreaterThan(0);
    expect((await api("GET", `/orgs/${o.orgId}/fund-loans/${small.loan._id}`, { token: other.token })).status).toBe(404);
    expect((await api("GET", `/orgs/${o.orgId}/fund-loans`, { token: other.token })).status).toBe(403);
    expect((await api("POST", `/orgs/${o.orgId}/fund-loans/${small.loan._id}/payments`, { token: borrower.token, body: { interestAmount: "10", date: "2026-10-01", idempotencyKey: uniq("x") } })).status).toBe(403);
    // a loan given by mistake can be cancelled while nothing is paid on it
    await ok(api("POST", `/orgs/${o.orgId}/fund-loans/${small.loan._id}/cancel`, { token: o.admin.token, body: { reason: "Given by mistake" } }));
    expect((await ok(api("GET", `/orgs/${o.orgId}/me/fund-loans`, { token: borrower.token }))).items[0].status).toBe("cancelled");
  });

  it("a fully repaid loan with no interest left is closed", async () => {
    await ok(pay(o, loanId, { interestAmount: "600", principalAmount: "3000", date: "2026-10-20" }));
    const l = await ok(api("GET", `/orgs/${o.orgId}/fund-loans/${loanId}`, { token: o.admin.token }));
    // closed only if no later month's interest is due yet (i.e. when run in October 2026); otherwise still active with interest due
    if (l.loan.interestDuePaise === 0) expect(l.loan.status).toBe("closed");
    expect(l.loan.outstandingPaise).toBe(0);
  });
});

describe("members requesting upad", () => {
  let o: Mandal;
  let asha: { token: string; userId: string };
  let ashaMember: string;
  const req = (token: string, amount: string, purpose?: string) => api("POST", `/orgs/${o.orgId}/me/upad-requests`, { token, body: { amount, purpose, idempotencyKey: uniq("ur") } });

  beforeAll(async () => {
    o = await createMandal("Request Mandal", "1000", JUL);
    ashaMember = (await ok(api("POST", `/orgs/${o.orgId}/members`, { token: o.admin.token, body: { name: "Asha Requester", joiningDate: "2026-07-01" } })))._id;
    const jul = await ok(api("GET", `/orgs/${o.orgId}/monthly?month=${JUL}`, { token: o.admin.token }));
    for (const r of jul.rows) await ok(api("POST", `/orgs/${o.orgId}/monthly/collect`, { token: o.admin.token, body: { installmentId: r.installmentId, amount: "1000", date: "2026-07-05", idempotencyKey: uniq("c") } }));
    // cash available: ₹2,000 (admin + Asha)
    const u = await registerAndLogin("Asha Login");
    await ok(api("POST", "/organizations/join", { token: u.token, body: { code: o.code } }));
    const pending = await ok<any[]>(api("GET", `/orgs/${o.orgId}/memberships?status=pending`, { token: o.admin.token }));
    await ok(api("PATCH", `/orgs/${o.orgId}/memberships/${pending.find((x) => x.user._id === u.userId)._id}`, { token: o.admin.token, body: { action: "approve", role: "member", memberId: ashaMember } }));
    asha = u;
  });

  it("can only ask for what the Mandal has available, one open request at a time", async () => {
    const mine = await ok(api("GET", `/orgs/${o.orgId}/me/upad-requests`, { token: asha.token }));
    expect(mine.availablePaise).toBe(200_000);
    const over = await req(asha.token, "2500");
    expect(over.status).toBe(400);
    expect(over.error?.message).toMatch(/₹2,000\.00 is available/);
    const r = await ok(req(asha.token, "1500", "School fees"));
    expect(r.request).toMatchObject({ status: "pending", amountPaise: 150_000, availableAtRequestPaise: 200_000 });
    expect((await req(asha.token, "100")).status).toBe(409); // already one pending
    await ok(api("POST", `/orgs/${o.orgId}/me/upad-requests/${r.request._id}/cancel`, { token: asha.token }));
    await ok(req(asha.token, "100")); // can ask again after cancelling
    const list = await ok(api("GET", `/orgs/${o.orgId}/upad-requests`, { token: o.admin.token }));
    expect(list.items).toHaveLength(1);
    expect(list.items[0].member.name).toBe("Asha Requester");
    const dash = await ok(api("GET", `/orgs/${o.orgId}/dashboard`, { token: o.admin.token }));
    expect(dash.pending.upadRequests).toBe(1);
    // members can't see or decide others' requests
    expect((await api("GET", `/orgs/${o.orgId}/upad-requests`, { token: asha.token })).status).toBe(403);
    expect((await api("POST", `/orgs/${o.orgId}/upad-requests/${list.items[0]._id}/approve`, { token: asha.token, body: {} })).status).toBe(403);
  });

  it("admin rejects with a reason, or approves — which gives the upad", async () => {
    const [first] = (await ok(api("GET", `/orgs/${o.orgId}/upad-requests`, { token: o.admin.token }))).items;
    await ok(api("POST", `/orgs/${o.orgId}/upad-requests/${first._id}/reject`, { token: o.admin.token, body: { reason: "Ask again next month" } }));
    const r = await ok(req(asha.token, "1500", "School fees"));
    const a = await ok(api("POST", `/orgs/${o.orgId}/upad-requests/${r.request._id}/approve`, { token: o.admin.token, body: { monthlyRate: "10" } }));
    expect(a.number).toMatch(/^UPAD\//);
    expect((await api("POST", `/orgs/${o.orgId}/upad-requests/${r.request._id}/approve`, { token: o.admin.token, body: {} })).status).toBe(409); // not twice
    const loans = await ok(api("GET", `/orgs/${o.orgId}/me/fund-loans`, { token: asha.token }));
    expect(loans.items[0]).toMatchObject({ principalPaise: 150_000, monthlyRate: "10", memberId: ashaMember });
    const mine = await ok(api("GET", `/orgs/${o.orgId}/me/upad-requests`, { token: asha.token }));
    expect(mine.items.map((x: any) => x.status)).toEqual(["approved", "rejected", "cancelled"]);
    expect(mine.items[0].loanId).toBe(loans.items[0]._id);
    expect(mine.availablePaise).toBe(50_000);
    // the ₹1,500 lent out is still part of the fund, just not cash in hand
    expect(mine.upadOutPaise).toBe(150_000);
    expect(mine.fundPaise).toBe(200_000);
  });

  it("approval re-checks the cash; if it's no longer there the request stays pending", async () => {
    const r = await ok(req(asha.token, "500"));
    // the admin gives ₹200 to someone else first → only ₹300 left
    const list = await ok(api("GET", `/orgs/${o.orgId}/members`, { token: o.admin.token }));
    const adminMember = list.items.find((m: any) => m._id !== ashaMember)._id;
    await ok(api("POST", `/orgs/${o.orgId}/fund-loans`, { token: o.admin.token, body: { memberId: adminMember, amount: "200", date: "2026-10-01", idempotencyKey: uniq("fl") } }));
    const a = await api("POST", `/orgs/${o.orgId}/upad-requests/${r.request._id}/approve`, { token: o.admin.token, body: {} });
    expect(a.status).toBe(400);
    expect(a.error?.message).toMatch(/can't give more cash than it holds/);
    const pending = await ok(api("GET", `/orgs/${o.orgId}/upad-requests`, { token: o.admin.token }));
    expect(pending.items.map((x: any) => x._id)).toContain(r.request._id);
  });

  it("requests can be switched off for the Mandal", async () => {
    const pending = await ok(api("GET", `/orgs/${o.orgId}/upad-requests`, { token: o.admin.token }));
    for (const x of pending.items) await ok(api("POST", `/orgs/${o.orgId}/upad-requests/${x._id}/reject`, { token: o.admin.token, body: { reason: "Closing requests" } }));
    await ok(api("PATCH", `/orgs/${o.orgId}`, { token: o.admin.token, body: { settings: { fundLoans: { defaultMonthlyRate: "2", dueDay: 10, allowMemberRequests: false } } } }));
    expect((await req(asha.token, "100")).status).toBe(403);
    expect((await ok(api("GET", `/orgs/${o.orgId}/me/upad-requests`, { token: asha.token }))).allowRequests).toBe(false);
  });
});

describe("'I have paid' with a purpose", () => {
  let o: Mandal;
  let mem: { token: string; userId: string };
  let memberId: string;
  let loanId: string;

  beforeAll(async () => {
    o = await createMandal("Paid Purpose Mandal", "1000", JUL);
    memberId = (await ok(api("POST", `/orgs/${o.orgId}/members`, { token: o.admin.token, body: { name: "Kiran Payer", joiningDate: "2026-07-01" } })))._id;
    const jul = await ok(api("GET", `/orgs/${o.orgId}/monthly?month=${JUL}`, { token: o.admin.token }));
    for (const r of jul.rows) await ok(api("POST", `/orgs/${o.orgId}/monthly/collect`, { token: o.admin.token, body: { installmentId: r.installmentId, amount: "1000", date: "2026-07-05", idempotencyKey: uniq("c") } }));
    mem = await registerAndLogin("Kiran Login");
    await ok(api("POST", "/organizations/join", { token: mem.token, body: { code: o.code } }));
    const pending = await ok<any[]>(api("GET", `/orgs/${o.orgId}/memberships?status=pending`, { token: o.admin.token }));
    await ok(api("PATCH", `/orgs/${o.orgId}/memberships/${pending.find((x) => x.user._id === mem.userId)._id}`, { token: o.admin.token, body: { action: "approve", role: "member", memberId } }));
    // ₹1,000 upad at 10% given in September → ₹100 interest due for October
    loanId = (await ok(api("POST", `/orgs/${o.orgId}/fund-loans`, { token: o.admin.token, body: { memberId, amount: "1000", date: "2026-09-10", monthlyRate: "10", idempotencyKey: uniq("fl") } }))).loan._id;
  });

  it("shows what the member owes: hapta due and each upad's interest", async () => {
    const opts = await ok(api("GET", `/orgs/${o.orgId}/me/payment-options`, { token: mem.token }));
    expect(opts.hapta.duePaise).toBeGreaterThan(0); // Aug onwards unpaid
    expect(opts.upads).toHaveLength(1);
    expect(opts.upads[0]).toMatchObject({ _id: loanId, outstandingPaise: 100_000 });
    expect(opts.upads[0].interestDuePaise).toBeGreaterThanOrEqual(10_000);
  });

  it("member reports upad interest + part returned; admin verifies → receipt with the member's method", async () => {
    const opts = await ok(api("GET", `/orgs/${o.orgId}/me/payment-options`, { token: mem.token }));
    const due = opts.upads[0].interestDuePaise as number;
    const claim = (body: Record<string, unknown>) => api("POST", `/orgs/${o.orgId}/me/upad-payments`, { token: mem.token, body: { loanId, date: "2026-10-20", method: "cash", idempotencyKey: uniq("uc"), ...body } });
    expect((await claim({ interestAmount: String(due / 100 + 1) })).status).toBe(400); // more than due
    expect((await claim({ principalAmount: "1001" })).status).toBe(400); // more than outstanding
    const c1 = await ok(claim({ interestAmount: String(due / 100), principalAmount: "200", reference: "UPI123" }));
    expect(c1.claim.status).toBe("pending");
    expect((await claim({ interestAmount: "1" })).status).toBe(400); // interest already reported, waiting for verification
    // nothing changes until it is verified
    expect((await ok(api("GET", `/orgs/${o.orgId}/fund-loans/${loanId}`, { token: o.admin.token }))).loan.outstandingPaise).toBe(100_000);
    expect((await api("POST", `/orgs/${o.orgId}/upad-payments/${c1.claim._id}/verify`, { token: mem.token, body: {} })).status).toBe(403);
    const list = await ok<any[]>(api("GET", `/orgs/${o.orgId}/upad-payments`, { token: o.admin.token }));
    expect(list.map((x) => x._id)).toEqual([c1.claim._id]);
    expect(list[0].member.name).toBe("Kiran Payer");
    const dash = await ok(api("GET", `/orgs/${o.orgId}/dashboard`, { token: o.admin.token }));
    expect(dash.pending.upadPayments).toBe(1);
    const v = await ok(api("POST", `/orgs/${o.orgId}/upad-payments/${c1.claim._id}/verify`, { token: o.admin.token, body: {} }));
    expect((await api("POST", `/orgs/${o.orgId}/upad-payments/${c1.claim._id}/verify`, { token: o.admin.token, body: {} })).status).toBe(409);
    const loan = await ok(api("GET", `/orgs/${o.orgId}/fund-loans/${loanId}`, { token: o.admin.token }));
    expect(loan.loan.outstandingPaise).toBe(80_000);
    expect(loan.loan.interestDuePaise).toBe(0);
    const receipt = await ok(api("GET", `/orgs/${o.orgId}/receipts/${v.receiptId}`, { token: mem.token }));
    expect(receipt.receipt).toMatchObject({ method: "cash", reference: "UPI123", amountPaise: due + 20_000 });
    const mine = await ok<any[]>(api("GET", `/orgs/${o.orgId}/me/upad-payments`, { token: mem.token }));
    expect(mine[0]).toMatchObject({ status: "verified", loanNumber: loan.loan.number });
  });

  it("admin can reject a reported upad payment with a reason", async () => {
    const c2 = await ok(api("POST", `/orgs/${o.orgId}/me/upad-payments`, { token: mem.token, body: { loanId, principalAmount: "100", date: "2026-10-21", method: "cash", idempotencyKey: uniq("uc") } }));
    await ok(api("POST", `/orgs/${o.orgId}/upad-payments/${c2.claim._id}/reject`, { token: o.admin.token, body: { reason: "Not received yet" } }));
    const mine = await ok<any[]>(api("GET", `/orgs/${o.orgId}/me/upad-payments`, { token: mem.token }));
    expect(mine[0]).toMatchObject({ status: "rejected", rejectedReason: "Not received yet" });
    expect((await ok(api("GET", `/orgs/${o.orgId}/fund-loans/${loanId}`, { token: o.admin.token }))).loan.outstandingPaise).toBe(80_000);
  });

  it("if the admin records the reported money with Receive, the member's claim closes itself", async () => {
    const c3 = await ok(api("POST", `/orgs/${o.orgId}/me/upad-payments`, { token: mem.token, body: { loanId, principalAmount: "100", date: "2026-10-22", method: "cash", idempotencyKey: uniq("uc") } }));
    const r = await ok(pay(o, loanId, { principalAmount: "100", date: "2026-10-22" }));
    expect(r.settledClaimId).toBe(c3.claim._id);
    expect(await ok<any[]>(api("GET", `/orgs/${o.orgId}/upad-payments`, { token: o.admin.token }))).toHaveLength(0);
    expect((await ok(api("GET", `/orgs/${o.orgId}/fund-loans/${loanId}`, { token: o.admin.token }))).loan.outstandingPaise).toBe(70_000); // counted once
    const mine = await ok<any[]>(api("GET", `/orgs/${o.orgId}/me/upad-payments`, { token: mem.token }));
    expect(mine.find((x) => x._id === c3.claim._id)).toMatchObject({ status: "verified", paymentId: r.payment._id });
  });

  it("a claim already covered by a different Receive is flagged; Verify refuses, 'Already recorded' closes it", async () => {
    const c4 = await ok(api("POST", `/orgs/${o.orgId}/me/upad-payments`, { token: mem.token, body: { loanId, principalAmount: "50", date: "2026-10-23", method: "cash", idempotencyKey: uniq("uc") } }));
    const r = await ok(pay(o, loanId, { principalAmount: "60", date: "2026-10-23" }));
    expect(r.settledClaimId).toBeNull(); // amounts differ: not closed automatically
    const [listed] = await ok<any[]>(api("GET", `/orgs/${o.orgId}/upad-payments`, { token: o.admin.token }));
    expect(listed.alreadyRecorded).toMatchObject({ paymentId: r.payment._id, principalPaise: 6_000 });
    const v = await api("POST", `/orgs/${o.orgId}/upad-payments/${c4.claim._id}/verify`, { token: o.admin.token, body: {} });
    expect(v.status).toBe(409);
    expect(JSON.stringify(v)).toContain("Already recorded");
    await ok(api("POST", `/orgs/${o.orgId}/upad-payments/${c4.claim._id}/settle`, { token: o.admin.token }));
    expect((await ok(api("GET", `/orgs/${o.orgId}/fund-loans/${loanId}`, { token: o.admin.token }))).loan.outstandingPaise).toBe(64_000);
    expect(await ok<any[]>(api("GET", `/orgs/${o.orgId}/upad-payments`, { token: o.admin.token }))).toHaveLength(0);
    // a claim with no covering payment can't be settled
    const c5 = await ok(api("POST", `/orgs/${o.orgId}/me/upad-payments`, { token: mem.token, body: { loanId, principalAmount: "10", date: "2026-10-24", method: "cash", idempotencyKey: uniq("uc") } }));
    expect((await api("POST", `/orgs/${o.orgId}/upad-payments/${c5.claim._id}/settle`, { token: o.admin.token })).status).toBe(400);
    await ok(api("POST", `/orgs/${o.orgId}/upad-payments/${c5.claim._id}/reject`, { token: o.admin.token, body: { reason: "Test" } }));
  });

  it("'Other' payments need a note and don't touch hapta", async () => {
    const send = (body: Record<string, unknown>) => api("POST", `/orgs/${o.orgId}/me/payment-requests`, { token: mem.token, body: { purpose: "other", amount: "251", date: "2026-10-20", method: "cash", idempotencyKey: uniq("pr"), ...body } });
    expect((await send({})).status).toBe(400);
    const r = await ok(send({ notes: "Navratri donation" }));
    expect(r.payment).toMatchObject({ kind: "other_income", status: "pending", allocations: [] });
    const h = await ok(api("POST", `/orgs/${o.orgId}/me/payment-requests`, { token: mem.token, body: { amount: "1000", date: "2026-10-20", method: "cash", idempotencyKey: uniq("pr") } }));
    expect(h.payment.kind).toBe("hapta"); // default purpose stays hapta
    expect(h.payment.allocations.length).toBeGreaterThan(0);
  });
});
