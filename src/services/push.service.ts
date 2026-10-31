import { createSign } from "node:crypto";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { cols } from "@/lib/collections";
import { env } from "@/config/env";
import type { AuthContext } from "@/lib/auth";
import { localize } from "./notification.service";
import { isLang } from "./notification-copy";

/**
 * Phone push notifications for the iOS / Android apps, through Firebase Cloud Messaging (HTTP v1).
 * Every in-app notification (notification.service → notify) is also pushed to the person's phones.
 * Nothing happens until FCM_SERVICE_ACCOUNT is set, so the website and tests work without it.
 */

/* ------------------------------------------------------------------ devices */

export const PushDeviceSchema = z.object({
  token: z.string().min(20).max(4096),
  platform: z.enum(["ios", "android"]),
});

/** The app registers its push token after sign-in (and whenever Firebase gives it a new one). */
export async function registerDevice(auth: AuthContext, input: z.infer<typeof PushDeviceSchema>) {
  const c = await cols();
  const now = new Date();
  // A token belongs to one install: if someone else signs in on this phone, it moves to them.
  await c.pushDevices.updateOne(
    { token: input.token },
    { $set: { userId: auth.user._id, platform: input.platform, sessionId: auth.session._id, lastSeenAt: now }, $setOnInsert: { _id: new ObjectId(), token: input.token, createdAt: now } },
    { upsert: true },
  );
  return { ok: true };
}

/** Signing out on the phone stops pushes to it. */
export async function unregisterDevice(auth: AuthContext, token: string) {
  const c = await cols();
  await c.pushDevices.deleteOne({ token, userId: auth.user._id });
  return { ok: true };
}

/** Signing out on a phone (its session ends) stops pushes to that phone. */
export async function unregisterSessionDevices(sessionId: ObjectId) {
  const c = await cols();
  await c.pushDevices.deleteMany({ sessionId });
}

export async function unregisterAllDevices(userId: ObjectId) {
  const c = await cols();
  await c.pushDevices.deleteMany({ userId });
}

/* ------------------------------------------------------------------ sending */

export interface PushMessage {
  token: string;
  title: string;
  body: string;
  data: Record<string, string>;
  badge?: number;
}
type SendResult = "ok" | "invalid-token" | "error";
type Transport = (m: PushMessage) => Promise<SendResult>;

/** Messages "sent" while no FCM credentials are configured (tests and local development). */
export const sentPushes: PushMessage[] = [];
let testTransport: Transport | null = null;
/** Test hook: replace the FCM transport. */
export function setPushTransport(t: Transport | null) {
  testTransport = t;
}

/**
 * Send the push for a notification once the request that created it has finished. Notifications
 * are often created inside a database transaction; sending afterwards (and only if the row then
 * exists) means a rolled-back action never pushes anything.
 */
export function queuePush(notificationId: ObjectId) {
  const run = () => sendNotificationPush(notificationId).catch((e) => console.error("[push]", e));
  void (async () => {
    try {
      const { after } = await import("next/server");
      after(run);
    } catch {
      // outside a Next.js request (tests, scripts)
      setTimeout(run, 50);
    }
  })();
}

/** Push one notification to all of its user's phones (exactly once). */
export async function sendNotificationPush(notificationId: ObjectId) {
  const c = await cols();
  // claim it, so retries / duplicate calls never push twice
  const n = await c.notifications.findOneAndUpdate({ _id: notificationId, pushedAt: { $in: [null, undefined] } }, { $set: { pushedAt: new Date() } });
  if (!n) return 0;
  const devices = await c.pushDevices.find({ userId: n.userId }).toArray();
  if (!devices.length) return 0;
  const [badge, user, org] = await Promise.all([
    c.notifications.countDocuments({ userId: n.userId, readAt: null }),
    c.users.findOne({ _id: n.userId }, { projection: { language: 1 } }),
    c.organizations.findOne({ _id: n.organizationId }, { projection: { name: 1 } }),
  ]);
  // in their language, and say which Mandal it's about (people can be in several)
  const words = localize(n, isLang(user?.language) ? user.language : "en");
  const title = org?.name ? `${words.title} · ${org.name}` : words.title;
  let sent = 0;
  for (const d of devices) {
    // one phone failing (network, Apple credentials …) never stops the others
    let r: SendResult;
    try {
      r = await send({ token: d.token, title, body: words.body, badge, data: { link: n.link ?? "", notificationId: n._id.toHexString(), organizationId: n.organizationId.toHexString() } });
    } catch (e) {
      console.error("[push] send failed", d.platform, (e as Error).message);
      r = "error";
    }
    if (r === "ok") sent++;
    // the app was uninstalled or the token expired: forget it
    if (r === "invalid-token") await c.pushDevices.deleteOne({ _id: d._id });
  }
  return sent;
}

