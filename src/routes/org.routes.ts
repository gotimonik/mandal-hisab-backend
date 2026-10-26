import { z } from "zod";
import type { Router } from "@/lib/http";
import { parseObjectId } from "@/lib/auth";
import { cols } from "@/lib/collections";
import { notFound } from "@/lib/errors";
import * as orgService from "@/services/organization.service";
import * as memberService from "@/services/member.service";
import * as schemeService from "@/services/scheme.service";
import * as paymentService from "@/services/payment.service";
import * as receiptService from "@/services/receipt.service";
import * as accountService from "@/services/account.service";
import { dateOnly, optText, reason } from "@/validators/common";

const W = { write: true } as const;

export function registerOrgRoutes(r: Router) {
  /* ---------------- organization & settings */
  r.get("/orgs/:orgId", async (req) => orgService.getOrganization(await req.org("org.view")));
  r.patch("/orgs/:orgId", async (req) =>
    orgService.updateOrganization(await req.org("org.settings.manage", { write: true, allowPending: true }), await req.body(orgService.UpdateOrgSchema)),
  );

  /* ---------------- app users & roles */
  r.get("/orgs/:orgId/memberships", async (req) => {
    const ctx = await req.org("memberships.manage");
    const q = req.queryAs(z.object({ status: z.enum(["pending", "active", "rejected", "deactivated"]).optional() }));
    return orgService.listMemberships(ctx, q.status);
  });
  r.patch("/orgs/:orgId/memberships/:id", async (req) =>
    orgService.updateMembership(
      await req.org("memberships.manage", { write: true, allowPending: true }),
      parseObjectId(req.params.id),
      await req.body(orgService.MembershipActionSchema),
    ),
  );
  r.post("/orgs/:orgId/invitations", async (req) =>
    orgService.createInvitation(await req.org("memberships.manage", { write: true, allowPending: true }), await req.body(orgService.InviteSchema)),
  );

  /* ---------------- members register */
  r.get("/orgs/:orgId/members", async (req) => {
    const ctx = await req.org("members.view");
    return memberService.listMembers(ctx, req.queryAs(memberService.MemberListQuery));
  });
  r.post("/orgs/:orgId/members", async (req) =>
    memberService.createMember(await req.org("members.manage", W), await req.body(memberService.MemberInputSchema)),
  );
  r.post("/orgs/:orgId/members/import", async (req) => {
    const ctx = await req.org("members.manage", W);
    const b = await req.body(z.object({ csv: z.string().min(1).max(2_000_000), dryRun: z.boolean().default(true) }));
    return memberService.importMembers(ctx, b.csv, b.dryRun);
  });
  r.get("/orgs/:orgId/members/:id", async (req) => memberService.getMember(await req.org("members.view"), parseObjectId(req.params.id, "Member")));
  r.patch("/orgs/:orgId/members/:id", async (req) =>
    memberService.updateMember(await req.org("members.manage", W), parseObjectId(req.params.id, "Member"), await req.body(memberService.MemberInputSchema.partial())),
  );

  /* ---------------- hapta schemes */
  r.get("/orgs/:orgId/schemes", async (req) => schemeService.listSchemes(await req.org("schemes.view")));
  r.post("/orgs/:orgId/schemes", async (req) =>
    schemeService.createScheme(await req.org("schemes.manage", W), await req.body(schemeService.SchemeInputSchema)),
  );
  r.get("/orgs/:orgId/schemes/:id", async (req) => schemeService.getScheme(await req.org("schemes.view"), parseObjectId(req.params.id, "Scheme")));
  r.patch("/orgs/:orgId/schemes/:id", async (req) =>
    schemeService.updateSchemeMeta(
      await req.org("schemes.manage", W),
      parseObjectId(req.params.id, "Scheme"),
      await req.body(
        z.object({
          name: z.string().trim().min(2).max(120).optional(),
          description: optText(1000),
          notes: optText(2000),
          graceDays: z.number().int().min(0).max(90).optional(),
          endDate: dateOnly.optional().nullable(),
        }),
      ),
    ),
  );
  r.post("/orgs/:orgId/schemes/:id/enroll", async (req) =>
    schemeService.enrollMembers(await req.org("schemes.manage", W), parseObjectId(req.params.id, "Scheme"), await req.body(schemeService.EnrollSchema)),
  );
  r.post("/orgs/:orgId/schemes/:id/exit", async (req) => {
    const b = await req.body(z.object({ memberId: z.string(), reason }));
    return schemeService.exitEnrollment(await req.org("schemes.manage", W), parseObjectId(req.params.id, "Scheme"), parseObjectId(b.memberId, "Member"), b.reason);
  });
  r.post("/orgs/:orgId/schemes/:id/status", async (req) =>
    schemeService.changeSchemeStatus(await req.org("schemes.manage", W), parseObjectId(req.params.id, "Scheme"), await req.body(schemeService.SchemeStatusSchema)),
  );
  r.post("/orgs/:orgId/schemes/:id/revisions", async (req) =>
    schemeService.reviseAmount(await req.org("schemes.manage", W), parseObjectId(req.params.id, "Scheme"), await req.body(schemeService.RevisionSchema)),
  );
  r.post("/orgs/:orgId/schemes/:id/overrides", async (req) =>
    schemeService.setOverride(await req.org("schemes.manage", W), parseObjectId(req.params.id, "Scheme"), await req.body(schemeService.OverrideSchema)),
  );
  r.post("/orgs/:orgId/schemes/:id/generate", async (req) => {
    const ctx = await req.org("schemes.manage", W);
    const b = await req.body(z.object({ upTo: dateOnly.optional() }));
    return schemeService.generateScheme(ctx, parseObjectId(req.params.id, "Scheme"), b.upTo);
  });

  /* ---------------- installments */
  r.get("/orgs/:orgId/installments", async (req) =>
    schemeService.listInstallments(await req.org("installments.view"), req.queryAs(schemeService.InstallmentListQuery)),
  );
  r.get("/orgs/:orgId/installments/:id", async (req) =>
    schemeService.getInstallment(await req.org("installments.view"), parseObjectId(req.params.id, "Installment")),
  );
  r.patch("/orgs/:orgId/installments/:id", async (req) =>
    schemeService.installmentAction(await req.org("installments.manage", W), parseObjectId(req.params.id, "Installment"), await req.body(schemeService.InstallmentActionSchema)),
  );

  /* ---------------- payments / collections */
  r.get("/orgs/:orgId/payments", async (req) =>
    paymentService.listPayments(await req.org("payments.view"), req.queryAs(paymentService.PaymentListQuery)),
  );
  r.post("/orgs/:orgId/payments", async (req) =>
    paymentService.recordPayment(await req.org("payments.record", W), await req.body(paymentService.RecordPaymentSchema)),
  );
  r.get("/orgs/:orgId/payments/:id", async (req) => paymentService.getPayment(await req.org("payments.view"), parseObjectId(req.params.id, "Payment")));
  r.post("/orgs/:orgId/payments/:id/verify", async (req) =>
    paymentService.verifyPayment(await req.org("payments.verify", W), parseObjectId(req.params.id, "Payment"), await req.body(paymentService.VerifySchema)),
  );
  r.post("/orgs/:orgId/payments/:id/reject", async (req) => {
    const b = await req.body(z.object({ reason }));
    return paymentService.rejectPayment(await req.org("payments.verify", W), parseObjectId(req.params.id, "Payment"), b.reason);
  });
  r.post("/orgs/:orgId/payments/:id/reverse", async (req) =>
    paymentService.reversePayment(await req.org("payments.reverse", W), parseObjectId(req.params.id, "Payment"), await req.body(paymentService.ReverseSchema)),
  );
  r.get("/orgs/:orgId/members/:id/allocation-preview", async (req) => {
    const ctx = await req.org("payments.record");
    const q = req.queryAs(z.object({ amount: z.string(), schemeId: z.string().optional() }));
    const { rupeesToPaise } = await import("@/lib/money");
    const amt = rupeesToPaise(q.amount);
    const allocs = await paymentService.autoAllocate(ctx.orgId, parseObjectId(req.params.id, "Member"), amt, q.schemeId ? parseObjectId(q.schemeId) : null);
    const c = await cols();
    const insts = await c.installments.find({ _id: { $in: allocs.map((a) => a.installmentId) }, organizationId: ctx.orgId }, { projection: { periodLabel: 1, dueDate: 1, schemeId: 1 } }).toArray();
    const schemes = await c.haptaSchemes.find({ organizationId: ctx.orgId }, { projection: { name: 1 } }).toArray();
    const im = new Map(insts.map((i) => [i._id.toHexString(), i]));
    const sm = new Map(schemes.map((x) => [x._id.toHexString(), x.name]));
    return allocs.map((a) => {
      const i = im.get(a.installmentId.toHexString());
      return { ...a, periodLabel: i?.periodLabel, dueDate: i?.dueDate, schemeName: i ? sm.get(i.schemeId.toHexString()) : undefined };
    });
  });

  /* ---------------- receipts */
  r.get("/orgs/:orgId/receipts", async (req) => {
    const ctx = await req.org("payments.view");
    const q = req.queryAs(z.object({ memberId: z.string().optional() }));
    return receiptService.listReceipts(ctx, q.memberId ? parseObjectId(q.memberId) : undefined);
  });
  r.get("/orgs/:orgId/receipts/:id", async (req) => {
    const ctx = await req.org("self.view");
    // Staff can see any receipt; members only their own.
    const restrict = ctx.can("payments.view") ? undefined : (ctx.membership.memberId ?? null);
    return receiptService.getReceipt(ctx, parseObjectId(req.params.id, "Receipt"), restrict);
  });

  /* ---------------- financial accounts, transfers, adjustments, journal */
  r.get("/orgs/:orgId/accounts", async (req) => {
    const ctx = await req.org("accounts.view");
    const q = req.queryAs(z.object({ asOf: dateOnly.optional() }));
    return accountService.listAccounts(ctx, q.asOf);
  });
  r.post("/orgs/:orgId/accounts", async (req) =>
    accountService.createAccount(await req.org("accounts.manage", W), await req.body(accountService.AccountInputSchema)),
  );
  r.patch("/orgs/:orgId/accounts/:id", async (req) =>
    accountService.updateAccount(
      await req.org("accounts.manage", W),
      parseObjectId(req.params.id, "Account"),
      await req.body(z.object({ name: z.string().trim().min(2).max(80).optional(), isActive: z.boolean().optional(), bankName: optText(100), upiId: optText(100) })),
    ),
  );
  r.post("/orgs/:orgId/transfers", async (req) =>
    accountService.transfer(await req.org("accounts.manage", W), await req.body(accountService.TransferSchema)),
  );
  r.post("/orgs/:orgId/adjustments", async (req) =>
    accountService.adjust(await req.org("transactions.adjust", W), await req.body(accountService.AdjustmentSchema)),
  );
  r.get("/orgs/:orgId/transactions", async (req) =>
    accountService.listTransactions(await req.org("transactions.view"), req.queryAs(accountService.TxnListQuery)),
  );
  r.post("/orgs/:orgId/transactions/:id/reverse", async (req) => {
    const b = await req.body(z.object({ reason }));
    return accountService.reverseGeneric(await req.org("transactions.adjust", W), parseObjectId(req.params.id, "Transaction"), b.reason);
  });

  /* ---------------- audit log */
  r.get("/orgs/:orgId/audit-logs", async (req) => {
    const ctx = await req.org("audit.view");
    const q = req.queryAs(z.object({ entityType: z.string().optional(), page: z.coerce.number().int().min(1).default(1) }));
    const c = await cols();
    const filter: Record<string, unknown> = { organizationId: ctx.orgId };
    if (q.entityType) filter.entityType = q.entityType;
    const items = await c.auditLogs.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * 50).limit(50).toArray();
    const users = await c.users.find({ _id: { $in: items.map((i) => i.actorId).filter(Boolean) as never[] } }, { projection: { name: 1 } }).toArray();
    const um = new Map(users.map((u) => [u._id.toHexString(), u.name]));
    return items.map((i) => ({ ...i, actorName: i.actorId ? um.get(i.actorId.toHexString()) ?? null : null }));
  });

  /* ---------------- member self-service */
  r.get("/orgs/:orgId/me", async (req) => {
    const ctx = await req.org("self.view");
    const memberId = ctx.membership.memberId;
    if (!memberId) return { member: null, linked: false };
    const c = await cols();
    const member = await c.members.findOne({ _id: memberId, organizationId: ctx.orgId }, { projection: { searchText: 0 } });
    if (!member) throw notFound("Member");
    return { member, linked: true };
  });
  r.get("/orgs/:orgId/me/installments", async (req) => {
    const ctx = await req.org("self.view");
    if (!ctx.membership.memberId) return { items: [], total: 0, page: 1, pageSize: 50 };
    return schemeService.listInstallments(ctx, req.queryAs(schemeService.InstallmentListQuery), ctx.membership.memberId);
  });
  r.get("/orgs/:orgId/me/payments", async (req) => {
    const ctx = await req.org("self.view");
    if (!ctx.membership.memberId) return { items: [], total: 0, totalAmountPaise: 0, page: 1, pageSize: 25 };
    return paymentService.listPayments(ctx, req.queryAs(paymentService.PaymentListQuery), ctx.membership.memberId);
  });
  r.get("/orgs/:orgId/me/receipts", async (req) => {
    const ctx = await req.org("self.view");
    if (!ctx.membership.memberId) return [];
    return receiptService.listReceipts(ctx, ctx.membership.memberId);
  });
  r.post("/orgs/:orgId/me/payment-requests", async (req) =>
    paymentService.submitMemberPaymentRequest(await req.org("self.submitPayment", W), await req.body(paymentService.MemberPaymentRequestSchema)),
  );
}
