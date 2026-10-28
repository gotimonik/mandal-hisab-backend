import { describe, expect, it } from "vitest";
import { addUser, api, ok, registerAndLogin, setupOrg, verifyEmailFromMail } from "../helpers/api";

describe("authentication", () => {
  it("registers, logs in, rejects bad passwords and invalidates sessions on logout", async () => {
    const u = await registerAndLogin("Asha");
    const me = await ok(api("GET", "/auth/me", { token: u.token }));
    expect(me.user.email).toBe(u.email);
    expect(me.user.isPlatformAdmin).toBe(false);

    const bad = await api("POST", "/auth/login", { body: { email: u.email, password: "wrongpass1" } });
    expect(bad.status).toBe(401);

    await ok(api("POST", "/auth/logout", { token: u.token }));
    expect((await api("GET", "/auth/me", { token: u.token })).status).toBe(401);
  });

  it("ignores role/admin fields submitted during registration", async () => {
    const email = `evil-${Date.now()}@example.com`;
    await ok(api("POST", "/auth/register", { body: { name: "Evil", email, password: "secret123", isPlatformAdmin: true, role: "admin" } }));
    await verifyEmailFromMail(email);
    const login = await ok(api("POST", "/auth/login", { body: { email, password: "secret123" } }));
    expect(login.user.isPlatformAdmin).toBe(false);
  });

  it("rejects weak passwords and duplicate emails", async () => {
    const weak = await api("POST", "/auth/register", { body: { name: "X Y", email: "weak@example.com", password: "short" } });
    expect(weak.status).toBe(422);
    const u = await registerAndLogin();
    const dup = await api("POST", "/auth/register", { body: { name: "Dup", email: u.email, password: "secret123" } });
    expect(dup.status).toBe(409);
  });

  it("password reset invalidates existing sessions", async () => {
    const u = await registerAndLogin();
    await ok(api("POST", "/auth/forgot-password", { body: { email: u.email } }));
    const { sentEmails } = await import("@/services/email.service");
    const mail = sentEmails.filter((m) => m.to === u.email && m.subject.includes("Reset")).pop()!;
    const token = decodeURIComponent(/token=([^\s]+)/.exec(mail.text)![1]);
    await ok(api("POST", "/auth/reset-password", { body: { token, password: "newpass123" } }));
    expect((await api("GET", "/auth/me", { token: u.token })).status).toBe(401);
    expect((await api("POST", "/auth/reset-password", { body: { token, password: "another123" } })).status).toBe(400);
    await ok(api("POST", "/auth/login", { body: { email: u.email, password: "newpass123" } }));
  });

  it("requires a token for protected routes", async () => {
    expect((await api("GET", "/auth/me")).status).toBe(401);
    expect((await api("GET", "/auth/me", { token: "x".repeat(43) })).status).toBe(401);
  });
});

describe("organization registration and approval", () => {
  it("new orgs start pending and become active after platform approval", async () => {
    const admin = await registerAndLogin("Founder");
    const org = await ok(api("POST", "/organizations", { token: admin.token, body: { name: "Navratri Mandal" } }));
    expect(org.status).toBe("pending");

    // pending org: financial writes blocked, settings allowed
    const m = await api("POST", `/orgs/${org.id}/members`, { token: admin.token, body: { name: "Ramesh" } });
    expect(m.status).toBe(423);
    await ok(api("PATCH", `/orgs/${org.id}`, { token: admin.token, body: { city: "Surat" } }));

    // only platform admins may approve
    expect((await api("PATCH", `/platform/organizations/${org.id}`, { token: admin.token, body: { action: "approve" } })).status).toBe(403);
    const { makePlatformAdmin } = await import("../helpers/api");
    const pa = await registerAndLogin("PA");
    await makePlatformAdmin(pa.userId);
    await ok(api("PATCH", `/platform/organizations/${org.id}`, { token: pa.token, body: { action: "approve" } }));
    await ok(api("POST", `/orgs/${org.id}/members`, { token: admin.token, body: { name: "Ramesh" } }));

    // platform admin has NO implicit access to the org's private data
    expect((await api("GET", `/orgs/${org.id}/members`, { token: pa.token })).status).toBe(404);

    // suspension blocks everything for org users
    await ok(api("PATCH", `/platform/organizations/${org.id}`, { token: pa.token, body: { action: "suspend", reason: "Compliance review" } }));
    expect((await api("GET", `/orgs/${org.id}/members`, { token: admin.token })).status).toBe(423);
  });
});

