import { ObjectId } from "mongodb";
import { z } from "zod";
import { cols } from "@/lib/collections";
import { badRequest, notFound } from "@/lib/errors";
import { clampedDate, formatDateOnly, todayIn, utcAddDays } from "@/lib/dates";
import type { AuthContext } from "@/lib/auth";
import type { PersonalReminderDoc, ReminderRepeat } from "@/types/models";
import { dateOnly, money, objectId, optText } from "@/validators/common";
import { localize, notify } from "./notification.service";
import { copy, isLang, type Lang } from "./notification-copy";
import { createEntry, ensureSetup } from "./personal.service";

/**
 * Personal Hisab reminders: "pay house rent to the owner on the 5th at 10 am, remind me a day
 * before". The push goes out at (due time − remind before). Times are India time (UTC+5:30, no DST).
 * Every query is filtered by the owner's user id — nobody else can see or change them.
 */

const TZ = "Asia/Kolkata";
const IST_OFFSET_MIN = 330;
export const REMIND_BEFORE = [0, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 4320, 10080] as const;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The due moment (UTC) of a calendar day + "HH:mm" in India. */
export function dueAt(dueDate: Date, time: string): Date {
  const [h, m] = time.split(":").map(Number);
  return new Date(dueDate.getTime() + (h * 60 + m - IST_OFFSET_MIN) * 60_000);
}
const remindAtFor = (dueDate: Date, time: string, before: number) => new Date(dueAt(dueDate, time).getTime() - before * 60_000);

/** The next due date after `d` (monthly / yearly keep the anchor day: 31 Jan → 28 Feb → 31 Mar). */
export function nextDue(d: Date, repeat: ReminderRepeat, anchorDay: number): Date {
  if (repeat === "weekly") return utcAddDays(d, 7);
  if (repeat === "monthly") return clampedDate(d.getUTCFullYear(), d.getUTCMonth() + 1, anchorDay);
  if (repeat === "yearly") return clampedDate(d.getUTCFullYear() + 1, d.getUTCMonth(), anchorDay);
  return d;
}

/* ------------------------------------------------------------------ CRUD */

const remindBefore = z.coerce.number().int().refine((v) => (REMIND_BEFORE as readonly number[]).includes(v), "Choose when to be reminded");
export const ReminderSchema = z.object({
  title: z.string().trim().min(1, "Enter what the reminder is for").max(80),
  note: optText(300),
  amount: z.union([money(), z.literal("").transform(() => null), z.null()]).optional(),
  categoryId: objectId.optional().nullable().or(z.literal("").transform(() => null)),
  walletId: objectId.optional().nullable().or(z.literal("").transform(() => null)),
  repeat: z.enum(["once", "weekly", "monthly", "yearly"]),
  dueDate: dateOnly,
  time: z.string().regex(TIME, "Choose a time"),
  remindBeforeMinutes: remindBefore,
});
export const ReminderUpdateSchema = ReminderSchema.extend({ isActive: z.boolean().optional() });

async function checkRefs(userId: ObjectId, v: { categoryId?: ObjectId | null; walletId?: ObjectId | null }) {
  const c = await cols();
  if (v.categoryId) {
    const k = await c.personalCategories.findOne({ _id: v.categoryId, userId });
    if (!k) throw notFound("Category");
    if (k.kind !== "expense") throw badRequest("Choose a spending category");
  }
  if (v.walletId && !(await c.personalWallets.findOne({ _id: v.walletId, userId }))) throw notFound("Wallet");
}

function fields(v: z.infer<typeof ReminderSchema>) {
  return {
    title: v.title,
    note: v.note,
    amountPaise: v.amount ?? null,
    categoryId: v.categoryId ?? null,
    walletId: v.walletId ?? null,
    repeat: v.repeat,
    dueDate: v.dueDate,
    time: v.time,
    anchorDay: v.dueDate.getUTCDate(),
    remindBeforeMinutes: v.remindBeforeMinutes,
    remindAt: remindAtFor(v.dueDate, v.time, v.remindBeforeMinutes),
    notifiedFor: null,
  };
}

export async function createReminder(auth: AuthContext, input: z.infer<typeof ReminderSchema>) {
  await ensureSetup(auth);
  const userId = auth.user._id;
  await checkRefs(userId, input);
  const now = new Date();
  const doc: PersonalReminderDoc = { _id: new ObjectId(), userId, ...fields(input), isActive: true, createdAt: now, updatedAt: now };
  if (!doc.note) delete doc.note;
  await (await cols()).personalReminders.insertOne(doc);
  return { reminder: await reminderOut(doc) };
}

