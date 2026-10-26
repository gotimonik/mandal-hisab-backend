import { beforeAll, describe, expect, it } from "vitest";
import { api, ok, registerAndLogin, setupOrg, uniq } from "../helpers/api";

/**
 * Adding a member with an email invites them to the app: new people register (email pre-filled)
 * and join linked to their member record; people already on MandalHisab join with one tap.
 */
describe("member invitations by email", () => {
  let o: Awaited<ReturnType<typeof setupOrg>>;
  beforeAll(async () => {
    o = await setupOrg("Invite Mandal");
  });

  const lastMailTo = async (to: string) => {
    const { sentEmails } = await import("@/services/email.service");
    return sentEmails.filter((m) => m.to === to).pop();
  };
  const tokenFrom = (link: string) => {
    const u = new URL(link);
    const next = u.searchParams.get("next");
    return new URL(next ? `http://x${next}` : link).searchParams.get("token")!;
  };

  it("a new person: email with a register link, then joins linked to their member record", async () => {
    const email = `${uniq("new")}@example.com`.toLowerCase();
    const m = await ok(api("POST", `/orgs/${o.orgId}/members`, { token: o.admin.token, body: { name: "Nayan Patel", email } }));
    expect(m.invitation).toMatchObject({ ok: true, existingUser: false, emailed: true });
    expect(m.invitation.inviteLink).toContain(`/register?email=${encodeURIComponent(email)}`);
    const mail = await lastMailTo(email);
    expect(mail?.subject).toContain("Invite Mandal");
    expect(mail?.html).toContain("Create account");

    // they register with that email and open the link
    const reg = await ok(api("POST", "/auth/register", { body: { name: "Nayan Patel", email, password: "secret123" } }));
    const { token } = await ok<{ token: string }>(api("POST", "/auth/login", { body: { email, password: "secret123" } }));
    const me = await ok(api("GET", "/auth/me", { token }));
    expect(me.invitations.map((i: any) => i.organization._id)).toContain(o.orgId);
    const preview = await ok(api("GET", `/invitations/preview?token=${encodeURIComponent(tokenFrom(m.invitation.inviteLink))}`, { token }));
    expect(preview).toMatchObject({ organization: { name: "Invite Mandal" }, member: { name: "Nayan Patel" }, emailMatches: true });

    await ok(api("POST", "/invitations/accept", { token, body: { token: tokenFrom(m.invitation.inviteLink) } }));
    const mine = await ok(api("GET", `/orgs/${o.orgId}/me`, { token }));
    expect(mine.member?._id ?? mine.member?.id).toBe(m._id);
    const member = await ok(api("GET", `/orgs/${o.orgId}/members/${m._id}`, { token: o.admin.token }));
    expect(String(member.userId ?? member.member?.userId)).toBe(reg.id);
  });

  it("someone already on MandalHisab: invitation in the app, one tap to join", async () => {
    const u = await registerAndLogin("Kavya Shah");
    const m = await ok(api("POST", `/orgs/${o.orgId}/members`, { token: o.admin.token, body: { name: "Kavya Shah", email: u.email } }));
    expect(m.invitation).toMatchObject({ ok: true, existingUser: true });
    expect(m.invitation.inviteLink).toContain("/invite?token=");
    const me = await ok(api("GET", "/auth/me", { token: u.token }));
    const inv = me.invitations.find((i: any) => i.organization._id === o.orgId);
    expect(inv.invitedByName).toBe("Org Admin");
    await ok(api("POST", `/invitations/${inv.id}/accept`, { token: u.token }));
    const mine = await ok(api("GET", `/orgs/${o.orgId}/me`, { token: u.token }));
    expect(mine.linked).toBe(true);
    expect((await ok(api("GET", "/auth/me", { token: u.token }))).invitations).toHaveLength(0);
  });

  it("inviting can be skipped, and a member already linked can't be invited again", async () => {
    const m = await ok(api("POST", `/orgs/${o.orgId}/members`, { token: o.admin.token, body: { name: "Raju Bhai", email: `${uniq("skip")}@example.com`, inviteToApp: false } }));
    expect(m.invitation).toBeNull();
    const noEmail = await ok(api("POST", `/orgs/${o.orgId}/members`, { token: o.admin.token, body: { name: "No Email" } }));
    expect(noEmail.invitation).toBeNull();
    // the member from the first test is linked now
    const list = await ok(api("GET", `/orgs/${o.orgId}/members?q=Nayan`, { token: o.admin.token }));
    const r = await api("POST", `/orgs/${o.orgId}/invitations`, { token: o.admin.token, body: { email: `${uniq("x")}@example.com`, role: "member", memberId: list.items[0]._id } });
    expect(r.status).toBe(409);
  });

  it("an invitation for a different email can't be used", async () => {
    const email = `${uniq("other")}@example.com`.toLowerCase();
    const m = await ok(api("POST", `/orgs/${o.orgId}/members`, { token: o.admin.token, body: { name: "Other Person", email } }));
    const stranger = await registerAndLogin("Stranger");
    const t = tokenFrom(m.invitation.inviteLink);
    const preview = await ok(api("GET", `/invitations/preview?token=${encodeURIComponent(t)}`, { token: stranger.token }));
    expect(preview.emailMatches).toBe(false);
    expect((await api("POST", "/invitations/accept", { token: stranger.token, body: { token: t } })).status).toBe(403);
  });
});
