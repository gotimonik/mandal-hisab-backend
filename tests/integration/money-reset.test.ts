import { beforeAll, describe, expect, it } from "vitest";
import { addUser, api, makePlatformAdmin, ok, registerAndLogin, uniq } from "../helpers/api";

/** Starting the hisab afresh: money goes, members stay, and the paper import opens again. */

const todayIST = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const thisMonth = () => todayIST().slice(0, 7);
const lastDayOfPrevMonth = () => {
  const [y, m] = thisMonth().split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
};

async function createMandal(name: string) {
  const admin = await registerAndLogin(`${name} Admin`);
  const org = await ok(api("POST", "/organizations", { token: admin.token, body: { name, monthlyHaptaAmount: "300", haptaStartMonth: thisMonth() } }));
  if (org.status === "pending") {
    const pa = await registerAndLogin("Platform Admin");
    await makePlatformAdmin(pa.userId);
    await ok(api("PATCH", `/platform/organizations/${org.id}`, { token: pa.token, body: { action: "approve" } }));
  }
  return { orgId: org.id as string, code: org.code as string, admin };
}

describe("resetting a Mandal's money", () => {
  let o: Awaited<ReturnType<typeof createMandal>>;
  let bhavesh: string;
  const status = () => ok(api("GET", `/orgs/${o.orgId}/money-reset`, { token: o.admin.token }));
  const reset = (body: Record<string, unknown>) => api("POST", `/orgs/${o.orgId}/money-reset`, { token: o.admin.token, body });
  const backup = () => api("GET", `/orgs/${o.orgId}/backup`, { token: o.admin.token });
  const collectAll = async () => {
    const month = await ok(api("GET", `/orgs/${o.orgId}/monthly?month=${thisMonth()}`, { token: o.admin.token }));
    for (const r of month.rows) if (r.outstandingPaise > 0) await ok(api("POST", `/orgs/${o.orgId}/monthly/collect`, { token: o.admin.token, body: { installmentId: r.installmentId, amount: "300", date: todayIST(), idempotencyKey: uniq("c") } }));
  };

  beforeAll(async () => {
    o = await createMandal("Reset Mandal");
    bhavesh = (await ok(api("POST", `/orgs/${o.orgId}/members`, { token: o.admin.token, body: { name: "Bhavesh Patel", joiningDate: `${thisMonth()}-01` } })))._id;
    await collectAll(); // ₹600 in
    await ok(api("POST", `/orgs/${o.orgId}/fund-loans`, { token: o.admin.token, body: { memberId: bhavesh, amount: "200", date: todayIST(), monthlyRate: "2", idempotencyKey: uniq("fl") } }));
  });

  it("needs nothing-to-reset, a fresh backup and the Mandal's name", async () => {
    const st = await status();
    expect(st.canReset).toBe(false);
    expect(st.blockers.join()).toMatch(/backup/i);
    expect(st.counts).toMatchObject({ payments: 2, upads: 1 });
    expect((await reset({ confirmName: "Reset Mandal", reason: "typed in wrong" })).status).toBe(409);

    await backup();
    expect((await status()).canReset).toBe(true);
    const wrong = await reset({ confirmName: "Some Other Mandal", reason: "typed in wrong" });
    expect(wrong.status).toBe(400);
    expect(wrong.error?.message).toMatch(/Reset Mandal/);
  });

  it("wipes money, keeps members, reopens the import", async () => {
    const r = await ok(reset({ confirmName: "  reset   mandal ", reason: "Bringing in the paper hisab properly" }));
    expect(r.removed).toMatchObject({ payments: 2, fundLoans: 1 });
    expect(r.removed.installmentsReset).toBe(2);
    // receipt / voucher / upad numbers start again from 1; member numbers keep going
    const { cols } = await import("@/lib/collections");
    const c = await cols();
    const counters = (await c.counters.find({ _id: { $regex: `^${o.orgId}:` } }).toArray()).map((x) => x._id);
    expect(counters).toEqual([`${o.orgId}:member`]);

    const d = await ok(api("GET", `/orgs/${o.orgId}/dashboard`, { token: o.admin.token }));
    expect(d.totals.mandalCashPaise).toBe(0);
    expect(d.totals.fundLoansOutstandingPaise).toBe(0);
    expect(d.totals.totalMemberBalancesPaise).toBe(0);
    const list = await ok(api("GET", `/orgs/${o.orgId}/members`, { token: o.admin.token }));
    expect(list.items).toHaveLength(2);
    const month = await ok(api("GET", `/orgs/${o.orgId}/monthly?month=${thisMonth()}`, { token: o.admin.token }));
    expect(month.rows.map((x: { outstandingPaise: number }) => x.outstandingPaise)).toEqual([30_000, 30_000]);
    expect((await ok(api("GET", `/orgs/${o.orgId}/fund-loans?status=all`, { token: o.admin.token }))).items).toHaveLength(0);

    // nothing left to reset (unless the members go too)
    expect((await status()).hasMoney).toBe(false);
    const again = await reset({ confirmName: "Reset Mandal", reason: "again again" });
    expect(again.status).toBe(400);
    expect(again.error?.message).toMatch(/nothing to reset/);

    // and the paper hisab can now be brought in
    const st = await ok(api("GET", `/orgs/${o.orgId}/opening-import`, { token: o.admin.token }));
    expect(st.canImport).toBe(true);
    const imp = await ok(
      api("POST", `/orgs/${o.orgId}/opening-import`, {
        token: o.admin.token,
        body: { dryRun: false, cutoverDate: lastDayOfPrevMonth(), cash: "5000", haptaAmount: "300", members: st.members.map((m: { _id: string; name: string }) => ({ memberId: m._id, name: m.name, savings: "2500" })) },
      }),
    );
    expect(imp.imported).toBe(true);
  });

  it("a backup older than the last money entry doesn't count", async () => {
    await backup();
    await ok(api("POST", `/orgs/${o.orgId}/fund-loans`, { token: o.admin.token, body: { memberId: bhavesh, amount: "100", date: todayIST(), monthlyRate: "2", idempotencyKey: uniq("fl") } }));
    const st = await status();
    expect(st.canReset).toBe(false);
    expect(st.backup.fresh).toBe(false);
  });

  it("only the admin can reset", async () => {
    const other = await registerAndLogin("Outsider");
    expect((await api("POST", `/orgs/${o.orgId}/money-reset`, { token: other.token, body: { confirmName: "Reset Mandal", reason: "nope nope" } })).status).toBeGreaterThanOrEqual(403);
  });
});

