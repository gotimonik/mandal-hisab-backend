import { formatMoney } from "@/lib/currency";
import { ObjectId, type ClientSession } from "mongodb";
import { z } from "zod";
import { cols } from "@/lib/collections";
import { withTransaction } from "@/lib/db";
import { audit } from "@/lib/audit";
import { badRequest, conflict, isDuplicateKeyError, notFound } from "@/lib/errors";
import { todayIn, utcAddDays } from "@/lib/dates";
import type { OrgContext } from "@/lib/auth";
import type { MemberEntryKind, MemberLedgerEntryDoc, OrganizationDoc } from "@/types/models";
import { dateOnly, idempotencyKey, money, reason } from "@/validators/common";
import { ADJUSTMENT_EQUITY, MEMBER_FUNDS, OPENING_EQUITY, postTransaction } from "./ledger.service";

/**
 * Member savings ledger.
 *
 *   Member balance = opening + hapta contributions + interest credited + other credits
 *                    − withdrawals − other debits
 *
 * This is what the Mandal owes each member — NOT the Mandal's cash. In the general ledger
 * the same amounts sit in `liability:member_funds`, so Σ member balances always equals that
 * account (see reconcileMemberFunds). `members.balancePaise` is a cache maintained only here,
 * inside the same transaction as the entry, and doubles as a lock so concurrent withdrawals
 * cannot both pass the balance check.
 */

export interface MemberEntryInput {
  org: Pick<OrganizationDoc, "_id"> & { settings?: { currency?: string } };
  memberId: ObjectId;
  date: Date;
  kind: MemberEntryKind;
  creditPaise?: number;
  debitPaise?: number;
  description: string;
  period?: string;
  sourceType: MemberLedgerEntryDoc["sourceType"];
  sourceId: ObjectId;
  transactionId?: ObjectId | null;
  dedupeKey?: string;
  reversalOf?: ObjectId | null;
  createdBy: ObjectId;
  /** For debits: refuse when the member's balance would go below zero. */
  requireSufficientBalance?: boolean;
}

export async function postMemberEntry(input: MemberEntryInput, session: ClientSession): Promise<{ entry: MemberLedgerEntryDoc; balanceAfterPaise: number }> {
  const credit = input.creditPaise ?? 0;
  const debit = input.debitPaise ?? 0;
  if (!Number.isSafeInteger(credit) || !Number.isSafeInteger(debit) || credit < 0 || debit < 0 || (credit > 0) === (debit > 0)) {
    throw new Error("A member entry must be exactly one positive credit or debit");
  }
  const c = await cols();
  const delta = credit - debit;
  const filter: Record<string, unknown> = { _id: input.memberId, organizationId: input.org._id };
  if (input.requireSufficientBalance && debit > 0) filter.$expr = { $gte: [{ $ifNull: ["$balancePaise", 0] }, debit] };
  const updated = await c.members.findOneAndUpdate(filter, { $inc: { balancePaise: delta }, $set: { updatedAt: new Date() } }, { session, returnDocument: "after", projection: { balancePaise: 1, name: 1 } });
  if (!updated) {
    const m = await c.members.findOne({ _id: input.memberId, organizationId: input.org._id }, { session, projection: { balancePaise: 1 } });
    if (!m) throw notFound("Member");
    throw badRequest(`Amount exceeds the member's available balance of ${formatMoney(m.balancePaise ?? 0, input.org.settings?.currency)}`);
  }
  const entry: MemberLedgerEntryDoc = {
    _id: new ObjectId(),
    organizationId: input.org._id,
    memberId: input.memberId,
    date: input.date,
    kind: input.kind,
    creditPaise: credit,
    debitPaise: debit,
    description: input.description,
    period: input.period,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    transactionId: input.transactionId ?? null,
    ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
    reversalOf: input.reversalOf ?? null,
    createdBy: input.createdBy,
    createdAt: new Date(),
  };
  await c.memberLedger.insertOne(entry, { session });
  return { entry, balanceAfterPaise: updated.balancePaise ?? delta };
}

