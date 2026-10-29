import { ObjectId } from "mongodb";
import { z } from "zod";
import { cols } from "@/lib/collections";
import { withTransaction } from "@/lib/db";
import { audit } from "@/lib/audit";
import { badRequest, conflict, isDuplicateKeyError, notFound } from "@/lib/errors";
import { formatMoney } from "@/lib/currency";
import { todayIn, utcAddDays } from "@/lib/dates";
import type { OrgContext } from "@/lib/auth";
import type { MemberDoc, MemberJoining, MemberLeaving } from "@/types/models";
import { dateOnly, idempotencyKey, optText, reason } from "@/validators/common";
import { balanceOf, requireAccount } from "./account.service";
import { MEMBER_FUNDS, faKey, postTransaction } from "./ledger.service";
import { balancesAsOf, postMemberEntry } from "./member-ledger.service";
import { fundLoanTotals, receiveFundLoanPayment, splitByWeight } from "./fund-loan.service";
import { recordWithdrawal } from "./withdrawal.service";
import { exitEnrollment } from "./scheme.service";
import { primaryScheme } from "./monthly.service";

/**
 * Joining or leaving a Mandal partway through, at the price of a hapta share.
 *
 * One share is worth:
 *   savings part  — the members' hapta savings per share, up to the month before the new member's
 *                   hapta starts (they pay their own hapta from then on, so it isn't counted twice)
 *   Mandal part   — the Mandal's own money per share (cash + upad lent out − what members are owed:
 *                   interest earned, donations, …), the same amount closing would share out.
 *
 * Joining: the new member pays price × their shares. The savings part goes into their balance and
 * the Mandal part into the Mandal's own money, so they stand exactly where an existing member does.
 *
 * Leaving: the member is paid their balance + their part of the Mandal's own money, minus upad they
 * still owe. Their future hapta stops and they are marked "left".
 *
 * Members are only "shareholders" once they belong fully: active, and not still owing a joining amount.
 */

const JOINING_EQUITY = "equity:member_joining";
const LEAVING_EQUITY = "equity:member_leaving";

const sharesOf = (m: Pick<MemberDoc, "haptaShares">) => m.haptaShares ?? 1;

/** Split a signed amount by weight, exactly to the paisa (a loss is shared too). */
function splitSigned(amount: number, weights: { id: string; w: number }[]) {
  const m = splitByWeight(Math.abs(amount), weights);
  if (amount >= 0) return m;
  return new Map([...m.entries()].map(([k, v]) => [k, -v]));
}

async function defaultCashAccountId(orgId: ObjectId) {
  const c = await cols();
  const cash = await c.financialAccounts.findOne({ organizationId: orgId, type: "cash", isActive: true }, { sort: { createdAt: 1 } });
  if (!cash) throw badRequest("Create a cash account first");
  return cash._id;
}

/** The Mandal's money right now: cash, upad lent out, what members are owed, and its own part. */
async function mandalPosition(orgId: ObjectId) {
  const c = await cols();
  const [accounts, loans, members] = await Promise.all([
    c.financialAccounts.find({ organizationId: orgId }, { projection: { _id: 1 } }).toArray(),
    c.fundLoans.find({ organizationId: orgId, status: "active" }, { projection: { outstandingPaise: 1 } }).toArray(),
    c.members.find({ organizationId: orgId }, { projection: { name: 1, status: 1, haptaShares: 1, balancePaise: 1, joining: 1 } }).toArray(),
  ]);
  const cashPaise = (await Promise.all(accounts.map((a) => balanceOf(orgId, a._id)))).reduce((s, b) => s + b, 0);
  const upadOutstandingPaise = loans.reduce((s, l) => s + l.outstandingPaise, 0);
  const memberFundsPaise = members.reduce((s, m) => s + (m.balancePaise ?? 0), 0);
  const holders = members.filter((m) => m.status === "active" && m.joining?.status !== "due");
  return { cashPaise, upadOutstandingPaise, memberFundsPaise, mandalOwnPaise: cashPaise + upadOutstandingPaise - memberFundsPaise, members, holders };
}

/* ------------------------------------------------------------------ marking new members */

/**
 * Called after members are put on the monthly hapta: anyone whose hapta starts after the hapta's
 * first month joined partway through and owes a joining amount (unless already settled).
 */
