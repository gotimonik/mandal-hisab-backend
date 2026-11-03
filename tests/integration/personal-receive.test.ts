import { beforeAll, describe, expect, it } from "vitest";
import { api, ok, registerAndLogin } from "../helpers/api";
import { runPersonalReminders } from "@/services/personal-reminders.service";
import { cols } from "@/lib/collections";
import { ObjectId } from "mongodb";

/** "Rameshbhai said he'll give me ₹5,000 on the 10th" — a reminder to call and collect it. */

const ist = (s: string) => new Date(`${s}+05:30`);

describe("Personal Hisab: money to receive", () => {
  let me: { token: string; userId: string };
  let other: { token: string; userId: string };
  let otherIncome: any, home: any, cash: any;
  const pushes = async () => (await cols()).notifications.find({ userId: new ObjectId(me.userId), organizationId: null, type: "personal.collect" }).sort({ createdAt: 1 }).toArray();

  beforeAll(async () => {
    me = await registerAndLogin("Collector");
    other = await registerAndLogin("Not Me");
    const cats = (await ok(api("GET", "/me/personal/categories", { token: me.token }))).categories;
    otherIncome = cats.find((k: any) => k.key === "other_income");
    home = cats.find((k: any) => k.key === "home");
    cash = (await ok(api("GET", "/me/personal/wallets", { token: me.token }))).wallets[0];
  });

  it("needs an income category, not a spending one", async () => {
    const res = await api("POST", "/me/personal/reminders", { token: me.token, body: { kind: "receive", title: "Money lent", categoryId: home._id, repeat: "once", dueDate: "2027-11-10", time: "10:00", remindBeforeMinutes: 0 } });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.error)).toMatch(/income category/);
  });

  it("reminds me to call them, with their number", async () => {
    const { reminder } = await ok(
      api("POST", "/me/personal/reminders", { token: me.token, body: { kind: "receive", title: "Money lent for Diwali", person: "Rameshbhai", phone: "98250 12345", amount: "5000", categoryId: otherIncome._id, repeat: "once", dueDate: "2027-11-10", time: "10:00", remindBeforeMinutes: 0 } }),
    );
    expect(reminder).toMatchObject({ kind: "receive", person: "Rameshbhai", phone: "98250 12345", amountPaise: 500000 });
    await runPersonalReminders(ist("2027-11-10T10:00"));
    const [n] = await pushes();
    expect(n.title).toBe("Collect from Rameshbhai: Money lent for Diwali");
    expect(n.body).toMatch(/^Money lent for Diwali · ₹5,000(\.00)? — Rameshbhai said they'd give it today at 10:00 am\. Call: 98250 12345\.$/);
    // someone else can't see or touch it
    expect((await ok(api("GET", "/me/personal/reminders", { token: other.token }))).reminders).toHaveLength(0);
    expect((await api("POST", `/me/personal/reminders/${reminder._id}/later`, { token: other.token, body: { dueDate: "2027-11-12" } })).status).toBe(404);
    (me as any).rid = reminder._id;
  });

  it("'not yet' moves it to a new date and pushes again then", async () => {
    const id = (me as any).rid;
    const { reminder } = await ok(api("POST", `/me/personal/reminders/${id}/later`, { token: me.token, body: { dueDate: "2027-11-15", time: "18:00" } }));
    expect(reminder).toMatchObject({ dueDate: "2027-11-15", time: "18:00", notified: false, isActive: true });
    expect((await api("POST", `/me/personal/reminders/${id}/later`, { token: me.token, body: { dueDate: "2020-01-01" } })).status).toBe(400);
    await runPersonalReminders(ist("2027-11-15T18:00"));
    expect(await pushes()).toHaveLength(2);
  });

  it("part received: added as income, the rest stays due on a new date", async () => {
    const id = (me as any).rid;
    const body = { record: true, partial: true, amount: "2000", date: "2026-11-01", walletId: cash._id, nextDueDate: "2027-11-20" };
    const res = await ok(api("POST", `/me/personal/reminders/${id}/paid`, { token: me.token, body }));
    expect(res.entry).toMatchObject({ type: "income", amountPaise: 200000 });
    expect(res.entry.note).toBe("Money lent for Diwali · Rameshbhai");
    expect(res.reminder).toMatchObject({ amountPaise: 300000, dueDate: "2027-11-20", isActive: true });
    // a double tap (two taps at once) changes nothing
    const { reminder: back } = await ok(api("PATCH", `/me/personal/reminders/${id}`, { token: me.token, body: { kind: "receive", title: "Money lent for Diwali", person: "Rameshbhai", phone: "98250 12345", amount: "4000", categoryId: otherIncome._id, repeat: "once", dueDate: "2027-11-20", time: "18:00", remindBeforeMinutes: 0 } }));
    expect(back.amountPaise).toBe(400000);
    const twice = { ...body, amount: "1000", nextDueDate: "2027-11-25" };
    await Promise.all([api("POST", `/me/personal/reminders/${id}/paid`, { token: me.token, body: twice }), api("POST", `/me/personal/reminders/${id}/paid`, { token: me.token, body: twice })]);
    const again = (await ok(api("GET", "/me/personal/reminders", { token: me.token }))).reminders.find((r: any) => r._id === id);
    expect(again.amountPaise).toBe(300000);
    // the full amount isn't "part"
    expect((await api("POST", `/me/personal/reminders/${id}/paid`, { token: me.token, body: { ...body, amount: "3000" } })).status).toBe(400);
  });

  it("the rest received: added as income and the reminder is done", async () => {
    const id = (me as any).rid;
    const res = await ok(api("POST", `/me/personal/reminders/${id}/paid`, { token: me.token, body: { record: true, date: "2026-11-02", walletId: cash._id } }));
    expect(res.entry).toMatchObject({ type: "income", amountPaise: 300000 });
    expect(res.reminder).toMatchObject({ isActive: false, status: "done" });
    const c = await cols();
    expect(await c.personalEntries.countDocuments({ userId: new ObjectId(me.userId), type: "income", categoryId: new ObjectId(otherIncome._id) })).toBe(3);
  });
});
