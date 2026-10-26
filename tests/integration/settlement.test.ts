import { beforeAll, describe, expect, it } from "vitest";
import { api, makePlatformAdmin, ok, registerAndLogin, uniq } from "../helpers/api";

/**
 * How long a Mandal runs (end month) and closing it: the Mandal's own money is shared by hapta
 * shares, each member is paid their balance (upad they owe is taken off), then it is closed.
 */

const nowMonth = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 7);
const todayIso = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const addMonths = (m: string, n: number) => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1 + n, 1)).toISOString().slice(0, 7);
};
const START = addMonths(nowMonth(), -1);
const THIS = nowMonth();

async function createMandal(name: string, extra: Record<string, unknown> = {}) {
  const admin = await registerAndLogin(`${name} Admin`);
  const org = await ok(api("POST", "/organizations", { token: admin.token, body: { name, monthlyHaptaAmount: "500", haptaStartMonth: START, creatorIsMember: false, ...extra } }));
  if (org.status === "pending") {
    const pa = await registerAndLogin("Platform Admin");
    await makePlatformAdmin(pa.userId);
    await ok(api("PATCH", `/platform/organizations/${org.id}`, { token: pa.token, body: { action: "approve" } }));
  }
  return { orgId: org.id as string, token: admin.token };
}

describe("end month", () => {
  it("no hapta after the end month; moving it later brings months back; can't be in the past", async () => {
    const END = addMonths(THIS, 1);
    const o = await createMandal("Ending Mandal", { endMonth: END });
    await ok(api("POST", `/orgs/${o.orgId}/members`, { token: o.token, body: { name: "Asha", joiningDate: `${START}-01` } }));
    const rows = async (m: string) => (await ok(api("GET", `/orgs/${o.orgId}/monthly?month=${m}`, { token: o.token }))).rows.filter((r: any) => r.state === "active").length;
    expect(await rows(END)).toBe(1);
    expect(await rows(addMonths(END, 1))).toBe(0);
    expect((await ok(api("GET", `/orgs/${o.orgId}`, { token: o.token }))).settings.endMonth).toBe(END);
    await ok(api("PATCH", `/orgs/${o.orgId}/end-month`, { token: o.token, body: { endMonth: addMonths(END, 2) } }));
    expect(await rows(addMonths(END, 2))).toBe(1);
    await ok(api("PATCH", `/orgs/${o.orgId}/end-month`, { token: o.token, body: { endMonth: END } }));
    expect(await rows(addMonths(END, 1))).toBe(0);
    expect((await api("PATCH", `/orgs/${o.orgId}/end-month`, { token: o.token, body: { endMonth: START } })).status).toBe(400);
    await ok(api("PATCH", `/orgs/${o.orgId}/end-month`, { token: o.token, body: { endMonth: null } }));
    expect(await rows(addMonths(END, 2))).toBe(1);
  });
});

