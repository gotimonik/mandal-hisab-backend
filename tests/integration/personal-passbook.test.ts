import { beforeAll, describe, expect, it } from "vitest";
import { api, ok, registerAndLogin, uniq } from "../helpers/api";

/**
 * Personal Hisab passbook: a period's entries in date order with the balance after each one,
 * for all wallets together or one wallet — matching the wallets' own balances to the paisa.
 */

describe("Personal Hisab passbook", () => {
  let me: { token: string; userId: string };
  let cash: any, bank: any, food: any, salary: any;
  const add = (body: Record<string, unknown>) => ok(api("POST", "/me/personal/entries", { token: me.token, body: { idempotencyKey: uniq("pe"), ...body } }));
  const book = (q: string, headers: Record<string, string> = {}) => ok(api("GET", `/me/personal/passbook?${q}`, { token: me.token, headers }));

  beforeAll(async () => {
    me = await registerAndLogin("Passbook Person");
    const w = (await ok(api("GET", "/me/personal/wallets", { token: me.token }))).wallets;
    [cash, bank] = [w.find((x: any) => x.key === "cash"), w.find((x: any) => x.key === "bank")];
    await ok(api("PATCH", `/me/personal/wallets/${cash._id}`, { token: me.token, body: { openingBalance: "1000" } }));
    await ok(api("PATCH", `/me/personal/wallets/${bank._id}`, { token: me.token, body: { openingBalance: "5000" } }));
    const cats = (await ok(api("GET", "/me/personal/categories", { token: me.token }))).categories;
    [food, salary] = [cats.find((k: any) => k.key === "food"), cats.find((k: any) => k.key === "salary")];
    // before the period
    await add({ type: "income", amount: "2000", date: "2026-09-15", walletId: bank._id, categoryId: salary._id });
    await add({ type: "expense", amount: "300", date: "2026-09-20", walletId: cash._id, categoryId: food._id });
    // in the period (October)
    await add({ type: "expense", amount: "500", date: "2026-10-02", walletId: bank._id, categoryId: food._id, note: "Dinner" });
    await add({ type: "income", amount: "10000", date: "2026-10-05", walletId: bank._id, categoryId: salary._id, note: "October salary" });
    await add({ type: "transfer", amount: "1000", date: "2026-10-06", walletId: bank._id, toWalletId: cash._id, note: "ATM" });
    await add({ type: "expense", amount: "200", date: "2026-10-07", walletId: cash._id, categoryId: food._id, note: "Tea" });
    // after the period
    await add({ type: "expense", amount: "50", date: "2026-11-01", walletId: cash._id, categoryId: food._id });
  });

  it("all wallets together: opening, each entry with its balance, closing", async () => {
    const p = await book("from=2026-10-01&to=2026-10-31");
    expect(p.openingPaise).toBe(770000); // 1000 + 5000 + 2000 − 300
    expect(p.rows.map((r: any) => [r.note, r.inPaise, r.outPaise, r.balancePaise])).toEqual([
      ["Dinner", 0, 50000, 720000],
      ["October salary", 1000000, 0, 1720000],
      ["Tea", 0, 20000, 1700000],
    ]); // moving money between your own wallets doesn't change the total
    expect(p).toMatchObject({ closingPaise: 1700000, totalInPaise: 1000000, totalOutPaise: 70000, wallet: null, book: { name: "Personal", isMain: true }, person: "Passbook Person" });
    expect(p.spending).toEqual([{ category: expect.objectContaining({ key: "food" }), totalPaise: 70000 }]);
  });

  it("one wallet: money moved in and out of it counts", async () => {
    const b = await book(`from=2026-10-01&to=2026-10-31&walletId=${bank._id}`);
    expect(b.openingPaise).toBe(700000);
    expect(b.rows.map((r: any) => [r.note, r.inPaise, r.outPaise, r.balancePaise])).toEqual([
      ["Dinner", 0, 50000, 650000],
      ["October salary", 1000000, 0, 1650000],
      ["ATM", 0, 100000, 1550000],
    ]);
    const c = await book(`from=2026-10-01&to=2026-10-31&walletId=${cash._id}`);
    expect(c.openingPaise).toBe(70000);
    expect(c.rows.map((r: any) => [r.note, r.inPaise, r.outPaise, r.balancePaise])).toEqual([
      ["ATM", 100000, 0, 170000],
      ["Tea", 0, 20000, 150000],
    ]);
    expect(b.closingPaise + c.closingPaise).toBe(1700000);
  });

  it("up to today it ends on the same balance as the wallets", async () => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
    const p = await book(`from=2026-01-01&to=${today}`);
    const w = (await ok(api("GET", "/me/personal/wallets", { token: me.token }))).wallets;
    expect(p.closingPaise).toBe(w.reduce((a: number, x: any) => a + x.balancePaise, 0));
  });

  it("is per book, and checks its input", async () => {
    const office = (await ok(api("POST", "/me/personal/books", { token: me.token, body: { name: "Office" } }))).book._id;
    const p = await book("from=2026-10-01&to=2026-10-31", { "x-personal-book": office });
    expect(p).toMatchObject({ openingPaise: 0, closingPaise: 0, rows: [], book: { name: "Office", isMain: false } });
    expect((await api("GET", `/me/personal/passbook?from=2026-10-01&to=2026-10-31&walletId=${bank._id}`, { token: me.token, headers: { "x-personal-book": office } })).status).toBe(404);
    expect((await api("GET", "/me/personal/passbook?from=2026-11-01&to=2026-10-01", { token: me.token })).status).toBe(400);
  });
});
