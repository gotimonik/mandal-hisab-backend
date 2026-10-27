import { beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { addUser, api, ok, setupOrg, uniq } from "../helpers/api";
import { cols } from "@/lib/collections";

type Ctx = Awaited<ReturnType<typeof setupOrg>>;

async function bal(orgId: string, key: string) {
  const c = await cols();
  const [r] = await c.ledgerEntries
    .aggregate<{ d: number; c: number }>([{ $match: { organizationId: new ObjectId(orgId), accountKey: key } }, { $group: { _id: null, d: { $sum: "$debitPaise" }, c: { $sum: "$creditPaise" } } }])
    .toArray();
  return r ? r.d - r.c : 0;
}

async function assertLedgerBalanced(orgId: string) {
  const c = await cols();
  const perTxn = await c.ledgerEntries
    .aggregate<{ _id: ObjectId; d: number; c: number }>([{ $match: { organizationId: new ObjectId(orgId) } }, { $group: { _id: "$transactionId", d: { $sum: "$debitPaise" }, c: { $sum: "$creditPaise" } } }])
    .toArray();
  expect(perTxn.length).toBeGreaterThan(0);
  for (const t of perTxn) expect(t.d).toBe(t.c);
}

async function bankAccount(o: Ctx, opening = "200000") {
  return ok(api("POST", `/orgs/${o.orgId}/accounts`, { token: o.admin.token, body: { name: `Bank ${uniq()}`, type: "cash", openingBalance: opening, openingDate: "2026-04-01" } }));
}

describe("accounts & transfers", () => {
  let o: Ctx;
  beforeAll(async () => {
    o = await setupOrg();
  });

  it("transfers move money between accounts without creating income or expense", async () => {
    const bank = await bankAccount(o, "50000");
    const before = await ok(api("GET", `/orgs/${o.orgId}/reports/income-expense?from=2026-04-01&to=2027-03-31`, { token: o.admin.token }));
    const key = uniq("tr");
    await ok(api("POST", `/orgs/${o.orgId}/transfers`, { token: o.admin.token, body: { fromAccountId: bank._id, toAccountId: o.cashAccountId, amount: "12500.50", date: "2026-05-01", idempotencyKey: key } }));
    // retry is idempotent
    const again = await ok(api("POST", `/orgs/${o.orgId}/transfers`, { token: o.admin.token, body: { fromAccountId: bank._id, toAccountId: o.cashAccountId, amount: "12500.50", date: "2026-05-01", idempotencyKey: key } }));
    expect(again.duplicate).toBe(true);
    expect(await bal(o.orgId, `fa:${bank._id}`)).toBe(5_000_000 - 1_250_050);
    expect(await bal(o.orgId, `fa:${o.cashAccountId}`)).toBe(1_250_050);
    const after = await ok(api("GET", `/orgs/${o.orgId}/reports/income-expense?from=2026-04-01&to=2027-03-31`, { token: o.admin.token }));
    expect(after.totalIncomePaise).toBe(before.totalIncomePaise);
    expect(after.totalExpensePaise).toBe(before.totalExpensePaise);
    // cannot overdraw
    const over = await api("POST", `/orgs/${o.orgId}/transfers`, { token: o.admin.token, body: { fromAccountId: o.cashAccountId, toAccountId: bank._id, amount: "999999", date: "2026-05-02", idempotencyKey: uniq("tr") } });
    expect(over.status).toBe(400);
    await assertLedgerBalanced(o.orgId);
  });

  it("balances can only be corrected through audited adjustments, which can be reversed", async () => {
    const bank = await bankAccount(o, "1000");
    const adj = await ok(api("POST", `/orgs/${o.orgId}/adjustments`, { token: o.admin.token, body: { accountId: bank._id, direction: "decrease", amount: "250", date: "2026-05-03", reason: "Bank charges not recorded", idempotencyKey: uniq("adj") } }));
    expect(await bal(o.orgId, `fa:${bank._id}`)).toBe(75_000);
    await ok(api("POST", `/orgs/${o.orgId}/transactions/${adj.transaction._id}/reverse`, { token: o.admin.token, body: { reason: "Entered twice" } }));
    expect(await bal(o.orgId, `fa:${bank._id}`)).toBe(100_000);
    const c = await cols();
    expect(await c.auditLogs.countDocuments({ organizationId: new ObjectId(o.orgId), action: { $in: ["account.adjustment", "transaction.reverse"] } })).toBeGreaterThanOrEqual(2);
    // There is no endpoint to edit a balance directly
    const patch = await api("PATCH", `/orgs/${o.orgId}/accounts/${bank._id}`, { token: o.admin.token, body: { balancePaise: 1 } });
    expect(patch.status).toBe(200);
    expect(await bal(o.orgId, `fa:${bank._id}`)).toBe(100_000);
  });
});

describe("expenses & donations", () => {
  let o: Ctx;
  let bankId: string;
  beforeAll(async () => {
    o = await setupOrg();
    bankId = (await bankAccount(o, "100000"))._id;
    const org = await ok(api("GET", `/orgs/${o.orgId}`, { token: o.admin.token }));
    await ok(api("PATCH", `/orgs/${o.orgId}`, { token: o.admin.token, body: { settings: { expenseApprovalThresholdPaise: 500000, managerPermissions: { ...org.settings.managerPermissions, canApproveExpenses: true } } } }));
  });

  const expense = (token: string, amount: string, extra: Record<string, unknown> = {}) =>
    api("POST", `/orgs/${o.orgId}/expenses`, {
      token,
      body: { categoryKey: "decoration", payeeName: "Shree Decorators", description: "Pandal lights", amount, date: "2026-08-20", method: "cash", accountId: bankId, eventName: "Ganeshotsav 2026", idempotencyKey: uniq("exp"), ...extra },
    });

  it("manager expenses above the threshold need admin approval; rejection posts nothing", async () => {
    const mgr = await addUser(o.orgId, o.code, o.admin.token, "manager");
    const small = await ok(expense(mgr.token, "3000"));
    expect(small.expense.status).toBe("approved");
    const big = await ok(expense(mgr.token, "15000"));
    expect(big.expense.status).toBe("pending");
    const bankBefore = await bal(o.orgId, `fa:${bankId}`);
    // manager cannot approve above threshold
    expect((await api("POST", `/orgs/${o.orgId}/expenses/${big.expense._id}/approve`, { token: mgr.token, body: {} })).status).toBe(403);
    await ok(api("POST", `/orgs/${o.orgId}/expenses/${big.expense._id}/approve`, { token: o.admin.token, body: {} }));
    expect(await bal(o.orgId, `fa:${bankId}`)).toBe(bankBefore - 1_500_000);
    expect(await bal(o.orgId, "expense:decoration")).toBe(300_000 + 1_500_000);

    const rej = await ok(expense(mgr.token, "9000"));
    await ok(api("POST", `/orgs/${o.orgId}/expenses/${rej.expense._id}/reject`, { token: o.admin.token, body: { reason: "No invoice attached" } }));
    expect(await bal(o.orgId, "expense:decoration")).toBe(1_800_000);
    expect((await api("POST", `/orgs/${o.orgId}/expenses/${rej.expense._id}/approve`, { token: o.admin.token, body: {} })).status).toBe(409);
    // members cannot submit expenses
    const member = await addUser(o.orgId, o.code, o.admin.token, "member");
    expect((await expense(member.token, "10")).status).toBe(403);
  });

  it("out-of-pocket expenses create a payable until reimbursed", async () => {
    const e = await ok(expense(o.admin.token, "1200", { paidBy: "out_of_pocket", accountId: null }));
    expect(e.expense.status).toBe("approved");
    expect(await bal(o.orgId, "liability:reimbursements_payable")).toBe(-120_000);
    await ok(api("POST", `/orgs/${o.orgId}/expenses/${e.expense._id}/reimburse`, { token: o.admin.token, body: { accountId: bankId, date: "2026-08-25" } }));
    expect(await bal(o.orgId, "liability:reimbursements_payable")).toBe(0);
  });

  it("donations issue receipts, and reversals cancel them", async () => {
    const d = await ok(api("POST", `/orgs/${o.orgId}/donations`, { token: o.admin.token, body: { donorName: "Patel Family", amount: "5001", date: "2026-08-22", method: "cash", accountId: bankId, eventName: "Ganeshotsav 2026", idempotencyKey: uniq("don") } }));
    expect(d.donation.status).toBe("verified");
    expect(await bal(o.orgId, "income:donation")).toBe(-500_100);
    const ev = await ok(api("GET", `/orgs/${o.orgId}/reports/events?from=2026-04-01&to=2027-03-31`, { token: o.admin.token }));
    const g = ev.rows.find((x: any) => x.eventName === "Ganeshotsav 2026");
    expect(g.incomePaise).toBe(500_100);
    expect(g.expensePaise).toBe(1_800_000 + 120_000); // incl. the out-of-pocket expense for the same event
    await ok(api("POST", `/orgs/${o.orgId}/donations/${d.donation._id}/reverse`, { token: o.admin.token, body: { reason: "UPI failed" } }));
    expect(await bal(o.orgId, "income:donation")).toBe(0);
    await assertLedgerBalanced(o.orgId);
  });
});

describe("loans", () => {
  let o: Ctx;
  let bankId: string;
  let memberId: string;
  beforeAll(async () => {
    o = await setupOrg();
    bankId = (await bankAccount(o, "500000"))._id;
    memberId = (await ok(api("POST", `/orgs/${o.orgId}/members`, { token: o.admin.token, body: { name: "Kiran Shah" } })))._id;
  });

  async function activeLoan(extra: Record<string, unknown> = {}) {
    const loan = await ok(api("POST", `/orgs/${o.orgId}/loans`, { token: o.admin.token, body: { memberId, amount: "100000", interestMethod: "reducing_balance", rate: "12", tenure: 12, repaymentFrequency: "monthly", ...extra } }));
    await ok(api("POST", `/orgs/${o.orgId}/loans/${loan._id}/approve`, { token: o.admin.token, body: { approvedAmount: "100000" } }));
    await ok(api("POST", `/orgs/${o.orgId}/loans/${loan._id}/disburse`, { token: o.admin.token, body: { accountId: bankId, date: "2026-04-01", firstDueDate: "2026-05-01" } }));
    return loan._id as string;
  }
  const repay = (id: string, amount: string, date: string, extra: Record<string, unknown> = {}) =>
    api("POST", `/orgs/${o.orgId}/loans/${id}/repayments`, { token: o.admin.token, body: { amount, date, method: "cash", accountId: bankId, idempotencyKey: uniq("rep"), ...extra } });

  it("disbursement is an asset movement, not an expense; EMI repayment splits principal and interest", async () => {
    const before = await bal(o.orgId, `fa:${bankId}`);
    const id = await activeLoan();
    expect(await bal(o.orgId, `fa:${bankId}`)).toBe(before - 10_000_000);
    expect(await bal(o.orgId, "asset:loans_receivable")).toBe(10_000_000);
    const loan = (await ok(api("GET", `/orgs/${o.orgId}/loans/${id}`, { token: o.admin.token }))).loan;
    expect(loan.schedule[0]).toMatchObject({ principalDuePaise: 788_488, interestDuePaise: 100_000 });

    // preview first (no write)
    const prev = await ok(repay(id, "8884.88", "2026-05-01", { dryRun: true }));
    expect(prev.preview).toMatchObject({ principalPaise: 788_488, interestPaise: 100_000, penaltyPaise: 0 });
    expect(await bal(o.orgId, "asset:loans_receivable")).toBe(10_000_000);

    await ok(repay(id, "8884.88", "2026-05-01"));
    expect(await bal(o.orgId, "asset:loans_receivable")).toBe(10_000_000 - 788_488);
    expect(await bal(o.orgId, "income:interest")).toBe(-100_000);
    const after = (await ok(api("GET", `/orgs/${o.orgId}/loans/${id}`, { token: o.admin.token }))).loan;
    expect(after.outstandingPrincipalPaise).toBe(9_211_512);
    expect(after.schedule[0].status).toBe("paid");
  });

  it("early closure charges only interest accrued to date and closes the loan", async () => {
    const id = await activeLoan();
    await ok(repay(id, "8884.88", "2026-05-01"));
    const quote = await ok(api("GET", `/orgs/${o.orgId}/loans/${id}/closure-quote?date=2026-05-16`, { token: o.admin.token }));
    expect(quote).toMatchObject({ outstandingPrincipalPaise: 9_211_512, accruedInterestPaise: 45_427, accruedDays: 15, totalPaise: 9_256_939 });
    expect((await repay(id, "92569.38", "2026-05-16", { closeLoan: true })).status).toBe(400);
    await ok(repay(id, "92569.39", "2026-05-16", { closeLoan: true }));
    const loan = (await ok(api("GET", `/orgs/${o.orgId}/loans/${id}`, { token: o.admin.token }))).loan;
    expect(loan.status).toBe("closed");
    expect(loan.outstandingPrincipalPaise).toBe(0);
    expect(loan.totalInterestPaidPaise).toBe(100_000 + 45_427);
    expect((await repay(id, "1", "2026-05-20")).status).toBe(400);
  });

  it("prepayment reduces principal and re-computes the EMI (reduce_emi)", async () => {
    const id = await activeLoan();
    const res = await ok(repay(id, "28884.88", "2026-05-01", { prepayment: true }));
    expect(res.repayment.kind).toBe("prepayment");
    const loan = (await ok(api("GET", `/orgs/${o.orgId}/loans/${id}`, { token: o.admin.token }))).loan;
    expect(loan.outstandingPrincipalPaise).toBe(7_211_512);
    expect(loan.schedule).toHaveLength(12);
    expect(loan.schedule[1].totalDuePaise).toBe(695_580);
    const sumP = loan.schedule.slice(1).reduce((s: number, r: any) => s + r.principalDuePaise, 0);
    expect(sumP).toBe(7_211_512);
  });

  it("the latest repayment can be reversed exactly", async () => {
    const id = await activeLoan();
    const r = await ok(repay(id, "28884.88", "2026-05-01", { prepayment: true }));
    await ok(api("POST", `/orgs/${o.orgId}/loans/${id}/repayments/${r.repayment._id}/reverse`, { token: o.admin.token, body: { reason: "Cheque bounced" } }));
    const loan = (await ok(api("GET", `/orgs/${o.orgId}/loans/${id}`, { token: o.admin.token }))).loan;
    expect(loan.outstandingPrincipalPaise).toBe(10_000_000);
    expect(loan.schedule[1].totalDuePaise).toBe(888_488);
    expect(loan.totalInterestPaidPaise).toBe(0);
    await assertLedgerBalanced(o.orgId);
  });

  it("managers cannot create or approve loans unless permitted", async () => {
    const mgr = await addUser(o.orgId, o.code, o.admin.token, "manager");
    expect((await api("POST", `/orgs/${o.orgId}/loans`, { token: mgr.token, body: { memberId, amount: "100", interestMethod: "flat", rate: "10", tenure: 2 } })).status).toBe(403);
    await ok(api("GET", `/orgs/${o.orgId}/loans`, { token: mgr.token }));
  });
});

describe("reports, ledger integrity and jobs", () => {
  let o: Ctx;
  beforeAll(async () => {
    o = await setupOrg();
    // These tests cover the classic "hapta is Mandal income" books; member-savings mode is covered in savings.test.ts.
    await ok(api("PATCH", `/orgs/${o.orgId}`, { token: o.admin.token, body: { settings: { haptaTreatment: "income" } } }));
    const member = await ok(api("POST", `/orgs/${o.orgId}/members`, { token: o.admin.token, body: { name: "Report Member", phone: "9876543210" } }));
    const scheme = await ok(
      api("POST", `/orgs/${o.orgId}/schemes`, {
        token: o.admin.token,
        body: { name: "Monthly hapta", startDate: "2026-04-01", frequency: "monthly", dueDay: 5, amount: "500", numberOfInstallments: 12, lateFee: { enabled: true, type: "fixed", value: 5000, graceDays: 2 } },
      }),
    );
    await ok(api("POST", `/orgs/${o.orgId}/schemes/${scheme._id}/enroll`, { token: o.admin.token, body: { members: [{ memberId: member._id }] } }));
    for (const [amt, date] of [["500", "2026-04-05"], ["500", "2026-05-06"], ["500", "2026-06-07"]]) {
      await ok(api("POST", `/orgs/${o.orgId}/payments`, { token: o.admin.token, body: { kind: "hapta", memberId: member._id, amount: amt, date, method: "cash", accountId: o.cashAccountId, idempotencyKey: uniq("p") } }));
    }
    await ok(api("POST", `/orgs/${o.orgId}/expenses`, { token: o.admin.token, body: { categoryKey: "puja", payeeName: "Pujari", description: "Puja samagri", amount: "300", date: "2026-05-10", method: "cash", accountId: o.cashAccountId, idempotencyKey: uniq("e") } }));
    (globalThis as any).__member = member;
  });

  it("monthly and yearly collection reports have exact totals", async () => {
    const m = await ok(api("GET", `/orgs/${o.orgId}/reports/collections?from=2026-04-01&to=2027-03-31&groupBy=month`, { token: o.admin.token }));
    expect(m.rows.map((r: any) => [r.period, r.totalPaise])).toEqual([
      ["2026-04", 50_000],
      ["2026-05", 50_000],
      ["2026-06", 50_000],
    ]);
    const y = await ok(api("GET", `/orgs/${o.orgId}/reports/collections?from=2026-04-01&to=2027-03-31&groupBy=year`, { token: o.admin.token }));
    expect(y.rows).toEqual([{ period: "2026-27", byCategory: { "income:hapta": 150_000 }, totalPaise: 150_000 }]);
    const q = await ok(api("GET", `/orgs/${o.orgId}/reports/collections?from=2026-04-01&to=2027-03-31&groupBy=quarter`, { token: o.admin.token }));
    expect(q.rows.map((r: any) => r.period)).toEqual(["2026-Q1"]);
    const pl = await ok(api("GET", `/orgs/${o.orgId}/reports/income-expense?from=2026-04-01&to=2027-03-31`, { token: o.admin.token }));
    expect([pl.totalIncomePaise, pl.totalExpensePaise, pl.surplusPaise]).toEqual([150_000, 30_000, 120_000]);
    const csv = await api("GET", `/orgs/${o.orgId}/reports/collections?from=2026-04-01&to=2027-03-31&format=csv`, { token: o.admin.token });
    expect(csv.status).toBe(200);
    expect(String(csv.data)).toContain("2026-05,500.00,500.00");
  });

  it("trial balance and balance sheet balance", async () => {
    const tb = await ok(api("GET", `/orgs/${o.orgId}/reports/trial-balance`, { token: o.admin.token }));
    expect(tb.balanced).toBe(true);
    const bs = await ok(api("GET", `/orgs/${o.orgId}/reports/balance-sheet`, { token: o.admin.token }));
    expect(bs.balanced).toBe(true);
    expect(bs.totalAssetsPaise).toBe(120_000);
    const cf = await ok(api("GET", `/orgs/${o.orgId}/reports/cash-flow?from=2026-04-01&to=2027-03-31`, { token: o.admin.token }));
    expect(cf.closingCashPaise).toBe(120_000);
  });

  it("member statement shows dues, payments and running balance", async () => {
    const member = (globalThis as any).__member;
    const st = await ok(api("GET", `/orgs/${o.orgId}/members/${member._id}/statement?from=2026-04-01&to=2026-06-30`, { token: o.admin.token }));
    expect(st.totalDebitPaise).toBe(150_000);
    expect(st.totalCreditPaise).toBe(150_000);
    expect(st.closingBalancePaise).toBe(0);
  });

  it("sensitive reports require permission; CSV exports use the same rules", async () => {
    const mgr = await addUser(o.orgId, o.code, o.admin.token, "manager");
    expect((await api("GET", `/orgs/${o.orgId}/reports/trial-balance`, { token: mgr.token })).status).toBe(403);
    expect((await api("GET", `/orgs/${o.orgId}/reports/trial-balance?format=csv`, { token: mgr.token })).status).toBe(403);
    await ok(api("GET", `/orgs/${o.orgId}/reports/overdue`, { token: mgr.token }));
    const dash = await ok(api("GET", `/orgs/${o.orgId}/dashboard`, { token: mgr.token }));
    expect(dash.role).toBe("manager");
    expect(dash.totals.fyIncomePaise).toBeUndefined();
  });

  it("dashboard figures come from the database", async () => {
    const d = await ok(api("GET", `/orgs/${o.orgId}/dashboard`, { token: o.admin.token }));
    expect(d.role).toBe("admin");
    expect(d.totals.totalCollectedPaise).toBe(150_000);
    expect(d.totals.cashBalancePaise).toBe(120_000);
    // creator (auto member) + report member + the manager approved in the previous test (auto member)
    expect(d.totals.activeMembers).toBe(3);
    expect(d.monthlyChart).toHaveLength(12);
  });

  it("daily job applies late fees once and never sends duplicate reminders", async () => {
    const { runDailyJobs } = await import("@/services/jobs.service");
    const user = await addUser(o.orgId, o.code, o.admin.token, "member", (globalThis as any).__member._id);
    const r1 = await runDailyJobs();
    expect(r1.penaltiesApplied).toBeGreaterThan(0);
    const r2 = await runDailyJobs();
    expect(r2.penaltiesApplied).toBe(0);
    expect(r2.remindersSent).toBe(0);
    const c = await cols();
    const withFee = await c.installments.countDocuments({ organizationId: new ObjectId(o.orgId), penaltyPaise: 5000 });
    expect(withFee).toBe(r1.penaltiesApplied);
    const notes = await ok(api("GET", `/notifications?orgId=${o.orgId}`, { token: user.token }));
    const keys = notes.items.map((n: any) => n.dedupeKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("cron endpoint requires the secret", async () => {
    process.env.CRON_SECRET = "cron-secret-123";
    const { resetEnvCache } = await import("@/config/env");
    resetEnvCache();
    expect((await api("GET", "/cron/daily")).status).toBe(401);
    expect((await api("GET", "/cron/daily", { token: "wrong" })).status).toBe(401);
    expect((await api("GET", "/cron/daily", { token: "cron-secret-123" })).status).toBe(200);
  });
});
