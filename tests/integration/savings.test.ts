import { beforeAll, describe, expect, it } from "vitest";
import { api, makePlatformAdmin, ok, registerAndLogin, uniq } from "../helpers/api";

/**
 * The real Mandal use case: monthly hapta in cash, member savings balances, monthly interest,
 * withdrawals and the cash book — all through the HTTP API against a real MongoDB.
 */

const nowMonth = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 7); // Asia/Kolkata
const addMonths = (m: string, n: number) => {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};

async function createMandal(name: string, hapta: string, startMonth: string) {
  const admin = await registerAndLogin(`${name} Admin`);
  const org = await ok(api("POST", "/organizations", { token: admin.token, body: { name, monthlyHaptaAmount: hapta, haptaStartMonth: startMonth, haptaDueDay: 10 } }));
  if (org.status === "pending") {
    const pa = await registerAndLogin("Platform Admin");
    await makePlatformAdmin(pa.userId);
    await ok(api("PATCH", `/platform/organizations/${org.id}`, { token: pa.token, body: { action: "approve" } }));
  }
  const accounts = await ok<any[]>(api("GET", `/orgs/${org.id}/accounts`, { token: admin.token }));
  return { orgId: org.id as string, code: org.code as string, admin, cashAccountId: accounts[0]._id as string };
}

type Mandal = Awaited<ReturnType<typeof createMandal>>;
const monthRows = async (o: Mandal, m: string, token = o.admin.token) => ok(api("GET", `/orgs/${o.orgId}/monthly?month=${m}`, { token }));
const rowFor = (view: any, memberId: string) => view.rows.find((r: any) => r.memberId === memberId);
const collect = (o: Mandal, installmentId: string, amount: string, date: string, extra: Record<string, unknown> = {}) =>
  api("POST", `/orgs/${o.orgId}/monthly/collect`, { token: o.admin.token, body: { installmentId, amount, date, idempotencyKey: uniq("c"), ...extra } });
const memberBalance = async (o: Mandal, memberId: string) => (await ok(api("GET", `/orgs/${o.orgId}/members/${memberId}/ledger`, { token: o.admin.token }))).closingBalancePaise as number;
const reconcile = (o: Mandal) => ok(api("GET", `/orgs/${o.orgId}/member-funds/reconcile`, { token: o.admin.token }));
const cashBal = async (o: Mandal) => (await ok<any[]>(api("GET", `/orgs/${o.orgId}/accounts`, { token: o.admin.token }))).find((a) => a._id === o.cashAccountId).balancePaise as number;

const START = "2026-07";
const JUL = "2026-07";
const AUG = "2026-08";
const SEP = "2026-09";

