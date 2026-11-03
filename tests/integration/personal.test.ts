import { beforeAll, describe, expect, it } from "vitest";
import { api, ok, registerAndLogin, setupOrg, uniq } from "../helpers/api";

/**
 * Personal Hisab: a person's own money book. Daily spending and income, wallets with balances,
 * categories with budgets, transfers — visible to that person only, never to a Mandal.
 */

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
const month = () => today().slice(0, 7);

describe("Personal Hisab", () => {
  let me: { token: string; userId: string };
  let other: { token: string; userId: string };
  let cash: any, bank: any, food: any, salary: any;
  const add = (token: string, body: Record<string, unknown>) => api("POST", "/me/personal/entries", { token, body: { date: today(), idempotencyKey: uniq("pe"), ...body } });

  beforeAll(async () => {
    me = await registerAndLogin("Personal Saver");
    other = await registerAndLogin("Someone Else");
  });

  it("first visit makes starter wallets and categories (once)", async () => {
    const [a, b] = await Promise.all([ok(api("GET", "/me/personal/wallets", { token: me.token })), ok(api("GET", "/me/personal/categories", { token: me.token }))]);
    expect(a.wallets.map((w: any) => w.key)).toEqual(["cash", "bank"]);
    expect(a.wallets.every((w: any) => w.balancePaise === 0)).toBe(true);
    expect(b.categories.filter((k: any) => k.kind === "expense").length).toBeGreaterThan(5);
    expect(b.categories.filter((k: any) => k.kind === "income").map((k: any) => k.key)).toContain("salary");
    // a second visit doesn't add them again
    const again = await ok(api("GET", "/me/personal/wallets", { token: me.token }));
    expect(again.wallets).toHaveLength(2);
    [cash, bank] = a.wallets;
    food = b.categories.find((k: any) => k.key === "food");
    salary = b.categories.find((k: any) => k.key === "salary");
  });

  it("income, spending and transfers move wallet balances", async () => {
    await ok(add(me.token, { type: "income", amount: "25000", walletId: bank._id, categoryId: salary._id, note: "October salary" }));
    await ok(add(me.token, { type: "transfer", amount: "2000", walletId: bank._id, toWalletId: cash._id, note: "ATM" }));
    await ok(add(me.token, { type: "expense", amount: "350.50", walletId: cash._id, categoryId: food._id, note: "Dinner" }));
    const { wallets } = await ok(api("GET", "/me/personal/wallets", { token: me.token }));
    expect(wallets.find((w: any) => w._id === bank._id).balancePaise).toBe(2_300_000);
    expect(wallets.find((w: any) => w._id === cash._id).balancePaise).toBe(164_950);

    const o = await ok(api("GET", "/me/personal/overview", { token: me.token }));
    expect(o.month).toBe(month());
    expect(o.totalBalancePaise).toBe(2_464_950);
    expect(o.monthTotals).toMatchObject({ incomePaise: 2_500_000, expensePaise: 35_050, netPaise: 2_464_950 });
    expect(o.todayTotals).toEqual({ incomePaise: 2_500_000, expensePaise: 35_050 });
    expect(o.spending[0]).toMatchObject({ totalPaise: 35_050, count: 1, category: { key: "food" } });
    expect(o.days.find((d: any) => d.date === today())).toMatchObject({ incomePaise: 2_500_000, expensePaise: 35_050 });
    expect(o.recent[0].note).toBe("Dinner");
  });

  it("a double tap saves once (idempotency key)", async () => {
    const key = uniq("pe");
    const one = await ok(add(me.token, { type: "expense", amount: "40", walletId: cash._id, categoryId: food._id, idempotencyKey: key }));
    const two = await ok(add(me.token, { type: "expense", amount: "40", walletId: cash._id, categoryId: food._id, idempotencyKey: key }));
    expect(two.duplicate).toBe(true);
    expect(two.entry._id).toBe(one.entry._id);
    await ok(api("DELETE", `/me/personal/entries/${one.entry._id}`, { token: me.token }));
  });

  it("checks what an entry needs", async () => {
    expect((await add(me.token, { type: "expense", amount: "10", walletId: cash._id })).error?.message).toBe("Choose a category");
    expect((await add(me.token, { type: "expense", amount: "10", walletId: cash._id, categoryId: salary._id })).error?.message).toBe("Choose a spending category");
    expect((await add(me.token, { type: "transfer", amount: "10", walletId: cash._id, toWalletId: cash._id })).error?.message).toBe("Choose two different wallets");
    expect((await add(me.token, { type: "transfer", amount: "10", walletId: cash._id })).error?.message).toBe("Choose the wallet the money goes to");
    expect((await add(me.token, { type: "expense", amount: "0", walletId: cash._id, categoryId: food._id })).status).toBe(422);
  });

  it("entries can be edited, listed with filters, searched and deleted", async () => {
    const { entry } = await ok(add(me.token, { type: "expense", amount: "120", walletId: cash._id, categoryId: food._id, note: "Chai and nasto" }));
    const moved = await ok(api("PATCH", `/me/personal/entries/${entry._id}`, { token: me.token, body: { type: "expense", amount: "150", date: today(), walletId: bank._id, categoryId: food._id } }));
    expect(moved.entry).toMatchObject({ amountPaise: 15_000, wallet: { _id: bank._id }, note: null });

    const list = await ok(api("GET", `/me/personal/entries?type=expense&walletId=${bank._id}`, { token: me.token }));
    expect(list.items.map((i: any) => i._id)).toEqual([entry._id]);
    expect(list.totals.expensePaise).toBe(15_000);
    // a wallet filter also finds transfers INTO that wallet
    const intoCash = await ok(api("GET", `/me/personal/entries?type=transfer&walletId=${cash._id}`, { token: me.token }));
    expect(intoCash.items).toHaveLength(1);
    const found = await ok(api("GET", `/me/personal/entries?q=${encodeURIComponent("salary")}`, { token: me.token }));
    expect(found.items.map((i: any) => i.note)).toEqual(["October salary"]);
    // a regex character in the search is just text
    expect((await ok(api("GET", `/me/personal/entries?q=${encodeURIComponent("(")}`, { token: me.token }))).items).toHaveLength(0);

    await ok(api("DELETE", `/me/personal/entries/${entry._id}`, { token: me.token }));
    expect((await api("DELETE", `/me/personal/entries/${entry._id}`, { token: me.token })).status).toBe(404);
  });

  it("budgets: per category and overall", async () => {
    await ok(api("PATCH", `/me/personal/categories/${food._id}`, { token: me.token, body: { monthlyBudget: "300" } }));
    await ok(api("PATCH", "/me/personal/settings", { token: me.token, body: { monthlyBudget: "10000" } }));
    const o = await ok(api("GET", "/me/personal/overview", { token: me.token }));
    expect(o.budgets).toEqual([expect.objectContaining({ budgetPaise: 30_000, spentPaise: 35_050 })]);
    expect(o.overallBudget).toEqual({ budgetPaise: 1_000_000, spentPaise: 35_050 });
    expect((await api("PATCH", `/me/personal/categories/${salary._id}`, { token: me.token, body: { monthlyBudget: "100" } })).status).toBe(400);
    // 0 removes it
    await ok(api("PATCH", `/me/personal/categories/${food._id}`, { token: me.token, body: { monthlyBudget: "0" } }));
    expect((await ok(api("GET", "/me/personal/overview", { token: me.token }))).budgets).toEqual([]);
  });

  it("own wallets and categories; used ones are hidden, not deleted", async () => {
    const { wallet } = await ok(api("POST", "/me/personal/wallets", { token: me.token, body: { name: "Paytm", kind: "upi", openingBalance: "500" } }));
    expect((await api("POST", "/me/personal/wallets", { token: me.token, body: { name: "paytm" } })).status).toBe(409);
    const { category } = await ok(api("POST", "/me/personal/categories", { token: me.token, body: { kind: "expense", name: "Pet care", tone: "amber" } }));
    await ok(add(me.token, { type: "expense", amount: "200", walletId: wallet._id, categoryId: category._id }));

    // renaming a starter category drops its translation key
    const renamed = await ok(api("PATCH", `/me/personal/categories/${food._id}`, { token: me.token, body: { name: "Khavanu" } }));
    expect(renamed.category).toMatchObject({ name: "Khavanu", key: null });

    expect(await ok(api("DELETE", `/me/personal/categories/${category._id}`, { token: me.token }))).toEqual({ deleted: false, archived: true });
    expect(await ok(api("DELETE", `/me/personal/wallets/${wallet._id}`, { token: me.token }))).toEqual({ deleted: false, archived: true });
    // a hidden wallet can't be picked for a new entry
    expect((await add(me.token, { type: "expense", amount: "1", walletId: wallet._id, categoryId: food._id })).error?.message).toMatch(/is hidden/);
    // an unused one is really deleted
    const { wallet: spare } = await ok(api("POST", "/me/personal/wallets", { token: me.token, body: { name: "Spare" } }));
    expect(await ok(api("DELETE", `/me/personal/wallets/${spare._id}`, { token: me.token }))).toEqual({ deleted: true, archived: false });
    // the hidden wallet still counts in the total while it holds money
    const o = await ok(api("GET", "/me/personal/overview", { token: me.token }));
    expect(o.wallets.find((w: any) => w._id === wallet._id)).toMatchObject({ isArchived: true, balancePaise: 30_000 });
  });

  it("keeps at least one wallet", async () => {
    const u = await registerAndLogin("One Wallet");
    const { wallets } = await ok(api("GET", "/me/personal/wallets", { token: u.token }));
    await ok(api("PATCH", `/me/personal/wallets/${wallets[1]._id}`, { token: u.token, body: { isArchived: true } }));
    expect((await api("PATCH", `/me/personal/wallets/${wallets[0]._id}`, { token: u.token, body: { isArchived: true } })).error?.message).toBe("Keep at least one wallet");
    expect((await api("DELETE", `/me/personal/wallets/${wallets[0]._id}`, { token: u.token })).status).toBe(400);
  });

  it("categories have icons: starters come with one, own ones pick theirs", async () => {
    const { categories } = await ok(api("GET", "/me/personal/categories", { token: me.token }));
    expect(categories.find((k: any) => k.key === "groceries").icon).toBe("shopping-cart");
    const { category } = await ok(api("POST", "/me/personal/categories", { token: me.token, body: { kind: "expense", name: "Petrol pump", tone: "sky", icon: "fuel" } }));
    expect(category.icon).toBe("fuel");
    const changed = await ok(api("PATCH", `/me/personal/categories/${category._id}`, { token: me.token, body: { icon: "car" } }));
    expect(changed.category.icon).toBe("car");
    expect((await api("PATCH", `/me/personal/categories/${category._id}`, { token: me.token, body: { icon: "<script>" } })).status).toBe(422);
    // no icon chosen: null (the app suggests one from the name)
    expect((await ok(api("POST", "/me/personal/categories", { token: me.token, body: { kind: "income", name: "Rent received" } }))).category.icon).toBeNull();
  });

  it("summary for one category or one wallet", async () => {
    const s = await ok(api("GET", `/me/personal/summary?from=${month()}-01&to=${today()}&categoryId=${salary._id}`, { token: me.token }));
    expect(s.totals).toEqual({ incomePaise: 2_500_000, expensePaise: 0, netPaise: 2_500_000 });
    expect(s.spending).toEqual([]);
    const w = await ok(api("GET", `/me/personal/summary?from=${month()}-01&to=${today()}&walletId=${cash._id}`, { token: me.token }));
    expect(w.totals.incomePaise).toBe(0);
    expect(w.totals.expensePaise).toBe(35_050);
  });

  it("summary for any range, month by month", async () => {
    const s = await ok(api("GET", `/me/personal/summary?from=${month()}-01&to=${today()}`, { token: me.token }));
    expect(s.totals.incomePaise).toBe(2_500_000);
    expect(s.months).toEqual([{ month: month(), incomePaise: 2_500_000, expensePaise: s.totals.expensePaise, netPaise: s.totals.netPaise }]);
    expect(s.income[0].category.key).toBe("salary");
    expect((await api("GET", `/me/personal/summary?from=${today()}&to=2020-01-01`, { token: me.token })).status).toBe(400);
  });

  it("CSV download of the entries", async () => {
    const r = await api("GET", "/me/personal/entries?format=csv", { token: me.token });
    expect(r.status).toBe(200);
    expect(String(r.data)).toContain("Date,Type,Category,Wallet,To wallet,Note,Money in,Money out");
    expect(String(r.data)).toContain("October salary");
  });

  it("is private: nobody else can see or change it", async () => {
    const mine = (await ok(api("GET", "/me/personal/entries", { token: me.token }))).items[0];
    // another person sees only their own (empty) book
    const theirs = await ok(api("GET", "/me/personal/entries", { token: other.token }));
    expect(theirs.total).toBe(0);
    expect((await ok(api("GET", "/me/personal/overview", { token: other.token }))).totalBalancePaise).toBe(0);
    // and gets "not found" for my things
    expect((await api("PATCH", `/me/personal/entries/${mine._id}`, { token: other.token, body: { type: "expense", amount: "1", date: today(), walletId: cash._id, categoryId: food._id } })).status).toBe(404);
    expect((await api("DELETE", `/me/personal/entries/${mine._id}`, { token: other.token })).status).toBe(404);
    expect((await api("PATCH", `/me/personal/wallets/${cash._id}`, { token: other.token, body: { name: "Mine now" } })).status).toBe(404);
    expect((await api("DELETE", `/me/personal/categories/${food._id}`, { token: other.token })).status).toBe(404);
    // they can't use my wallet or category in their own entries either
    const theirCats = (await ok(api("GET", "/me/personal/categories", { token: other.token }))).categories;
    expect((await add(other.token, { type: "expense", amount: "1", walletId: cash._id, categoryId: theirCats[0]._id })).status).toBe(404);
    // signed out: nothing
    expect((await api("GET", "/me/personal/overview")).status).toBe(401);
  });

  it("stays out of the Mandal: not in its backup, not reachable by its admin", async () => {
    const o = await setupOrg("Personal Privacy Mandal");
    await ok(add(o.admin.token, { type: "expense", amount: "99", walletId: (await ok(api("GET", "/me/personal/wallets", { token: o.admin.token }))).wallets[0]._id, categoryId: (await ok(api("GET", "/me/personal/categories", { token: o.admin.token }))).categories[0]._id, note: "admin's own chai" }));
    const { readBackup } = await import("@/services/backup.service");
    const { createApiHandler } = await import("@/lib/http");
    const { buildRouter } = await import("@/routes");
    const { NextRequest } = await import("next/server");
    const res = await createApiHandler(buildRouter(), "/api/v1")(new NextRequest(`http://localhost/api/v1/orgs/${o.orgId}/backup`, { headers: { authorization: `Bearer ${o.admin.token}` } }));
    expect(res.status).toBe(200);
    const file = readBackup(await res.text());
    expect(Object.keys(file.data).some((k) => k.startsWith("personal"))).toBe(false);
    expect(JSON.stringify(file.data)).not.toContain("admin's own chai");
  });
});
