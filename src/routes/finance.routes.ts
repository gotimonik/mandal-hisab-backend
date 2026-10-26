import { z } from "zod";
import { csvResponse, type Router } from "@/lib/http";
import { parseObjectId } from "@/lib/auth";
import { env } from "@/config/env";
import { safeEqual } from "@/lib/crypto";
import { badRequest, forbidden, unauthorized } from "@/lib/errors";
import { toCsv } from "@/lib/csv";
import { dateOnly, reason } from "@/validators/common";
import * as de from "@/services/donation-expense.service";
import * as loans from "@/services/loan.service";
import * as reports from "@/services/report.service";
import { runDailyJobs } from "@/services/jobs.service";
import { uploadAttachment } from "@/services/upload.service";
import type { Permission } from "@/lib/permissions";

const W = { write: true } as const;

type ReportFn = (ctx: Awaited<ReturnType<import("@/lib/http").ApiRequest["org"]>>, q: reports.ReportParams) => Promise<unknown>;

const REPORTS: Record<string, { permission: Permission; fn: ReportFn }> = {
  "income-expense": { permission: "reports.sensitive", fn: reports.incomeExpense },
  "trial-balance": { permission: "reports.sensitive", fn: reports.trialBalance },
  "balance-sheet": { permission: "reports.sensitive", fn: reports.balanceSheet },
  "account-summary": { permission: "reports.sensitive", fn: reports.accountSummary },
  "cash-flow": { permission: "reports.sensitive", fn: reports.cashFlow },
  ledger: { permission: "reports.sensitive", fn: reports.ledgerAccount },
  interest: { permission: "reports.sensitive", fn: reports.interestReport },
  collections: { permission: "reports.view", fn: reports.collections },
  hapta: { permission: "reports.view", fn: reports.haptaReport },
  overdue: { permission: "reports.view", fn: reports.overdueReport },
  donations: { permission: "reports.view", fn: reports.donationReport },
  events: { permission: "reports.view", fn: reports.eventReport },
  loans: { permission: "loans.view", fn: (ctx) => reports.loanOutstandingReport(ctx) },
};