export async function markJoiningDue(orgId: ObjectId, memberIds: ObjectId[]) {
  if (!memberIds.length) return 0;
  const s = await primaryScheme(orgId);
  if (!s) return 0;
  const c = await cols();
  const late = await c.memberSchemeEnrollments
    .find({ organizationId: orgId, schemeId: s._id, memberId: { $in: memberIds }, status: "active", startDate: { $gt: s.startDate } }, { projection: { memberId: 1 } })
    .toArray();
  if (!late.length) return 0;
  const r = await c.members.updateMany(
    { _id: { $in: late.map((e) => e.memberId) }, organizationId: orgId, status: "active", joining: { $exists: false } },
    { $set: { joining: { status: "due", since: new Date() } satisfies MemberJoining, updatedAt: new Date() } },
  );
  return r.modifiedCount;
}

/* ------------------------------------------------------------------ joining */

export async function joiningQuote(ctx: OrgContext, memberId: ObjectId) {
  const c = await cols();
  const member = await c.members.findOne({ _id: memberId, organizationId: ctx.orgId });
  if (!member) throw notFound("Member");
  const s = await primaryScheme(ctx.orgId);
  const enrollment = s ? await c.memberSchemeEnrollments.findOne({ organizationId: ctx.orgId, schemeId: s._id, memberId }) : null;
  const shares = sharesOf(member);
  const base = { joining: member.joining ?? null, shares, haptaStart: enrollment?.startDate ?? null, haptaFirstMonth: s?.startDate ?? null };
  if (!member.joining || member.joining.status !== "due" || !enrollment) {
    return { ...base, due: false as const, perShareSavingsPaise: 0, perShareMandalPaise: 0, perSharePaise: 0, savingsPaise: 0, mandalSharePaise: 0, totalPaise: 0, holderShares: 0 };
  }
  const pos = await mandalPosition(ctx.orgId);
  const holders = pos.holders.filter((m) => !m._id.equals(memberId));
  const holderShares = holders.reduce((t, m) => t + sharesOf(m), 0);
  let perShareSavingsPaise = 0;
  let perShareMandalPaise = 0;
  if (holderShares > 0) {
    // savings up to the day before this member's hapta starts — they pay their own hapta from then on
    const asOf = utcAddDays(enrollment.startDate, -1);
    const bal = await balancesAsOf(ctx.orgId, asOf);
    const savings = holders.reduce((t, m) => t + Math.max(0, bal.get(m._id.toHexString()) ?? 0), 0);
    perShareSavingsPaise = Math.trunc(savings / holderShares);
    perShareMandalPaise = Math.trunc(pos.mandalOwnPaise / holderShares);
  }
  const savingsPaise = perShareSavingsPaise * shares;
  const mandalSharePaise = perShareMandalPaise * shares;
  return {
    ...base,
    due: true as const,
    perShareSavingsPaise,
    perShareMandalPaise,
    perSharePaise: perShareSavingsPaise + perShareMandalPaise,
    savingsPaise,
    mandalSharePaise,
    totalPaise: Math.max(0, savingsPaise + mandalSharePaise),
    holderShares,
  };
}

export const JoiningPaymentSchema = z.object({
  date: dateOnly.optional(),
  accountId: z.string().optional(),
  note: optText(300),
  /** the total the screen showed — refused if the price has changed since */
  expectedTotalPaise: z.number().int().nonnegative().optional(),
  idempotencyKey,
});