describe("membership approval & role-based access", () => {
  it("join requests are pending, roles are assigned by admins only", async () => {
    const { orgId, code, admin } = await setupOrg();
    const u = await registerAndLogin("Joiner");
    const res = await ok(api("POST", "/organizations/join", { token: u.token, body: { code, role: "admin" } }));
    expect(res.status).toBe("pending");
    // pending user has no access
    expect((await api("GET", `/orgs/${orgId}`, { token: u.token })).status).toBe(404);

    const ms = await ok<any[]>(api("GET", `/orgs/${orgId}/memberships?status=pending`, { token: admin.token }));
    const m = ms.find((x) => x.user._id === u.userId);
    expect(m.role).toBe("member");
    await ok(api("PATCH", `/orgs/${orgId}/memberships/${m._id}`, { token: admin.token, body: { action: "approve" } }));
    const org = await ok(api("GET", `/orgs/${orgId}`, { token: u.token }));
    expect(org.myRole).toBe("member");

    // member cannot list members, record payments, or manage roles
    expect((await api("GET", `/orgs/${orgId}/members`, { token: u.token })).status).toBe(403);
    expect((await api("GET", `/orgs/${orgId}/memberships`, { token: u.token })).status).toBe(403);
    expect((await api("PATCH", `/orgs/${orgId}/memberships/${m._id}`, { token: u.token, body: { action: "change_role", role: "admin" } })).status).toBe(403);
  });

  it("manager permissions follow admin-configured flags", async () => {
    const { orgId, code, admin } = await setupOrg();
    const mgr = await addUser(orgId, code, admin.token, "manager");
    await ok(api("GET", `/orgs/${orgId}/members`, { token: mgr.token }));
    const scheme = { name: "Monthly", startDate: "2026-04-01", frequency: "monthly", amount: "500" };
    expect((await api("POST", `/orgs/${orgId}/schemes`, { token: mgr.token, body: scheme })).status).toBe(403);
    expect((await api("PATCH", `/orgs/${orgId}`, { token: mgr.token, body: { city: "X" } })).status).toBe(403);

    const org = await ok(api("GET", `/orgs/${orgId}`, { token: admin.token }));
    await ok(
      api("PATCH", `/orgs/${orgId}`, {
        token: admin.token,
        body: { settings: { managerPermissions: { ...org.settings.managerPermissions, canManageSchemes: true } } },
      }),
    );
    await ok(api("POST", `/orgs/${orgId}/schemes`, { token: mgr.token, body: scheme }));
  });

  it("an org always keeps at least one admin", async () => {
    const { orgId, admin } = await setupOrg();
    const ms = await ok<any[]>(api("GET", `/orgs/${orgId}/memberships`, { token: admin.token }));
    const mine = ms.find((x) => x.user._id === admin.userId);
    const r = await api("PATCH", `/orgs/${orgId}/memberships/${mine._id}`, { token: admin.token, body: { action: "change_role", role: "member" } });
    expect(r.status).toBe(400);
  });

  it("deactivated memberships lose access immediately", async () => {
    const { orgId, code, admin } = await setupOrg();
    const mgr = await addUser(orgId, code, admin.token, "manager");
    await ok(api("GET", `/orgs/${orgId}/members`, { token: mgr.token }));
    const ms = await ok<any[]>(api("GET", `/orgs/${orgId}/memberships`, { token: admin.token }));
    const m = ms.find((x) => x.user._id === mgr.userId);
    await ok(api("PATCH", `/orgs/${orgId}/memberships/${m._id}`, { token: admin.token, body: { action: "deactivate" } }));
    expect((await api("GET", `/orgs/${orgId}/members`, { token: mgr.token })).status).toBe(404);
  });
});

describe("tenant isolation", () => {
  it("users of one org cannot read or write another org's data", async () => {
    const a = await setupOrg("Org A");
    const b = await setupOrg("Org B");
    const memberB = await ok(api("POST", `/orgs/${b.orgId}/members`, { token: b.admin.token, body: { name: "Bhavesh" } }));

    // Admin of A against org B routes
    for (const path of ["", "/members", "/accounts", "/payments", "/schemes", "/transactions", `/members/${memberB._id}`]) {
      const r = await api("GET", `/orgs/${b.orgId}${path}`, { token: a.admin.token });
      expect(r.status, path).toBe(404);
    }
    expect((await api("POST", `/orgs/${b.orgId}/members`, { token: a.admin.token, body: { name: "Intruder" } })).status).toBe(404);

    // Admin of A referencing B's member/account through A's own org routes
    const pay = await api("POST", `/orgs/${a.orgId}/payments`, {
      token: a.admin.token,
      body: { kind: "other_income", memberId: memberB._id, amount: "100", date: "2026-05-01", method: "cash", accountId: b.cashAccountId, idempotencyKey: "cross-org-0001" },
    });
    expect(pay.status).toBe(404);
    expect((await api("GET", `/orgs/${a.orgId}/members/${memberB._id}`, { token: a.admin.token })).status).toBe(404);
  });
});
