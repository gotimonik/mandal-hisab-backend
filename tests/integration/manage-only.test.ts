import { beforeAll, describe, expect, it } from "vitest";
import { api, makePlatformAdmin, ok, registerAndLogin, uniq } from "../helpers/api";

/** An admin who only looks after the Mandal: a login and a role, but no member record. */

const todayIST = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const thisMonth = () => todayIST().slice(0, 7);

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

describe("only managing a Mandal", () => {
  let o: Awaited<ReturnType<typeof createMandal>>;
  const get = (path: string, token = o.admin.token) => api("GET", `/orgs/${o.orgId}${path}`, { token });
  const post = (path: string, body: Record<string, unknown> = {}, token = o.admin.token) => api("POST", `/orgs/${o.orgId}${path}`, { token, body });
  const memberNames = async () => (await ok(get("/members?pageSize=100"))).items.map((m: { name: string }) => m.name);

  beforeAll(async () => {
    o = await createMandal("Manage Only Mandal");
    await ok(post("/members", { name: "Bhavesh Patel", joiningDate: `${thisMonth()}-01` }));
  });

  it("removes the admin's own member record but keeps them as admin", async () => {
    const st = await ok(get("/me/manage-only"));
    expect(st).toMatchObject({ isMember: true, action: "delete", canSwitch: true, money: [] });
    expect(await memberNames()).toContain("Manage Only Mandal Admin");

    const r = await ok(post("/me/manage-only", { reason: "I only keep the books" }));
    expect(r).toMatchObject({ ok: true, recordDeleted: true });

    expect(await memberNames()).toEqual(["Bhavesh Patel"]);
    const org = await ok(get(""));
    expect(org).toMatchObject({ myRole: "admin", myMemberId: null });
    const logins = await ok(get("/memberships"));
    expect(logins.some((m: { role: string; user: { name: string } }) => m.role === "admin" && m.user.name === "Manage Only Mandal Admin")).toBe(true);
    // only Bhavesh's hapta is left this month
    const month = await ok(get(`/monthly?month=${thisMonth()}`));
    expect(month.rows).toHaveLength(1);
    // doing it again is harmless
    expect(await ok(post("/me/manage-only"))).toMatchObject({ already: true });
  });

  it("can be undone: the admin is added back as a member", async () => {
    await ok(post("/me/member", { haptaStartMonth: thisMonth() }));
    const org = await ok(get(""));
    expect(org.myMemberId).toBeTruthy();
    expect(await memberNames()).toContain("Manage Only Mandal Admin");
    expect((await post("/me/member")).status).toBe(400);
  });

  it("refuses while the admin's member record has money in it", async () => {
    const month = await ok(get(`/monthly?month=${thisMonth()}`));
    const org = await ok(get(""));
    const mine = month.rows.find((r: { memberId: string }) => r.memberId === org.myMemberId);
    await ok(post("/monthly/collect", { installmentId: mine.installmentId, amount: "300", date: todayIST(), idempotencyKey: uniq("c") }));
    const st = await ok(get("/me/manage-only"));
    expect(st.canSwitch).toBe(false);
    expect(st.money).toContain("hapta paid");
    expect(st.blockers.join()).toMatch(/Leave the Mandal/);
    expect((await post("/me/manage-only")).status).toBe(409);
    expect(await memberNames()).toContain("Manage Only Mandal Admin");
  });

  it("isn't for plain members", async () => {
    const asha = await registerAndLogin("Asha Shah");
    await ok(api("POST", "/organizations/join", { token: asha.token, body: { code: o.code } }));
    const req = (await ok(get("/memberships"))).find((m: { user: { name: string } }) => m.user.name === "Asha Shah");
    await ok(api("PATCH", `/orgs/${o.orgId}/memberships/${req._id}`, { token: o.admin.token, body: { action: "approve", role: "member", createMember: true } }));
    const st = await ok(get("/me/manage-only", asha.token));
    expect(st.canSwitch).toBe(false);
    expect((await post("/me/manage-only", {}, asha.token)).status).toBe(403);
  });
});
