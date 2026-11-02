import { beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { api, ok, registerAndLogin, setupOrg, uniq } from "../helpers/api";
import { cols } from "@/lib/collections";

/**
 * A platform admin can open any Mandal from the admin panel and see what its admin sees —
 * read-only, and every visit is in the audit log. Everyone else still can't see in.
 */
describe("platform admin viewing a Mandal", () => {
  let o: Awaited<ReturnType<typeof setupOrg>>;
  let memberId: string;

  beforeAll(async () => {
    o = await setupOrg("Viewable Mandal");
    memberId = (await ok(api("POST", `/orgs/${o.orgId}/members`, { token: o.admin.token, body: { name: "Asha Saver" } })))._id;
  });

  it("sees the Mandal like an admin, but only read permissions", async () => {
    const pa = o.platformAdmin.token;
    const org = await ok(api("GET", `/orgs/${o.orgId}`, { token: pa }));
    expect(org.platformView).toBe(true);
    expect(org.myRole).toBe("admin");
    expect(org.myMemberId).toBeNull();
    expect(org.myPermissions).toEqual(expect.arrayContaining(["members.view", "reports.view", "accounts.view", "audit.view"]));
    for (const p of ["members.manage", "payments.record", "withdrawals.record", "org.settings.manage"]) expect(org.myPermissions).not.toContain(p);
    // the real admin's view is unchanged
    const mine = await ok(api("GET", `/orgs/${o.orgId}`, { token: o.admin.token }));
    expect(mine.platformView).toBe(false);
    expect(mine.myPermissions).toContain("members.manage");

    // every screen's data loads
    const members = await ok(api("GET", `/orgs/${o.orgId}/members`, { token: pa }));
    expect(members.items.map((m: any) => m._id)).toContain(memberId);
    for (const path of ["dashboard", "accounts", "fund-loans", "upad-requests", "meetings", `members/${memberId}/ledger`]) {
      const r = await api("GET", `/orgs/${o.orgId}/${path}`, { token: pa });
      expect(r.status, path).toBe(200);
    }
  });

  it("can't change anything", async () => {
    const pa = o.platformAdmin.token;
    const attempts: [string, string, unknown][] = [
      ["POST", "members", { name: "Sneaky" }],
      ["PATCH", "", { city: "Elsewhere" }],
      ["POST", "meetings", { date: "2030-01-01", time: "10:00", place: "Hall", idempotencyKey: uniq("mt") }],
      ["PATCH", `members/${memberId}`, { name: "Renamed" }],
    ];
    for (const [method, path, body] of attempts) {
      const r = await api(method, `/orgs/${o.orgId}${path ? `/${path}` : ""}`, { token: pa, body });
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.error?.message).toMatch(/only view this Mandal/);
    }
    const members = await ok(api("GET", `/orgs/${o.orgId}/members`, { token: o.admin.token }));
    expect(members.items.map((m: any) => m.name)).not.toContain("Sneaky");
    expect(members.items.find((m: any) => m._id === memberId).name).toBe("Asha Saver");
  });

  it("each visit is in the audit log (once a day per admin)", async () => {
    const pa = o.platformAdmin;
    await ok(api("GET", `/orgs/${o.orgId}`, { token: pa.token }));
    await ok(api("GET", `/orgs/${o.orgId}`, { token: pa.token }));
    const c = await cols();
    const logs = await c.auditLogs.find({ organizationId: new ObjectId(o.orgId), action: "platform.organization.view", actorId: new ObjectId(pa.userId) }).toArray();
    expect(logs).toHaveLength(1);
    // the Mandal's own admin sees it in their audit log
    const audit = await ok(api("GET", `/orgs/${o.orgId}/audit-logs`, { token: o.admin.token }));
    const items = audit.items ?? audit;
    expect(items.some((a: any) => a.action === "platform.organization.view")).toBe(true);
  });

  it("can look at a suspended Mandal; ordinary users still can't see in", async () => {
    const other = await setupOrg("Suspended Mandal");
    await ok(api("PATCH", `/platform/organizations/${other.orgId}`, { token: other.platformAdmin.token, body: { action: "suspend", reason: "Review" } }));
    expect((await api("GET", `/orgs/${other.orgId}/members`, { token: other.platformAdmin.token })).status).toBe(200);
    const stranger = await registerAndLogin("Stranger");
    expect((await api("GET", `/orgs/${other.orgId}/members`, { token: stranger.token })).status).toBe(404);
    expect((await api("GET", `/orgs/${other.orgId}`, { token: stranger.token })).status).toBe(404);
  });
});
