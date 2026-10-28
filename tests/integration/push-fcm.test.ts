import { describe, expect, it, vi } from "vitest";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { ObjectId } from "mongodb";
import { cols } from "@/lib/collections";
import { resetEnvCache } from "@/config/env";

/** The real Firebase Cloud Messaging path, against a fake Google server. */
describe("FCM sending", () => {
  it("signs in with the service account and sends an HTTP v1 message", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const account = { project_id: "demo-proj", client_email: "push@demo-proj.iam.gserviceaccount.com", private_key: pem.replace(/\n/g, "\\n") };
    process.env.FCM_SERVICE_ACCOUNT = Buffer.from(JSON.stringify(account)).toString("base64");
    resetEnvCache();
    const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? ""), headers: (init?.headers ?? {}) as Record<string, string> });
      if (String(url).includes("oauth2")) return new Response(JSON.stringify({ access_token: "ya29.test", expires_in: 3600 }));
      if (String(url).includes("fcm.googleapis.com") && String(init?.body).includes("dead-token")) return new Response(JSON.stringify({ error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } }), { status: 404 });
      return new Response("{}");
    }) as typeof fetch;
    try {
      const { sendNotificationPush } = await import("@/services/push.service");
      const c = await cols();
      const userId = new ObjectId();
      const good = `good-token-${"x".repeat(40)}`;
      await c.pushDevices.insertMany([
        { _id: new ObjectId(), userId, token: good, platform: "ios", createdAt: new Date(), lastSeenAt: new Date() },
        { _id: new ObjectId(), userId, token: `dead-token-${"y".repeat(40)}`, platform: "android", createdAt: new Date(), lastSeenAt: new Date() },
      ]);
      const id = new ObjectId();
      await c.notifications.insertOne({ _id: id, organizationId: new ObjectId(), userId, type: "t", title: "Payment verified", body: "₹500 received", link: "/org/x/receipts/y", dedupeKey: "k", readAt: null, createdAt: new Date() });
      expect(await sendNotificationPush(id)).toBe(1);

      // 1. Google token request carries a valid RS256 JWT for the FCM scope
      const tok = calls.find((x) => x.url.includes("oauth2"))!;
      const assertion = new URLSearchParams(tok.body).get("assertion")!;
      const [h, p, sig] = assertion.split(".");
      expect(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, sig, "base64url")).toBe(true);
      const claims = JSON.parse(Buffer.from(p, "base64url").toString());
      expect(claims).toMatchObject({ iss: account.client_email, aud: "https://oauth2.googleapis.com/token", scope: "https://www.googleapis.com/auth/firebase.messaging" });

      // 2. the message itself
      const send = calls.find((x) => x.url === "https://fcm.googleapis.com/v1/projects/demo-proj/messages:send" && x.body.includes(good))!;
      expect(send.headers.authorization).toBe("Bearer ya29.test");
      const msg = JSON.parse(send.body).message;
      expect(msg).toMatchObject({ token: good, notification: { title: "Payment verified", body: "₹500 received" }, data: { link: "/org/x/receipts/y", notificationId: id.toHexString() } });
      expect(msg.apns.payload.aps.badge).toBe(1);

      // 3. the rejected token is forgotten, and the access token is reused (one sign-in)
      expect(await c.pushDevices.countDocuments({ userId })).toBe(1);
      expect(calls.filter((x) => x.url.includes("oauth2"))).toHaveLength(1);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.FCM_SERVICE_ACCOUNT;
      resetEnvCache();
    }
  });
});