/** Receive the joining amount in cash; the member then belongs fully (shares in the Mandal's money). */
export async function recordJoiningPayment(ctx: OrgContext, memberId: ObjectId, input: z.infer<typeof JoiningPaymentSchema>) {
  const c = await cols();
  const q = await joiningQuote(ctx, memberId);
  if (!q.due) {
    if (q.joining?.status === "paid") return { ok: true, duplicate: true, joining: q.joining };
    throw badRequest("This member doesn't owe a joining amount");
  }
  if (input.expectedTotalPaise !== undefined && input.expectedTotalPaise !== q.totalPaise) {
    throw conflict(`The joining amount has changed to ${formatMoney(q.totalPaise, ctx.org.settings.currency)} — please check it again`);
  }
  const member = (await c.members.findOne({ _id: memberId, organizationId: ctx.orgId }))!;
  const today = todayIn(ctx.org.settings.timezone);
  const date = input.date ?? today;
  if (date > today) throw badRequest("The date can't be in the future");
  const accountId = input.accountId ? new ObjectId(input.accountId) : await defaultCashAccountId(ctx.orgId);
  const now = new Date();
  const sourceId = new ObjectId();
  const savings = q.savingsPaise;
  const mandal = q.totalPaise - savings; // = the Mandal part (can be negative after a loss)

  const joining: MemberJoining = {
    status: "paid",
    since: member.joining!.since,
    at: now,
    by: ctx.user._id,
    date,
    shares: q.shares,
    perShareSavingsPaise: q.perShareSavingsPaise,
    perShareMandalPaise: q.perShareMandalPaise,
    savingsPaise: savings,
    mandalSharePaise: mandal,
    totalPaise: q.totalPaise,
    transactionId: null,
    reason: input.note,
  };

  try {
    await withTransaction(async (session) => {
      // the guard: only one joining payment per member
      const g = await c.members.updateOne({ _id: memberId, organizationId: ctx.orgId, "joining.status": "due" }, { $set: { "joining.status": "paid", updatedAt: now } }, { session });
      if (g.modifiedCount !== 1) throw conflict("The joining amount has already been recorded");
      if (q.totalPaise > 0) {
        const account = await requireAccount(ctx.orgId, accountId, session);
        const lines = [{ accountKey: faKey(account._id), debitPaise: q.totalPaise }] as { accountKey: string; debitPaise?: number; creditPaise?: number; memberId?: ObjectId }[];
        if (savings > 0) lines.push({ accountKey: MEMBER_FUNDS, creditPaise: savings, memberId });
        if (mandal > 0) lines.push({ accountKey: JOINING_EQUITY, creditPaise: mandal });
        if (mandal < 0) lines.push({ accountKey: JOINING_EQUITY, debitPaise: -mandal });
        const txn = await postTransaction(
          {
            org: ctx.org,
            type: "member_joining",
            date,
            description: `Joining amount — ${member.name} (${q.shares} share${q.shares === 1 ? "" : "s"} × ${formatMoney(q.perSharePaise, ctx.org.settings.currency)})`,
            lines,
            createdBy: ctx.user._id,
            memberId,
            sourceType: "joining",
            sourceId,
            reason: input.note,
            idempotencyKey: input.idempotencyKey,
          },
          session,
        );
        joining.transactionId = txn._id;
        if (savings > 0) {
          await postMemberEntry(
            {
              org: ctx.org,
              memberId,
              date,
              kind: "adjustment",
              creditPaise: savings,
              description: `Joining amount — savings part (${q.shares} share${q.shares === 1 ? "" : "s"} × ${formatMoney(q.perShareSavingsPaise, ctx.org.settings.currency)})`,
              sourceType: "joining",
              sourceId,
              transactionId: txn._id,
              dedupeKey: `joining:${memberId.toHexString()}`,
              createdBy: ctx.user._id,
            },
            session,
          );
        }
      }
      await c.members.updateOne({ _id: memberId }, { $set: { joining, updatedAt: now } }, { session });
      await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "member.joining_paid", entityType: "member", entityId: memberId, after: joining }, session);
    });
  } catch (e) {
    if (isDuplicateKeyError(e)) throw conflict("The joining amount has already been recorded");
    throw e;
  }
  return { ok: true, duplicate: false, joining };
}

export const JoiningWaiveSchema = z.object({ reason });

/** The Mandal agreed this member joins without paying in (e.g. they were there from the start). */
export async function waiveJoining(ctx: OrgContext, memberId: ObjectId, input: z.infer<typeof JoiningWaiveSchema>) {
  const c = await cols();
  const now = new Date();
  const r = await c.members.updateOne(
    { _id: memberId, organizationId: ctx.orgId, "joining.status": "due" },
    { $set: { "joining.status": "waived", "joining.at": now, "joining.by": ctx.user._id, "joining.reason": input.reason, updatedAt: now } },
  );
  if (r.matchedCount !== 1) throw badRequest("This member doesn't owe a joining amount");
  await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "member.joining_waived", entityType: "member", entityId: memberId, reason: input.reason });
  return { ok: true };
}

/* ------------------------------------------------------------------ leaving */

