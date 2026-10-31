import { formatMoney } from "@/lib/currency";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { cols } from "@/lib/collections";
import { withTransaction } from "@/lib/db";
import { audit } from "@/lib/audit";
import { AppError, badRequest, conflict, forbidden, isDuplicateKeyError, notFound } from "@/lib/errors";
import { todayIn } from "@/lib/dates";
import type { OrgContext } from "@/lib/auth";
import type { WithdrawalDoc } from "@/types/models";
import { dateOnly, idempotencyKey, money, optText } from "@/validators/common";
import { MEMBER_FUNDS, faKey, fyNumber, postTransaction, reverseTransaction } from "./ledger.service";
import { balanceOf, requireAccount } from "./account.service";
import { postMemberEntry } from "./member-ledger.service";
import { notifyMember } from "./notification.service";
import { copy } from "./notification-copy";

/**
 * Withdrawals: cash paid out of the Mandal to a member from their savings balance.
 * Books: Dr member funds / Cr cash. The member's balance is checked and reduced atomically
 * (conditional update on members.balancePaise inside the transaction), so two concurrent
 * withdrawals can never both pass the check. The cash account must also hold the money.
 */

export const WithdrawalSchema = z.object({
  memberId: z.string(),
  amount: money(),
  date: dateOnly,
  note: optText(300),
  accountId: z.string().optional(),
  /** Admin-only exception when the Mandal allows it; requires a reason. */
  allowExceedBalance: z.boolean().default(false),
  exceptionReason: optText(300),
  confirmDuplicate: z.boolean().default(false),
  idempotencyKey,
});

export async function recordWithdrawal(ctx: OrgContext, input: z.infer<typeof WithdrawalSchema>) {
  const c = await cols();
  const prior = await c.withdrawals.findOne({ organizationId: ctx.orgId, idempotencyKey: input.idempotencyKey });
  if (prior) return { withdrawal: prior, duplicate: true };
  if (!ObjectId.isValid(input.memberId)) throw notFound("Member");
  const memberId = new ObjectId(input.memberId);
  const member = await c.members.findOne({ _id: memberId, organizationId: ctx.orgId });
  if (!member) throw notFound("Member");
  const today = todayIn(ctx.org.settings.timezone);
  if (input.date > today) throw badRequest("A withdrawal can't be dated in the future");

  if (input.allowExceedBalance) {
    if (ctx.role !== "admin") throw forbidden("Only an admin can approve a withdrawal above the member's balance");
    if (!ctx.org.settings.withdrawals.allowExceptions) throw forbidden("Withdrawals above the member balance are disabled in settings");
    if (!input.exceptionReason || input.exceptionReason.length < 3) throw badRequest("Give a reason for the exception");
  }
  if (!input.confirmDuplicate) {
    const recent = await c.withdrawals.findOne({ organizationId: ctx.orgId, memberId, amountPaise: input.amount, date: input.date, status: "paid" });
    if (recent) throw new AppError("CONFLICT", `${formatMoney(input.amount, ctx.org.settings.currency)} was already paid to ${member.name} on this date (${recent.number}). Confirm if this is a second withdrawal.`, { code: "DUPLICATE_SUSPECTED" });
  }

  let accountId = input.accountId;
  if (!accountId) {
    const cash = await c.financialAccounts.findOne({ organizationId: ctx.orgId, type: "cash", isActive: true }, { sort: { createdAt: 1 } });
    if (!cash) throw badRequest("Create a cash account first");
    accountId = cash._id.toHexString();
  }

  try {
    const w = await withTransaction(async (session) => {
      const account = await requireAccount(ctx.orgId, accountId!, session);
      const cashBal = await balanceOf(ctx.orgId, account._id, session);
      if (cashBal < input.amount) throw badRequest(`${account.name} has only ${formatMoney(cashBal, ctx.org.settings.currency)} — the Mandal can't pay out more cash than it holds`);
      const id = new ObjectId();
      const number = await fyNumber(ctx.org, "WDL", input.date, session);
      const txn = await postTransaction(
        {
          org: ctx.org,
          type: "withdrawal",
          date: input.date,
          description: `Withdrawal ${number} — ${member.name}${input.note ? ` (${input.note})` : ""}`,
          lines: [
            { accountKey: MEMBER_FUNDS, debitPaise: input.amount, memberId },
            { accountKey: faKey(account._id), creditPaise: input.amount },
          ],
          createdBy: ctx.user._id,
          memberId,
          sourceType: "withdrawal",
          sourceId: id,
          reason: input.exceptionReason,
        },
        session,
      );
      const { entry, balanceAfterPaise } = await postMemberEntry(
        {
          org: ctx.org,
          memberId,
          date: input.date,
          kind: "withdrawal",
          debitPaise: input.amount,
          description: `Withdrawal ${number}${input.note ? ` — ${input.note}` : ""}`,
          sourceType: "withdrawal",
          sourceId: id,
          transactionId: txn._id,
          dedupeKey: `wdl:${id.toHexString()}`,
          createdBy: ctx.user._id,
          requireSufficientBalance: !input.allowExceedBalance,
        },
        session,
      );
      const doc: WithdrawalDoc = {
        _id: id,
        organizationId: ctx.orgId,
        number,
        memberId,
        amountPaise: input.amount,
        date: input.date,
        accountId: account._id,
        note: input.note,
        balanceBeforePaise: balanceAfterPaise + input.amount,
        balanceAfterPaise,
        exceptionReason: input.allowExceedBalance ? input.exceptionReason : null,
        status: "paid",
        idempotencyKey: input.idempotencyKey,
        transactionId: txn._id,
        ledgerEntryId: entry._id,
        recordedBy: ctx.user._id,
        createdAt: new Date(),
      };
      await c.withdrawals.insertOne(doc, { session });
      await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "withdrawal.record", entityType: "withdrawal", entityId: id, after: { number, amountPaise: input.amount, memberId, balanceAfterPaise }, reason: input.exceptionReason }, session);
      return doc;
    });
    await notifyMember(ctx.orgId, memberId, { actorId: ctx.user._id, type: "withdrawal.paid", copy: copy("withdrawal.paid", { amountPaise: w.amountPaise, number: w.number, balancePaise: w.balanceAfterPaise }, ctx.org.settings.currency), link: `/org/${ctx.orgId}/withdrawals/${w._id}`, dedupeKey: `wdl:${w._id}` });
    return { withdrawal: w, duplicate: false };
  } catch (e) {
    if (isDuplicateKeyError(e)) {
      const again = await c.withdrawals.findOne({ organizationId: ctx.orgId, idempotencyKey: input.idempotencyKey });
      if (again) return { withdrawal: again, duplicate: true };
    }
    throw e;
  }
}