export function registerFinanceRoutes(r: Router) {
  /* ---------------- dashboard (role specific) */
  r.get("/orgs/:orgId/dashboard", async (req) => {
    const ctx = await req.org("org.view");
    if (ctx.role === "admin") return { role: "admin", ...(await reports.adminDashboard(ctx)) };
    if (ctx.role === "manager") return { role: "manager", ...(await reports.managerDashboard(ctx)) };
    return { role: "member", ...(await reports.memberDashboard(ctx)) };
  });

  /* ---------------- reports + CSV export (same authorization as JSON) */
  r.get("/orgs/:orgId/reports/:kind", async (req) => {
    const def = REPORTS[req.params.kind];
    if (!def) throw badRequest("Unknown report");
    const ctx = await req.org(def.permission);
    const q = req.queryAs(reports.ReportQuery);
    const data = (await def.fn(ctx, q)) as Record<string, unknown>;
    if (q.format === "csv") {
      const t = reports.toTable(req.params.kind, data, ctx.org.settings.currency);
      return csvResponse(`${req.params.kind}-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(t.headers, t.rows));
    }
    return data;
  });
  r.get("/orgs/:orgId/members/:id/statement", async (req) => {
    const ctx = await req.org("members.view");
    const q = req.queryAs(reports.ReportQuery);
    const data = await reports.memberStatement(ctx, req.params.id, q);
    if (q.format === "csv") {
      const t = reports.toTable("member-statement", data as unknown as Record<string, unknown>, ctx.org.settings.currency);
      return csvResponse(`statement-${data.member.membershipNumber}.csv`, toCsv(t.headers, t.rows));
    }
    return data;
  });
  r.get("/orgs/:orgId/me/statement", async (req) => {
    const ctx = await req.org("self.view");
    if (!ctx.membership.memberId) throw forbidden("Your login is not linked to a member record");
    const q = req.queryAs(reports.ReportQuery);
    const data = await reports.memberStatement(ctx, ctx.membership.memberId.toHexString(), q);
    if (q.format === "csv") {
      const t = reports.toTable("member-statement", data as unknown as Record<string, unknown>, ctx.org.settings.currency);
      return csvResponse(`statement-${data.member.membershipNumber}.csv`, toCsv(t.headers, t.rows));
    }
    return data;
  });

  /* ---------------- donations */
  r.get("/orgs/:orgId/donations", async (req) => de.listDonations(await req.org("payments.view"), req.queryAs(de.ListQuery)));
  r.post("/orgs/:orgId/donations", async (req) => de.recordDonation(await req.org("donations.record", W), await req.body(de.DonationSchema)));
  r.post("/orgs/:orgId/donations/:id/verify", async (req) => de.verifyDonation(await req.org("payments.verify", W), parseObjectId(req.params.id, "Donation")));
  r.post("/orgs/:orgId/donations/:id/reverse", async (req) => {
    const b = await req.body(z.object({ reason }));
    return de.reverseDonation(await req.org("payments.reverse", W), parseObjectId(req.params.id, "Donation"), b.reason);
  });

  /* ---------------- expenses */
  r.get("/orgs/:orgId/expenses", async (req) => de.listExpenses(await req.org("expenses.view"), req.queryAs(de.ListQuery)));
  r.post("/orgs/:orgId/expenses", async (req) => de.submitExpense(await req.org("expenses.submit", W), await req.body(de.ExpenseSchema)));
  r.post("/orgs/:orgId/expenses/:id/approve", async (req) => de.approveExpense(await req.org("expenses.approve", W), parseObjectId(req.params.id, "Expense")));
  r.post("/orgs/:orgId/expenses/:id/reject", async (req) => {
    const b = await req.body(z.object({ reason }));
    return de.rejectExpense(await req.org("expenses.approve", W), parseObjectId(req.params.id, "Expense"), b.reason);
  });
  r.post("/orgs/:orgId/expenses/:id/reimburse", async (req) =>
    de.reimburseExpense(await req.org("expenses.approve", W), parseObjectId(req.params.id, "Expense"), await req.body(de.ReimburseSchema)),
  );
  r.post("/orgs/:orgId/expenses/:id/reverse", async (req) => {
    const b = await req.body(z.object({ reason }));
    return de.reverseExpense(await req.org("transactions.adjust", W), parseObjectId(req.params.id, "Expense"), b.reason);
  });

  /* ---------------- loans */
  r.post("/orgs/:orgId/loans/preview", async (req) => {
    await req.org("loans.view");
    return loans.previewSchedule(await req.body(loans.LoanPreviewSchema));
  });
  r.get("/orgs/:orgId/loans", async (req) => loans.listLoans(await req.org("loans.view"), req.queryAs(loans.LoanListQuery)));
  r.post("/orgs/:orgId/loans", async (req) => loans.applyLoan(await req.org("loans.manage", W), await req.body(loans.LoanApplySchema)));
  r.get("/orgs/:orgId/loans/:id", async (req) => loans.getLoan(await req.org("loans.view"), parseObjectId(req.params.id, "Loan")));
  r.post("/orgs/:orgId/loans/:id/approve", async (req) =>
    loans.approveLoan(await req.org("loans.approve", W), parseObjectId(req.params.id, "Loan"), await req.body(loans.LoanApproveSchema)),
  );
  r.post("/orgs/:orgId/loans/:id/reject", async (req) => {
    const b = await req.body(z.object({ reason }));
    return loans.rejectLoan(await req.org("loans.approve", W), parseObjectId(req.params.id, "Loan"), b.reason);
  });
  r.post("/orgs/:orgId/loans/:id/disburse", async (req) =>
    loans.disburseLoan(await req.org("loans.approve", W), parseObjectId(req.params.id, "Loan"), await req.body(loans.LoanDisburseSchema)),
  );
  r.post("/orgs/:orgId/loans/:id/repayments", async (req) =>
    loans.repayLoan(await req.org("payments.record", W), parseObjectId(req.params.id, "Loan"), await req.body(loans.RepaySchema)),
  );
  r.post("/orgs/:orgId/loans/:id/repayments/:repId/reverse", async (req) => {
    const b = await req.body(z.object({ reason }));
    return loans.reverseRepayment(await req.org("payments.reverse", W), parseObjectId(req.params.id, "Loan"), parseObjectId(req.params.repId, "Repayment"), b.reason);
  });
  r.get("/orgs/:orgId/loans/:id/closure-quote", async (req) => {
    const ctx = await req.org("loans.view");
    const q = req.queryAs(z.object({ date: dateOnly.optional() }));
    return loans.getClosureQuote(ctx, parseObjectId(req.params.id, "Loan"), q.date);
  });
  r.post("/orgs/:orgId/loans/:id/rate", async (req) =>
    loans.changeRate(await req.org("interest.manage", W), parseObjectId(req.params.id, "Loan"), await req.body(loans.RateChangeSchema)),
  );
  r.get("/orgs/:orgId/me/loans", async (req) => {
    const ctx = await req.org("self.view");
    if (!ctx.membership.memberId) return [];
    return loans.listLoans(ctx, {}, ctx.membership.memberId);
  });
  r.get("/orgs/:orgId/me/loans/:id", async (req) => {
    const ctx = await req.org("self.view");
    if (!ctx.membership.memberId) throw forbidden();
    return loans.getLoan(ctx, parseObjectId(req.params.id, "Loan"), ctx.membership.memberId);
  });

  /* ---------------- attachments */
  r.post("/orgs/:orgId/uploads", async (req) => {
    const ctx = await req.org("expenses.submit", W);
    const ct = req.raw.headers.get("content-type") ?? "";
    if (!ct.includes("multipart/form-data")) throw badRequest("Use multipart/form-data with a 'file' field");
    const len = Number(req.raw.headers.get("content-length") ?? 0);
    if (len > env().MAX_UPLOAD_BYTES + 10_000) throw badRequest("File too large");
    const form = await req.raw.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw badRequest("Missing file");
    return uploadAttachment(ctx, file);
  });

  /* ---------------- scheduled jobs (Vercel Cron) */
  r.get("/cron/daily", async (req) => {
    const secret = env().CRON_SECRET;
    const h = req.raw.headers.get("authorization") ?? "";
    if (!secret || !safeEqual(h, `Bearer ${secret}`)) throw unauthorized("Invalid cron secret");
    return runDailyJobs();
  });
}
