import { ObjectId } from "mongodb";
import { z } from "zod";
import { cols } from "@/lib/collections";
import { audit } from "@/lib/audit";
import { badRequest, conflict, isDuplicateKeyError, notFound } from "@/lib/errors";
import { todayIn } from "@/lib/dates";
import type { OrgContext } from "@/lib/auth";
import type { MeetingDoc, OrganizationDoc } from "@/types/models";
import { dateOnly, idempotencyKey, optText } from "@/validators/common";
import { notifyOrgMembers } from "./notification.service";
import { copy } from "./notification-copy";

/**
 * Mandal meet-ups. An admin sets the date, time and place (the Mandal's address unless they
 * change it) and anything else happening that day; every member is notified on their phone.
 */

/** The Mandal's address from its profile — where meetings are held unless the admin says otherwise. */
export function defaultPlace(org: Pick<OrganizationDoc, "address" | "city">) {
  const parts = [org.address, org.city].map((p) => p?.trim()).filter((p): p is string => !!p);
  // don't repeat the city when the address already ends with it
  if (parts.length === 2 && parts[0].toLowerCase().includes(parts[1].toLowerCase())) parts.pop();
  return parts.join(", ");
}

export const MeetingSchema = z.object({
  date: dateOnly,
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Enter the time"),
  /** Left empty → the Mandal's address. */
  place: optText(300),
  /** Anything else happening that day (puja, election, dinner…). */
  events: optText(1000),
  idempotencyKey,
});

const toCopy = (m: Pick<MeetingDoc, "date" | "time" | "place" | "events">) => ({ date: m.date.toISOString(), time: m.time, place: m.place, events: m.events ?? "" });

export async function listMeetings(ctx: OrgContext) {
  const c = await cols();
  const today = todayIn(ctx.org.settings.timezone);
  const [upcoming, past] = await Promise.all([
    c.meetings.find({ organizationId: ctx.orgId, date: { $gte: today } }).sort({ date: 1, time: 1 }).limit(50).toArray(),
    c.meetings.find({ organizationId: ctx.orgId, date: { $lt: today } }).sort({ date: -1, time: -1 }).limit(20).toArray(),
  ]);
  return { upcoming, past, defaultPlace: defaultPlace(ctx.org), canManage: ctx.can("org.settings.manage") };
}

/** The next meeting that hasn't been cancelled (for the dashboard), or null. */
export async function nextMeeting(ctx: OrgContext) {
  const c = await cols();
  return c.meetings.findOne({ organizationId: ctx.orgId, status: "scheduled", date: { $gte: todayIn(ctx.org.settings.timezone) } }, { sort: { date: 1, time: 1 } });
}

export async function createMeeting(ctx: OrgContext, input: z.infer<typeof MeetingSchema>) {
  const c = await cols();
  const prior = await c.meetings.findOne({ organizationId: ctx.orgId, idempotencyKey: input.idempotencyKey });
  if (prior) return { meeting: prior, duplicate: true };
  if (input.date < todayIn(ctx.org.settings.timezone)) throw badRequest("The meeting date can't be in the past");
  const place = input.place || defaultPlace(ctx.org);
  if (!place) throw badRequest("Enter where the meeting is — or add the Mandal's address in Settings");
  const now = new Date();
  const doc: MeetingDoc = {
    _id: new ObjectId(),
    organizationId: ctx.orgId,
    date: input.date,
    time: input.time,
    place,
    events: input.events || undefined,
    status: "scheduled",
    createdBy: ctx.user._id,
    idempotencyKey: input.idempotencyKey,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await c.meetings.insertOne(doc);
  } catch (e) {
    if (isDuplicateKeyError(e)) {
      const again = await c.meetings.findOne({ organizationId: ctx.orgId, idempotencyKey: input.idempotencyKey });
      if (again) return { meeting: again, duplicate: true };
    }
    throw e;
  }
  await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "meeting.create", entityType: "meeting", entityId: doc._id, after: toCopy(doc) });
  await notifyOrgMembers(
    ctx.orgId,
    {
      actorId: ctx.user._id,
      type: "meeting.scheduled",
      copy: copy("meeting.scheduled", toCopy(doc), ctx.org.settings.currency),
      link: `/org/${ctx.orgId}/meetings`,
      dedupeKey: `meeting:${doc._id}`,
    },
    { exceptUserIds: [ctx.user._id] },
  );
  return { meeting: doc, duplicate: false };
}

export async function cancelMeeting(ctx: OrgContext, id: ObjectId, reasonText?: string) {
  const c = await cols();
  const m = await c.meetings.findOne({ _id: id, organizationId: ctx.orgId });
  if (!m) throw notFound("Meeting");
  if (m.status === "cancelled") throw conflict("This meeting is already cancelled");
  if (m.date < todayIn(ctx.org.settings.timezone)) throw badRequest("This meeting has already happened");
  const r = await c.meetings.updateOne({ _id: id, status: "scheduled" }, { $set: { status: "cancelled", cancelReason: reasonText || undefined, cancelledAt: new Date(), updatedAt: new Date() } });
  if (r.modifiedCount !== 1) throw conflict("This meeting was just changed — refresh and try again");
  await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "meeting.cancel", entityType: "meeting", entityId: id, reason: reasonText });
  await notifyOrgMembers(
    ctx.orgId,
    {
      actorId: ctx.user._id,
      type: "meeting.cancelled",
      copy: copy("meeting.cancelled", { ...toCopy(m), reason: reasonText ?? "" }, ctx.org.settings.currency),
      link: `/org/${ctx.orgId}/meetings`,
      dedupeKey: `meeting-cancel:${id}`,
    },
    { exceptUserIds: [ctx.user._id] },
  );
  return { ok: true };
}
