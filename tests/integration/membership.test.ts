import { beforeAll, describe, expect, it } from "vitest";
import { api, makePlatformAdmin, ok, registerAndLogin, uniq } from "../helpers/api";

/**
 * Joining or leaving partway through at the price of a hapta share: a joiner pays what one
 * existing share is worth (savings + the Mandal's own money); a leaver takes theirs out.
 */

const nowMonth = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 7);
const addMonths = (m: string, n: number) => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1 + n, 1)).toISOString().slice(0, 7);
};
const START = addMonths(nowMonth(), -1);
const THIS = nowMonth();

async function createMandal(name: string) {
  const admin = await registerAndLogin(`${name} Admin`);
  const org = await ok(api("POST", "/organizations", { token: admin.token, body: { name, monthlyHaptaAmount: "500", haptaStartMonth: START, creatorIsMember: false } }));
  if (org.status === "pending") {
    const pa = await registerAndLogin("Platform Admin");
    await makePlatformAdmin(pa.userId);
    await ok(api("PATCH", `/platform/organizations/${org.id}`, { token: pa.token, body: { action: "approve" } }));
  }
  return { orgId: org.id as string, token: admin.token };
}

describe("joining and leaving partway through", () => {
  let o: { orgId: string; token: string };
  let asha: string;
  let monik: string;
  let ravi: string;
  const get = (p: string) => ok(api("GET", `/orgs/${o.orgId}${p}`, { token: o.token }));
  const post = (p: string, body: unknown) => api("POST", `/orgs/${o.orgId}${p}`, { token: o.token, body });
  const cash = async () => (await get("/settlement")).totals.cashPaise as number;
  const own = async () => (await get("/settlement")).totals.mandalOwnPaise as number;

  beforeAll(async () => {
    o = await createMandal("Joining Mandal");
    asha = (await ok(post("/members", { name: "Asha Patel", joiningDate: `${START}-01` })))._id;
    monik = (await ok(post("/members", { name: "Monik Goti", haptaShares: 3, joiningDate: `${START}-01` })))._id;
    const v = await get(`/monthly?month=${START}`);
    for (const r of v.rows) await ok(post("/monthly/collect", { installmentId: r.installmentId, amount: String(r.expectedPaise / 100), date: `${START}-05`, idempotencyKey: uniq("c") }));
    // the Mandal's own money: a ₹400 donation
    await ok(post("/cashbook/entries", { direction: "in", amount: "400", date: `${START}-06`, description: "Diwali donation", idempotencyKey: uniq("ce") }));
  });

  it("members there from the start owe nothing to join", async () => {
    const q = await get(`/members/${asha}/joining`);
    expect(q.due).toBe(false);
    expect(q.joining).toBeNull();
  });

  it("a member whose hapta starts later owes the price of their shares", async () => {
    ravi = (await ok(post("/members", { name: "Ravi Shah", joiningDate: `${THIS}-01` })))._id;
    const q = await get(`/members/${ravi}/joining`);
    expect(q.due).toBe(true);
    expect(q.holderShares).toBe(4); // Asha 1 + Monik 3
    expect(q.perShareSavingsPaise).toBe(50_000); // ₹2,000 hapta saved ÷ 4 shares
    expect(q.perShareMandalPaise).toBe(10_000); // ₹400 donation ÷ 4 shares
    expect(q.totalPaise).toBe(60_000);
  });

  it("isn't a shareholder until paid, and closing waits for it", async () => {
    const p = await get("/settlement");
    expect(p.blockers.map((b: any) => b.key)).toContain(`joining:${ravi}`);
    const l = await get(`/members/${ravi}/leaving`);
    expect(l.mandalSharePaise).toBe(0);
  });

  it("paying puts the savings part in their balance and the rest in the Mandal's own money", async () => {
    const before = { cash: await cash(), own: await own() };
    expect((await post(`/members/${ravi}/joining/pay`, { expectedTotalPaise: 1, idempotencyKey: uniq("j") })).status).toBe(409); // price changed
    const r = await ok(post(`/members/${ravi}/joining/pay`, { expectedTotalPaise: 60_000, idempotencyKey: uniq("j") }));
    expect(r.joining).toMatchObject({ status: "paid", totalPaise: 60_000, savingsPaise: 50_000, mandalSharePaise: 10_000 });
    expect(await cash()).toBe(before.cash + 60_000);
    expect(await own()).toBe(before.own + 10_000);
    const ledger = await get(`/members/${ravi}/ledger`);
    expect(ledger.currentBalancePaise).toBe(50_000);
    // now on par: ₹500 own money over 5 shares = ₹100 each, same as before Ravi joined
    const l = await get(`/members/${ravi}/leaving`);
    expect(l.mandalSharePaise).toBe(10_000);
    // paying twice does nothing
    expect((await ok(post(`/members/${ravi}/joining/pay`, { idempotencyKey: uniq("j") }))).duplicate).toBe(true);
    expect((await get("/settlement")).blockers.map((b: any) => b.key)).not.toContain(`joining:${ravi}`);
  });

  it("a joining amount can be waived", async () => {
    const kiran = (await ok(post("/members", { name: "Kiran Desai", joiningDate: `${THIS}-01` })))._id;
    expect((await get(`/members/${kiran}/joining`)).due).toBe(true);
    await ok(post(`/members/${kiran}/joining/waive`, { reason: "Founder's brother, agreed by all" }));
    const q = await get(`/members/${kiran}/joining`);
    expect(q.due).toBe(false);
    expect(q.joining.status).toBe("waived");
  });

  it("leaving pays balance + share of the Mandal's own money, then marks them left", async () => {
    let q = await get(`/members/${asha}/leaving`);
    if (q.blockers.some((b: any) => b.key === "hapta")) {
      expect((await post(`/members/${asha}/leave`, { idempotencyKey: uniq("lv") })).status).toBe(400);
      await ok(post(`/members/${asha}/leaving/waive-hapta`, { reason: "Leaving this month" }));
      q = await get(`/members/${asha}/leaving`);
    }
    expect(q.canLeave).toBe(true);
    expect(q.savingsPaise).toBe(50_000);
    expect(q.netPaise).toBe(q.savingsPaise + q.mandalSharePaise);
    const before = { cash: await cash(), own: await own() };
    const r = await ok(post(`/members/${asha}/leave`, { expectedNetPaise: q.netPaise, reason: "Moving away", idempotencyKey: uniq("lv") }));
    expect(r.leaving).toMatchObject({ status: "done", netPaise: q.netPaise });
    expect(await cash()).toBe(before.cash - q.netPaise);
    expect(await own()).toBe(before.own - q.mandalSharePaise);
    const m = await get(`/members/${asha}`);
    expect(m.member.status).toBe("left");
    expect(m.member.balancePaise ?? 0).toBe(0);
    expect(m.enrollments.every((e: any) => e.status === "exited")).toBe(true);
    // a second click changes nothing
    expect((await ok(post(`/members/${asha}/leave`, { idempotencyKey: uniq("lv") }))).duplicate).toBe(true);
    expect(await cash()).toBe(before.cash - q.netPaise);
  });

  it("a leaver who owes upad gets it taken off the payout", async () => {
    const loanId = (await ok(post("/fund-loans", { memberId: monik, amount: "1000", date: `${THIS}-01`, monthlyRate: "2", idempotencyKey: uniq("fl") }))).loan._id;
    let q = await get(`/members/${monik}/leaving`);
    if (q.blockers.some((b: any) => b.key === "upadInterest")) {
      expect((await post(`/members/${monik}/leave`, { idempotencyKey: uniq("lv") })).status).toBe(400);
      const loan = await get(`/fund-loans/${loanId}`);
      const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
      await ok(post(`/fund-loans/${loanId}/payments`, { interestAmount: String(loan.loan.interestDuePaise / 100), date: today, idempotencyKey: uniq("flp") }));
      q = await get(`/members/${monik}/leaving`);
    }
    if (q.blockers.some((b: any) => b.key === "hapta")) {
      await ok(post(`/members/${monik}/leaving/waive-hapta`, { reason: "Leaving" }));
      q = await get(`/members/${monik}/leaving`);
    }
    expect(q.upadOwedPaise).toBe(100_000);
    expect(q.netPaise).toBe(q.savingsPaise + q.mandalSharePaise - 100_000);
    const before = await cash();
    await ok(post(`/members/${monik}/leave`, { idempotencyKey: uniq("lv") }));
    expect(await cash()).toBe(before - q.netPaise);
    const after = await get("/settlement");
    expect(after.totals.upadOutstandingPaise).toBe(0);
  });
});
