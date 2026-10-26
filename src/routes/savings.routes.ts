import * as settlement from "@/services/settlement.service";
import { z } from "zod";
import { csvResponse, type Router } from "@/lib/http";
import { parseObjectId } from "@/lib/auth";
import { forbidden } from "@/lib/errors";
import { toCsv } from "@/lib/csv";
import { reason } from "@/validators/common";
import * as monthly from "@/services/monthly.service";
import * as ledger from "@/services/member-ledger.service";
import * as interest from "@/services/member-interest.service";
import * as wd from "@/services/withdrawal.service";
import * as cash from "@/services/cashbook.service";
import * as fl from "@/services/fund-loan.service";
import * as ur from "@/services/upad-request.service";
import * as mp from "@/services/member-payments.service";
import * as orgService from "@/services/organization.service";
import { monthlyReport, toTable } from "@/services/report.service";

const W = { write: true } as const;
const wantsCsv = (q: URLSearchParams) => q.get("format") === "csv";

export function registerSavingsRoutes(r: Router) {
  /* ---------------- discovery & in-app invitations (user level) */
  r.get("/organizations/search", async (req) => {
    const auth = await req.auth();
    const { q } = req.queryAs(z.object({ q: z.string().trim().min(2, "Type at least 2 letters").max(100) }));
    return orgService.searchOrganizations(auth, q);
  });
  r.get("/invitations/mine", async (req) => orgService.myInvitations(await req.auth()));
  r.get("/invitations/preview", async (req) => orgService.previewInvitation(await req.auth(), req.query.get("token") ?? ""));
  r.post("/invitations/:id/accept", async (req) => orgService.acceptInvitationById(await req.auth(), parseObjectId(req.params.id, "Invitation")));
  r.post("/invitations/:id/decline", async (req) => orgService.declineInvitation(await req.auth(), parseObjectId(req.params.id, "Invitation")));
  r.get("/orgs/:orgId/invitations", async (req) => orgService.listInvitations(await req.org("memberships.manage")));
  r.post("/orgs/:orgId/invitations/:id/revoke", async (req) => orgService.revokeInvitation(await req.org("memberships.manage", { write: true, allowPending: true }), parseObjectId(req.params.id, "Invitation")));

  /* ---------------- monthly hapta */
  r.post("/orgs/:orgId/monthly-hapta", async (req) => monthly.setupMonthlyHapta(await req.org("org.settings.manage", { write: true, allowPending: true }), await req.body(monthly.SetupSchema)));
  r.patch("/orgs/:orgId/monthly-hapta", async (req) => monthly.changeMonthlyHapta(await req.org("org.settings.manage", { write: true, allowPending: true }), await req.body(monthly.ChangeAmountSchema)));
  r.get("/orgs/:orgId/monthly", async (req) => monthly.monthView(await req.org("installments.view"), req.queryAs(monthly.MonthQuery)));
  r.post("/orgs/:orgId/monthly/collect", async (req) => monthly.quickCollect(await req.org("payments.record", W), await req.body(monthly.QuickCollectSchema)));
  r.post("/orgs/:orgId/monthly/enroll", async (req) => {
    const ctx = await req.org("members.manage", W);
    const b = await req.body(z.object({ memberIds: z.array(z.string()).min(1).max(2000), startMonth: monthly.month.optional() }));
    return monthly.enrollInMonthlyHapta(ctx, b.memberIds.map((id) => parseObjectId(id, "Member")), b.startMonth);
  });

  /* ---------------- member savings ledger */
  r.get("/orgs/:orgId/members/:id/ledger", async (req) => {
    const ctx = await req.org("members.view");
    const data = await ledger.memberLedgerStatement(ctx, parseObjectId(req.params.id, "Member"), req.queryAs(ledger.MemberLedgerQuery.extend({ format: z.string().optional() })));
    if (wantsCsv(req.query)) {
      const t = toTable("member-ledger", data as unknown as Record<string, unknown>);
      return csvResponse(`savings-${data.member.membershipNumber}.csv`, toCsv(t.headers, t.rows));
    }
    return data;
  });
  r.get("/orgs/:orgId/me/ledger", async (req) => {
    const ctx = await req.org("self.view");
    if (!ctx.membership.memberId) throw forbidden("Your login is not linked to a member record yet");
    const data = await ledger.memberLedgerStatement(ctx, ctx.membership.memberId, req.queryAs(ledger.MemberLedgerQuery.extend({ format: z.string().optional() })));
    if (wantsCsv(req.query)) {
      const t = toTable("member-ledger", data as unknown as Record<string, unknown>);
      return csvResponse(`my-savings-${data.member.membershipNumber}.csv`, toCsv(t.headers, t.rows));
    }
    return data;
  });
  r.post("/orgs/:orgId/members/:id/opening", async (req) => ledger.setOpeningBalance(await req.org("members.balanceAdjust", W), parseObjectId(req.params.id, "Member"), await req.body(ledger.OpeningSchema)));
  r.post("/orgs/:orgId/members/:id/adjustments", async (req) => ledger.adjustMemberBalance(await req.org("members.balanceAdjust", W), parseObjectId(req.params.id, "Member"), await req.body(ledger.AdjustmentSchema)));
  r.get("/orgs/:orgId/member-funds/reconcile", async (req) => {
    const ctx = await req.org("reports.view");
    return ledger.reconcileMemberFunds(ctx.orgId);
  });

  /* ---------------- interest */
  r.post("/orgs/:orgId/interest/preview", async (req) => interest.previewInterest(await req.org("interest.distribute"), await req.body(interest.PreviewSchema)));
  r.post("/orgs/:orgId/interest/runs", async (req) => interest.finalizeInterest(await req.org("interest.distribute", W), await req.body(interest.FinalizeSchema)));
  r.get("/orgs/:orgId/interest/runs", async (req) => interest.listInterestRuns(await req.org("reports.view")));
  r.get("/orgs/:orgId/interest/runs/:id", async (req) => interest.getInterestRun(await req.org("reports.view"), parseObjectId(req.params.id, "Interest distribution")));

  /* ---------------- withdrawals */
  r.get("/orgs/:orgId/withdrawals", async (req) => wd.listWithdrawals(await req.org("members.view"), req.queryAs(wd.WithdrawalListQuery)));
  r.post("/orgs/:orgId/withdrawals", async (req) => wd.recordWithdrawal(await req.org("withdrawals.record", W), await req.body(wd.WithdrawalSchema)));
  r.get("/orgs/:orgId/withdrawals/:id", async (req) => {
    const ctx = await req.org("self.view");
    const restrict = ctx.can("members.view") ? undefined : (ctx.membership.memberId ?? null);
    return wd.getWithdrawal(ctx, parseObjectId(req.params.id, "Withdrawal"), restrict);
  });
  r.post("/orgs/:orgId/withdrawals/:id/reverse", async (req) => {
    const b = await req.body(z.object({ reason }));
    return wd.reverseWithdrawal(await req.org("transactions.adjust", W), parseObjectId(req.params.id, "Withdrawal"), b.reason);
  });
  r.get("/orgs/:orgId/me/withdrawals", async (req) => {
    const ctx = await req.org("self.view");
    if (!ctx.membership.memberId) return { items: [], total: 0, totalPaidPaise: 0, page: 1, pageSize: 25 };
    return wd.listWithdrawals(ctx, req.queryAs(wd.WithdrawalListQuery), ctx.membership.memberId);
  });

  /* ---------------- loans from the Mandal fund */
  r.get("/orgs/:orgId/fund-loans", async (req) => fl.listFundLoans(await req.org("members.view"), req.queryAs(fl.FundLoanListQuery)));
  r.post("/orgs/:orgId/fund-loans", async (req) => fl.giveFundLoan(await req.org("withdrawals.record", W), await req.body(fl.GiveLoanSchema)));
  r.get("/orgs/:orgId/fund-loans/month", async (req) => {
    const ctx = await req.org("installments.view");
    return fl.fundLoanMonth(ctx, req.query.get("month") ?? undefined);
  });
  r.get("/orgs/:orgId/fund-loans/:id", async (req) => {
    const ctx = await req.org("self.view");
    const restrict = ctx.can("members.view") ? undefined : (ctx.membership.memberId ?? null);
    return fl.getFundLoan(ctx, parseObjectId(req.params.id, "Upad"), restrict);
  });
  r.post("/orgs/:orgId/fund-loans/:id/payments", async (req) => {
    const ctx = await req.org("payments.record", W);
    const res = await fl.receiveFundLoanPayment(ctx, parseObjectId(req.params.id, "Upad"), await req.body(fl.LoanPaymentSchema));
    // the member may have reported this same payment: close their claim so it isn't verified twice
    const settledClaimId = res.duplicate ? null : await mp.settleMatchingClaim(ctx, res.payment);
    return { ...res, settledClaimId };
  });
  r.post("/orgs/:orgId/fund-loans/:id/cancel", async (req) => {
    const b = await req.body(z.object({ reason }));
    return fl.cancelFundLoan(await req.org("transactions.adjust", W), parseObjectId(req.params.id, "Upad"), b.reason);
  });
  r.post("/orgs/:orgId/fund-loan-payments/:id/reverse", async (req) => {
    const b = await req.body(z.object({ reason }));
    return fl.reverseFundLoanPayment(await req.org("transactions.adjust", W), parseObjectId(req.params.id, "Payment"), b.reason);
  });
  /* upad requests: members ask, admins approve / reject */
  r.get("/orgs/:orgId/me/upad-requests", async (req) => ur.myUpadRequests(await req.org("self.view")));
  r.post("/orgs/:orgId/me/upad-requests", async (req) => ur.requestUpad(await req.org("self.view", W), await req.body(ur.UpadRequestSchema)));
  r.post("/orgs/:orgId/me/upad-requests/:id/cancel", async (req) => ur.cancelMyUpadRequest(await req.org("self.view", W), parseObjectId(req.params.id, "Request")));
  r.get("/orgs/:orgId/upad-requests", async (req) => ur.listUpadRequests(await req.org("withdrawals.record"), req.queryAs(ur.UpadRequestListQuery)));
  r.post("/orgs/:orgId/upad-requests/:id/approve", async (req) => ur.approveUpadRequest(await req.org("withdrawals.record", W), parseObjectId(req.params.id, "Request"), await req.body(ur.ApproveUpadSchema)));
  r.post("/orgs/:orgId/upad-requests/:id/reject", async (req) => {
    const b = await req.body(z.object({ reason }));
    return ur.rejectUpadRequest(await req.org("withdrawals.record", W), parseObjectId(req.params.id, "Request"), b.reason);
  });
  /* "I have paid": options, and upad payments reported by members */
  r.get("/orgs/:orgId/me/payment-options", async (req) => mp.myPaymentOptions(await req.org("self.submitPayment")));
  r.get("/orgs/:orgId/me/upad-payments", async (req) => mp.myUpadClaims(await req.org("self.view")));
  r.post("/orgs/:orgId/me/upad-payments", async (req) => mp.submitUpadClaim(await req.org("self.submitPayment", W), await req.body(mp.UpadClaimSchema)));
  r.get("/orgs/:orgId/upad-payments", async (req) => mp.listUpadClaims(await req.org("payments.view"), req.query.get("status") === "all" ? "all" : "pending"));
  /* ---------------- how long the Mandal runs, closing & settlement (admin) */
  r.patch("/orgs/:orgId/end-month", async (req) => settlement.setEndMonth(await req.org("org.settings.manage", W), await req.body(settlement.EndMonthSchema)));
  r.get("/orgs/:orgId/settlement", async (req) => settlement.settlementPreview(await req.org("org.settings.manage")));
  r.post("/orgs/:orgId/settlement/waive-hapta", async (req) => settlement.waiveUnpaidHapta(await req.org("org.settings.manage", W), await req.body(settlement.WaiveSchema)));
  r.post("/orgs/:orgId/settlement/start", async (req) => settlement.startSettlement(await req.org("org.settings.manage", W), await req.body(settlement.StartSchema)));
  r.post("/orgs/:orgId/settlement/payouts/:memberId", async (req) => settlement.payoutMember(await req.org("org.settings.manage", W), parseObjectId(req.params.memberId, "Member"), await req.body(settlement.PayoutSchema)));
  r.post("/orgs/:orgId/settlement/close", async (req) => settlement.closeMandal(await req.org("org.settings.manage", W), await req.body(settlement.CloseSchema)));
  r.post("/orgs/:orgId/upad-payments/:id/settle", async (req) => mp.settleUpadClaim(await req.org("payments.verify", W), parseObjectId(req.params.id, "Payment")));
  r.post("/orgs/:orgId/upad-payments/:id/verify", async (req) => mp.verifyUpadClaim(await req.org("payments.verify", W), parseObjectId(req.params.id, "Payment"), await req.body(mp.VerifyClaimSchema)));
  r.post("/orgs/:orgId/upad-payments/:id/reject", async (req) => {
    const b = await req.body(z.object({ reason }));
    return mp.rejectUpadClaim(await req.org("payments.verify", W), parseObjectId(req.params.id, "Payment"), b.reason);
  });
  r.get("/orgs/:orgId/me/fund-loans", async (req) => {
    const ctx = await req.org("self.view");
    if (!ctx.membership.memberId) return { items: [], totals: { outstandingPaise: 0, interestDuePaise: 0, interestPaidPaise: 0, activeLoans: 0 }, defaultMonthlyRate: ctx.org.settings.fundLoans.defaultMonthlyRate };
    return fl.listFundLoans(ctx, { status: "all" }, ctx.membership.memberId);
  });

  /* ---------------- cash book */
  r.get("/orgs/:orgId/cashbook", async (req) => {
    const ctx = await req.org("accounts.view");
    const data = await cash.cashBook(ctx, req.queryAs(cash.CashBookQuery.extend({ format: z.string().optional() })));
    if (wantsCsv(req.query)) {
      const t = toTable("cashbook", data as unknown as Record<string, unknown>);
      return csvResponse(`cashbook-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(t.headers, t.rows));
    }
    return data;
  });
  r.post("/orgs/:orgId/cashbook/entries", async (req) => cash.recordCashEntry(await req.org("accounts.manage", W), await req.body(cash.CashEntrySchema)));

  /* ---------------- monthly report */
  r.get("/orgs/:orgId/monthly-report", async (req) => {
    const ctx = await req.org("reports.view");
    const data = await monthlyReport(ctx, req.query.get("month") ?? undefined);
    if (wantsCsv(req.query)) {
      const t = toTable("monthly", data as unknown as Record<string, unknown>);
      return csvResponse(`monthly-${data.month}.csv`, toCsv(t.headers, t.rows));
    }
    return data;
  });
}