export async function leavingQuote(ctx: OrgContext, memberId: ObjectId) {
  const c = await cols();
  const member = await c.members.findOne({ _id: memberId, organizationId: ctx.orgId });
  if (!member) throw notFound("Member");
  const today = todayIn(ctx.org.settings.timezone);
  const owed = { $subtract: [{ $add: ["$amountPaise", "$penaltyPaise"] }, { $add: ["$paidPaise", "$penaltyPaidPaise"] }] };
  const [pos, loans, fl, unpaid, pendingPayments, pendingClaims, pendingRequests, emiLoans] = await Promise.all([
    mandalPosition(ctx.orgId),
    c.fundLoans.find({ organizationId: ctx.orgId, memberId, status: "active" }, { projection: { outstandingPaise: 1 } }).toArray(),
    fundLoanTotals(ctx.org, memberId),
    c.installments
      .aggregate<{ amt: number; n: number }>([
        { $match: { organizationId: ctx.orgId, memberId, state: "active", dueDate: { $lte: today } } },
        { $match: { $expr: { $gt: [owed, 0] } } },
        { $group: { _id: null, amt: { $sum: owed }, n: { $sum: 1 } } },
      ])
      .toArray(),
    c.payments.countDocuments({ organizationId: ctx.orgId, memberId, status: "pending" }),
    c.upadPaymentClaims.countDocuments({ organizationId: ctx.orgId, memberId, status: "pending" }),
    c.upadRequests.countDocuments({ organizationId: ctx.orgId, memberId, status: "pending" }),
    c.loans.countDocuments({ organizationId: ctx.orgId, memberId, status: { $in: ["applied", "approved", "active"] } }),
  ]);
  const id = memberId.toHexString();
  const isHolder = pos.holders.some((m) => m._id.equals(memberId));
  const holderShares = pos.holders.reduce((t, m) => t + sharesOf(m), 0);
  const split = splitSigned(pos.mandalOwnPaise, pos.holders.map((m) => ({ id: m._id.toHexString(), w: sharesOf(m) })));
  const mandalSharePaise = isHolder ? (split.get(id) ?? 0) : 0;
  const savingsPaise = member.balancePaise ?? 0;
  const upadOwedPaise = loans.reduce((t, l) => t + l.outstandingPaise, 0);
  const netPaise = savingsPaise + mandalSharePaise - upadOwedPaise;

  const base = `/org/${ctx.orgId}`;
  const blockers: { key: string; label: string; amountPaise?: number; count?: number; link: string }[] = [];
  if (member.status === "left") blockers.push({ key: "left", label: "This member has already left", link: `${base}/members/${id}` });
  if (settlementStarted(ctx)) blockers.push({ key: "closing", label: "The Mandal is closing — pay members out from Closing instead", link: `${base}/settings/close` });
  if (pendingPayments) blockers.push({ key: "payments", label: "Payments waiting for verification", count: pendingPayments, link: `${base}/collections?status=pending` });
  if (pendingClaims) blockers.push({ key: "upadClaims", label: "Upad payments waiting for verification", count: pendingClaims, link: `${base}/fund-loans` });
  if (pendingRequests) blockers.push({ key: "upadRequests", label: "Upad requests to approve or reject", count: pendingRequests, link: `${base}/fund-loans` });
  if (unpaid[0]?.amt) blockers.push({ key: "hapta", label: "Unpaid hapta — collect it or waive it first", amountPaise: unpaid[0].amt, count: unpaid[0].n, link: `${base}/members/${id}` });
  if (fl.interestDuePaise > 0) blockers.push({ key: "upadInterest", label: "Upad interest still due — collect it first", amountPaise: fl.interestDuePaise, link: `${base}/fund-loans` });
  if (emiLoans) blockers.push({ key: "emiLoans", label: "EMI loans still open", count: emiLoans, link: `${base}/loans` });
  if (netPaise < 0) blockers.push({ key: "short", label: `Owes ${formatMoney(-netPaise, ctx.org.settings.currency)} more than their balance — collect it first`, amountPaise: -netPaise, link: `${base}/members/${id}` });

  return {
    status: member.status,
    leaving: member.leaving ?? null,
    joiningDue: member.joining?.status === "due",
    shares: isHolder ? sharesOf(member) : 0,
    holderShares,
    mandalOwnPaise: pos.mandalOwnPaise,
    perShareMandalPaise: holderShares ? Math.trunc(pos.mandalOwnPaise / holderShares) : 0,
    savingsPaise,
    mandalSharePaise,
    upadOwedPaise,
    netPaise,
    blockers,
    canLeave: blockers.length === 0,
  };
}