describe("closing and settling a Mandal", () => {
  let o: { orgId: string; token: string };
  let asha: string;
  let monik: string;
  let loanId: string;
  const preview = () => ok(api("GET", `/orgs/${o.orgId}/settlement`, { token: o.token }));

  beforeAll(async () => {
    o = await createMandal("Closing Mandal");
    asha = (await ok(api("POST", `/orgs/${o.orgId}/members`, { token: o.token, body: { name: "Asha Patel", joiningDate: `${START}-01` } })))._id;
    monik = (await ok(api("POST", `/orgs/${o.orgId}/members`, { token: o.token, body: { name: "Monik Goti", haptaShares: 3, joiningDate: `${START}-01` } })))._id;
    const v = await ok(api("GET", `/orgs/${o.orgId}/monthly?month=${START}`, { token: o.token }));
    for (const r of v.rows) await ok(api("POST", `/orgs/${o.orgId}/monthly/collect`, { token: o.token, body: { installmentId: r.installmentId, amount: String(r.expectedPaise / 100), date: `${START}-05`, idempotencyKey: uniq("c") } }));
    // the Mandal's own money: a ₹400 donation in cash
    await ok(api("POST", `/orgs/${o.orgId}/cashbook/entries`, { token: o.token, body: { direction: "in", amount: "400", date: `${START}-06`, description: "Diwali donation", idempotencyKey: uniq("ce") } }));
    // Monik takes ₹1,000 upad
    loanId = (await ok(api("POST", `/orgs/${o.orgId}/fund-loans`, { token: o.token, body: { memberId: monik, amount: "1000", date: `${START}-10`, monthlyRate: "2", idempotencyKey: uniq("fl") } }))).loan._id;
  });

  it("lists what must be finished first and won't start until it is", async () => {
    const p = await preview();
    const keys = p.blockers.map((b: any) => b.key);
    expect(keys).toContain("hapta"); // this month is unpaid
    expect(keys).toContain("upadInterest");
    expect(p.canStart).toBe(false);
    expect((await api("POST", `/orgs/${o.orgId}/settlement/start`, { token: o.token, body: {} })).status).toBe(400);
  });

  it("after collecting upad interest and waiving unpaid hapta, the payouts add up to the cash", async () => {
    const loan = await ok(api("GET", `/orgs/${o.orgId}/fund-loans/${loanId}`, { token: o.token }));
    await ok(api("POST", `/orgs/${o.orgId}/fund-loans/${loanId}/payments`, { token: o.token, body: { interestAmount: String(loan.loan.interestDuePaise / 100), date: todayIso(), idempotencyKey: uniq("flp") } }));
    await ok(api("POST", `/orgs/${o.orgId}/settlement/waive-hapta`, { token: o.token, body: { reason: "Closing early" } }));
    const p = await preview();
    expect(p.blockers).toHaveLength(0);
    expect(p.canStart).toBe(true);
    expect(p.totals.mandalOwnPaise).toBe(40_000); // the donation
    expect(p.totals.totalShares).toBe(4);
    const a = p.rows.find((r: any) => r.memberId === asha);
    const m = p.rows.find((r: any) => r.memberId === monik);
    expect(a.mandalSharePaise).toBe(10_000); // 1 share
    expect(m.mandalSharePaise).toBe(30_000); // 3 shares
    expect(m.upadOwedPaise).toBe(100_000);
    expect(m.netPaise).toBe(m.savingsPaise + 30_000 - 100_000);
    expect(p.totals.netPayoutPaise).toBe(p.totals.cashPaise); // everything in the box goes back
  });

  it("start shares the Mandal's own money into balances and stops future hapta", async () => {
    const before = await preview();
    await ok(api("POST", `/orgs/${o.orgId}/settlement/start`, { token: o.token, body: { note: "Members agreed" } }));
    const p = await preview();
    expect(p.state.startedAt).toBeTruthy();
    expect(p.totals.mandalOwnPaise).toBe(0);
    const a0 = before.rows.find((r: any) => r.memberId === asha);
    const a = p.rows.find((r: any) => r.memberId === asha);
    expect(a.savingsPaise).toBe(a0.savingsPaise + 10_000);
    expect(a.netPaise).toBe(a0.netPaise);
    const next = await ok(api("GET", `/orgs/${o.orgId}/monthly?month=${addMonths(THIS, 1)}`, { token: o.token }));
    expect(next.rows.filter((r: any) => r.state === "active")).toHaveLength(0);
    expect((await api("POST", `/orgs/${o.orgId}/settlement/close`, { token: o.token, body: {} })).status).toBe(400); // not paid out yet
  });

  it("pays each member out (upad taken off), then closes the Mandal read-only", async () => {
    const p = await preview();
    const m = p.rows.find((r: any) => r.memberId === monik);
    const paidM = await ok(api("POST", `/orgs/${o.orgId}/settlement/payouts/${monik}`, { token: o.token, body: { idempotencyKey: uniq("po") } }));
    expect(paidM).toMatchObject({ netPaise: m.netPaise, upadSettledPaise: 100_000 });
    expect((await api("POST", `/orgs/${o.orgId}/settlement/payouts/${monik}`, { token: o.token, body: { idempotencyKey: uniq("po") } })).status).toBe(409);
    await ok(api("POST", `/orgs/${o.orgId}/settlement/payouts/${asha}`, { token: o.token, body: { idempotencyKey: uniq("po") } }));
    const after = await preview();
    expect(after.totals).toMatchObject({ cashPaise: 0, memberFundsPaise: 0, upadOutstandingPaise: 0 });
    expect(after.canClose).toBe(true);
    await ok(api("POST", `/orgs/${o.orgId}/settlement/close`, { token: o.token, body: { note: "All settled" } }));
    const org = await ok(api("GET", `/orgs/${o.orgId}`, { token: o.token }));
    expect(org.status).toBe("archived");
    // read-only now
    expect((await api("POST", `/orgs/${o.orgId}/members`, { token: o.token, body: { name: "Late Joiner" } })).status).toBeGreaterThanOrEqual(400);
  });
});
