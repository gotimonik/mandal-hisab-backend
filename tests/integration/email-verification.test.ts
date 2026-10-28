import { describe, expect, it } from "vitest";
import { api, ok, uniq, verifyEmailFromMail } from "../helpers/api";

describe("email verification for new accounts", () => {
  it("blocks sign-in until the emailed link is opened", async () => {
    const email = `${uniq("v")}@example.com`.toLowerCase();
    const reg = await ok(api("POST", "/auth/register", { body: { name: "Kiran Shah", email, password: "secret123" } }));
    expect(reg.emailVerified).toBe(false);

    const blocked = await api("POST", "/auth/login", { body: { email, password: "secret123" } });
    expect(blocked.status).toBe(403);
    expect(blocked.error?.code).toBe("EMAIL_NOT_VERIFIED");

    // a wrong password still says "invalid", so the check reveals nothing about the account
    expect((await api("POST", "/auth/login", { body: { email, password: "wrongpass1" } })).status).toBe(401);

    const v = await verifyEmailFromMail(email);
    expect(v.email).toBe(email);
    const login = await ok<{ token: string }>(api("POST", "/auth/login", { body: { email, password: "secret123" } }));
    expect(login.token).toBeTruthy();
  });

  it("resends the link while signed out, with the same answer for unknown emails", async () => {
    const email = `${uniq("r")}@example.com`.toLowerCase();
    await ok(api("POST", "/auth/register", { body: { name: "Riya Desai", email, password: "secret123" } }));
    const { sentEmails } = await import("@/services/email.service");
    const before = sentEmails.filter((m) => m.to === email).length;
    expect(await ok(api("POST", "/auth/resend-verification-email", { body: { email } }))).toEqual({ ok: true });
    expect(sentEmails.filter((m) => m.to === email).length).toBe(before + 1);
    expect(await ok(api("POST", "/auth/resend-verification-email", { body: { email: "nobody-here@example.com" } }))).toEqual({ ok: true });
    await verifyEmailFromMail(email); // the newest link works
  });

  it("does not affect accounts created before verification was required", async () => {
    const email = `${uniq("old")}@example.com`.toLowerCase();
    await ok(api("POST", "/auth/register", { body: { name: "Old User", email, password: "secret123" } }));
    const { cols } = await import("@/lib/collections");
    const c = await cols();
    await c.users.updateOne({ email }, { $unset: { mustVerifyEmail: "" } }); // like an account from before
    await ok(api("POST", "/auth/login", { body: { email, password: "secret123" } }));
  });
});
