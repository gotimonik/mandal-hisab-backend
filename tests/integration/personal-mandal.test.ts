import { beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { api, makePlatformAdmin, ok, registerAndLogin, uniq } from "../helpers/api";
import { cols } from "@/lib/collections";

/**
 * Personal Hisab copies the person's OWN Mandal money into their book (opt-in): hapta they pay
 * takes money out of their wallet, upad / withdrawals put it in, upad interest is spending — and
 * a reversal in the Mandal takes the entry away again. Other members' money never shows.
 *
 * The Mandal (savings type, ₹1,000 hapta): 5 members each pay July; the admin (also a member,
 * linked to their app account) takes ₹3,000 upad, pays ₹300 interest + ₹1,000 back, and later
 * withdraws ₹200 of savings.
 */

const JUL = "2026-07";

describe("Personal Hisab ⇄ my Mandal", () => {
  let orgId: string;
  let admin: { token: string; userId: string };
  let me: string; // the admin's member record
  let other: string;
  let myHapta: any;
  let cash: any, bank: any;
  const resync = (body: Record<string, unknown> = {}) => ok(api("PATCH", "/me/personal/mandal-sync", { token: admin.token, body: { enabled: true, ...body } }));
  const mandalEntries = async () => (await ok(api("GET", "/me/personal/entries?mandal=1&pageSize=200", { token: admin.token }))).items as any[];
  const walletBal = async (id: string) => ((await ok(api("GET", "/me/personal/wallets", { token: admin.token }))).wallets as any[]).find((w) => w._id === id).balancePaise;

  beforeAll(async () => {
    admin = await registerAndLogin("Sync Admin");
    const org = await ok(api("POST", "/organizations", { token: admin.token, body: { name: "Sync Mandal", monthlyHaptaAmount: "1000", haptaStartMonth: JUL } }));
    orgId = org.id;
    if (org.status === "pending") {
      const pa = await registerAndLogin("Platform Admin");
      await makePlatformAdmin(pa.userId);
      await ok(api("PATCH", `/platform/organizations/${orgId}`, { token: pa.token, body: { action: "approve" } }));
    }
    const list = await ok(api("GET", `/orgs/${orgId}/members`, { token: admin.token }));
    me = list.items[0]._id;
    const others: string[] = [];
    for (const n of ["Bhavna", "Chetan", "Daksha", "Esha"]) others.push((await ok(api("POST", `/orgs/${orgId}/members`, { token: admin.token, body: { name: `${n} Saver`, joiningDate: "2026-07-01" } })))._id);
    other = others[0];
    const jul = await ok(api("GET", `/orgs/${orgId}/monthly?month=${JUL}`, { token: admin.token }));
    for (const r of jul.rows) {
      const p = await ok(api("POST", `/orgs/${orgId}/monthly/collect`, { token: admin.token, body: { installmentId: r.installmentId, amount: "1000", date: "2026-07-05", idempotencyKey: uniq("c") } }));
      if (r.memberId === me) myHapta = p;
    }
    const w = (await ok(api("GET", "/me/personal/wallets", { token: admin.token }))).wallets;
    [cash, bank] = w;
  });

  it("is off until turned on, and shows which Mandals it can copy", async () => {
    expect(await mandalEntries()).toEqual([]);
    const s = await ok(api("GET", "/me/personal/mandal-sync", { token: admin.token }));
    expect(s).toMatchObject({ enabled: false, mandals: [{ name: "Sync Mandal", supported: true, entries: 0 }] });
  });

  it("my hapta takes money out of my wallet (into my own savings: not spending)", async () => {
    const s = await resync({ fromDate: "2026-07-01", walletId: bank._id });
    expect(s.enabled).toBe(true);
    const e = await mandalEntries();
    expect(e).toHaveLength(1); // only MY hapta, not the other members'
    expect(e[0]).toMatchObject({ type: "out", amountPaise: 100_000, date: "2026-07-05", wallet: { _id: bank._id }, mandal: { name: "Sync Mandal", kind: "hapta_collection", part: "main" } });
    expect(await walletBal(bank._id)).toBe(-100_000);
    // not in spending totals
    const sum = await ok(api("GET", "/me/personal/summary?from=2026-07-01&to=2026-07-31", { token: admin.token }));
    expect(sum.totals).toEqual({ incomePaise: 0, expensePaise: 0, netPaise: 0 });
  });

  it("upad in; interest is spending, what I repay (and my share of the interest) only moves", async () => {
    const loan = (await ok(api("POST", `/orgs/${orgId}/fund-loans`, { token: admin.token, body: { memberId: me, amount: "3000", date: "2026-07-20", monthlyRate: "10", idempotencyKey: uniq("fl") } }))).loan;
    await ok(api("POST", `/orgs/${orgId}/fund-loans/${loan._id}/payments`, { token: admin.token, body: { interestAmount: "300", principalAmount: "1000", date: "2026-08-15", idempotencyKey: uniq("flp") } }));
    await resync();
    const e = await mandalEntries();
    const got = (kind: string, part: string) => e.find((x) => x.mandal.kind === kind && x.mandal.part === part);
    expect(got("fund_loan_given", "main")).toMatchObject({ type: "in", amountPaise: 300_000, date: "2026-07-20" });
    // ₹300 interest is shared by the 5 equal savers: ₹60 comes back into my own savings
    expect(got("fund_loan_payment", "main")).toMatchObject({ type: "out", amountPaise: 106_000 });
    expect(got("fund_loan_payment", "spend")).toMatchObject({ type: "expense", amountPaise: 24_000, category: { key: "loan" } });
    expect(await walletBal(bank._id)).toBe(-100_000 + 300_000 - 130_000);
    const aug = await ok(api("GET", "/me/personal/summary?from=2026-08-01&to=2026-08-31", { token: admin.token }));
    expect(aug.totals.expensePaise).toBe(24_000);
  });

  it("a withdrawal of my savings puts money in (not income)", async () => {
    await ok(api("POST", `/orgs/${orgId}/withdrawals`, { token: admin.token, body: { memberId: me, amount: "200", date: "2026-09-15", idempotencyKey: uniq("w") } }));
    await resync();
    const w = (await mandalEntries()).find((x) => x.mandal.kind === "withdrawal");
    expect(w).toMatchObject({ type: "in", amountPaise: 20_000 });
    const list = await ok(api("GET", "/me/personal/entries?mandal=1", { token: admin.token }));
    expect(list.totals).toMatchObject({ incomePaise: 0, inPaise: 320_000, outPaise: 206_000, expensePaise: 24_000 });
  });

  it("the wallet and note are mine to change; the rest follows the Mandal", async () => {
    const hapta = (await mandalEntries()).find((x) => x.mandal.kind === "hapta_collection");
    const moved = await ok(api("PATCH", `/me/personal/entries/${hapta._id}`, { token: admin.token, body: { walletId: cash._id, note: "Paid in cash at the meeting" } }));
    expect(moved.entry).toMatchObject({ wallet: { _id: cash._id }, note: "Paid in cash at the meeting", amountPaise: 100_000 });
    expect((await api("PATCH", `/me/personal/entries/${hapta._id}`, { token: admin.token, body: { type: "income", amount: "5", date: "2026-07-05", walletId: cash._id, categoryId: null, note: "Paid in cash at the meeting" } })).status).toBe(200); // the rest is ignored
    expect((await ok(api("GET", `/me/personal/entries?mandal=1&type=out`, { token: admin.token }))).items.find((x: any) => x._id === hapta._id)).toMatchObject({ type: "out", amountPaise: 100_000 });
    expect((await api("DELETE", `/me/personal/entries/${hapta._id}`, { token: admin.token })).error?.message).toMatch(/comes from your Mandal/);
    // a later sync keeps my wallet and note
    await resync();
    expect((await mandalEntries()).find((x) => x._id === hapta._id)).toMatchObject({ wallet: { _id: cash._id }, note: "Paid in cash at the meeting" });
  });

  it("reversed in the Mandal → gone from my book", async () => {
    await ok(api("POST", `/orgs/${orgId}/payments/${myHapta.payment._id}/reverse`, { token: admin.token, body: { reason: "Entered for the wrong month" } }));
    await resync();
    expect((await mandalEntries()).some((x) => x.mandal.kind === "hapta_collection")).toBe(false);
    expect(await walletBal(cash._id)).toBe(0);
  });

  it("syncs by itself when the book is opened (and not more than once in a few seconds)", async () => {
    await ok(api("POST", `/orgs/${orgId}/fund-loans`, { token: admin.token, body: { memberId: me, amount: "100", date: "2026-09-20", monthlyRate: "2", idempotencyKey: uniq("fl") } }));
    const c = await cols();
    await c.users.updateOne({ _id: new ObjectId(admin.userId) }, { $set: { personalMandalSyncedAt: null } });
    await ok(api("GET", "/me/personal/overview", { token: admin.token }));
    expect((await mandalEntries()).filter((x) => x.mandal.kind === "fund_loan_given")).toHaveLength(2);
  });

  it("only from the start date; other members' money never; off keeps what's there", async () => {
    await resync({ fromDate: "2026-08-01" });
    const e = await mandalEntries();
    expect(e.some((x) => x.date < "2026-08-01")).toBe(false);
    // another person (the other member isn't even linked to an app account) sees nothing
    const stranger = await registerAndLogin("Stranger");
    await ok(api("PATCH", "/me/personal/mandal-sync", { token: stranger.token, body: { enabled: true, fromDate: "2026-07-01" } }));
    expect((await ok(api("GET", "/me/personal/entries?mandal=1", { token: stranger.token }))).items).toEqual([]);
    expect((await ok(api("GET", "/me/personal/mandal-sync", { token: stranger.token }))).mandals).toEqual([]);
    // turning it off keeps the entries but stops copying
    const off = await ok(api("PATCH", "/me/personal/mandal-sync", { token: admin.token, body: { enabled: false } }));
    expect(off.enabled).toBe(false);
    await ok(api("POST", `/orgs/${orgId}/fund-loans`, { token: admin.token, body: { memberId: me, amount: "50", date: "2026-09-25", monthlyRate: "2", idempotencyKey: uniq("fl") } }));
    const c = await cols();
    await c.users.updateOne({ _id: new ObjectId(admin.userId) }, { $set: { personalMandalSyncedAt: null } });
    expect(await mandalEntries()).toHaveLength(e.length);
    expect(other).toBeTruthy();
  });

  it("checks the settings", async () => {
    expect((await api("PATCH", "/me/personal/mandal-sync", { token: admin.token, body: { enabled: true, fromDate: "2999-01-01" } })).status).toBe(400);
    const stranger = await registerAndLogin("Wallet Thief");
    expect((await api("PATCH", "/me/personal/mandal-sync", { token: stranger.token, body: { enabled: true, walletId: cash._id } })).status).toBe(404);
  });
});
