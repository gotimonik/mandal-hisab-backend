import { z } from "zod";
import { cols } from "@/lib/collections";
import { withTransaction } from "@/lib/db";
import { audit } from "@/lib/audit";
import { badRequest, conflict } from "@/lib/errors";
import type { OrgContext } from "@/lib/auth";
import { backupStatus } from "./backup.service";
import { notify, notifyOrgMembers } from "./notification.service";
import { copy } from "./notification-copy";

/**
 * Reset a Mandal's money: start the hisab afresh, keeping the people.
 *
 * For a Mandal whose old hisab was partly typed in before it was brought in properly (see
 * opening-import.service): every money record goes — hapta payments and receipts, interest runs,
 * upad and its interest, withdrawals, cash book, expenses, donations, loans and the ledger behind
 * them. Hapta months are back to unpaid and every balance is ₹0. The import screen opens again.
 *
 * Kept: members and their shares, logins and roles, hapta schemes, settings, meetings,
 * notifications and the audit log (which records the reset and what was removed).
 * Personal Hisab books drop the copied entries on their next sync (their transactions are gone).
 *
 * With removeMembers, the people go too: every member record but the resetting admin's own, their
 * hapta, every other login's link to the Mandal and all invitations (the accounts stay — people
 * can join again). Removed people are told.
 *
 * Mandal admin only, after a backup taken in the last 24 hours with nothing recorded since, and
 * with the Mandal's name typed to confirm. Not while the Mandal is being closed.
 */

const MONEY = [
  "payments",
  "donations",
  "expenses",
  "financialTransactions",
  "ledgerEntries",
  "receipts",
  "loans",
  "loanRepayments",
  "interestCalculations",
  "memberLedger",
  "interestRuns",
  "withdrawals",
  "fundLoans",
  "fundLoanDues",
  "fundLoanPayments",
  "upadRequests",
  "upadPaymentClaims",
  "upadInterestPayments",
] as const;

const BACKUP_MAX_AGE_MS = 24 * 3600_000;

export const MoneyResetSchema = z.object({
  /** the Mandal's name, typed to confirm */
  confirmName: z.string().trim().min(1, "Type the Mandal's name"),
  reason: z.string().trim().min(3, "Please give a reason").max(300),
  /**
   * Also remove every member and unlink every login from the Mandal (the accounts themselves stay;
   * people can join again with the code or an invitation). Only the person resetting stays, as
   * admin, with their own member record.
   */
  removeMembers: z.boolean().default(false),
});

const sameName = (a: string, b?: string | null) => !!b && a.trim().toLowerCase().replace(/\s+/g, " ") === b.trim().toLowerCase().replace(/\s+/g, " ");

/** The member record linked to the person resetting (kept when members are removed). */
async function ownMemberId(ctx: OrgContext) {
  return ctx.membership.memberId ?? null;
}

async function check(ctx: OrgContext) {
  const c = await cols();
  const q = { organizationId: ctx.orgId };
  const own = await ownMemberId(ctx);
  const [backup, transactions, payments, upads, interestRuns, withdrawals, otherMembers, otherLogins] = await Promise.all([
    backupStatus(ctx),
    c.financialTransactions.countDocuments(q),
    c.payments.countDocuments(q),
    c.fundLoans.countDocuments(q),
    c.interestRuns.countDocuments(q),
    c.withdrawals.countDocuments(q),
    c.members.countDocuments({ ...q, ...(own ? { _id: { $ne: own } } : {}) }),
    c.organizationMemberships.countDocuments({ ...q, userId: { $ne: ctx.user._id } }),
  ]);
  const backupFresh = !!backup.lastBackupAt && Date.now() - backup.lastBackupAt.getTime() <= BACKUP_MAX_AGE_MS && !backup.changedSinceBackup;
  const blockers: string[] = [];
  if (ctx.org.status !== "active") blockers.push("The Mandal isn't active");
  if (ctx.org.settings.settlement) blockers.push("The Mandal is being closed — a reset isn't possible now");
  if (!backupFresh) blockers.push("Download a backup first (Settings → Backup). It must be from the last 24 hours, with nothing recorded since.");
  const money = transactions + payments + upads + interestRuns + withdrawals > 0 || !!ctx.org.settings.openingImport;
  return {
    blockers,
    backup: { lastBackupAt: backup.lastBackupAt, fresh: backupFresh },
    counts: { transactions, payments, upads, interestRuns, withdrawals, otherMembers, otherLogins },
    hasMoney: money,
    imported: !!ctx.org.settings.openingImport,
  };
}

export async function resetStatus(ctx: OrgContext) {
  const r = await check(ctx);
  return { canReset: r.blockers.length === 0, ...r };
}