async function send(m: PushMessage): Promise<SendResult> {
  if (testTransport) return testTransport(m);
  const account = serviceAccount();
  if (!account) {
    sentPushes.push(m);
    return "ok";
  }
  const token = await accessToken(account);
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(fcmMessage(m)),
  });
  if (res.ok) return "ok";
  const text = await res.text().catch(() => "");
  if (isDeadToken(text)) return "invalid-token";
  if (fcmError(text).code === "THIRD_PARTY_AUTH_ERROR") {
    // our setup, not the phone: keep the token (fix the APNs key in Firebase → Cloud Messaging)
    console.error("[push] FCM rejected the APNs credentials for an iOS phone — check the APNs key in Firebase. Token kept.");
    return "error";
  }
  console.error("[push] FCM", res.status, text.slice(0, 300));
  return "error";
}

/** The FCM HTTP v1 request body for one phone. */
export function fcmMessage(m: PushMessage) {
  return {
    message: {
      token: m.token,
      notification: { title: m.title, body: m.body },
      data: m.data,
      android: { priority: "high", notification: { channel_id: "default", sound: "default", ...(m.badge !== undefined ? { notification_count: m.badge } : {}) } },
      // every push is Time Sensitive on iOS: it breaks through Focus and stays on the lock screen
      // (needs the time-sensitive entitlement in the iOS app), delivered right away (priority 10)
      apns: {
        headers: { "apns-priority": "10" },
        payload: { aps: { sound: "default", "interruption-level": "time-sensitive", ...(m.badge !== undefined ? { badge: m.badge } : {}) } },
      },
    },
  };
}

/** FCM's reason for a failed send, from the HTTP v1 error body. */
export function fcmError(text: string): { code?: string; message?: string } {
  try {
    const e = (JSON.parse(text) as { error?: { status?: string; message?: string; details?: { errorCode?: string }[] } }).error;
    return { code: e?.details?.find((d) => d?.errorCode)?.errorCode ?? e?.status, message: e?.message };
  } catch {
    return {};
  }
}

/**
 * The token will never work again (app uninstalled, token expired, or it belongs to another
 * Firebase project), so the device can be forgotten. A bare 404 is NOT enough: a wrong project id
 * also gives 404, and that must never wipe everyone's devices.
 */
export function isDeadToken(text: string) {
  const { code, message } = fcmError(text);
  if (code === "UNREGISTERED" || code === "SENDER_ID_MISMATCH") return true;
  return code === "INVALID_ARGUMENT" && /registration token/i.test(message ?? "");
}

/* ------------------------------------------------------------------ Google OAuth (service account → access token) */

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}
let accountCache: ServiceAccount | null | undefined;
function serviceAccount(): ServiceAccount | null {
  if (accountCache !== undefined) return accountCache;
  const raw = env().FCM_SERVICE_ACCOUNT?.trim();
  if (!raw) return (accountCache = null);
  try {
    const json = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
    const a = JSON.parse(json) as ServiceAccount;
    if (!a.project_id || !a.client_email || !a.private_key) throw new Error("missing fields");
    return (accountCache = a);
  } catch (e) {
    console.error("[push] FCM_SERVICE_ACCOUNT is not a valid service account JSON:", (e as Error).message);
    return (accountCache = null);
  }
}

let tokenCache: { token: string; expires: number } | null = null;
async function accessToken(a: ServiceAccount): Promise<string> {
  if (tokenCache && tokenCache.expires > Date.now() + 60_000) return tokenCache.token;
  const now = Math.floor(Date.now() / 1000);
  const b64 = (v: object | string) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: a.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(a.private_key.replace(/\\n/g, "\n"), "base64url");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }),
  });
  if (!res.ok) throw new Error(`Google token request failed (${res.status})`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = { token: j.access_token, expires: Date.now() + j.expires_in * 1000 };
  return j.access_token;
}