describe("Parivar Mandal (₹500/month)", () => {
  let o: Mandal;
  let creatorMemberId: string;
  let asha: any;
  let bhavin: any;

  beforeAll(async () => {
    o = await createMandal("Parivar Mandal", "500", START);
    asha = await ok(api("POST", `/orgs/${o.orgId}/members`, { token: o.admin.token, body: { name: "Asha Patel", phone: "9800000001", joiningDate: "2026-07-01" } }));
    bhavin = await ok(api("POST", `/orgs/${o.orgId}/members`, { token: o.admin.token, body: { name: "Bhavin Shah", phone: "9800000002", joiningDate: "2026-07-01" } }));
    const me = await ok(api("GET", `/orgs/${o.orgId}/members?q=${encodeURIComponent("Parivar Mandal Admin")}`, { token: o.admin.token }));
    creatorMemberId = (me.items ?? me)[0]._id;
  });

  describe("installment generation", () => {
    it("creates one installment per active member per month at the Mandal's amount", async () => {
      const org = await ok(api("GET", `/orgs/${o.orgId}`, { token: o.admin.token }));
      expect(org.settings.monthlyHapta.amountPaise).toBe(50_000);
      for (const m of [JUL, AUG, SEP]) {
        const v = await monthRows(o, m);
        expect(v.rows).toHaveLength(3);
        expect(new Set(v.rows.map((r: any) => r.memberId)).size).toBe(3);
        expect(v.rows.every((r: any) => r.expectedPaise === 50_000)).toBe(true);
        expect(v.summary.expectedPaise).toBe(150_000);
        expect(v.notEnrolled).toHaveLength(0);
      }
      expect(rowFor(await monthRows(o, JUL), creatorMemberId)).toBeTruthy();
    });

    it("starts a member from their joining month, and lists un-enrolled members for the month", async () => {
      const late = await ok(api("POST", `/orgs/${o.orgId}/members`, { token: o.admin.token, body: { name: "Chirag Late", joiningDate: "2026-09-03" } }));
      expect(rowFor(await monthRows(o, AUG), late._id)).toBeUndefined();
      expect(rowFor(await monthRows(o, SEP), late._id)).toBeTruthy();
      const skip = await ok(api("POST", `/orgs/${o.orgId}/members`, { token: o.admin.token, body: { name: "Dipti Skip", enrollInMonthlyHapta: false } }));
      const v = await monthRows(o, nowMonth());
      expect(v.notEnrolled.map((m: any) => m._id)).toContain(skip._id);
      await ok(api("POST", `/orgs/${o.orgId}/monthly/enroll`, { token: o.admin.token, body: { memberIds: [skip._id] } }));
      await ok(api("POST", `/orgs/${o.orgId}/monthly/enroll`, { token: o.admin.token, body: { memberIds: [skip._id] } })); // idempotent
      const v2 = await monthRows(o, nowMonth());
      expect(v2.notEnrolled.map((m: any) => m._id)).not.toContain(skip._id);
      expect(v2.rows.filter((r: any) => r.memberId === skip._id)).toHaveLength(1);
      // keep the rest of the suite to the original three members
      for (const id of [late._id, skip._id]) await ok(api("PATCH", `/orgs/${o.orgId}/members/${id}`, { token: o.admin.token, body: { status: "inactive" } }));
    });

    it("changing the amount applies to future months only", async () => {
      const cur = nowMonth();
      expect((await api("PATCH", `/orgs/${o.orgId}/monthly-hapta`, { token: o.admin.token, body: { amount: "600", effectiveMonth: addMonths(cur, -1) } })).status).toBe(400);
      const r = await ok(api("PATCH", `/orgs/${o.orgId}/monthly-hapta`, { token: o.admin.token, body: { amount: "600" } }));
      expect(r.effectiveMonth).toBe(addMonths(cur, 1));
      expect(rowFor(await monthRows(o, cur), asha._id).expectedPaise).toBe(50_000);
      expect(rowFor(await monthRows(o, JUL), asha._id).expectedPaise).toBe(50_000);
      expect(rowFor(await monthRows(o, addMonths(cur, 1)), asha._id).expectedPaise).toBe(60_000);
      // and back, so the remaining tests stay simple
      await ok(api("PATCH", `/orgs/${o.orgId}/monthly-hapta`, { token: o.admin.token, body: { amount: "500" } }));
      expect(rowFor(await monthRows(o, addMonths(cur, 1)), asha._id).expectedPaise).toBe(50_000);
    });
  });

  describe("cash collection", () => {
    it("records full and partial cash payments; unpaid months are not counted as collected", async () => {
      const jul = await monthRows(o, JUL);
      await ok(collect(o, rowFor(jul, asha._id).installmentId, "500", "2026-07-05"));
      await ok(collect(o, rowFor(jul, bhavin._id).installmentId, "200", "2026-07-06"));
      const v = await monthRows(o, JUL);
      expect(rowFor(v, asha._id)).toMatchObject({ status: "paid", collectedPaise: 50_000, outstandingPaise: 0 });
      expect(rowFor(v, asha._id).recordedBy).toEqual(["Parivar Mandal Admin"]);
      // past the due date, a part-paid month is overdue (with the part payment shown)
      expect(rowFor(v, bhavin._id)).toMatchObject({ status: "overdue", collectedPaise: 20_000, outstandingPaise: 30_000 });
      expect(rowFor(v, creatorMemberId).status).toBe("overdue");
      expect(v.summary.collectedPaise).toBe(70_000);
      expect(v.summary.outstandingPaise).toBe(80_000);
      expect(v.summary.cashReceivedInMonthPaise).toBe(70_000);
      expect(await memberBalance(o, asha._id)).toBe(50_000);
      expect(await memberBalance(o, bhavin._id)).toBe(20_000);
      expect(await memberBalance(o, creatorMemberId)).toBe(0);
      expect(await cashBal(o)).toBe(70_000);
    });

    it("refuses overpayment, flags suspected duplicates and is idempotent", async () => {
      const jul = await monthRows(o, JUL);
      const inst = rowFor(jul, bhavin._id).installmentId;
      expect((await collect(o, inst, "400", "2026-07-20")).status).toBe(400); // only 300 outstanding
      const dup = await collect(o, inst, "200", "2026-07-06");
      expect(dup.status).toBe(409);
      expect((dup.error?.details as any)?.code).toBe("DUPLICATE_SUSPECTED");
      const key = uniq("same");
      const a = await ok(collect(o, inst, "300", "2026-07-25", { idempotencyKey: key }));
      const b = await ok(collect(o, inst, "300", "2026-07-25", { idempotencyKey: key }));
      expect(b.payment._id).toBe(a.payment._id);
      expect(rowFor(await monthRows(o, JUL), bhavin._id).status).toBe("paid");
      expect((await collect(o, inst, "1", "2026-07-26")).status).toBe(400); // already fully paid
      expect(await memberBalance(o, bhavin._id)).toBe(50_000);
      expect((await reconcile(o)).reconciled).toBe(true);
    });

    it("a reversed payment comes off the member's balance and the cash", async () => {
      const aug = await monthRows(o, AUG);
      const p = await ok(collect(o, rowFor(aug, creatorMemberId).installmentId, "500", "2026-08-04"));
      expect(await memberBalance(o, creatorMemberId)).toBe(50_000);
      await ok(api("POST", `/orgs/${o.orgId}/payments/${p.payment._id}/reverse`, { token: o.admin.token, body: { reason: "Entered for the wrong member" } }));
      expect(await memberBalance(o, creatorMemberId)).toBe(0);
      expect(rowFor(await monthRows(o, AUG), creatorMemberId).collectedPaise).toBe(0);
      expect(await cashBal(o)).toBe(100_000);
      expect((await reconcile(o)).reconciled).toBe(true);
    });
  });

  describe("interest", () => {
    it("rate mode: previews eligible balance × rate using the previous month's closing balance", async () => {
      // August hapta paid in August must not earn August interest.
      const aug = await monthRows(o, AUG);
      await ok(collect(o, rowFor(aug, asha._id).installmentId, "500", "2026-08-03"));
      const pv = await ok(api("POST", `/orgs/${o.orgId}/interest/preview`, { token: o.admin.token, body: { period: AUG, mode: "rate", monthlyRate: "1.5" } }));
      expect(pv.basisDate.slice(0, 10)).toBe("2026-07-31");
      const a = pv.rows.find((r: any) => r.memberId === asha._id);
      const b = pv.rows.find((r: any) => r.memberId === bhavin._id);
      const c = pv.rows.find((r: any) => r.memberId === creatorMemberId);
      expect([a.eligibleBalancePaise, a.interestPaise]).toEqual([50_000, 750]);
      expect([b.eligibleBalancePaise, b.interestPaise]).toEqual([50_000, 750]);
      expect([c.eligibleBalancePaise, c.interestPaise]).toEqual([0, 0]);
      expect(pv.totalPaise).toBe(1_500);
    });

    it("finalizing credits members once, stores the rate and basis, and moves no cash", async () => {
      const cashBefore = await cashBal(o);
      const r = await ok(api("POST", `/orgs/${o.orgId}/interest/runs`, { token: o.admin.token, body: { period: AUG, mode: "rate", monthlyRate: "1.5", idempotencyKey: uniq("i") } }));
      expect(r.run).toMatchObject({ period: AUG, mode: "rate", monthlyRate: "1.5", basis: "previous_month_closing", totalPaise: 1_500 });
      expect(r.run.entries).toHaveLength(2);
      expect(r.run.entries[0].eligibleBalancePaise).toBe(50_000);
      expect(await memberBalance(o, asha._id)).toBe(100_000 + 750);
      expect(await memberBalance(o, bhavin._id)).toBe(50_000 + 750);
      expect(await cashBal(o)).toBe(cashBefore);
      // no double credit — rate or manual
      expect((await api("POST", `/orgs/${o.orgId}/interest/runs`, { token: o.admin.token, body: { period: AUG, mode: "rate", monthlyRate: "1.5", idempotencyKey: uniq("i") } })).status).toBe(400);
      expect((await api("POST", `/orgs/${o.orgId}/interest/runs`, { token: o.admin.token, body: { period: AUG, mode: "manual", entries: [{ memberId: asha._id, amount: "10" }], idempotencyKey: uniq("i") } })).status).toBe(409);
      const pv = await ok(api("POST", `/orgs/${o.orgId}/interest/preview`, { token: o.admin.token, body: { period: AUG, mode: "rate", monthlyRate: "1.5" } }));
      expect(pv.alreadyCreditedCount).toBe(2);
      expect(pv.totalPaise).toBe(0);
      expect((await reconcile(o)).reconciled).toBe(true);
    });

    it("manual mode credits the entered amounts; the hapta-only basis ignores interest", async () => {
      const r = await ok(api("POST", `/orgs/${o.orgId}/interest/runs`, { token: o.admin.token, body: { period: AUG, mode: "manual", entries: [{ memberId: creatorMemberId, amount: "25" }], note: "Goodwill", idempotencyKey: uniq("i") } }));
      expect(r.run.totalPaise).toBe(2_500);
      expect(await memberBalance(o, creatorMemberId)).toBe(2_500);
      const pv = await ok(api("POST", `/orgs/${o.orgId}/interest/preview`, { token: o.admin.token, body: { period: SEP, mode: "rate", monthlyRate: "1", basis: "hapta_contributions" } }));
      expect(pv.rows.find((x: any) => x.memberId === asha._id).eligibleBalancePaise).toBe(100_000); // excludes the ₹7.50 interest
      const pv2 = await ok(api("POST", `/orgs/${o.orgId}/interest/preview`, { token: o.admin.token, body: { period: SEP, mode: "rate", monthlyRate: "1" } }));
      expect(pv2.rows.find((x: any) => x.memberId === asha._id).eligibleBalancePaise).toBe(100_750);
      expect((await api("POST", `/orgs/${o.orgId}/interest/preview`, { token: o.admin.token, body: { period: addMonths(nowMonth(), 1), mode: "rate" } })).status).toBe(400);
    });
  });

  describe("withdrawals", () => {
    const wd = (body: Record<string, unknown>, token = o.admin.token) =>
      api("POST", `/orgs/${o.orgId}/withdrawals`, { token, body: { date: "2026-09-15", idempotencyKey: uniq("w"), ...body } });

    it("pays out up to the member's balance with a voucher number", async () => {
      expect((await wd({ memberId: bhavin._id, amount: "600" })).status).toBe(400); // balance 507.50
      const r = await ok(wd({ memberId: bhavin._id, amount: "200", note: "Medical" }));
      expect(r.withdrawal.number).toMatch(/^WDL\//);
      expect([r.withdrawal.balanceBeforePaise, r.withdrawal.balanceAfterPaise]).toEqual([50_750, 30_750]);
      expect(await memberBalance(o, bhavin._id)).toBe(30_750);
      const v = await ok(api("GET", `/orgs/${o.orgId}/withdrawals/${r.withdrawal._id}`, { token: o.admin.token }));
      expect(v.member.name).toBe("Bhavin Shah");
      const dup = await wd({ memberId: bhavin._id, amount: "200" });
      expect(dup.status).toBe(409);
      expect((dup.error?.details as any)?.code).toBe("DUPLICATE_SUSPECTED");
      expect((await reconcile(o)).reconciled).toBe(true);
    });

    it("two simultaneous withdrawals can never overdraw a balance", async () => {
      // Asha has 1,007.50; two concurrent 600s → exactly one succeeds
      const res = await Promise.all([wd({ memberId: asha._id, amount: "600", date: "2026-09-16" }), wd({ memberId: asha._id, amount: "600", date: "2026-09-17" })]);
      expect(res.map((r) => r.status).sort()).toEqual([200, 400]);
      expect(res.filter((r) => r.status < 300)).toHaveLength(1);
      expect(await memberBalance(o, asha._id)).toBe(100_750 - 60_000);
      expect((await reconcile(o)).reconciled).toBe(true);
    });

    it("exceptions above the balance need the setting, the admin and a reason", async () => {
      expect((await wd({ memberId: creatorMemberId, amount: "100", allowExceedBalance: true, exceptionReason: "Emergency" })).status).toBe(403); // disabled
      await ok(api("PATCH", `/orgs/${o.orgId}`, { token: o.admin.token, body: { settings: { withdrawals: { allowExceptions: true } } } }));
      expect((await wd({ memberId: creatorMemberId, amount: "100", allowExceedBalance: true })).status).toBe(400); // no reason
      const r = await ok(wd({ memberId: creatorMemberId, amount: "100", allowExceedBalance: true, exceptionReason: "Hospital emergency, approved in meeting" }));
      expect(r.withdrawal.balanceAfterPaise).toBe(2_500 - 10_000);
      expect(r.withdrawal.exceptionReason).toContain("Hospital");
    });

    it("cannot pay out more cash than the Mandal holds", async () => {
      const cash = await cashBal(o);
      const r = await wd({ memberId: creatorMemberId, amount: String(cash / 100 + 1), allowExceedBalance: true, exceptionReason: "Testing the cash limit" });
      expect(r.status).toBe(400);
      expect(r.error?.message).toMatch(/cash/i);
    });

    it("reversal restores the member balance and the cash", async () => {
      const list = await ok(api("GET", `/orgs/${o.orgId}/withdrawals?memberId=${bhavin._id}`, { token: o.admin.token }));
      const w = list.items[0];
      const cashBefore = await cashBal(o);
      await ok(api("POST", `/orgs/${o.orgId}/withdrawals/${w._id}/reverse`, { token: o.admin.token, body: { reason: "Paid twice by mistake" } }));
      expect((await api("POST", `/orgs/${o.orgId}/withdrawals/${w._id}/reverse`, { token: o.admin.token, body: { reason: "again please" } })).status).toBe(409);
      expect(await memberBalance(o, bhavin._id)).toBe(50_750);
      expect(await cashBal(o)).toBe(cashBefore + 20_000);
      expect((await reconcile(o)).reconciled).toBe(true);
    });
  });

  describe("member balances, adjustments and books", () => {
    it("opening balance is set once; adjustments are audited and reversible by an opposite entry", async () => {
      const m = await ok(api("POST", `/orgs/${o.orgId}/members`, { token: o.admin.token, body: { name: "Ela Opening", joiningDate: "2026-07-01", enrollInMonthlyHapta: false } }));
      await ok(api("POST", `/orgs/${o.orgId}/members/${m._id}/opening`, { token: o.admin.token, body: { amount: "2000", date: "2026-07-01" } }));
      expect((await api("POST", `/orgs/${o.orgId}/members/${m._id}/opening`, { token: o.admin.token, body: { amount: "2000", date: "2026-07-01" } })).status).toBe(409);
      await ok(api("POST", `/orgs/${o.orgId}/members/${m._id}/adjustments`, { token: o.admin.token, body: { direction: "debit", amount: "150", date: "2026-08-01", reason: "Correct an old entry", idempotencyKey: uniq("a") } }));
      const st = await ok(api("GET", `/orgs/${o.orgId}/members/${m._id}/ledger`, { token: o.admin.token }));
      expect(st.closingBalancePaise).toBe(185_000);
      expect(st.lines.map((e: any) => e.kind)).toEqual(["opening", "adjustment"]);
      expect((await reconcile(o)).reconciled).toBe(true);
      await ok(api("PATCH", `/orgs/${o.orgId}/members/${m._id}`, { token: o.admin.token, body: { status: "inactive" } }));
    });

    it("member balance = opening + hapta + interest + credits − withdrawals − debits, separate from Mandal cash", async () => {
      const st = await ok(api("GET", `/orgs/${o.orgId}/members/${asha._id}/ledger`, { token: o.admin.token }));
      const t = st.totals;
      expect(t.haptaPaise).toBe(100_000);
      expect(t.interestPaise).toBe(750);
      expect(t.withdrawalsPaise).toBe(60_000);
      expect(st.closingBalancePaise).toBe(40_750);
      const rec = await reconcile(o);
      const cb = await ok(api("GET", `/orgs/${o.orgId}/cashbook`, { token: o.admin.token }));
      expect(cb.closingBalancePaise).toBe(await cashBal(o));
      expect(cb.summary.haptaCollectedPaise).toBe(150_000); // 500+200+300 (Jul) + 500 (Aug, Asha); creator's Aug reversed
      expect(cb.summary.withdrawalsPaidPaise).toBe(60_000 + 10_000);
      // cash = Σ hapta − withdrawals; member funds exceed cash by the interest credited (an obligation, not cash)
      expect(cb.closingBalancePaise).toBe(150_000 - 70_000);
      expect(rec.generalLedgerPaise - cb.closingBalancePaise).toBe(750 + 750 + 2_500 + 185_000);
    });

    it("cash in/out entries appear in the cash book and can't overdraw cash", async () => {
      const before = await ok(api("GET", `/orgs/${o.orgId}/cashbook`, { token: o.admin.token }));
      await ok(api("POST", `/orgs/${o.orgId}/cashbook/entries`, { token: o.admin.token, body: { direction: "in", amount: "1000", date: "2026-09-20", description: "Diwali stall surplus", idempotencyKey: uniq("ce") } }));
      await ok(api("POST", `/orgs/${o.orgId}/cashbook/entries`, { token: o.admin.token, body: { direction: "out", amount: "250", date: "2026-09-21", description: "Register and pens", idempotencyKey: uniq("ce") } }));
      expect((await api("POST", `/orgs/${o.orgId}/cashbook/entries`, { token: o.admin.token, body: { direction: "out", amount: "100000", date: "2026-09-21", description: "Too much", idempotencyKey: uniq("ce") } })).status).toBe(400);
      const after = await ok(api("GET", `/orgs/${o.orgId}/cashbook`, { token: o.admin.token }));
      expect(after.summary.otherReceiptsPaise - before.summary.otherReceiptsPaise).toBe(100_000);
      expect(after.summary.otherExpensesPaise - before.summary.otherExpensesPaise).toBe(25_000);
      expect(after.closingBalancePaise - before.closingBalancePaise).toBe(75_000);
      const sep = await ok(api("GET", `/orgs/${o.orgId}/cashbook?from=2026-09-01&to=2026-09-30`, { token: o.admin.token }));
      expect(sep.openingBalancePaise).toBe(sep.closingBalancePaise - sep.summary.totalReceiptsPaise + sep.summary.totalPaymentsPaise);
      const csv = await api("GET", `/orgs/${o.orgId}/cashbook?format=csv`, { token: o.admin.token });
      expect(csv.status).toBe(200);
      expect(String(csv.data)).toContain("Diwali stall surplus");
    });

    it("dashboard and monthly report come from the same records", async () => {
      const d = await ok(api("GET", `/orgs/${o.orgId}/dashboard`, { token: o.admin.token }));
      const rec = await reconcile(o);
      expect(d.totals.totalMemberBalancesPaise).toBe(rec.generalLedgerPaise);
      expect(d.totals.mandalCashPaise).toBe(await cashBal(o));
      expect(d.recentWithdrawals.length).toBeGreaterThan(0);
      const rpt = await ok(api("GET", `/orgs/${o.orgId}/monthly-report?month=${AUG}`, { token: o.admin.token }));
      expect(rpt.month).toBe(AUG);
      const a = rpt.members.find((m: any) => m.memberId === asha._id);
      expect(a).toMatchObject({ openingPaise: 50_000, haptaPaise: 50_000, interestPaise: 750, withdrawalsPaise: 0, closingPaise: 100_750 });
    });
  });

  describe("roles and member self-service", () => {
    let memberUser: Awaited<ReturnType<typeof registerAndLogin>>;

    it("an invited existing user accepts in-app and becomes a linked, enrolled member", async () => {
      memberUser = await registerAndLogin("Farah Invitee");
      const inv = await ok(api("POST", `/orgs/${o.orgId}/invitations`, { token: o.admin.token, body: { email: memberUser.email, role: "member" } }));
      expect(inv.existingUser).toBe(true);
      const mine = await ok<any[]>(api("GET", "/invitations/mine", { token: memberUser.token }));
      const invite = mine.find((i) => i.organization?._id === o.orgId);
      expect(invite).toBeTruthy();
      await ok(api("POST", `/invitations/${invite.id}/accept`, { token: memberUser.token }));
      expect((await api("POST", `/orgs/${o.orgId}/invitations`, { token: o.admin.token, body: { email: memberUser.email, role: "member" } })).status).toBe(409);
      const myLedger = await ok(api("GET", `/orgs/${o.orgId}/me/ledger`, { token: memberUser.token }));
      expect(myLedger.member.name).toBe("Farah Invitee");
      const v = await monthRows(o, nowMonth());
      expect(rowFor(v, myLedger.member._id)).toBeTruthy();
    });

    it("members see only their own data", async () => {
      expect((await api("GET", `/orgs/${o.orgId}/members/${asha._id}/ledger`, { token: memberUser.token })).status).toBe(403);
      expect((await api("GET", `/orgs/${o.orgId}/monthly?month=${JUL}`, { token: memberUser.token })).status).toBe(403);
      expect((await api("GET", `/orgs/${o.orgId}/cashbook`, { token: memberUser.token })).status).toBe(403);
      expect((await api("POST", `/orgs/${o.orgId}/interest/preview`, { token: memberUser.token, body: { period: AUG, mode: "rate" } })).status).toBe(403);
      const list = await ok(api("GET", `/orgs/${o.orgId}/withdrawals?memberId=${asha._id}`, { token: o.admin.token }));
      expect((await api("GET", `/orgs/${o.orgId}/withdrawals/${list.items[0]._id}`, { token: memberUser.token })).status).toBe(404);
      const mine = await ok(api("GET", `/orgs/${o.orgId}/me/withdrawals`, { token: memberUser.token }));
      expect(mine.items).toHaveLength(0);
      const dash = await ok(api("GET", `/orgs/${o.orgId}/dashboard`, { token: memberUser.token }));
      expect(dash.role).toBe("member");
      expect(dash.savings.balancePaise).toBe(0);
    });

    it("managers record collections but need permission for withdrawals and interest", async () => {
      const mgr = await registerAndLogin("Manager Mehul");
      await ok(api("POST", "/organizations/join", { token: mgr.token, body: { code: o.code } }));
      await ok(api("POST", "/organizations/join", { token: mgr.token, body: { code: o.code } })); // duplicate request is harmless
      const pending = await ok<any[]>(api("GET", `/orgs/${o.orgId}/memberships?status=pending`, { token: o.admin.token }));
      expect(pending.filter((m) => m.user._id === mgr.userId)).toHaveLength(1);
      await ok(api("PATCH", `/orgs/${o.orgId}/memberships/${pending.find((m) => m.user._id === mgr.userId)._id}`, { token: o.admin.token, body: { action: "approve", role: "manager", createMember: false } }));
      const sep = await monthRows(o, SEP, mgr.token);
      await ok(api("POST", `/orgs/${o.orgId}/monthly/collect`, { token: mgr.token, body: { installmentId: rowFor(sep, asha._id).installmentId, amount: "500", date: "2026-09-08", idempotencyKey: uniq("c") } }));
      expect((await api("POST", `/orgs/${o.orgId}/withdrawals`, { token: mgr.token, body: { memberId: asha._id, amount: "10", date: "2026-09-20", idempotencyKey: uniq("w") } })).status).toBe(403);
      expect((await api("POST", `/orgs/${o.orgId}/interest/runs`, { token: mgr.token, body: { period: SEP, mode: "manual", entries: [], idempotencyKey: uniq("i") } })).status).toBe(403);
      expect((await api("POST", `/orgs/${o.orgId}/members/${asha._id}/adjustments`, { token: mgr.token, body: { direction: "credit", amount: "1", date: "2026-09-20", reason: "nope", idempotencyKey: uniq("a") } })).status).toBe(403);
    });
  });
});

describe("two Mandals for the same person stay isolated", () => {
  let parivar: Mandal;
  let college: Mandal;
  let user: Awaited<ReturnType<typeof registerAndLogin>>;

  beforeAll(async () => {
    parivar = await createMandal("Parivar Isolation Mandal", "500", START);
    college = await createMandal("College Friends Mandal", "1000", START);
    user = await registerAndLogin("Gaurav Both");
  });

  it("finds a Mandal by name or code, requests to join and gets a member record on approval", async () => {
    const found = await ok<any[]>(api("GET", `/organizations/search?q=${encodeURIComponent("College Friends")}`, { token: user.token }));
    const hit = found.find((f) => f.id === college.orgId || f._id === college.orgId);
    expect(hit).toBeTruthy();
    expect(hit.acceptsJoinRequests).toBe(true);
    await ok(api("POST", "/organizations/join", { token: user.token, body: { organizationId: college.orgId } }));
    await ok(api("POST", "/organizations/join", { token: user.token, body: { code: parivar.code } }));
    for (const o of [parivar, college]) {
      const pending = await ok<any[]>(api("GET", `/orgs/${o.orgId}/memberships?status=pending`, { token: o.admin.token }));
      const m = pending.find((x) => x.user._id === user.userId);
      await ok(api("PATCH", `/orgs/${o.orgId}/memberships/${m._id}`, { token: o.admin.token, body: { action: "approve", role: "member", haptaStartMonth: JUL } }));
    }
    expect((await api("POST", "/organizations/join", { token: user.token, body: { code: college.code } })).status).toBe(409);
    const p = await ok(api("GET", `/orgs/${parivar.orgId}/me/ledger`, { token: user.token }));
    const c = await ok(api("GET", `/orgs/${college.orgId}/me/ledger`, { token: user.token }));
    expect(p.member._id).not.toBe(c.member._id);
    expect(rowFor(await monthRows(parivar, JUL), p.member._id).expectedPaise).toBe(50_000);
    expect(rowFor(await monthRows(college, JUL), c.member._id).expectedPaise).toBe(100_000);
  });

  it("payments, balances and withdrawals never cross Mandals", async () => {
    const p = await ok(api("GET", `/orgs/${parivar.orgId}/me/ledger`, { token: user.token }));
    const c = await ok(api("GET", `/orgs/${college.orgId}/me/ledger`, { token: user.token }));
    const cRow = rowFor(await monthRows(college, JUL), c.member._id);
    // Parivar's admin can't touch College's installment, member or withdrawal endpoints
    expect((await api("POST", `/orgs/${parivar.orgId}/monthly/collect`, { token: parivar.admin.token, body: { installmentId: cRow.installmentId, amount: "1000", date: "2026-07-05", idempotencyKey: uniq("x") } })).status).toBe(404);
    expect((await api("POST", `/orgs/${college.orgId}/monthly/collect`, { token: parivar.admin.token, body: { installmentId: cRow.installmentId, amount: "1000", date: "2026-07-05", idempotencyKey: uniq("x") } })).status).toBe(404); // not a member there
    expect((await api("GET", `/orgs/${parivar.orgId}/members/${c.member._id}/ledger`, { token: parivar.admin.token })).status).toBe(404);
    await ok(collect(college, cRow.installmentId, "1000", "2026-07-05"));
    expect((await api("POST", `/orgs/${parivar.orgId}/withdrawals`, { token: parivar.admin.token, body: { memberId: c.member._id, amount: "100", date: "2026-07-20", idempotencyKey: uniq("w") } })).status).toBe(404);
    const pAfter = await ok(api("GET", `/orgs/${parivar.orgId}/me/ledger`, { token: user.token }));
    const cAfter = await ok(api("GET", `/orgs/${college.orgId}/me/ledger`, { token: user.token }));
    expect(pAfter.closingBalancePaise).toBe(0);
    expect(cAfter.closingBalancePaise).toBe(100_000);
    expect(p.member._id).toBe(pAfter.member._id);
    expect(await cashBal(parivar)).toBe(0);
    expect(await cashBal(college)).toBe(100_000);
    expect((await reconcile(parivar)).reconciled).toBe(true);
    expect((await reconcile(college)).reconciled).toBe(true);
  });
});

describe("approving from the Users screen", () => {
  it("creates the member record even when the form sends memberId: null, and an already-approved user can be added later", async () => {
    const o = await createMandal("Approval Mandal", "500", START);
    const join = async (name: string) => {
      const u = await registerAndLogin(name);
      await ok(api("POST", "/organizations/join", { token: u.token, body: { code: o.code } }));
      const pending = await ok<any[]>(api("GET", `/orgs/${o.orgId}/memberships?status=pending`, { token: o.admin.token }));
      return { u, m: pending.find((x) => x.user._id === u.userId) };
    };
    const members = async () => (await ok(api("GET", `/orgs/${o.orgId}/members?pageSize=100`, { token: o.admin.token }))).items.map((x: any) => x.name);

    // exactly what the approve button sends
    const a = await join("Hetal Joiner");
    await ok(api("PATCH", `/orgs/${o.orgId}/memberships/${a.m._id}`, { token: o.admin.token, body: { action: "approve", role: "member", memberId: null, createMember: true, haptaStartMonth: JUL } }));
    expect(await members()).toContain("Hetal Joiner");
    const ledger = await ok(api("GET", `/orgs/${o.orgId}/me/ledger`, { token: a.u.token }));
    expect(rowFor(await monthRows(o, JUL), ledger.member._id).expectedPaise).toBe(50_000);

    // approved without a member record (admin unticked it) → "Add as member" later
    const b = await join("Kunal Later");
    await ok(api("PATCH", `/orgs/${o.orgId}/memberships/${b.m._id}`, { token: o.admin.token, body: { action: "approve", role: "member", memberId: null, createMember: false } }));
    expect(await members()).not.toContain("Kunal Later");
    await ok(api("PATCH", `/orgs/${o.orgId}/memberships/${b.m._id}`, { token: o.admin.token, body: { action: "link_member", createMember: true, haptaStartMonth: AUG } }));
    await ok(api("PATCH", `/orgs/${o.orgId}/memberships/${b.m._id}`, { token: o.admin.token, body: { action: "link_member", createMember: true } })); // idempotent
    expect((await members()).filter((n: string) => n === "Kunal Later")).toHaveLength(1);
    const kl = await ok(api("GET", `/orgs/${o.orgId}/me/ledger`, { token: b.u.token }));
    expect(rowFor(await monthRows(o, JUL), kl.member._id)).toBeUndefined();
    expect(rowFor(await monthRows(o, AUG), kl.member._id)).toBeTruthy();
  });
});