export async function updateReminder(auth: AuthContext, id: ObjectId, input: z.infer<typeof ReminderUpdateSchema>) {
  const c = await cols();
  const userId = auth.user._id;
  const r = await c.personalReminders.findOne({ _id: id, userId });
  if (!r) throw notFound("Reminder");
  await checkRefs(userId, input);
  const { note, ...f } = fields(input);
  // same due moment and already pushed → don't push again
  const sameDue = r.dueDate.getTime() === f.dueDate.getTime() && r.time === f.time && r.remindBeforeMinutes === f.remindBeforeMinutes;
  const set = { ...f, notifiedFor: sameDue ? (r.notifiedFor ?? null) : null, isActive: input.isActive ?? r.isActive, updatedAt: new Date() };
  await c.personalReminders.updateOne({ _id: id, userId }, note ? { $set: { ...set, note } } : { $set: set, $unset: { note: "" } });
  return { reminder: await reminderOut((await c.personalReminders.findOne({ _id: id, userId }))!) };
}

export async function deleteReminder(auth: AuthContext, id: ObjectId) {
  const r = await (await cols()).personalReminders.deleteOne({ _id: id, userId: auth.user._id });
  if (!r.deletedCount) throw notFound("Reminder");
  return { ok: true };
}

/* ------------------------------------------------------------------ paid / skip */

/** Move to the next due date (repeating), or finish (one-time). */
async function advance(r: PersonalReminderDoc, paidDate?: Date) {
  const c = await cols();
  const set: Partial<PersonalReminderDoc> = { updatedAt: new Date(), notifiedFor: null, ...(paidDate ? { lastPaidDate: paidDate } : {}) };
  if (r.repeat === "once") set.isActive = false;
  else {
    set.dueDate = nextDue(r.dueDate, r.repeat, r.anchorDay);
    set.remindAt = remindAtFor(set.dueDate, r.time, r.remindBeforeMinutes);
  }
  await c.personalReminders.updateOne({ _id: r._id, userId: r.userId }, { $set: set });
}

export const PaidSchema = z.object({
  /** record it as spending (needs an amount and a category) */
  record: z.boolean().default(true),
  amount: money().optional(),
  date: dateOnly.optional(),
  walletId: objectId.optional(),
  categoryId: objectId.optional(),
});

/** "Paid": optionally add the spending entry, then go to the next due date. Safe to tap twice. */
export async function markPaid(auth: AuthContext, id: ObjectId, input: z.infer<typeof PaidSchema>) {
  const c = await cols();
  const userId = auth.user._id;
  const r = await c.personalReminders.findOne({ _id: id, userId });
  if (!r) throw notFound("Reminder");
  if (!r.isActive) throw badRequest("This reminder is already done");
  const date = input.date ?? todayIn(TZ);
  let entry = null;
  if (input.record) {
    const amount = input.amount ?? r.amountPaise;
    const categoryId = input.categoryId ?? r.categoryId;
    if (!amount) throw badRequest("Enter the amount paid");
    if (!categoryId) throw badRequest("Choose a category");
    const walletId = input.walletId ?? r.walletId ?? (await c.personalWallets.findOne({ userId, isArchived: false }, { sort: { createdAt: 1, _id: 1 } }))?._id;
    if (!walletId) throw badRequest("Add a wallet first");
    // one entry per due date, even if "Paid" is tapped twice
    const res = await createEntry(auth, { type: "expense", amount, date, walletId, categoryId, toWalletId: null, note: r.title, idempotencyKey: `rem-${r._id.toHexString()}-${formatDateOnly(r.dueDate)}` });
    entry = res.entry;
  }
  // a double tap: the entry above was a duplicate and the reminder already moved on — don't move it twice
  const fresh = await c.personalReminders.findOne({ _id: id, userId });
  if (fresh && fresh.isActive && fresh.dueDate.getTime() === r.dueDate.getTime()) await advance(fresh, date);
  return { entry, reminder: await reminderOut((await c.personalReminders.findOne({ _id: id, userId }))!) };
}

/** Skip this time (repeating only): nothing is recorded, the next due date comes up. */
export async function skipReminder(auth: AuthContext, id: ObjectId) {
  const c = await cols();
  const r = await c.personalReminders.findOne({ _id: id, userId: auth.user._id });
  if (!r) throw notFound("Reminder");
  if (r.repeat === "once" || !r.isActive) throw badRequest("Only an active repeating reminder can be skipped");
  await advance(r);
  return { reminder: await reminderOut((await c.personalReminders.findOne({ _id: id }))!) };
}

/* ------------------------------------------------------------------ list */