export const WaiveMemberHaptaSchema = z.object({ reason });

/** Waive this member's unpaid hapta due up to today (e.g. the Mandal agreed they leave without it). */
export async function waiveMemberUnpaidHapta(ctx: OrgContext, memberId: ObjectId, input: z.infer<typeof WaiveMemberHaptaSchema>) {
  const c = await cols();
  const today = todayIn(ctx.org.settings.timezone);
  const now = new Date();
  const r = await c.installments.updateMany(
    { organizationId: ctx.orgId, memberId, state: "active", dueDate: { $lte: today }, $expr: { $lt: [{ $add: ["$paidPaise", "$penaltyPaidPaise"] }, { $add: ["$amountPaise", "$penaltyPaise"] }] } },
    [{ $set: { state: "waived", stateReason: `Waived on leaving: ${input.reason}`, updatedAt: now, history: { $concatArrays: ["$history", [{ at: now, by: ctx.user._id, action: "waived", reason: input.reason }]] } } }],
  );
  await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "member.waive_hapta", entityType: "member", entityId: memberId, reason: input.reason, after: { waived: r.modifiedCount } });
  return { waived: r.modifiedCount };
}

function settlementStarted(ctx: OrgContext) {
  return !!ctx.org.settings.settlement;
}

export const LeaveSchema = z.object({
  date: dateOnly.optional(),
  accountId: z.string().optional(),
  reason: optText(300),
  /** the payout the screen showed — refused if it has changed since */
  expectedNetPaise: z.number().int().optional(),
  idempotencyKey,
});

/**
 * Pay a member out and mark them "left": (1) credit their part of the Mandal's own money to their
 * balance, (2) take upad they still owe off it, (3) pay out the rest in cash, (4) stop their hapta.
 * Each step is idempotent, so a retry after a failure finishes the job with the same numbers.
 */
