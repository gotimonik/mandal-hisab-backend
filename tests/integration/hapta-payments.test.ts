import { beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { addUser, api, ok, setupOrg, uniq } from "../helpers/api";
import { cols } from "@/lib/collections";

type Ctx = Awaited<ReturnType<typeof setupOrg>>;

async function ledgerTotals(orgId: string) {
  const c = await cols();
  const [r] = await c.ledgerEntries
    .aggregate<{ d: number; c: number }>([{ $match: { organizationId: new ObjectId(orgId) } }, { $group: { _id: null, d: { $sum: "$debitPaise" }, c: { $sum: "$creditPaise" } } }])
    .toArray();
  return r ?? { d: 0, c: 0 };
}

async function balance(orgId: string, key: string) {
  const c = await cols();
  const [r] = await c.ledgerEntries
    .aggregate<{ d: number; c: number }>([{ $match: { organizationId: new ObjectId(orgId), accountKey: key } }, { $group: { _id: null, d: { $sum: "$debitPaise" }, c: { $sum: "$creditPaise" } } }])
    .toArray();
  return r ? r.d - r.c : 0;
}

async function memberWithScheme(o: Ctx, amount = "1000", extra: Record<string, unknown> = {}) {
  const member = await ok(api("POST", `/orgs/${o.orgId}/members`, { token: o.admin.token, body: { name: `Member ${uniq()}` } }));
  const scheme = await ok(
    api("POST", `/orgs/${o.orgId}/schemes`, {
      token: o.admin.token,
      body: { name: `Monthly ${uniq()}`, startDate: "2026-04-01", frequency: "monthly", dueDay: 10, amount, numberOfInstallments: 12, ...extra },
    }),
  );
  const enr = await ok(api("POST", `/orgs/${o.orgId}/schemes/${scheme._id}/enroll`, { token: o.admin.token, body: { members: [{ memberId: member._id }] } }));
  return { member, scheme, enr };
}

const insts = (o: Ctx, memberId: string) =>
  ok(api("GET", `/orgs/${o.orgId}/installments?memberId=${memberId}&pageSize=100`, { token: o.admin.token })).then((r) => r.items as any[]);

const pay = (o: Ctx, token: string, memberId: string, amount: string, key = uniq("pay"), extra: Record<string, unknown> = {}) =>
  api("POST", `/orgs/${o.orgId}/payments`, {
    token,
    body: { kind: "hapta", memberId, amount, date: "2026-04-12", method: "cash", accountId: o.cashAccountId, idempotencyKey: key, ...extra },
  });

describe("hapta schemes & installments", () => {
  let o: Ctx;
  beforeAll(async () => {
    o = await setupOrg();
  });

  it("monthly scheme generates 12 installments of ₹1,000 and re-generation never duplicates", async () => {
    const { member, scheme, enr } = await memberWithScheme(o);
    expect(enr.installmentsCreated).toBe(12);
    const again = await ok(api("POST", `/orgs/${o.orgId}/schemes/${scheme._id}/generate`, { token: o.admin.token, body: {} }));
    expect(again.installmentsCreated).toBe(0);
    const list = await insts(o, member._id);
    expect(list).toHaveLength(12);
    expect(list.every((i) => i.amountPaise === 100000)).toBe(true);
    expect(list[0].dueDate.slice(0, 10)).toBe("2026-04-10");
    expect(list[11].dueDate.slice(0, 10)).toBe("2027-03-10");
    // enrolling again is a no-op
    const re = await ok(api("POST", `/orgs/${o.orgId}/schemes/${scheme._id}/enroll`, { token: o.admin.token, body: { members: [{ memberId: member._id }] } }));
    expect(re.enrolled).toBe(0);
  });

  it("₹3,000 every three months creates quarterly obligations", async () => {
    const { member } = await memberWithScheme(o, "3000", { frequency: "every_three_months", numberOfInstallments: 4 });
    const list = await insts(o, member._id);
    expect(list.map((i) => i.dueDate.slice(0, 10))).toEqual(["2026-04-10", "2026-07-10", "2026-10-10", "2027-01-10"]);
  });

  it("changes one month's due date scheme-wide and per-installment without touching others", async () => {
    const { member, scheme } = await memberWithScheme(o);
    await ok(api("POST", `/orgs/${o.orgId}/schemes/${scheme._id}/overrides`, { token: o.admin.token, body: { sequence: 7, dueDate: "2026-10-25", reason: "Navratri" } }));
    let list = await insts(o, member._id);
    expect(list.find((i) => i.sequence === 7).dueDate.slice(0, 10)).toBe("2026-10-25");
    expect(list.find((i) => i.sequence === 8).dueDate.slice(0, 10)).toBe("2026-11-10");
    const target = list.find((i) => i.sequence === 9);
    await ok(api("PATCH", `/orgs/${o.orgId}/installments/${target._id}`, { token: o.admin.token, body: { action: "set_due_date", dueDate: "2026-12-20", reason: "Member request" } }));
    await ok(api("PATCH", `/orgs/${o.orgId}/installments/${target._id}`, { token: o.admin.token, body: { action: "set_amount", amount: "1500", reason: "Special month" } }));
    list = await insts(o, member._id);
    const t = list.find((i) => i.sequence === 9);
    expect(t.dueDate.slice(0, 10)).toBe("2026-12-20");
    expect(t.amountPaise).toBe(150000);
    // skip a month
    await ok(api("POST", `/orgs/${o.orgId}/schemes/${scheme._id}/overrides`, { token: o.admin.token, body: { sequence: 10, skip: true, reason: "Diwali break" } }));
    list = await insts(o, member._id);
    expect(list.find((i) => i.sequence === 10).status).toBe("cancelled");
  });

  it("amount revision changes only future unpaid installments (history preserved)", async () => {
    const { member, scheme } = await memberWithScheme(o);
    await ok(pay(o, o.admin.token, member._id, "1000")); // pays April
    await ok(api("POST", `/orgs/${o.orgId}/schemes/${scheme._id}/revisions`, { token: o.admin.token, body: { effectiveFrom: "2026-04-01", amount: "1200" } }));
    const list = await insts(o, member._id);
    expect(list[0].amountPaise).toBe(100000); // paid one untouched
    expect(list[0].status).toBe("paid");
    expect(list.slice(1).every((i) => i.amountPaise === 120000)).toBe(true);
  });

  it("pausing defers future installments and resuming restores them", async () => {
    const { member, scheme } = await memberWithScheme(o);
    await ok(api("POST", `/orgs/${o.orgId}/schemes/${scheme._id}/status`, { token: o.admin.token, body: { action: "pause" } }));
    let list = await insts(o, member._id);
    expect(list.filter((i) => i.status === "deferred").length).toBeGreaterThan(0);
    await ok(api("POST", `/orgs/${o.orgId}/schemes/${scheme._id}/status`, { token: o.admin.token, body: { action: "resume" } }));
    list = await insts(o, member._id);
    expect(list.filter((i) => i.status === "deferred")).toHaveLength(0);
  });
});

describe("payments", () => {
  let o: Ctx;
  beforeAll(async () => {
    o = await setupOrg();
  });

  it("partial then full payment: statuses, ledger and receipt", async () => {
    const { member } = await memberWithScheme(o);
    const p1 = await ok(pay(o, o.admin.token, member._id, "400"));
    expect(p1.payment.status).toBe("verified");
    let list = await insts(o, member._id);
    expect(list[0].paidPaise).toBe(40000);
    expect(list[0].status).toBe("overdue"); // due 10 Apr 2026, today is later
    expect(list[0].outstandingPaise).toBe(60000);

    await ok(pay(o, o.admin.token, member._id, "600"));
    list = await insts(o, member._id);
    expect(list[0].paidPaise).toBe(100000);
    expect(list[0].status).toBe("paid");
    expect(list[1].paidPaise).toBe(0);

    // 1,500 spans two installments
    await ok(pay(o, o.admin.token, member._id, "1500"));
    list = await insts(o, member._id);
    expect([list[1].paidPaise, list[2].paidPaise]).toEqual([100000, 50000]);

    const receipt = await ok(api("GET", `/orgs/${o.orgId}/receipts/${p1.payment.receiptId}`, { token: o.admin.token }));
    expect(receipt.receipt.receiptNumber).toMatch(/^RCPT\/2026-27\/\d{6}$/);
    expect(receipt.receipt.amountPaise).toBe(40000);

    const t = await ledgerTotals(o.orgId);
    expect(t.d).toBe(t.c);
  });

  it("rejects overpayment and invalid amounts", async () => {
    const { member } = await memberWithScheme(o, "100", { numberOfInstallments: 2 });
    expect((await pay(o, o.admin.token, member._id, "300")).status).toBe(400);
    expect((await pay(o, o.admin.token, member._id, "-5")).status).toBe(422);
    expect((await pay(o, o.admin.token, member._id, "0")).status).toBe(422);
    expect((await pay(o, o.admin.token, member._id, "10.001")).status).toBe(422);
  });

  it("duplicate requests with the same idempotency key create one payment", async () => {
    const { member } = await memberWithScheme(o);
    const key = uniq("dup");
    const results = await Promise.all([1, 2, 3].map(() => pay(o, o.admin.token, member._id, "1000", key)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const ids = new Set(results.map((r) => r.data.payment._id));
    expect(ids.size).toBe(1);
    const c = await cols();
    expect(await c.payments.countDocuments({ idempotencyKey: key })).toBe(1);
    expect(await c.receipts.countDocuments({ sourceId: new ObjectId([...ids][0] as string) })).toBe(1);
    const list = await insts(o, member._id);
    expect(list[0].paidPaise).toBe(100000);
    expect(list[1].paidPaise).toBe(0);
  });

  it("concurrent payments never over-allocate installments", async () => {
    const { member } = await memberWithScheme(o, "1000", { numberOfInstallments: 3 });
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => pay(o, o.admin.token, member._id, "1000")));
    const succeeded = results.filter((r) => r.status === 200);
    expect(succeeded).toHaveLength(3);
    expect(results.filter((r) => r.status !== 200).every((r) => r.status === 400 || r.status === 409)).toBe(true);
    const list = await insts(o, member._id);
    expect(list.map((i) => i.paidPaise)).toEqual([100000, 100000, 100000]);
    const t = await ledgerTotals(o.orgId);
    expect(t.d).toBe(t.c);
  });

  it("reversal restores dues, cancels the receipt and nets the ledger to zero", async () => {
    const { member } = await memberWithScheme(o);
    const before = await balance(o.orgId, `fa:${o.cashAccountId}`);
    const p = (await ok(pay(o, o.admin.token, member._id, "1000"))).payment;
    expect(await balance(o.orgId, `fa:${o.cashAccountId}`)).toBe(before + 100000);
    const rev = await api("POST", `/orgs/${o.orgId}/payments/${p._id}/reverse`, { token: o.admin.token, body: { reason: "Cheque bounced" } });
    expect(rev.status).toBe(200);
    expect(await balance(o.orgId, `fa:${o.cashAccountId}`)).toBe(before);
    const list = await insts(o, member._id);
    expect(list[0].paidPaise).toBe(0);
    const r = await ok(api("GET", `/orgs/${o.orgId}/receipts/${p.receiptId}`, { token: o.admin.token }));
    expect(r.receipt.status).toBe("cancelled");
    // cannot reverse twice
    expect((await api("POST", `/orgs/${o.orgId}/payments/${p._id}/reverse`, { token: o.admin.token, body: { reason: "again" } })).status).toBe(409);
    // original transaction still exists, marked reversed
    const c = await cols();
    const txn = await c.financialTransactions.findOne({ _id: new ObjectId(p.transactionId) });
    expect(txn?.reversedBy).toBeTruthy();
  });

  it("manager payments stay pending until verified when verification is required", async () => {
    const org = await ok(api("GET", `/orgs/${o.orgId}`, { token: o.admin.token }));
    await ok(api("PATCH", `/orgs/${o.orgId}`, { token: o.admin.token, body: { settings: { managerPermissions: { ...org.settings.managerPermissions, canVerifyPayments: false } } } }));
    const mgr = await addUser(o.orgId, o.code, o.admin.token, "manager");
    const { member } = await memberWithScheme(o);
    const cashBefore = await balance(o.orgId, `fa:${o.cashAccountId}`);
    const p = (await ok(pay(o, mgr.token, member._id, "1000"))).payment;
    expect(p.status).toBe("pending");
    expect(await balance(o.orgId, `fa:${o.cashAccountId}`)).toBe(cashBefore); // pending does not count
    expect((await insts(o, member._id))[0].paidPaise).toBe(0);
    expect((await api("POST", `/orgs/${o.orgId}/payments/${p._id}/verify`, { token: mgr.token, body: {} })).status).toBe(403);
    await ok(api("POST", `/orgs/${o.orgId}/payments/${p._id}/verify`, { token: o.admin.token, body: {} }));
    expect(await balance(o.orgId, `fa:${o.cashAccountId}`)).toBe(cashBefore + 100000);
    expect((await insts(o, member._id))[0].paidPaise).toBe(100000);
    // managers can never reverse
    expect((await api("POST", `/orgs/${o.orgId}/payments/${p._id}/reverse`, { token: mgr.token, body: { reason: "test" } })).status).toBe(403);
  });

  it("members see only their own data and can submit payment requests", async () => {
    const a = await memberWithScheme(o);
    const b = await memberWithScheme(o);
    const userA = await addUser(o.orgId, o.code, o.admin.token, "member", a.member._id);
    const mine = await ok(api("GET", `/orgs/${o.orgId}/me/installments?pageSize=100`, { token: userA.token }));
    expect(mine.items.every((i: any) => i.memberId === a.member._id)).toBe(true);
    expect(mine.items).toHaveLength(12);
    // cannot reach the staff endpoints or another member's data
    expect((await api("GET", `/orgs/${o.orgId}/installments?memberId=${b.member._id}`, { token: userA.token })).status).toBe(403);
    expect((await api("GET", `/orgs/${o.orgId}/members/${b.member._id}`, { token: userA.token })).status).toBe(403);
    expect((await pay(o, userA.token, a.member._id, "1000")).status).toBe(403);

    const req = await ok(
      api("POST", `/orgs/${o.orgId}/me/payment-requests`, {
        token: userA.token,
        body: { amount: "1000", date: "2026-04-11", method: "cash", reference: "UPI123", idempotencyKey: uniq("req") },
      }),
    );
    expect(req.payment.status).toBe("pending");
    // cash only for now: any other method is refused
    const upi = await api("POST", `/orgs/${o.orgId}/me/payment-requests`, { token: userA.token, body: { amount: "1000", date: "2026-04-11", method: "upi", idempotencyKey: uniq("req") } });
    expect(upi.status).toBe(400);
    const pBVerified = (await ok(pay(o, o.admin.token, b.member._id, "1000"))).payment;
    // member A cannot open member B's receipt
    expect((await api("GET", `/orgs/${o.orgId}/receipts/${pBVerified.receiptId}`, { token: userA.token })).status).toBe(404);
    // staff verify with an account
    await ok(api("POST", `/orgs/${o.orgId}/payments/${req.payment._id}/verify`, { token: o.admin.token, body: { accountId: o.cashAccountId } }));
    // receipts and notifications come a page at a time, with the total
    const receipts = await ok(api("GET", `/orgs/${o.orgId}/me/receipts?pageSize=10`, { token: userA.token }));
    expect(receipts).toMatchObject({ total: 1, page: 1, pageSize: 10 });
    expect(receipts.items).toHaveLength(1);
    const notes = await ok(api("GET", `/notifications?orgId=${o.orgId}`, { token: userA.token }));
    expect(notes.items.some((n: any) => n.type === "payment.verified")).toBe(true);
    expect(notes.total).toBeGreaterThanOrEqual(notes.items.length);
    const page2 = await ok(api("GET", `/notifications?orgId=${o.orgId}&page=2&pageSize=1`, { token: userA.token }));
    expect(page2.items.length).toBe(notes.total > 1 ? 1 : 0);

    // "My schemes": only their own enrollments, each with the full schedule
    const mySchemes = await ok<any[]>(api("GET", `/orgs/${o.orgId}/me/schemes`, { token: userA.token }));
    expect(mySchemes.length).toBeGreaterThan(0);
    for (const e of mySchemes) {
      expect(e.scheme.name).toBeTruthy();
      expect(e.schedule).toHaveLength(e.installmentCount);
      expect(e.totalPaidPaise).toBeGreaterThanOrEqual(e.paidPaise);
    }
    expect(mySchemes.reduce((sum: number, e: any) => sum + e.totalPaidPaise, 0)).toBeGreaterThanOrEqual(100_000); // the verified ₹1,000
  });
});