export async function resetMoney(ctx: OrgContext, input: z.infer<typeof MoneyResetSchema>) {
  if (!sameName(input.confirmName, ctx.org.name) && !sameName(input.confirmName, ctx.org.nameEnglish)) throw badRequest(`Type the Mandal's name exactly: ${ctx.org.name}`);
  const st = await check(ctx);
  if (st.blockers.length) throw conflict(st.blockers[0]);
  const dropPeople = input.removeMembers && st.counts.otherMembers + st.counts.otherLogins > 0;
  if (!st.hasMoney && !dropPeople) throw badRequest(input.removeMembers ? "There is nothing to reset — no money and no other members" : "There is nothing to reset — no money has been recorded yet");
  const c = await cols();
  const q = { organizationId: ctx.orgId };
  const prefix = `${ctx.orgId.toHexString()}:`;
  const now = new Date();
  const own = await ownMemberId(ctx);
  // the people being unlinked, told after the reset
  const leaving = input.removeMembers ? (await c.organizationMemberships.find({ ...q, userId: { $ne: ctx.user._id }, status: "active" }, { projection: { userId: 1 } }).toArray()).map((m) => m.userId) : [];

  const removed = await withTransaction(async (session) => {
    // a concurrent reset or closing stops here
    const lock = await c.organizations.updateOne(
      { _id: ctx.orgId, "settings.settlement": { $in: [null] } },
      { $unset: { "settings.openingImport": "" }, $set: { updatedAt: now } },
      { session },
    );
    if (lock.matchedCount !== 1) throw conflict("The Mandal is being closed — a reset isn't possible now");

    const out: Record<string, number> = {};
    for (const name of MONEY) out[name] = (await c[name].deleteMany(q, { session })).deletedCount;

    // hapta months back to unpaid (amounts, shares and waivers stay as they are)
    const inst = await c.installments.updateMany(
      { ...q, $or: [{ paidPaise: { $gt: 0 } }, { penaltyPaidPaise: { $gt: 0 } }] },
      { $set: { paidPaise: 0, penaltyPaidPaise: 0, updatedAt: now }, $push: { history: { at: now, by: ctx.user._id, action: "money_reset", reason: input.reason } } },
      { session },
    );
    out.installmentsReset = inst.modifiedCount;

    // balances to ₹0; a paid joining amount is owed again; a half-done leaving is undone
    await c.members.updateMany(q, { $set: { balancePaise: 0, updatedAt: now }, $unset: { upadAdvancePaise: "" } }, { session });
    await c.members.updateMany({ ...q, "joining.status": "paid" }, [{ $set: { joining: { status: "due", since: "$joining.since" } } }], { session });
    await c.members.updateMany({ ...q, "leaving.status": "in_progress" }, { $unset: { leaving: "" } }, { session });

    // cash / UPI accounts back to ₹0 (their opening entries are gone with the rest)
    await c.financialAccounts.updateMany(q, { $set: { openingBalancePaise: 0, updatedAt: now } }, { session });

    // Personal Hisab copies of this Mandal's money (their transactions are gone; people being
    // unlinked would otherwise keep them, as their book no longer syncs with this Mandal)
    out.personalEntries = (await c.personalEntries.deleteMany({ "source.organizationId": ctx.orgId }, { session })).deletedCount;

    if (input.removeMembers) {
      // everyone but the person resetting: member records, their hapta, logins and invitations
      const others = own ? { $ne: own } : { $exists: true };
      out.members = (await c.members.deleteMany({ ...q, _id: others }, { session })).deletedCount;
      await c.installments.deleteMany({ ...q, memberId: others }, { session });
      await c.memberSchemeEnrollments.deleteMany({ ...q, memberId: others }, { session });
      out.logins = (await c.organizationMemberships.deleteMany({ ...q, userId: { $ne: ctx.user._id } }, { session })).deletedCount;
      out.invitations = (await c.invitations.deleteMany(q, { session })).deletedCount;
    }

    // receipt / voucher / upad numbers start again from 1; member numbers too when nobody else is left
    await c.counters.deleteMany({ _id: { $regex: `^${prefix}`, ...(input.removeMembers && !own ? {} : { $ne: `${prefix}member` }) } }, { session });

    await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "org.money_reset", entityType: "organization", entityId: ctx.orgId, reason: input.reason, after: { removeMembers: input.removeMembers, removed: out, backupAt: st.backup.lastBackupAt } }, session);
    return out;
  });
  ctx.org.settings.openingImport = null;

  if (input.removeMembers) {
    for (const userId of leaving) {
      await notify({ organizationId: ctx.orgId, userId, actorId: ctx.user._id, type: "org.removedOnReset", copy: copy("org.removedOnReset", { actor: ctx.user.name, mandal: ctx.org.name }, ctx.org.settings.currency), link: "/onboarding", dedupeKey: `reset-out:${now.getTime()}:${userId}` });
    }
  } else {
    await notifyOrgMembers(
      ctx.orgId,
      { actorId: ctx.user._id, type: "org.moneyReset", copy: copy("org.moneyReset", { actor: ctx.user.name }, ctx.org.settings.currency), link: `/org/${ctx.orgId}`, dedupeKey: `reset:${now.getTime()}` },
      { exceptUserIds: [ctx.user._id] },
    );
  }
  return { ok: true, removed };
}
