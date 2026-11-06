import { beforeAll, describe, expect, it } from "vitest";
import { addUser, api, ok, registerAndLogin, setupOrg, uniq } from "../helpers/api";

/**
 * UPI in a Mandal: off until an admin adds the Mandal's UPI account and turns it on. Members then
 * pay that UPI ID from any UPI app and report it with the 12-digit UTR; an admin verifies it.
 * Personal Hisab: a UPI wallet can say which app it is.
 */

type Ctx = Awaited<ReturnType<typeof setupOrg>>;

describe("UPI payments", () => {
  let o: Ctx;
  let upiAccountId: string;
  let member: { token: string };

  const request = (body: Record<string, unknown>, token = member.token) =>
    api("POST", `/orgs/${o.orgId}/me/payment-requests`, { token, body: { purpose: "other", notes: "Navratri donation", amount: "500", date: "2026-04-11", method: "upi", idempotencyKey: uniq("req"), ...body } });

  beforeAll(async () => {
    o = await setupOrg("UPI Mandal");
    const m = await ok(api("POST", `/orgs/${o.orgId}/members`, { token: o.admin.token, body: { name: `Member ${uniq()}` } }));
    member = await addUser(o.orgId, o.code, o.admin.token, "member", m._id);
  });

  it("is off by default", async () => {
    const org = await ok(api("GET", `/orgs/${o.orgId}`, { token: o.admin.token }));
    expect(org.settings.paymentMethods).toEqual(["cash"]);
    expect(org.settings.upi).toEqual({ enabled: false, accountId: null });
    expect((await ok(api("GET", `/orgs/${o.orgId}/me/payment-options`, { token: member.token }))).upi).toBeNull();
    const r = await request({ reference: "412345678901" });
    expect(r.status).toBe(400);
    expect(r.error?.message).toMatch(/UPI is not turned on/);
  });

  it("adds a UPI account with a valid UPI ID", async () => {
    expect((await api("POST", `/orgs/${o.orgId}/accounts`, { token: o.admin.token, body: { name: "UPI", type: "upi" } })).status).toBe(422);
    expect((await api("POST", `/orgs/${o.orgId}/accounts`, { token: o.admin.token, body: { name: "UPI", type: "upi", upiId: "not a upi id" } })).status).toBe(422);
    // bank accounts are still not offered
    expect((await api("POST", `/orgs/${o.orgId}/accounts`, { token: o.admin.token, body: { name: "SBI", type: "bank" } })).status).toBe(422);
    const acc = await ok(api("POST", `/orgs/${o.orgId}/accounts`, { token: o.admin.token, body: { name: "Mandal UPI", type: "upi", upiId: " UpiMandal@OkAxis " } }));
    expect(acc).toMatchObject({ type: "upi", upiId: "upimandal@okaxis" });
    const list = await ok<any[]>(api("GET", `/orgs/${o.orgId}/accounts`, { token: o.admin.token }));
    const upi = list.find((a) => a.name === "Mandal UPI");
    expect(upi).toMatchObject({ type: "upi", upiId: "upimandal@okaxis" });
    upiAccountId = upi._id;
    // a cash account can't be given a UPI ID
    expect((await api("PATCH", `/orgs/${o.orgId}/accounts/${o.cashAccountId}`, { token: o.admin.token, body: { upiId: "mandal@okaxis" } })).status).toBe(400);
  });

  it("turns on only with a UPI account to pay into", async () => {
    expect((await api("PATCH", `/orgs/${o.orgId}`, { token: o.admin.token, body: { settings: { upi: { enabled: true, accountId: null } } } })).status).toBe(400);
    expect((await api("PATCH", `/orgs/${o.orgId}`, { token: o.admin.token, body: { settings: { upi: { enabled: true, accountId: o.cashAccountId } } } })).status).toBe(400);
    expect((await api("PATCH", `/orgs/${o.orgId}`, { token: member.token, body: { settings: { upi: { enabled: true, accountId: upiAccountId } } } })).status).toBe(403);
    const org = await ok(api("PATCH", `/orgs/${o.orgId}`, { token: o.admin.token, body: { settings: { upi: { enabled: true, accountId: upiAccountId } } } }));
    expect(org.settings.paymentMethods).toEqual(["cash", "upi"]);
    expect(org.settings.upi).toEqual({ enabled: true, accountId: upiAccountId });
    const opts = await ok(api("GET", `/orgs/${o.orgId}/me/payment-options`, { token: member.token }));
    expect(opts.methods).toEqual(["cash", "upi"]);
    expect(opts.upi).toEqual({ upiId: "upimandal@okaxis", payeeName: "UPI Mandal" });
  });

  it("members report a UPI payment with its UTR; the same UTR can't be used twice", async () => {
    expect((await request({})).status).toBe(400);
    expect((await request({ reference: "12345" })).status).toBe(400);
    const r = await ok(request({ reference: "4123 4567 8901" }));
    expect(r.payment).toMatchObject({ status: "pending", method: "upi", reference: "412345678901", accountId: upiAccountId });
    const again = await request({ reference: "412345678901" });
    expect(again.status).toBe(409);
    expect(again.error?.message).toMatch(/waiting to be verified/);
    // staff entering the same UPI payment again are stopped too
    const members = await ok(api("GET", `/orgs/${o.orgId}/members?pageSize=5`, { token: o.admin.token }));
    const staff = await api("POST", `/orgs/${o.orgId}/payments`, {
      token: o.admin.token,
      body: { kind: "other_income", memberId: members.items[0]._id, amount: "500", date: "2026-04-11", method: "upi", reference: "412345678901", accountId: upiAccountId, idempotencyKey: uniq("pay") },
    });
    expect(staff.status).toBe(409);
    // verified into the UPI account without choosing it again
    await ok(api("POST", `/orgs/${o.orgId}/payments/${r.payment._id}/verify`, { token: o.admin.token, body: {} }));
    const accounts = await ok<any[]>(api("GET", `/orgs/${o.orgId}/accounts`, { token: o.admin.token }));
    expect(accounts.find((a) => a._id === upiAccountId).balancePaise).toBe(50000);
    expect((await request({ reference: "412345678901" })).error?.message).toMatch(/already been recorded/);
  });

  it("the UPI account members pay into can't be switched off while UPI is on", async () => {
    expect((await api("PATCH", `/orgs/${o.orgId}/accounts/${upiAccountId}`, { token: o.admin.token, body: { isActive: false } })).status).toBe(400);
    await ok(api("PATCH", `/orgs/${o.orgId}`, { token: o.admin.token, body: { settings: { upi: { enabled: false, accountId: upiAccountId } } } }));
    expect((await ok(api("GET", `/orgs/${o.orgId}`, { token: o.admin.token }))).settings.paymentMethods).toEqual(["cash"]);
    expect((await request({ reference: "512345678901" })).status).toBe(400);
  });
});

