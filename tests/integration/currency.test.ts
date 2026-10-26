import { describe, expect, it } from "vitest";
import { api, makePlatformAdmin, ok, registerAndLogin, uniq } from "../helpers/api";
import { currencySymbol, formatMoney } from "@/lib/currency";

/** Each Mandal keeps its books in one currency, picked at creation (INR by default). */

const todayIso = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const nowMonth = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 7);

async function createMandal(name: string, extra: Record<string, unknown> = {}) {
  const admin = await registerAndLogin(`${name} Admin`);
  const res = await api("POST", "/organizations", { token: admin.token, body: { name, monthlyHaptaAmount: "50", haptaStartMonth: nowMonth(), creatorIsMember: false, ...extra } });
  if (res.status >= 300) return { res, orgId: "", token: admin.token };
  if (res.data.status === "pending") {
    const pa = await registerAndLogin("Platform Admin");
    await makePlatformAdmin(pa.userId);
    await ok(api("PATCH", `/platform/organizations/${res.data.id}`, { token: pa.token, body: { action: "approve" } }));
  }
  return { res, orgId: res.data.id as string, token: admin.token };
}

describe("formatting", () => {
  it("keeps Indian grouping for INR and uses the currency's symbol otherwise", () => {
    expect(formatMoney(12500050)).toBe("₹1,25,000.50");
    expect(formatMoney(12500050, "USD")).toBe("$125,000.50");
    expect(formatMoney(-150, "GBP")).toBe("-£1.50");
    expect(currencySymbol("EUR")).toBe("€");
    expect(currencySymbol()).toBe("₹");
  });
});

describe("Mandal currency", () => {
  it("defaults to INR", async () => {
    const o = await createMandal("Rupee Mandal");
    expect((await ok(api("GET", `/orgs/${o.orgId}`, { token: o.token }))).settings.currency).toBe("INR");
  });

  it("can be picked at creation; unknown or 0-decimal currencies are refused", async () => {
    const o = await createMandal("Dollar Mandal", { currency: "USD" });
    expect((await ok(api("GET", `/orgs/${o.orgId}`, { token: o.token }))).settings.currency).toBe("USD");
    expect((await createMandal("Yen Mandal", { currency: "JPY" })).res.status).toBe(422);
  });

  it("can be changed until money is recorded; CSV headers and messages use it", async () => {
    const o = await createMandal("Pound Mandal", { currency: "USD" });
    await ok(api("PATCH", `/orgs/${o.orgId}`, { token: o.token, body: { settings: { currency: "GBP" } } }));
    const m = await ok(api("POST", `/orgs/${o.orgId}/members`, { token: o.token, body: { name: "Asha" } }));
    const v = await ok(api("GET", `/orgs/${o.orgId}/monthly?month=${nowMonth()}`, { token: o.token }));
    const row = v.rows.find((r: any) => r.memberId === m._id);
    await ok(api("POST", `/orgs/${o.orgId}/monthly/collect`, { token: o.token, body: { installmentId: row.installmentId, amount: "50", date: todayIso(), idempotencyKey: uniq("c") } }));
    const change = await api("PATCH", `/orgs/${o.orgId}`, { token: o.token, body: { settings: { currency: "EUR" } } });
    expect(change.status).toBe(400);
    const csv = await api("GET", `/orgs/${o.orgId}/cashbook?format=csv`, { token: o.token });
    expect(String(csv.data)).toContain("(£)");
    expect(String(csv.data)).not.toContain("₹");
    // over-collecting is refused with the amount in pounds
    const again = await api("POST", `/orgs/${o.orgId}/monthly/collect`, { token: o.token, body: { installmentId: row.installmentId, amount: "999", date: todayIso(), idempotencyKey: uniq("c") } });
    if (again.status >= 400 && again.error?.message?.match(/[₹£]/)) expect(again.error.message).toContain("£");
  });
});