describe("resetting with the members too", () => {
  it("removes every other member, unlinks their logins, keeps the admin and the accounts", async () => {
    const o = await createMandal("People Reset Mandal");
    const members = await ok(api("GET", `/orgs/${o.orgId}/members`, { token: o.admin.token }));
    const adminMemberId = members.items[0]._id;
    const chetan = (await ok(api("POST", `/orgs/${o.orgId}/members`, { token: o.admin.token, body: { name: "Chetan Login", joiningDate: `${thisMonth()}-01` } })))._id;
    await ok(api("POST", `/orgs/${o.orgId}/members`, { token: o.admin.token, body: { name: "Daksha NoLogin", joiningDate: `${thisMonth()}-01` } }));
    const chetanUser = await addUser(o.orgId, o.code, o.admin.token, "member", chetan);
    await ok(api("POST", `/orgs/${o.orgId}/invitations`, { token: o.admin.token, body: { email: `${uniq("inv")}@example.com`, role: "member" } })).catch(() => null);
    const month = await ok(api("GET", `/orgs/${o.orgId}/monthly?month=${thisMonth()}`, { token: o.admin.token }));
    await ok(api("POST", `/orgs/${o.orgId}/monthly/collect`, { token: o.admin.token, body: { installmentId: month.rows[0].installmentId, amount: "300", date: todayIST(), idempotencyKey: uniq("c") } }));
    // a Personal Hisab copy of this Mandal's money in Chetan's book
    const { cols } = await import("@/lib/collections");
    const { ObjectId } = await import("mongodb");
    const c = await cols();
    await c.personalEntries.insertOne({ _id: new ObjectId(), userId: new ObjectId(chetanUser.userId), source: { organizationId: new ObjectId(o.orgId) } } as never);

    await api("GET", `/orgs/${o.orgId}/backup`, { token: o.admin.token });
    const st = await ok(api("GET", `/orgs/${o.orgId}/money-reset`, { token: o.admin.token }));
    expect(st.counts).toMatchObject({ otherMembers: 2, otherLogins: 1 });

    const r = await ok(api("POST", `/orgs/${o.orgId}/money-reset`, { token: o.admin.token, body: { confirmName: "People Reset Mandal", reason: "start completely fresh", removeMembers: true } }));
    expect(r.removed).toMatchObject({ members: 2, logins: 1, personalEntries: 1 });

    const left = await ok(api("GET", `/orgs/${o.orgId}/members`, { token: o.admin.token }));
    expect(left.items.map((m: { _id: string }) => m._id)).toEqual([adminMemberId]);
    const now = await ok(api("GET", `/orgs/${o.orgId}/monthly?month=${thisMonth()}`, { token: o.admin.token }));
    expect(now.rows).toHaveLength(1);
    expect(now.rows[0].outstandingPaise).toBe(30_000);
    // Chetan's account still works, but not in this Mandal
    expect((await api("GET", `/orgs/${o.orgId}`, { token: chetanUser.token })).status).toBe(404);
    expect((await api("GET", "/auth/me", { token: chetanUser.token })).status).toBe(200);
    const notes = await ok(api("GET", "/notifications", { token: chetanUser.token }));
    expect(JSON.stringify(notes)).toMatch(/Removed from People Reset Mandal/);
    expect(await c.invitations.countDocuments({ organizationId: new ObjectId(o.orgId) })).toBe(0);

    // members only: a second run has members to remove no more
    const again = await api("POST", `/orgs/${o.orgId}/money-reset`, { token: o.admin.token, body: { confirmName: "People Reset Mandal", reason: "start completely fresh", removeMembers: true } });
    expect(again.status).toBe(400);
  });
});