/** Balances of all members (or one) as of the end of `asOf` (inclusive), from the ledger itself. */
export async function balancesAsOf(orgId: ObjectId, asOf: Date, opts: { kinds?: MemberEntryKind[]; memberId?: ObjectId } = {}) {
  const c = await cols();
  const match: Record<string, unknown> = { organizationId: orgId, date: { $lte: asOf } };
  if (opts.kinds) match.kind = { $in: opts.kinds };
  if (opts.memberId) match.memberId = opts.memberId;
  const rows = await c.memberLedger
    .aggregate<{ _id: ObjectId; bal: number }>([{ $match: match }, { $group: { _id: "$memberId", bal: { $sum: { $subtract: ["$creditPaise", "$debitPaise"] } } } }])
    .toArray();
  return new Map(rows.map((r) => [r._id.toHexString(), r.bal]));
}

/** Check Σ member ledger == cached balances == general-ledger member funds. */
export async function reconcileMemberFunds(orgId: ObjectId) {
  const c = await cols();
  const [ledger] = await c.memberLedger.aggregate<{ t: number }>([{ $match: { organizationId: orgId } }, { $group: { _id: null, t: { $sum: { $subtract: ["$creditPaise", "$debitPaise"] } } } }]).toArray();
  const [cached] = await c.members.aggregate<{ t: number }>([{ $match: { organizationId: orgId } }, { $group: { _id: null, t: { $sum: { $ifNull: ["$balancePaise", 0] } } } }]).toArray();
  const [gl] = await c.ledgerEntries.aggregate<{ t: number }>([{ $match: { organizationId: orgId, accountKey: MEMBER_FUNDS } }, { $group: { _id: null, t: { $sum: { $subtract: ["$creditPaise", "$debitPaise"] } } } }]).toArray();
  const r = { memberLedgerPaise: ledger?.t ?? 0, cachedBalancesPaise: cached?.t ?? 0, generalLedgerPaise: gl?.t ?? 0 };
  return { ...r, reconciled: r.memberLedgerPaise === r.cachedBalancesPaise && r.memberLedgerPaise === r.generalLedgerPaise };
}

/* ------------------------------------------------------------------ statement */

export const MemberLedgerQuery = z.object({
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  kind: z.enum(["opening", "hapta", "interest", "withdrawal", "adjustment"]).optional(),
});

/** A member's savings statement with opening balance and running balance. */
export async function memberLedgerStatement(ctx: OrgContext, memberId: ObjectId, q: z.infer<typeof MemberLedgerQuery>) {
  const c = await cols();
  const member = await c.members.findOne({ _id: memberId, organizationId: ctx.orgId }, { projection: { searchText: 0 } });
  if (!member) throw notFound("Member");
  const to = q.to ?? todayIn(ctx.org.settings.timezone);
  const match: Record<string, unknown> = { organizationId: ctx.orgId, memberId, date: { ...(q.from ? { $gte: q.from } : {}), $lte: to } };
  if (q.kind) match.kind = q.kind;
  const opening = q.from && !q.kind ? (await balancesAsOf(ctx.orgId, utcAddDays(q.from, -1), { memberId })).get(memberId.toHexString()) ?? 0 : 0;
  const entries = await c.memberLedger.find(match).sort({ date: 1, createdAt: 1, _id: 1 }).limit(5000).toArray();
  const users = await c.users.find({ _id: { $in: [...new Set(entries.map((e) => e.createdBy.toHexString()))].map((h) => new ObjectId(h)) } }, { projection: { name: 1 } }).toArray();
  const um = new Map(users.map((u) => [u._id.toHexString(), u.name]));
  let bal = opening;
  const lines = entries.map((e) => {
    bal += e.creditPaise - e.debitPaise;
    return { ...e, balancePaise: bal, recordedByName: um.get(e.createdBy.toHexString()) ?? null };
  });
  const sum = (k: MemberEntryKind) => entries.filter((e) => e.kind === k).reduce((s, e) => s + e.creditPaise - e.debitPaise, 0);
  return {
    member,
    from: q.from ?? null,
    to,
    openingBalancePaise: opening,
    lines: q.kind ? lines.map(({ balancePaise: _b, ...l }) => l) : lines,
    totals: {
      openingCreditsPaise: sum("opening"),
      haptaPaise: sum("hapta"),
      interestPaise: sum("interest"),
      withdrawalsPaise: -sum("withdrawal"),
      adjustmentsPaise: sum("adjustment"),
    },
    closingBalancePaise: q.kind ? null : bal,
    currentBalancePaise: member.balancePaise ?? 0,
  };
}

/* ------------------------------------------------------------------ opening balance & adjustments */

