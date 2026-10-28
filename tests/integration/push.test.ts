import { afterEach, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { addUser, api, ok, setupOrg, uniq } from "../helpers/api";
import { cols } from "@/lib/collections";
import { sendNotificationPush, sentPushes, setPushTransport } from "@/services/push.service";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const token = () => `fcm-${uniq()}-${"x".repeat(30)}`;

describe("phone push notifications", () => {
  afterEach(() => setPushTransport(null));

  it("pushes a new in-app notification to the person's phones, once", async () => {
    const o = await setupOrg();
    const member = await ok(api("POST", `/orgs/${o.orgId}/members`, { token: o.admin.token, body: { name: `Member ${uniq()}` } }));
    const u = await addUser(o.orgId, o.code, o.admin.token, "member", member._id);
    const adminPhone = token();
    await ok(api("POST", "/me/push-devices", { token: o.admin.token, body: { token: adminPhone, platform: "ios" } }));
    // registering again is harmless
    await ok(api("POST", "/me/push-devices", { token: o.admin.token, body: { token: adminPhone, platform: "ios" } }));

    // a member's "I have paid" report notifies the admins
    await ok(
      api("POST", `/orgs/${o.orgId}/me/payment-requests`, {
        token: u.token,
        body: { purpose: "other", amount: "250", date: new Date().toISOString().slice(0, 10), method: "cash", notes: "Ganpati donation", idempotencyKey: uniq("req") },
      }),
    );
    await wait(300);
    // (the earlier join request may also reach this phone; look at the payment one)
    const pushes = sentPushes.filter((p) => p.token === adminPhone && p.title.includes("says they paid"));
    expect(pushes).toHaveLength(1);
    // the Mandal's name is in the title, so it's clear which Mandal it's about
    expect(pushes[0].title).toBe(`${member.name} says they paid · Shree Ganesh Mandal`);
    expect(pushes[0].body).toBe("₹250.00 in cash for “Ganpati donation”. Verify it to issue a receipt.");
    expect(pushes[0].data.link).toContain(`/org/${o.orgId}/collections`);
    expect(pushes[0].badge).toBeGreaterThanOrEqual(1);

    // never pushed twice
    const c = await cols();
    const n = await c.notifications.findOne({ userId: new ObjectId(o.admin.userId), type: "payment.request" });
    expect(await sendNotificationPush(n!._id)).toBe(0);
  });

  it("forgets tokens FCM rejects, and stops on sign-out", async () => {
    const o = await setupOrg();
    const dead = token();
    await ok(api("POST", "/me/push-devices", { token: o.admin.token, body: { token: dead, platform: "android" } }));
    setPushTransport(async () => "invalid-token");
    const c = await cols();
    const id = new ObjectId();
    await c.notifications.insertOne({ _id: id, organizationId: new ObjectId(o.orgId), userId: new ObjectId(o.admin.userId), type: "test", title: "T", body: "B", dedupeKey: uniq(), readAt: null, createdAt: new Date() });
    await sendNotificationPush(id);
    expect(await c.pushDevices.countDocuments({ token: dead })).toBe(0);

    const phone = token();
    await ok(api("POST", "/me/push-devices", { token: o.admin.token, body: { token: phone, platform: "android" } }));
    await ok(api("DELETE", "/me/push-devices", { token: o.admin.token, body: { token: phone } }));
    expect(await c.pushDevices.countDocuments({ token: phone })).toBe(0);
    // validation
    expect((await api("POST", "/me/push-devices", { token: o.admin.token, body: { token: "short", platform: "web" } })).status).toBe(422);
    // signing out on the phone stops its pushes
    const phone2 = token();
    await ok(api("POST", "/me/push-devices", { token: o.admin.token, body: { token: phone2, platform: "ios" } }));
    await ok(api("POST", "/auth/logout", { token: o.admin.token }));
    expect(await c.pushDevices.countDocuments({ token: phone2 })).toBe(0);

  });

  it("writes notifications and pushes in each person's own language", async () => {
    const o = await setupOrg("Jay Ambe Mandal");
    const member = await ok(api("POST", `/orgs/${o.orgId}/members`, { token: o.admin.token, body: { name: "Kiran Shah" } }));
    const u = await addUser(o.orgId, o.code, o.admin.token, "member", member._id);
    const second = await addUser(o.orgId, o.code, o.admin.token, "admin");
    // one admin uses Gujarati, the other stays on English
    const me = await ok(api("PATCH", "/auth/me", { token: o.admin.token, body: { language: "gu" } }));
    expect(me.language).toBe("gu");
    const guPhone = token();
    const enPhone = token();
    await ok(api("POST", "/me/push-devices", { token: o.admin.token, body: { token: guPhone, platform: "android" } }));
    await ok(api("POST", "/me/push-devices", { token: second.token, body: { token: enPhone, platform: "ios" } }));

    // a member reports a donation: both admins hear about it
    await ok(api("POST", `/orgs/${o.orgId}/me/payment-requests`, { token: u.token, body: { purpose: "other", amount: "500", date: new Date().toISOString().slice(0, 10), method: "cash", notes: "Navratri", idempotencyKey: uniq("req") } }));
    await wait(300);

    const gu = sentPushes.find((p) => p.token === guPhone && p.body.includes("Navratri"))!;
    expect(gu.title).toBe("Kiran Shah એ ચુકવણી કરી · Jay Ambe Mandal");
    expect(gu.body).toBe("“Navratri” માટે રોકડ માં ₹500.00. ખાતરી કરીને રસીદ આપો.");
    const en = sentPushes.find((p) => p.token === enPhone && p.body.includes("Navratri"))!;
    expect(en.title).toBe("Kiran Shah says they paid · Jay Ambe Mandal");

    // the in-app list follows the language too — and changes when they switch
    const listGu = await ok(api("GET", `/notifications?orgId=${o.orgId}`, { token: o.admin.token }));
    expect(listGu.items.find((n: any) => n.type === "payment.request").title).toBe("Kiran Shah એ ચુકવણી કરી");
    await ok(api("PATCH", "/auth/me", { token: o.admin.token, body: { language: "hi" } }));
    const listHi = await ok(api("GET", `/notifications?orgId=${o.orgId}`, { token: o.admin.token }));
    expect(listHi.items.find((n: any) => n.type === "payment.request").title).toBe("Kiran Shah ने भुगतान किया");
    expect(listHi.items.find((n: any) => n.type === "membership.request").title).toBe("जुड़ने की नई माँग");
    expect((await api("PATCH", "/auth/me", { token: o.admin.token, body: { language: "fr" } })).status).toBe(422);
  });
});
