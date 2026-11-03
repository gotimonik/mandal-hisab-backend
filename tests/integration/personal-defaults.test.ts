import { beforeAll, describe, expect, it } from "vitest";
import { api, ok, registerAndLogin } from "../helpers/api";

/** A default wallet and default spending / income categories, so a new entry needn't pick them every time. */

describe("Personal Hisab defaults", () => {
  let me: { token: string; userId: string };
  let other: { token: string; userId: string };
  let food: any, salary: any, bank: any, otherWallet: any;
  const get = async () => ({
    wallets: (await ok(api("GET", "/me/personal/wallets", { token: me.token }))).wallets,
    categories: (await ok(api("GET", "/me/personal/categories", { token: me.token }))).categories,
  });

  beforeAll(async () => {
    me = await registerAndLogin("Default Person");
    other = await registerAndLogin("Other Person");
    const b = await get();
    food = b.categories.find((k: any) => k.key === "food");
    salary = b.categories.find((k: any) => k.key === "salary");
    bank = b.wallets.find((w: any) => w.kind === "bank");
    otherWallet = (await ok(api("GET", "/me/personal/wallets", { token: other.token }))).wallets[0];
  });

  it("starts with none", async () => {
    const b = await get();
    expect(b.wallets.some((w: any) => w.isDefault)).toBe(false);
    expect(b.categories.some((k: any) => k.isDefault)).toBe(false);
  });

  it("sets the default wallet and categories", async () => {
    const res = await ok(api("PATCH", "/me/personal/settings", { token: me.token, body: { defaultWalletId: bank._id, defaultExpenseCategoryId: food._id, defaultIncomeCategoryId: salary._id } }));
    expect(res.defaults).toEqual({ walletId: bank._id, expenseCategoryId: food._id, incomeCategoryId: salary._id });
    const b = await get();
    expect(b.wallets.filter((w: any) => w.isDefault).map((w: any) => w._id)).toEqual([bank._id]);
    expect(b.categories.filter((k: any) => k.isDefault).map((k: any) => k._id).sort()).toEqual([food._id, salary._id].sort());
    // the budget settings are untouched
    expect(res.budgetAlerts).toBe(true);
  });

  it("checks they're mine and of the right kind", async () => {
    expect((await api("PATCH", "/me/personal/settings", { token: me.token, body: { defaultWalletId: otherWallet._id } })).status).toBe(404);
    expect((await api("PATCH", "/me/personal/settings", { token: me.token, body: { defaultExpenseCategoryId: salary._id } })).status).toBe(400);
    expect((await api("PATCH", "/me/personal/settings", { token: me.token, body: { defaultIncomeCategoryId: food._id } })).status).toBe(400);
  });

  it("changing one leaves the others; null clears it", async () => {
    const res = await ok(api("PATCH", "/me/personal/settings", { token: me.token, body: { defaultExpenseCategoryId: null } }));
    expect(res.defaults).toEqual({ walletId: bank._id, expenseCategoryId: null, incomeCategoryId: salary._id });
  });

  it("a hidden wallet stops being the default", async () => {
    await ok(api("DELETE", `/me/personal/wallets/${bank._id}`, { token: me.token }));
    const b = await get();
    expect(b.wallets.some((w: any) => w.isDefault)).toBe(false);
  });
});