export const OpeningSchema = z.object({ amount: money(), date: dateOnly, note: z.string().trim().max(300).optional() });

/**
 * Record a member's savings brought forward from before the app was used (once per member).
 * Books: Dr opening-balance equity / Cr member funds — no cash moves (the cash is recorded as
 * the cash account's own opening balance).
 */
export async function setOpeningBalance(ctx: OrgContext, memberId: ObjectId, input: z.infer<typeof OpeningSchema>) {
  const c = await cols();
  const m = await c.members.findOne({ _id: memberId, organizationId: ctx.orgId });
  if (!m) throw notFound("Member");
  try {
    return await withTransaction(async (session) => {
      const sourceId = new ObjectId();
      const txn = await postTransaction(
        {
          org: ctx.org,
          type: "member_opening",
          date: input.date,
          description: `Opening balance — ${m.name}`,
          lines: [
            { accountKey: OPENING_EQUITY, debitPaise: input.amount },
            { accountKey: MEMBER_FUNDS, creditPaise: input.amount, memberId },
          ],
          createdBy: ctx.user._id,
          memberId,
          sourceType: "memberOpening",
          sourceId,
          reason: input.note,
        },
        session,
      );
      const r = await postMemberEntry(
        { org: ctx.org, memberId, date: input.date, kind: "opening", creditPaise: input.amount, description: input.note ? `Opening balance — ${input.note}` : "Opening balance brought forward", sourceType: "opening", sourceId, transactionId: txn._id, dedupeKey: `opening:${memberId.toHexString()}`, createdBy: ctx.user._id },
        session,
      );
      await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "member.opening_balance", entityType: "member", entityId: memberId, after: { amountPaise: input.amount, date: input.date } }, session);
      return { balancePaise: r.balanceAfterPaise };
    });
  } catch (e) {
    if (isDuplicateKeyError(e)) throw conflict("This member already has an opening balance. Use an adjustment to correct it.");
    throw e;
  }
}

export const AdjustmentSchema = z.object({ direction: z.enum(["credit", "debit"]), amount: money(), date: dateOnly, reason, idempotencyKey });

/**
 * Authorized correction of a member balance (audited). Books: credit → Dr adjustments equity /
 * Cr member funds; debit → the reverse. Never touches cash.
 */
export async function adjustMemberBalance(ctx: OrgContext, memberId: ObjectId, input: z.infer<typeof AdjustmentSchema>) {
  const c = await cols();
  const m = await c.members.findOne({ _id: memberId, organizationId: ctx.orgId });
  if (!m) throw notFound("Member");
  try {
    return await withTransaction(async (session) => {
      const sourceId = new ObjectId();
      const credit = input.direction === "credit";
      const txn = await postTransaction(
        {
          org: ctx.org,
          type: "member_adjustment",
          date: input.date,
          description: `Member balance ${credit ? "credit" : "debit"} — ${m.name}`,
          lines: credit
            ? [
                { accountKey: ADJUSTMENT_EQUITY, debitPaise: input.amount },
                { accountKey: MEMBER_FUNDS, creditPaise: input.amount, memberId },
              ]
            : [
                { accountKey: MEMBER_FUNDS, debitPaise: input.amount, memberId },
                { accountKey: ADJUSTMENT_EQUITY, creditPaise: input.amount },
              ],
          createdBy: ctx.user._id,
          memberId,
          sourceType: "memberAdjustment",
          sourceId,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
        },
        session,
      );
      const r = await postMemberEntry(
        { org: ctx.org, memberId, date: input.date, kind: "adjustment", creditPaise: credit ? input.amount : undefined, debitPaise: credit ? undefined : input.amount, description: `Adjustment: ${input.reason}`, sourceType: "adjustment", sourceId, transactionId: txn._id, dedupeKey: `adj:${input.idempotencyKey}`, createdBy: ctx.user._id },
        session,
      );
      await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "member.balance_adjustment", entityType: "member", entityId: memberId, after: { direction: input.direction, amountPaise: input.amount }, reason: input.reason }, session);
      return { balancePaise: r.balanceAfterPaise, duplicate: false };
    });
  } catch (e) {
    if (isDuplicateKeyError(e)) return { balancePaise: (await c.members.findOne({ _id: memberId }))?.balancePaise ?? 0, duplicate: true };
    throw e;
  }
}

