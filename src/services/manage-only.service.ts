import { z } from "zod";
import { cols } from "@/lib/collections";
import { withTransaction } from "@/lib/db";
import { audit } from "@/lib/audit";
import { badRequest, conflict, forbidden } from "@/lib/errors";
import type { OrgContext } from "@/lib/auth";
import { optText } from "@/validators/common";
import { updateMembership } from "./organization.service";

/**
 * "Only manage this Mandal": an admin or manager who looks after the Mandal but doesn't save in it.
 *
 * Their login and role stay (they still show under Users and can do everything their role allows),
 * but they have no member record: not in the members list, no hapta, not in the totals or the
 * share-out. A member record that has never had money in it is deleted; one that has left the
 * Mandal is only unlinked (it stays as history). A member record with money in it has to be
 * settled first with "Leave the Mandal" — money is never deleted here.
 */

const MANAGING_ROLES = new Set(["admin", "manager"]);

async function ownRecord(ctx: OrgContext) {
  if (!ctx.membership.memberId) return null;
  const c = await cols();
  return c.members.findOne({ _id: ctx.membership.memberId, organizationId: ctx.orgId });
}

/** What money (if any) the member record has: anything here means it can't simply be deleted. */
async function moneyOn(ctx: OrgContext, memberId: NonNullable<OrgContext["membership"]["memberId"]>) {
  const c = await cols();
  const q = { organizationId: ctx.orgId, memberId };
  const one = { limit: 1 };
  const [ledger, payments, upads, loans, withdrawals, claims, paidHapta, txns, donations] = await Promise.all([
    c.memberLedger.countDocuments(q, one),
    c.payments.countDocuments(q, one),
    c.fundLoans.countDocuments(q, one),
    c.loans.countDocuments(q, one),
    c.withdrawals.countDocuments(q, one),
    c.upadPaymentClaims.countDocuments({ ...q, status: "pending" }, one),
    c.installments.countDocuments({ ...q, $or: [{ paidPaise: { $gt: 0 } }, { penaltyPaidPaise: { $gt: 0 } }] }, one),
    c.financialTransactions.countDocuments(q, one),
    c.donations.countDocuments(q, one),
  ]);
  const out: string[] = [];
  if (paidHapta || payments) out.push("hapta paid");
  if (ledger || txns) out.push("savings entries");
  if (upads || loans) out.push("upad");
  if (withdrawals) out.push("withdrawals");
  if (claims) out.push("an upad payment waiting to be checked");
  if (donations) out.push("donations");
  return out;
}

export async function manageOnlyStatus(ctx: OrgContext) {
  const managing = MANAGING_ROLES.has(ctx.membership.role);
  const m = await ownRecord(ctx);
  const blockers: string[] = [];
  let money: string[] = [];
  if (!managing) blockers.push("Only an admin or manager can manage a Mandal without being a member");
  if (m && m.status !== "left") {
    money = await moneyOn(ctx, m._id);
    if (money.length) {
      blockers.push(`Your member record has ${money.join(", ")}. Settle it first with "Leave the Mandal" on your member page — then you can stay on only to manage.`);
    }
    if (m.leaving?.status === "in_progress") blockers.push("Your leaving is half done — finish it on your member page first");
  }
  if (ctx.org.settings.settlement) blockers.push("The Mandal is being closed");
  return {
    role: ctx.membership.role,
    isMember: !!m,
    member: m ? { _id: m._id, name: m.name, membershipNumber: m.membershipNumber, status: m.status } : null,
    /** what will happen: the record is deleted, or (after leaving) only unlinked */
    action: !m ? null : m.status === "left" ? ("unlink" as const) : ("delete" as const),
    money,
    canSwitch: !!m && blockers.length === 0,
    blockers,
    canAddBack: !m && ctx.can("memberships.manage"),
  };
}

export const ManageOnlySchema = z.object({ reason: optText(300) });

export async function becomeManageOnly(ctx: OrgContext, input: z.infer<typeof ManageOnlySchema>) {
  if (!MANAGING_ROLES.has(ctx.membership.role)) throw forbidden("Only an admin or manager can manage a Mandal without being a member");
  const st = await manageOnlyStatus(ctx);
  if (!st.isMember) return { ok: true, already: true };
  if (st.blockers.length) throw conflict(st.blockers[0]);
  const c = await cols();
  const m = (await ownRecord(ctx))!;
  const q = { organizationId: ctx.orgId, memberId: m._id };
  const now = new Date();
  await withTransaction(async (session) => {
    // unlink first: a second (or concurrent) request finds no record and stops
    const r = await c.organizationMemberships.updateOne({ _id: ctx.membership._id, memberId: m._id }, { $set: { memberId: null, updatedAt: now } }, { session });
    if (r.modifiedCount !== 1) throw conflict("This was already done — reload the page");
    if (st.action === "delete") {
      // no money on it: the record, its unpaid hapta months and enrolments go
      await c.installments.deleteMany(q, { session });
      await c.memberSchemeEnrollments.deleteMany(q, { session });
      await c.upadRequests.deleteMany(q, { session });
      await c.upadPaymentClaims.deleteMany(q, { session });
      await c.members.deleteOne({ _id: m._id, organizationId: ctx.orgId }, { session });
    } else {
      // left the Mandal: the record stays as history, without the login
      await c.members.updateOne({ _id: m._id }, { $set: { userId: null, updatedAt: now } }, { session });
    }
    await audit(
      {
        organizationId: ctx.orgId,
        actorId: ctx.user._id,
        action: "membership.manage_only",
        entityType: "membership",
        entityId: ctx.membership._id,
        before: { memberId: m._id, name: m.name, membershipNumber: m.membershipNumber, status: m.status },
        after: { memberId: null, recordDeleted: st.action === "delete" },
        reason: input.reason,
      },
      session,
    );
  });
  ctx.membership.memberId = null;
  return { ok: true, already: false, recordDeleted: st.action === "delete" };
}

export const AddMeBackSchema = z.object({ haptaStartMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() });

/** Undo: the admin becomes a member again (a new member record, enrolled in the monthly hapta). */
export async function addMeAsMember(ctx: OrgContext, input: z.infer<typeof AddMeBackSchema>) {
  if (ctx.membership.memberId) throw badRequest("You are already a member of this Mandal");
  return updateMembership(ctx, ctx.membership._id, { action: "link_member", createMember: true, haptaStartMonth: input.haptaStartMonth, reason: "Added themselves as a member again" });
}
