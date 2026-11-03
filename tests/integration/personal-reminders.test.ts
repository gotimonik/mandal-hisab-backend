import { beforeAll, describe, expect, it } from "vitest";
import { api, ok, registerAndLogin, uniq } from "../helpers/api";
import { dueAt, nextDue, runPersonalReminders } from "@/services/personal-reminders.service";
import { sentPushes } from "@/services/push.service";
import { cols } from "@/lib/collections";
import { ObjectId } from "mongodb";

/**
 * Personal Hisab reminders ("pay house rent to the owner on the 5th, remind me a day before") and
 * budget alerts. Pushes are only for the owner; nothing here belongs to a Mandal.
 */

const ist = (s: string) => new Date(`${s}+05:30`); // "2026-12-05T10:00" in India
const settle = () => new Promise((r) => setTimeout(r, 150)); // pushes go out just after the request
const istToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

describe("Personal Hisab reminders", () => {
  let me: { token: string; userId: string };
  let other: { token: string; userId: string };
  let rent: any, cash: any;
  const pushesOf = async (reminderId: string) => (await cols()).notifications.countDocuments({ dedupeKey: { $regex: `^ph-rem:${reminderId}:` } });
  const pushesFor = async (userId: string) => {
    const c = await cols();
    return c.notifications.find({ userId: new ObjectId(userId), organizationId: null }).sort({ createdAt: 1 }).toArray();
  };

  beforeAll(async () => {
    me = await registerAndLogin("Reminder Person");
    other = await registerAndLogin("Someone Else");
    const cats = (await ok(api("GET", "/me/personal/categories", { token: me.token }))).categories;
    rent = cats.find((k: any) => k.key === "home");
    cash = (await ok(api("GET", "/me/personal/wallets", { token: me.token }))).wallets[0];
    const c = await cols();
    await c.pushDevices.insertOne({ _id: new ObjectId(), userId: new ObjectId(me.userId), token: `tok-${uniq()}`, platform: "android", createdAt: new Date(), updatedAt: new Date() } as any);
  });

  it("works out due times in India time and repeats on the same day of the month", () => {
    expect(dueAt(new Date("2026-12-05T00:00:00Z"), "10:00").toISOString()).toBe("2026-12-05T04:30:00.000Z");
    const jan31 = new Date("2027-01-31T00:00:00Z");
    const feb = nextDue(jan31, "monthly", 31);
    expect(feb.toISOString().slice(0, 10)).toBe("2027-02-28");
    expect(nextDue(feb, "monthly", 31).toISOString().slice(0, 10)).toBe("2027-03-31");
    expect(nextDue(jan31, "weekly", 31).toISOString().slice(0, 10)).toBe("2027-02-07");
    expect(nextDue(new Date("2028-02-29T00:00:00Z"), "yearly", 29).toISOString().slice(0, 10)).toBe("2029-02-28");
  });

  it("pushes just before the chosen time — not earlier, and only once", async () => {
    const { reminder } = await ok(
      api("POST", "/me/personal/reminders", { token: me.token, body: { title: "House rent to owner", amount: "12000", categoryId: rent._id, walletId: cash._id, repeat: "monthly", dueDate: "2027-12-05", time: "10:00", remindBeforeMinutes: 1440, note: "Pay Rameshbhai" } }),
    );
    expect(reminder).toMatchObject({ repeat: "monthly", remindAt: "2027-12-04T04:30:00.000Z", notified: false, isActive: true });

    await runPersonalReminders(ist("2027-12-04T09:55"));
    expect(await pushesFor(me.userId)).toHaveLength(0);

    const before = sentPushes.length;
    await runPersonalReminders(ist("2027-12-04T10:01"));
    await settle();
    const [n] = await pushesFor(me.userId);
    expect(n).toMatchObject({ type: "personal.reminder", organizationId: null, title: "Reminder: House rent to owner", link: "/personal/reminders" });
    expect(n.body).toMatch(/^House rent to owner · ₹12,000(\.00)? is due tomorrow at 10:00 am\. Pay Rameshbhai$/);
    expect(sentPushes.length).toBe(before + 1);
    expect(sentPushes.at(-1)!.title).toBe("Reminder: House rent to owner"); // no Mandal name

    await runPersonalReminders(ist("2027-12-04T10:06"));
    await runPersonalReminders(ist("2027-12-05T10:30"));
    expect(await pushesFor(me.userId)).toHaveLength(1);
    rent.reminderId = reminder._id;
  });

  it("in the person's language", async () => {
    await ok(api("PATCH", "/auth/me", { token: me.token, body: { language: "gu" } }));
    const list = await ok(api("GET", "/me/personal/reminders?markRead=1", { token: me.token }));
    expect(list.alerts[0].title).toBe("યાદ અપાવું: House rent to owner");
    expect(list.alerts[0].body).toMatch(/^House rent to owner · ₹12,000(\.00)? કાલે 10:00 .+ વાગ્યે ભરવાનું છે\./);
    // reading the list marks them read
    expect((await ok(api("GET", "/me/personal/reminders", { token: me.token }))).alerts[0].unread).toBe(false);
    await ok(api("PATCH", "/auth/me", { token: me.token, body: { language: "en" } }));
  });

  it("'Paid' records the spending once and moves to next month", async () => {
    const id = rent.reminderId;
    const paid = await ok(api("POST", `/me/personal/reminders/${id}/paid`, { token: me.token, body: {} }));
    expect(paid.entry).toMatchObject({ type: "expense", amountPaise: 1_200_000, note: "House rent to owner", category: { _id: rent._id }, wallet: { _id: cash._id } });
    expect(paid.reminder).toMatchObject({ dueDate: "2028-01-05", notified: false, lastPaidDate: istToday() });
    // tapping "Paid" twice doesn't record it twice (the second tap is for the next month's due date)
    const entries = await ok(api("GET", `/me/personal/entries?q=${encodeURIComponent("House rent to owner")}`, { token: me.token }));
    expect(entries.total).toBe(1);
    // the next month's push comes a day before again
    await runPersonalReminders(ist("2028-01-04T10:00"));
    expect(await pushesFor(me.userId)).toHaveLength(2);
  });

  it("skip moves on without recording anything; one-time reminders finish when paid", async () => {
    const id = rent.reminderId;
    expect((await ok(api("POST", `/me/personal/reminders/${id}/skip`, { token: me.token, body: {} }))).reminder.dueDate).toBe("2028-02-05");
    const { reminder } = await ok(api("POST", "/me/personal/reminders", { token: me.token, body: { title: "Car insurance", repeat: "once", dueDate: "2028-03-01", time: "09:00", remindBeforeMinutes: 10080 } }));
    expect(reminder.remindAt).toBe("2028-02-23T03:30:00.000Z");
    // no amount → just mark done without an entry
    const done = await ok(api("POST", `/me/personal/reminders/${reminder._id}/paid`, { token: me.token, body: { record: false } }));
    expect(done).toMatchObject({ entry: null, reminder: { isActive: false, status: "done" } });
    expect((await api("POST", `/me/personal/reminders/${reminder._id}/paid`, { token: me.token, body: { record: false } })).status).toBe(400);
    expect((await api("POST", `/me/personal/reminders/${reminder._id}/skip`, { token: me.token, body: {} })).status).toBe(400);
    // asking to record it without an amount says so
    const { reminder: r2 } = await ok(api("POST", "/me/personal/reminders", { token: me.token, body: { title: "Gas cylinder", repeat: "once", dueDate: "2028-03-01", time: "09:00", remindBeforeMinutes: 0 } }));
    expect((await api("POST", `/me/personal/reminders/${r2._id}/paid`, { token: me.token, body: {} })).error?.message).toBe("Enter the amount paid");
  });

  it("an ignored monthly reminder still reminds next month (and catches up after a long gap)", async () => {
    const { reminder } = await ok(api("POST", "/me/personal/reminders", { token: me.token, body: { title: "Office rent", amount: "8000", categoryId: rent._id, repeat: "monthly", dueDate: "2029-01-10", time: "11:00", remindBeforeMinutes: 60 } }));
    await runPersonalReminders(ist("2029-01-10T10:00"));
    await runPersonalReminders(ist("2029-01-20T10:00")); // overdue, not paid: nothing new yet
    let r = (await ok(api("GET", "/me/personal/reminders", { token: me.token }))).reminders.find((x: any) => x._id === reminder._id);
    expect(r).toMatchObject({ dueDate: "2029-01-10", notified: true });
    await runPersonalReminders(ist("2029-02-10T10:00"));
    r = (await ok(api("GET", "/me/personal/reminders", { token: me.token }))).reminders.find((x: any) => x._id === reminder._id);
    expect(r).toMatchObject({ dueDate: "2029-02-10", notified: true });
    // months without the job running: only the latest month is pushed
    expect(await pushesOf(reminder._id)).toBe(2);
    await runPersonalReminders(ist("2029-06-10T10:30"));
    r = (await ok(api("GET", "/me/personal/reminders", { token: me.token }))).reminders.find((x: any) => x._id === reminder._id);
    expect(r.dueDate).toBe("2029-06-10");
    expect(await pushesOf(reminder._id)).toBe(3);
  });

  it("checks the form and keeps reminders private", async () => {
    const bad = (body: any) => api("POST", "/me/personal/reminders", { token: me.token, body: { title: "x", repeat: "monthly", dueDate: "2028-01-01", time: "10:00", remindBeforeMinutes: 60, ...body } });
    expect((await bad({ time: "25:00" })).status).toBe(422);
    expect((await bad({ remindBeforeMinutes: 7 })).status).toBe(422);
    expect((await bad({ title: "" })).status).toBe(422);
    const income = (await ok(api("GET", "/me/personal/categories", { token: me.token }))).categories.find((k: any) => k.kind === "income");
    expect((await bad({ categoryId: income._id })).error?.message).toBe("Choose a spending category");
    // someone else
    const id = rent.reminderId;
    expect((await ok(api("GET", "/me/personal/reminders", { token: other.token }))).reminders).toEqual([]);
    expect((await api("POST", `/me/personal/reminders/${id}/paid`, { token: other.token, body: {} })).status).toBe(404);
    expect((await api("DELETE", `/me/personal/reminders/${id}`, { token: other.token })).status).toBe(404);
    expect((await api("POST", "/me/personal/reminders", { token: other.token, body: { title: "x", repeat: "once", dueDate: "2028-01-01", time: "10:00", remindBeforeMinutes: 0, categoryId: rent._id } })).status).toBe(404);
    // editing the time re-arms the push; delete removes it
    const moved = await ok(api("PATCH", `/me/personal/reminders/${id}`, { token: me.token, body: { title: "House rent to owner", repeat: "monthly", dueDate: "2028-02-06", time: "08:00", remindBeforeMinutes: 0 } }));
    expect(moved.reminder).toMatchObject({ dueDate: "2028-02-06", remindAt: "2028-02-06T02:30:00.000Z", amountPaise: null, notified: false });
    await ok(api("DELETE", `/me/personal/reminders/${id}`, { token: me.token }));
    expect((await api("DELETE", `/me/personal/reminders/${id}`, { token: me.token })).status).toBe(404);
  });

  it("the cron endpoint needs the secret", async () => {
    expect((await api("GET", "/cron/reminders")).status).toBe(401);
  });
});

