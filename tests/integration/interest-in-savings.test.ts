import { describe, expect, it } from "vitest";
import { api, makePlatformAdmin, ok, registerAndLogin, uniq } from "../helpers/api";

/**
 * A paper Mandal where the unpaid upad interest is already added to members' savings:
 * savings ₹1,00,000 = cash ₹38,000 + upad ₹60,000 + unpaid interest ₹2,000.
 * Collecting that ₹2,000 must add to cash only — not to members' savings a second time.
 */

const todayIST = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const thisMonth = () => todayIST().slice(0, 7);
const lastDayOfPrevMonth = () => {
  const [y, m] = thisMonth().split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
};

async function bringIn(name: string, interestInSavings: boolean) {
  const admin = await registerAndLogin(`${name} Admin`);
  const org = await ok(api("POST", "/organizations", { token: admin.token, body: { name, monthlyHaptaAmount: "500", haptaStartMonth: thisMonth() } }));
  if (org.status === "pending") {
    const pa = await registerAndLogin("Platform Admin");
    await makePlatformAdmin(pa.userId);
    await ok(api("PATCH", `/platform/organizations/${org.id}`, { token: pa.token, body: { action: "approve" } }));
  }
  const orgId = org.id as string;
  const st = await ok(api("GET", `/orgs/${orgId}/opening-import`, { token: admin.token }));
  const body = {
    cutoverDate: lastDayOfPrevMonth(),
    cash: "38000",
    haptaAmount: "500",
    upadRate: "1",
    interestInSavings,
    members: [
      { memberId: st.members[0]._id, name: st.members[0].name, savings: "50000" },
      { name: "Ramesh Upad", savings: "50000", upads: [{ amount: "60000", interestDue: "2000" }] },
    ],
  };
  const check = await ok(api("POST", `/orgs/${orgId}/opening-import`, { token: admin.token, body: { ...body, dryRun: true } }));
  const r = await ok(api("POST", `/orgs/${orgId}/opening-import`, { token: admin.token, body: { ...body, dryRun: false } }));
  expect(r.imported).toBe(true);
  const list = await ok(api("GET", `/orgs/${orgId}/members`, { token: admin.token }));
  const ramesh = list.items.find((m: { name: string }) => m.name === "Ramesh Upad")._id as string;
  const loans = (await ok(api("GET", `/orgs/${orgId}/fund-loans`, { token: admin.token }))).items;
  return { orgId, admin, ramesh, loanId: loans[0]._id as string, check };
}
type M = Awaited<ReturnType<typeof bringIn>>;
const dash = async (o: M) => (await ok(api("GET", `/orgs/${o.orgId}/dashboard`, { token: o.admin.token }))).totals;

describe("unpaid interest already in members' savings", () => {
  it("tallies at the import, and collecting it adds to cash only", async () => {
    const o = await bringIn("Paper Interest Mandal", true);
    expect(o.check.totals.mandalOwnPaise).toBe(0); // 38,000 + 60,000 + 2,000 − 1,00,000
    expect(o.check.warnings.map((w: { message: string }) => w.message).join()).not.toMatch(/short/);

    await ok(api("POST", `/orgs/${o.orgId}/fund-loans/${o.loanId}/payments`, { token: o.admin.token, body: { interestAmount: "2000", date: todayIST(), idempotencyKey: uniq("flp") } }));
    const t = await dash(o);
    expect(t.mandalCashPaise).toBe(4_000_000);
    expect(t.totalMemberBalancesPaise).toBe(10_000_000); // not shared out again

    // this month's interest (1% of ₹60,000) is new interest: shared among members as usual
    await ok(api("POST", `/orgs/${o.orgId}/members/${o.ramesh}/upad-interest`, { token: o.admin.token, body: { amount: "600", date: todayIST(), idempotencyKey: uniq("ui") } }));
    const t2 = await dash(o);
    expect(t2.mandalCashPaise).toBe(4_060_000);
    expect(t2.totalMemberBalancesPaise).toBe(10_060_000);
  });

  it("can be marked after the import, then collected for all upads at once", async () => {
    const o = await bringIn("Marked Later Mandal", false);
    expect(o.check.totals.mandalOwnPaise).toBe(-200_000); // looked short without the tick
    const r = await ok(api("POST", `/orgs/${o.orgId}/opening-import/interest-in-savings`, { token: o.admin.token, body: { inSavings: true } }));
    expect(r).toMatchObject({ inSavings: true, interestPaise: 200_000, dues: 1 });
    const st = await ok(api("GET", `/orgs/${o.orgId}`, { token: o.admin.token }));
    expect(st.settings.openingImport).toMatchObject({ interestInSavings: true, mandalOwnPaise: 0 });

    // ₹2,600 = the brought-forward ₹2,000 (cash only) + this month's ₹600 (shared)
    await ok(api("POST", `/orgs/${o.orgId}/members/${o.ramesh}/upad-interest`, { token: o.admin.token, body: { amount: "2600", date: todayIST(), idempotencyKey: uniq("ui") } }));
    const t = await dash(o);
    expect(t.mandalCashPaise).toBe(4_060_000);
    expect(t.totalMemberBalancesPaise).toBe(10_060_000);

    // once some of it is collected it can't be changed any more
    expect((await api("POST", `/orgs/${o.orgId}/opening-import/interest-in-savings`, { token: o.admin.token, body: { inSavings: false } })).status).toBe(400);
  });
});
