import { formatMoney } from "@/lib/currency";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { cols } from "@/lib/collections";
import { audit } from "@/lib/audit";
import { badRequest, conflict, forbidden, isDuplicateKeyError, notFound } from "@/lib/errors";
import { todayIn } from "@/lib/dates";
import type { OrgContext } from "@/lib/auth";
import type { UpadRequestDoc } from "@/types/models";
import { dateOnly, idempotencyKey, money, optText, rateString } from "@/validators/common";
import { balanceOf } from "./account.service";
import { fundLoanTotals, giveFundLoan } from "./fund-loan.service";
import { notifyMember, notifyRoles } from "./notification.service";
import { copy } from "./notification-copy";

/**
 * Members ask for upad from the app; an admin approves (which gives the upad) or rejects.
 * A request can't be more than the cash the Mandal has available — checked when the request is
 * made, and again when it is approved (the Mandal never lends more cash than it holds).
 * One open request per member at a time.
 */

/** Cash the Mandal holds right now, across its active cash / bank / UPI accounts. */
export async function availableCashPaise(orgId: ObjectId) {
  const c = await cols();
  const accounts = await c.financialAccounts.find({ organizationId: orgId, isActive: true }, { projection: { _id: 1 } }).toArray();
  let total = 0;
  for (const a of accounts) total += await balanceOf(orgId, a._id);
  return Math.max(0, total);
}

export const UpadRequestSchema = z.object({
  amount: money(),
  purpose: optText(300),
  idempotencyKey,
});

function requireLinkedMember(ctx: OrgContext) {
  if (!ctx.membership.memberId) throw forbidden("Your login is not linked to a member record yet — ask the admin");
  return ctx.membership.memberId;
}

export async function requestUpad(ctx: OrgContext, input: z.infer<typeof UpadRequestSchema>) {
  const memberId = requireLinkedMember(ctx);
  if (!ctx.org.settings.fundLoans.allowMemberRequests) throw forbidden("This Mandal doesn't take upad requests in the app — speak to the admin");
  const c = await cols();
  const prior = await c.upadRequests.findOne({ organizationId: ctx.orgId, idempotencyKey: input.idempotencyKey });
  if (prior) return { request: prior, duplicate: true };
  const member = await c.members.findOne({ _id: memberId, organizationId: ctx.orgId }, { projection: { status: 1, name: 1 } });
  if (!member || member.status !== "active") throw forbidden("Only active members can request upad");
  const available = await availableCashPaise(ctx.orgId);
  if (input.amount > available) throw badRequest(available > 0 ? `Only ${formatMoney(available, ctx.org.settings.currency)} is available in the Mandal right now` : "The Mandal has no cash available for upad right now");
  const now = new Date();
  const doc: UpadRequestDoc = {
    _id: new ObjectId(),
    organizationId: ctx.orgId,
    memberId,
    requestedBy: ctx.user._id,
    amountPaise: input.amount,
    purpose: input.purpose,
    status: "pending",
    availableAtRequestPaise: available,
    decidedBy: null,
    decidedAt: null,
    loanId: null,
    idempotencyKey: input.idempotencyKey,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await c.upadRequests.insertOne(doc);
  } catch (e) {
    if (isDuplicateKeyError(e)) {
      const again = await c.upadRequests.findOne({ organizationId: ctx.orgId, idempotencyKey: input.idempotencyKey });
      if (again) return { request: again, duplicate: true };
      throw conflict("You already have an upad request waiting for approval");
    }
    throw e;
  }
  await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "upadRequest.create", entityType: "upadRequest", entityId: doc._id, after: { memberId, amountPaise: input.amount } });
  await notifyRoles(ctx.orgId, ["admin"], {
    type: "upadRequest.new",
    copy: copy("upadRequest.new", { member: member.name, amountPaise: input.amount, purpose: input.purpose ?? "" }, ctx.org.settings.currency),
    link: `/org/${ctx.orgId}/fund-loans`,
    dedupeKey: `upadreq:${doc._id}`,
  });
  return { request: doc, duplicate: false };
}

export async function myUpadRequests(ctx: OrgContext) {
  const memberId = ctx.membership.memberId;
  const c = await cols();
  const [items, available, upad] = await Promise.all([
    memberId ? c.upadRequests.find({ organizationId: ctx.orgId, memberId }).sort({ createdAt: -1 }).limit(50).toArray() : Promise.resolve([] as UpadRequestDoc[]),
    availableCashPaise(ctx.orgId),
    fundLoanTotals(ctx.org),
  ]);
  // why "available" is less than the Mandal fund: upad already given out isn't cash in hand
  return { items, availablePaise: available, upadOutPaise: upad.outstandingPaise, fundPaise: available + upad.outstandingPaise, allowRequests: ctx.org.settings.fundLoans.allowMemberRequests, linked: !!memberId };
}