export async function leaveMandal(ctx: OrgContext, memberId: ObjectId, input: z.infer<typeof LeaveSchema>) {
  const c = await cols();
  const today = todayIn(ctx.org.settings.timezone);
  const date = input.date ?? today;
  if (date > today) throw badRequest("The date can't be in the future");
  let member = await c.members.findOne({ _id: memberId, organizationId: ctx.orgId });
  if (!member) throw notFound("Member");
  if (member.leaving?.status === "done") return { ok: true, duplicate: true, leaving: member.leaving };

  // 0) freeze the numbers once, so a retry pays exactly what was agreed
  let leaving = member.leaving;
  if (!leaving) {
    const q = await leavingQuote(ctx, memberId);
    if (!q.canLeave) throw badRequest(`Finish these first: ${q.blockers.map((b) => b.label).join("; ")}`);
    if (input.expectedNetPaise !== undefined && input.expectedNetPaise !== q.netPaise) {
      throw conflict(`The payout has changed to ${formatMoney(q.netPaise, ctx.org.settings.currency)} — please check it again`);
    }
    const fresh: MemberLeaving = {
      status: "in_progress",
      key: input.idempotencyKey,
      startedAt: new Date(),
      by: ctx.user._id,
      date,
      shares: q.shares,
      savingsPaise: q.savingsPaise,
      mandalSharePaise: q.mandalSharePaise,
      upadSettledPaise: q.upadOwedPaise,
      netPaise: q.netPaise,
      withdrawalId: null,
      reason: input.reason,
    };
    const r = await c.members.updateOne({ _id: memberId, organizationId: ctx.orgId, leaving: { $exists: false } }, { $set: { leaving: fresh, updatedAt: new Date() } });
    if (r.modifiedCount !== 1) {
      member = (await c.members.findOne({ _id: memberId, organizationId: ctx.orgId }))!;
      leaving = member.leaving!;
    } else leaving = fresh;
  }
  const L = leaving!;
  const tag = `${memberId.toHexString()}:${L.key}`;

  // 1) their part of the Mandal's own money into their balance
  if (L.mandalSharePaise !== 0) {
    const gain = L.mandalSharePaise > 0;
    const amt = Math.abs(L.mandalSharePaise);
    const sourceId = new ObjectId();
    try {
      await withTransaction(async (session) => {
        const txn = await postTransaction(
          {
            org: ctx.org,
            type: "member_leaving",
            date: L.date,
            description: `Leaving: ${member!.name}'s share of the Mandal's own money (${L.shares} share${L.shares === 1 ? "" : "s"})`,
            lines: gain
              ? [{ accountKey: LEAVING_EQUITY, debitPaise: amt }, { accountKey: MEMBER_FUNDS, creditPaise: amt, memberId }]
              : [{ accountKey: LEAVING_EQUITY, creditPaise: amt }, { accountKey: MEMBER_FUNDS, debitPaise: amt, memberId }],
            createdBy: ctx.user._id,
            memberId,
            sourceType: "leaving",
            sourceId,
            reason: L.reason,
          },
          session,
        );
        await postMemberEntry(
          {
            org: ctx.org,
            memberId,
            date: L.date,
            kind: "adjustment",
            ...(gain ? { creditPaise: amt } : { debitPaise: amt }),
            description: `Leaving: share of the Mandal's own money (${L.shares} share${L.shares === 1 ? "" : "s"})`,
            sourceType: "leaving",
            sourceId,
            transactionId: txn._id,
            dedupeKey: `leave-share:${tag}`,
            createdBy: ctx.user._id,
          },
          session,
        );
      });
    } catch (e) {
      if (!isDuplicateKeyError(e)) throw e; // already done on an earlier try
    }
  }

  // 2) upad still owed is settled out of the payout
  const loans = await c.fundLoans.find({ organizationId: ctx.orgId, memberId, status: "active" }).toArray();
  for (const l of loans) {
    if (l.outstandingPaise <= 0) continue;
    await receiveFundLoanPayment(ctx, l._id, {
      interestAmount: 0,
      principalAmount: l.outstandingPaise,
      date: L.date,
      note: "Settled from the member's leaving payout",
      accountId: input.accountId,
      method: "settlement",
      reference: undefined,
      idempotencyKey: `leave-upad:${tag}:${l._id.toHexString()}`,
    });
  }

  // 3) pay out the whole balance (upad received above offsets it in the cash box)
  const fresh = (await c.members.findOne({ _id: memberId }, { projection: { balancePaise: 1 } }))!;
  let withdrawalId: ObjectId | null = L.withdrawalId ?? null;
  const gross = fresh.balancePaise ?? 0;
  if (gross > 0) {
    const w = await recordWithdrawal(ctx, {
      memberId: memberId.toHexString(),
      amount: gross,
      date: L.date,
      note: `Leaving the Mandal${L.upadSettledPaise ? ` (upad ${formatMoney(L.upadSettledPaise, ctx.org.settings.currency)} settled from it — paid ${formatMoney(L.netPaise, ctx.org.settings.currency)})` : ""}`,
      accountId: input.accountId,
      allowExceedBalance: false,
      exceptionReason: undefined,
      confirmDuplicate: true,
      idempotencyKey: `leave:${tag}`,
    });
    withdrawalId = w.withdrawal._id;
  } else if (!withdrawalId) {
    // a retry after the payout went through
    const prior = await c.withdrawals.findOne({ organizationId: ctx.orgId, idempotencyKey: `leave:${tag}` }, { projection: { _id: 1 } });
    withdrawalId = prior?._id ?? null;
  }

  // 4) stop their hapta and mark them as left
  const enrollments = await c.memberSchemeEnrollments.find({ organizationId: ctx.orgId, memberId, status: "active" }, { projection: { schemeId: 1 } }).toArray();
  for (const e of enrollments) await exitEnrollment(ctx, e.schemeId, memberId, L.reason ? `Left the Mandal — ${L.reason}` : "Left the Mandal");
  const done: MemberLeaving = { ...L, status: "done", at: new Date(), withdrawalId };
  await c.members.updateOne({ _id: memberId }, { $set: { status: "left", leaving: done, updatedAt: new Date() } });
  await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "member.left", entityType: "member", entityId: memberId, after: done, reason: L.reason });
  return { ok: true, duplicate: false, leaving: done };
}