describe("Personal Hisab budget alerts", () => {
  it("pushes at 80% and when over — once each per month, and can be turned off", async () => {
    const u = await registerAndLogin("Budget Person");
    const cats = (await ok(api("GET", "/me/personal/categories", { token: u.token }))).categories;
    const food = cats.find((k: any) => k.key === "food");
    const wallet = (await ok(api("GET", "/me/personal/wallets", { token: u.token }))).wallets[0];
    await ok(api("PATCH", `/me/personal/categories/${food._id}`, { token: u.token, body: { monthlyBudget: "1000" } }));
    await ok(api("PATCH", "/me/personal/settings", { token: u.token, body: { monthlyBudget: "5000" } }));
    const spend = (amount: string) => ok(api("POST", "/me/personal/entries", { token: u.token, body: { type: "expense", amount, date: istToday(), walletId: wallet._id, categoryId: food._id, idempotencyKey: uniq("pe") } }));
    const alerts = async () => (await (await cols()).notifications.find({ userId: new ObjectId(u.userId), organizationId: null }).sort({ createdAt: 1 }).toArray()).map((n) => `${n.type}:${n.title}`);

    await spend("700");
    expect(await alerts()).toEqual([]);
    await spend("150"); // 850 of 1000
    expect(await alerts()).toEqual(["personal.budget.near:80% of your Food & dining budget used"]);
    await spend("10");
    expect(await alerts()).toHaveLength(1);
    await spend("300"); // 1160 > 1000
    expect((await alerts()).at(-1)).toBe("personal.budget.over:Food & dining budget exceeded");
    const over = (await (await cols()).notifications.findOne({ userId: new ObjectId(u.userId), type: "personal.budget.over" }))!;
    expect(over.body).toMatch(/₹160(\.00)? over your ₹1,000(\.00)? budget/);
    expect(over.link).toBe(`/personal/categories/${food._id}`);
    await spend("3000"); // overall 4160 of 5000 → 80 %
    expect((await alerts()).at(-1)).toBe("personal.budget.near:80% of your monthly budget used");

    // turned off: nothing more
    expect((await ok(api("PATCH", "/me/personal/settings", { token: u.token, body: { budgetAlerts: false } }))).budgetAlerts).toBe(false);
    const n = (await alerts()).length;
    await spend("2000");
    expect(await alerts()).toHaveLength(n);
    expect((await ok(api("GET", "/me/personal/categories", { token: u.token }))).budgetAlerts).toBe(false);
  });
});