export async function cancelMyUpadRequest(ctx: OrgContext, id: ObjectId) {
  const memberId = requireLinkedMember(ctx);
  const c = await cols();
  const r = await c.upadRequests.updateOne({ _id: id, organizationId: ctx.orgId, memberId, status: "pending" }, { $set: { status: "cancelled", decidedAt: new Date(), updatedAt: new Date() } });
  if (r.modifiedCount !== 1) throw notFound("Pending request");
  await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "upadRequest.cancel", entityType: "upadRequest", entityId: id });
  return { ok: true };
}

export const UpadRequestListQuery = z.object({ status: z.enum(["pending", "approved", "rejected", "cancelled", "all"]).default("pending") });

export async function listUpadRequests(ctx: OrgContext, q: z.infer<typeof UpadRequestListQuery>) {
  const c = await cols();
  const filter: Record<string, unknown> = { organizationId: ctx.orgId };
  if (q.status !== "all") filter.status = q.status;
  const items = await c.upadRequests.find(filter).sort({ createdAt: -1 }).limit(200).toArray();
  const members = await c.members.find({ _id: { $in: items.map((i) => i.memberId) } }, { projection: { name: 1, membershipNumber: 1, balancePaise: 1 } }).toArray();
  const [available, upad] = await Promise.all([availableCashPaise(ctx.orgId), fundLoanTotals(ctx.org)]);
  return {
    items: items.map((i) => ({ ...i, member: members.find((m) => m._id.equals(i.memberId)) ?? null, withinAvailable: i.amountPaise <= available })),
    availablePaise: available,
    upadOutPaise: upad.outstandingPaise,
    fundPaise: available + upad.outstandingPaise,
  };
}

export const ApproveUpadSchema = z.object({
  monthlyRate: rateString.optional(),
  date: dateOnly.optional(),
  accountId: z.string().optional(),
});

/** Approve: gives the upad (same rules as "Give upad", incl. the cash check) and links it. */
export async function approveUpadRequest(ctx: OrgContext, id: ObjectId, input: z.infer<typeof ApproveUpadSchema>) {
  const c = await cols();
  const req = await c.upadRequests.findOne({ _id: id, organizationId: ctx.orgId });
  if (!req) throw notFound("Request");
  if (req.status !== "pending") throw conflict(`This request is already ${req.status}`);
  // claim it first so the member can't cancel it while the upad is being given
  const claimed = await c.upadRequests.updateOne({ _id: id, status: "pending" }, { $set: { status: "approved", decidedBy: ctx.user._id, decidedAt: new Date(), updatedAt: new Date() } });
  if (claimed.modifiedCount !== 1) throw conflict("This request was just changed — refresh and try again");
  try {
    const { loan } = await giveFundLoan(ctx, {
      memberId: req.memberId.toHexString(),
      amount: req.amountPaise,
      date: input.date ?? todayIn(ctx.org.settings.timezone),
      monthlyRate: input.monthlyRate,
      note: req.purpose ? `Requested: ${req.purpose}` : "Requested in the app",
      accountId: input.accountId,
      idempotencyKey: `upadreq:${id.toHexString()}`,
    });
    await c.upadRequests.updateOne({ _id: id }, { $set: { loanId: loan._id, updatedAt: new Date() } });
    await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "upadRequest.approve", entityType: "upadRequest", entityId: id, after: { loanId: loan._id, number: loan.number } });
    return { ok: true, loanId: loan._id, number: loan.number };
  } catch (e) {
    // couldn't give it (e.g. not enough cash any more) → back to pending
    await c.upadRequests.updateOne({ _id: id, status: "approved", loanId: null }, { $set: { status: "pending", decidedBy: null, decidedAt: null, updatedAt: new Date() } });
    throw e;
  }
}

export async function rejectUpadRequest(ctx: OrgContext, id: ObjectId, reasonText: string) {
  const c = await cols();
  const req = await c.upadRequests.findOne({ _id: id, organizationId: ctx.orgId });
  if (!req) throw notFound("Request");
  const r = await c.upadRequests.updateOne({ _id: id, status: "pending" }, { $set: { status: "rejected", decisionReason: reasonText, decidedBy: ctx.user._id, decidedAt: new Date(), updatedAt: new Date() } });
  if (r.modifiedCount !== 1) throw conflict(`This request is already ${req.status}`);
  await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "upadRequest.reject", entityType: "upadRequest", entityId: id, reason: reasonText });
  await notifyMember(ctx.orgId, req.memberId, { type: "upadRequest.rejected", copy: copy("upadRequest.rejected", { amountPaise: req.amountPaise, reason: reasonText }, ctx.org.settings.currency), link: `/org/${ctx.orgId}/my`, dedupeKey: `upadreq-rej:${id}` });
  return { ok: true };
}