describe("Personal Hisab UPI wallets", () => {
  it("remember which UPI app they are", async () => {
    const me = await registerAndLogin("Wallet Owner");
    const { wallet } = await ok(api("POST", "/me/personal/wallets", { token: me.token, body: { name: "PhonePe", kind: "upi", upiApp: "phonepe" } }));
    expect(wallet).toMatchObject({ kind: "upi", upiApp: "phonepe" });
    expect((await api("POST", "/me/personal/wallets", { token: me.token, body: { name: "Bad", kind: "upi", upiApp: "venmo" } })).status).toBe(422);
    const gpay = await ok(api("PATCH", `/me/personal/wallets/${wallet._id}`, { token: me.token, body: { name: "GPay", upiApp: "gpay" } }));
    expect(gpay.wallet.upiApp).toBe("gpay");
    // not a UPI wallet any more → no app
    const cash = await ok(api("PATCH", `/me/personal/wallets/${wallet._id}`, { token: me.token, body: { kind: "cash" } }));
    expect(cash.wallet).toMatchObject({ kind: "cash", upiApp: null });
    // a cash wallet ignores an app
    const { wallet: w2 } = await ok(api("POST", "/me/personal/wallets", { token: me.token, body: { name: "Purse", kind: "cash", upiApp: "paytm" } }));
    expect(w2.upiApp).toBeNull();
  });
});