async function reminderOut(r: PersonalReminderDoc, now = new Date()) {
  const c = await cols();
  const [cat, wallet] = await Promise.all([r.categoryId ? c.personalCategories.findOne({ _id: r.categoryId, userId: r.userId }) : null, r.walletId ? c.personalWallets.findOne({ _id: r.walletId, userId: r.userId }) : null]);
  const due = dueAt(r.dueDate, r.time);
  const today = todayIn(TZ, now);
  const daysLeft = Math.round((r.dueDate.getTime() - today.getTime()) / 86_400_000);
  return {
    _id: r._id,
    title: r.title,
    note: r.note ?? null,
    amountPaise: r.amountPaise ?? null,
    category: cat ? { _id: cat._id, name: cat.name, key: cat.key ?? null, tone: cat.tone, icon: cat.icon ?? null, kind: cat.kind } : null,
    wallet: wallet ? { _id: wallet._id, name: wallet.name, key: wallet.key ?? null, kind: wallet.kind } : null,
    repeat: r.repeat,
    dueDate: formatDateOnly(r.dueDate),
    time: r.time,
    dueAt: due,
    remindBeforeMinutes: r.remindBeforeMinutes,
    remindAt: r.remindAt,
    notified: !!r.notifiedFor && r.notifiedFor.getTime() === r.dueDate.getTime(),
    isActive: r.isActive,
    daysLeft,
    status: !r.isActive ? "done" : due.getTime() < now.getTime() ? "overdue" : daysLeft <= 0 ? "today" : daysLeft <= 7 ? "soon" : "later",
    lastPaidDate: r.lastPaidDate ? formatDateOnly(r.lastPaidDate) : null,
  };
}

/** Reminders (soonest first, finished ones last) and the latest Personal Hisab alerts (`markRead`: the person is looking at them now). */
export async function listReminders(auth: AuthContext, opts: { markRead?: boolean } = {}) {
  await ensureSetup(auth);
  const c = await cols();
  const userId = auth.user._id;
  const [rows, alerts] = await Promise.all([
    c.personalReminders.find({ userId }).sort({ isActive: -1, dueDate: 1, time: 1 }).toArray(),
    c.notifications.find({ userId, organizationId: null }).sort({ createdAt: -1 }).limit(20).toArray(),
  ]);
  const now = new Date();
  const lang: Lang = isLang(auth.user.language) ? auth.user.language : "en";
  const unread = alerts.filter((a) => !a.readAt).map((a) => a._id);
  if (opts.markRead && unread.length) await c.notifications.updateMany({ _id: { $in: unread }, userId }, { $set: { readAt: now } });
  return {
    reminders: await Promise.all(rows.map((r) => reminderOut(r, now))),
    alerts: alerts.map((a) => {
      const l = localize(a, lang);
      return { _id: a._id, type: a.type, title: l.title, body: l.body, createdAt: a.createdAt, unread: !a.readAt };
    }),
  };
}

/* ------------------------------------------------------------------ the job */

/**
 * Send every reminder whose time has come (once per due date). Run it often (every 5 minutes) for
 * pushes right on time; the daily job also runs it, so nothing is ever missed entirely.
 * A repeating reminder nobody marked paid moves on by itself when its next one is due, so the
 * next month's push still goes out.
 */
export async function runPersonalReminders(now = new Date()) {
  const c = await cols();
  let sent = 0;
  const due = c.personalReminders.find({ isActive: true, remindAt: { $lte: now } });
  for await (const r of due) {
    try {
      let cur = r;
      const alreadySent = !!r.notifiedFor && r.notifiedFor.getTime() === r.dueDate.getTime();
      if (alreadySent) {
        // pushed, not marked paid yet: stays overdue until the next one's reminder time comes
        if (r.repeat === "once") continue;
        let next = nextDue(r.dueDate, r.repeat, r.anchorDay);
        if (remindAtFor(next, r.time, r.remindBeforeMinutes).getTime() > now.getTime()) continue;
        // catch up (the job didn't run for a long time): only the latest one is pushed
        for (let guard = 0; guard < 500; guard++) {
          const after = nextDue(next, r.repeat, r.anchorDay);
          if (remindAtFor(after, r.time, r.remindBeforeMinutes).getTime() > now.getTime()) break;
          next = after;
        }
        cur = { ...r, dueDate: next, remindAt: remindAtFor(next, r.time, r.remindBeforeMinutes), notifiedFor: null };
        await c.personalReminders.updateOne({ _id: r._id }, { $set: { dueDate: cur.dueDate, remindAt: cur.remindAt, notifiedFor: null, updatedAt: now } });
      }
      const today = todayIn(TZ, now);
      const days = Math.round((cur.dueDate.getTime() - today.getTime()) / 86_400_000);
      const created = await notify({
        organizationId: null,
        userId: cur.userId,
        type: "personal.reminder",
        copy: copy("personal.reminder", { title: cur.title, note: cur.note ?? null, amountPaise: cur.amountPaise ?? null, dueDate: cur.dueDate.toISOString(), time: cur.time, when: days === 0 ? "today" : days === 1 ? "tomorrow" : "" }, "INR"),
        link: "/personal/reminders",
        dedupeKey: `ph-rem:${cur._id.toHexString()}:${formatDateOnly(cur.dueDate)}`,
      });
      await c.personalReminders.updateOne({ _id: cur._id }, { $set: { notifiedFor: cur.dueDate, updatedAt: now } });
      if (created) sent++;
    } catch (e) {
      console.error("[personal-reminders]", r._id.toHexString(), e);
    }
  }
  return { remindersSent: sent };
}
