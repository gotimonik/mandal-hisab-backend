import { ObjectId, type ClientSession } from "mongodb";
import { cols } from "@/lib/collections";
import type { AuthContext } from "@/lib/auth";

export interface NotifyInput {
  organizationId: ObjectId;
  userId: ObjectId;
  type: string;
  title: string;
  body: string;
  link?: string;
  /** Unique per user. Re-sending the same key is a no-op (prevents duplicate reminders). */
  dedupeKey: string;
}

/**
 * In-app notification. Channel fan-out (email / push via Capacitor + FCM/APNs) is
 * designed to hang off this function: add a `channels` step here once credentials
 * exist. Returns true when a new notification was created.
 */
export async function notify(n: NotifyInput, session?: ClientSession): Promise<boolean> {
  const c = await cols();
  const r = await c.notifications.updateOne(
    { userId: n.userId, dedupeKey: n.dedupeKey },
    {
      $setOnInsert: {
        _id: new ObjectId(),
        organizationId: n.organizationId,
        userId: n.userId,
        type: n.type,
        title: n.title,
        body: n.body,
        link: n.link,
        dedupeKey: n.dedupeKey,
        readAt: null,
        createdAt: new Date(),
      },
    },
    { upsert: true, session },
  );
  return r.upsertedCount === 1;
}

/** Notify the app user linked to a member record, if any. */
export async function notifyMember(
  organizationId: ObjectId,
  memberId: ObjectId | null | undefined,
  n: Omit<NotifyInput, "organizationId" | "userId">,
  session?: ClientSession,
) {
  if (!memberId) return false;
  const c = await cols();
  const m = await c.members.findOne({ _id: memberId, organizationId }, { session, projection: { userId: 1 } });
  if (!m?.userId) return false;
  return notify({ ...n, organizationId, userId: m.userId }, session);
}

export async function notifyRoles(
  organizationId: ObjectId,
  roles: ("admin" | "manager")[],
  n: Omit<NotifyInput, "organizationId" | "userId">,
) {
  const c = await cols();
  const ms = await c.organizationMemberships.find({ organizationId, status: "active", role: { $in: roles } }).toArray();
  for (const m of ms) await notify({ ...n, organizationId, userId: m.userId, dedupeKey: `${n.dedupeKey}:${m.userId}` });
}

export async function listNotifications(auth: AuthContext, opts: { organizationId?: ObjectId; unreadOnly?: boolean; page?: number; pageSize?: number }) {
  const c = await cols();
  const page = opts.page ?? 1;
  const pageSize = opts.pageSize ?? 25;
  const q: Record<string, unknown> = { userId: auth.user._id };
  if (opts.organizationId) q.organizationId = opts.organizationId;
  if (opts.unreadOnly) q.readAt = null;
  const [items, total, unread] = await Promise.all([
    c.notifications.find(q).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray(),
    c.notifications.countDocuments(q),
    c.notifications.countDocuments({ ...q, readAt: null }),
  ]);
  return { items, unread, total, page, pageSize };
}

export async function markRead(auth: AuthContext, ids: ObjectId[] | "all") {
  const c = await cols();
  const q: Record<string, unknown> = { userId: auth.user._id, readAt: null };
  if (ids !== "all") q._id = { $in: ids };
  await c.notifications.updateMany(q, { $set: { readAt: new Date() } });
  return { ok: true };
}