/** Reverse a withdrawal recorded by mistake: cash and the member's balance are restored. */
export async function reverseWithdrawal(ctx: OrgContext, id: ObjectId, reasonText: string) {
  const c = await cols();
  const today = todayIn(ctx.org.settings.timezone);
  return withTransaction(async (session) => {
    const w = await c.withdrawals.findOne({ _id: id, organizationId: ctx.orgId }, { session });
    if (!w) throw notFound("Withdrawal");
    const claimed = await c.withdrawals.updateOne({ _id: id, status: "paid" }, { $set: { status: "reversed", reversalReason: reasonText } }, { session });
    if (claimed.modifiedCount !== 1) throw conflict("This withdrawal is already reversed");
    const rev = await reverseTransaction(ctx.org, w.transactionId, reasonText, ctx.user._id, today, session);
    await postMemberEntry(
      { org: ctx.org, memberId: w.memberId, date: today, kind: "withdrawal", creditPaise: w.amountPaise, description: `Reversed withdrawal ${w.number}: ${reasonText}`, sourceType: "withdrawal", sourceId: w._id, transactionId: rev._id, dedupeKey: `wdl-rev:${w._id.toHexString()}`, reversalOf: w.ledgerEntryId, createdBy: ctx.user._id },
      session,
    );
    await c.withdrawals.updateOne({ _id: id }, { $set: { reversalTransactionId: rev._id } }, { session });
    await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "withdrawal.reverse", entityType: "withdrawal", entityId: id, reason: reasonText }, session);
    return { ok: true };
  });
}

export const WithdrawalListQuery = z.object({
  memberId: z.string().optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

export async function listWithdrawals(ctx: OrgContext, q: z.infer<typeof WithdrawalListQuery>, restrictMemberId?: ObjectId) {
  const c = await cols();
  const filter: Record<string, unknown> = { organizationId: ctx.orgId };
  if (restrictMemberId) filter.memberId = restrictMemberId;
  else if (q.memberId && ObjectId.isValid(q.memberId)) filter.memberId = new ObjectId(q.memberId);
  const d: Record<string, Date> = {};
  if (q.from) d.$gte = q.from;
  if (q.to) d.$lte = q.to;
  if (Object.keys(d).length) filter.date = d;
  const [items, total, sum] = await Promise.all([
    c.withdrawals.find(filter).sort({ date: -1, createdAt: -1 }).skip((q.page - 1) * q.pageSize).limit(q.pageSize).toArray(),
    c.withdrawals.countDocuments(filter),
    c.withdrawals.aggregate<{ t: number }>([{ $match: { ...filter, status: "paid" } }, { $group: { _id: null, t: { $sum: "$amountPaise" } } }]).toArray(),
  ]);
  const members = await c.members.find({ _id: { $in: items.map((i) => i.memberId) } }, { projection: { name: 1, membershipNumber: 1 } }).toArray();
  const mm = new Map(members.map((m) => [m._id.toHexString(), m]));
  const users = await c.users.find({ _id: { $in: items.map((i) => i.recordedBy) } }, { projection: { name: 1 } }).toArray();
  const um = new Map(users.map((u) => [u._id.toHexString(), u.name]));
  return {
    items: items.map((w) => ({ ...w, member: mm.get(w.memberId.toHexString()) ?? null, recordedByName: um.get(w.recordedBy.toHexString()) ?? null })),
    total,
    totalPaidPaise: sum[0]?.t ?? 0,
    page: q.page,
    pageSize: q.pageSize,
  };
}

/** Withdrawal voucher (printable) — staff see any, members only their own. */
export async function getWithdrawal(ctx: OrgContext, id: ObjectId, restrictMemberId?: ObjectId | null) {
  const c = await cols();
  const w = await c.withdrawals.findOne({ _id: id, organizationId: ctx.orgId });
  if (!w) throw notFound("Withdrawal");
  if (restrictMemberId !== undefined && (!restrictMemberId || !w.memberId.equals(restrictMemberId))) throw notFound("Withdrawal");
  const [member, account, user] = await Promise.all([
    c.members.findOne({ _id: w.memberId }, { projection: { name: 1, membershipNumber: 1, phone: 1 } }),
    c.financialAccounts.findOne({ _id: w.accountId }, { projection: { name: 1 } }),
    c.users.findOne({ _id: w.recordedBy }, { projection: { name: 1 } }),
  ]);
  return {
    withdrawal: w,
    member,
    accountName: account?.name ?? null,
    recordedByName: user?.name ?? null,
    organization: { name: ctx.org.name, address: [ctx.org.address, ctx.org.city, ctx.org.state].filter(Boolean).join(", "), contactPhone: ctx.org.contactPhone ?? null },
  };
}
