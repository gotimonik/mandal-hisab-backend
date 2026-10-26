import { formatMoney } from "@/lib/currency";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { cols } from "@/lib/collections";
import { withTransaction } from "@/lib/db";
import { audit } from "@/lib/audit";
import { badRequest, conflict, notFound } from "@/lib/errors";
import { todayIn, utcAddDays, utcAddMonths } from "@/lib/dates";
import type { OrgContext } from "@/lib/auth";
import type { SettlementState } from "@/types/models";
import { dateOnly, idempotencyKey, optText, reason } from "@/validators/common";
import { balanceOf } from "./account.service";
import { MEMBER_FUNDS, postTransaction } from "./ledger.service";
import { postMemberEntry } from "./member-ledger.service";
import { fundLoanTotals, receiveFundLoanPayment, splitByWeight } from "./fund-loan.service";
import { recordWithdrawal } from "./withdrawal.service";
import { firstOfMonth, monthOf, primaryScheme } from "./monthly.service";
import { generateScheme } from "./scheme.service";
import { notifyMember, notifyRoles } from "./notification.service";

/**
 * How long the Mandal runs (end month) and closing it: share the Mandal's own money out by hapta
 * shares, pay every member their balance (upad still owed is taken off), then close it read-only.
 */

const CLOSING_EQUITY = "equity:closing_distribution";
const END_REASON = "After the Mandal's end month";
const ym = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM");

/* ------------------------------------------------------------------ end month */

export const EndMonthSchema = z.object({ endMonth: ym.nullable() });

/**
 * Set (or clear) the last month the Mandal runs. Hapta after it is not created; unpaid hapta
 * already created after it is cancelled. Moving it later brings those months back.
 */
export async function setEndMonth(ctx: OrgContext, input: z.infer<typeof EndMonthSchema>) {
  const c = await cols();
  const today = todayIn(ctx.org.settings.timezone);
  if (input.endMonth && input.endMonth < monthOf(today)) throw badRequest("The end month can't be in the past");
  const scheme = await primaryScheme(ctx.orgId);
  if (input.endMonth && scheme && input.endMonth < monthOf(scheme.startDate)) throw badRequest("The end month is before the hapta starts");
  await c.organizations.updateOne({ _id: ctx.orgId }, { $set: { "settings.endMonth": input.endMonth, updatedAt: new Date() } });
  ctx.org.settings.endMonth = input.endMonth;
  let cancelled = 0;
  let restored = 0;
  if (scheme) {
    const endDate = input.endMonth ? utcAddDays(utcAddMonths(firstOfMonth(input.endMonth), 1), -1) : null;
    await c.haptaSchemes.updateOne({ _id: scheme._id }, { $set: { endDate, updatedAt: new Date() } });
    const now = new Date();
    // months that are inside the period again
    const r1 = await c.installments.updateMany(
      { organizationId: ctx.orgId, schemeId: scheme._id, state: "cancelled", stateReason: END_REASON, ...(endDate ? { dueDate: { $lte: endDate } } : {}) },
      [{ $set: { state: "active", stateReason: null, updatedAt: now, history: { $concatArrays: ["$history", [{ at: now, by: ctx.user._id, action: "reactivated", reason: "Mandal end month moved" }]] } } }],
    );
    restored = r1.modifiedCount;
    if (endDate) {
      const r2 = await c.installments.updateMany(
        { organizationId: ctx.orgId, schemeId: scheme._id, state: "active", paidPaise: 0, dueDate: { $gt: endDate } },
        [{ $set: { state: "cancelled", stateReason: END_REASON, updatedAt: now, history: { $concatArrays: ["$history", [{ at: now, by: ctx.user._id, action: "cancelled", reason: END_REASON }]] } } }],
      );
      cancelled = r2.modifiedCount;
    }
    // fill in months up to the (new) end
    await generateScheme(ctx, scheme._id);
  }
  await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "organization.end_month", entityType: "organization", entityId: ctx.orgId, after: { endMonth: input.endMonth, cancelled, restored } });
  return { endMonth: input.endMonth, installmentsCancelled: cancelled, installmentsRestored: restored };
}

/* ------------------------------------------------------------------ settlement preview */

async function cashAccounts(ctx: OrgContext) {
  const c = await cols();
  const accounts = await c.financialAccounts.find({ organizationId: ctx.orgId }, { projection: { name: 1, type: 1, isActive: 1 } }).toArray();
  return Promise.all(accounts.map(async (a) => ({ _id: a._id, name: a.name, type: a.type, isActive: a.isActive, balancePaise: await balanceOf(ctx.orgId, a._id) })));
}

/** Everything needed to close: what's still open, the Mandal's own money and each member's payout. */
export async function settlementPreview(ctx: OrgContext) {
  const c = await cols();
  const today = todayIn(ctx.org.settings.timezone);
  const owed = { $subtract: [{ $add: ["$amountPaise", "$penaltyPaise"] }, { $add: ["$paidPaise", "$penaltyPaidPaise"] }] };
  const [accounts, members, loans, fl, unpaidHapta, pendingPayments, pendingClaims, pendingRequests, pendingExpenses, emiLoans] = await Promise.all([
    cashAccounts(ctx),
    c.members.find({ organizationId: ctx.orgId }, { projection: { name: 1, membershipNumber: 1, status: 1, haptaShares: 1, balancePaise: 1 } }).sort({ name: 1 }).toArray(),
    c.fundLoans.find({ organizationId: ctx.orgId, status: "active" }, { projection: { memberId: 1, outstandingPaise: 1, number: 1 } }).toArray(),
    fundLoanTotals(ctx.org),
    c.installments
      .aggregate<{ amt: number; n: number }>([
        { $match: { organizationId: ctx.orgId, state: "active", dueDate: { $lte: today } } },
        { $match: { $expr: { $gt: [owed, 0] } } },
        { $group: { _id: null, amt: { $sum: owed }, n: { $sum: 1 } } },
      ])
      .toArray(),
    c.payments.countDocuments({ organizationId: ctx.orgId, status: "pending" }),
    c.upadPaymentClaims.countDocuments({ organizationId: ctx.orgId, status: "pending" }),
    c.upadRequests.countDocuments({ organizationId: ctx.orgId, status: "pending" }),
    c.expenses.countDocuments({ organizationId: ctx.orgId, status: "pending" }),
    c.loans.countDocuments({ organizationId: ctx.orgId, status: { $in: ["applied", "approved", "active"] } }),
  ]);
  const cashPaise = accounts.reduce((s, a) => s + a.balancePaise, 0);
  const upadOutstandingPaise = loans.reduce((s, l) => s + l.outstandingPaise, 0);
  const memberFundsPaise = members.reduce((s, m) => s + (m.balancePaise ?? 0), 0);
  /** money that belongs to the Mandal itself, not to any member's savings */
  const mandalOwnPaise = cashPaise + upadOutstandingPaise - memberFundsPaise;
  const sharers = members.filter((m) => m.status === "active");
  const totalShares = sharers.reduce((s, m) => s + (m.haptaShares ?? 1), 0);
  const split = splitSigned(mandalOwnPaise, sharers.map((m) => ({ id: m._id.toHexString(), w: m.haptaShares ?? 1 })));
  const st = ctx.org.settings.settlement ?? null;
  const paid = new Map((st?.payouts ?? []).map((p) => [p.memberId.toHexString(), p]));

  const rows = members
    .map((m) => {
      const id = m._id.toHexString();
      const upad = loans.filter((l) => l.memberId.equals(m._id)).reduce((s, l) => s + l.outstandingPaise, 0);
      const share = split.get(id) ?? 0;
      const savings = m.balancePaise ?? 0;
      const payout = paid.get(id);
      return {
        memberId: m._id,
        name: m.name,
        membershipNumber: m.membershipNumber,
        status: m.status,
        shares: m.status === "active" ? (m.haptaShares ?? 1) : 0,
        savingsPaise: savings,
        /** their part of the Mandal's own money (not yet shared out) */
        mandalSharePaise: share,
        upadOwedPaise: upad,
        /** what they take home: savings + share − upad still owed */
        netPaise: savings + share - upad,
        paidOut: payout ? { at: payout.at, netPaise: payout.netPaise } : null,
      };
    })
    .filter((r) => r.status === "active" || r.savingsPaise !== 0 || r.upadOwedPaise > 0 || r.paidOut);

  const blockers: { key: string; label: string; amountPaise?: number; count?: number; link: string }[] = [];
  const base = `/org/${ctx.orgId}`;
  if (pendingPayments) blockers.push({ key: "payments", label: "Payments waiting for verification", count: pendingPayments, link: `${base}/collections?status=pending` });
  if (pendingClaims) blockers.push({ key: "upadClaims", label: "Upad payments waiting for verification", count: pendingClaims, link: `${base}/fund-loans` });
  if (pendingRequests) blockers.push({ key: "upadRequests", label: "Upad requests to approve or reject", count: pendingRequests, link: `${base}/fund-loans` });
  if (pendingExpenses) blockers.push({ key: "expenses", label: "Expenses waiting for approval", count: pendingExpenses, link: `${base}/expenses?status=pending` });
  if (unpaidHapta[0]?.amt) blockers.push({ key: "hapta", label: "Unpaid hapta (collect it, or waive it here)", amountPaise: unpaidHapta[0].amt, count: unpaidHapta[0].n, link: `${base}/monthly?show=due` });
  if (fl.interestDuePaise > 0) blockers.push({ key: "upadInterest", label: "Upad interest still due — collect it first", amountPaise: fl.interestDuePaise, link: `${base}/fund-loans` });
  if (emiLoans) blockers.push({ key: "emiLoans", label: "EMI loans still open", count: emiLoans, link: `${base}/loans` });
  const short = rows.filter((r) => r.netPaise < 0 && !r.paidOut);
  for (const r of short) blockers.push({ key: `short:${r.memberId}`, label: `${r.name} owes more than they have — collect ${formatMoney(-r.netPaise, ctx.org.settings.currency)} first`, amountPaise: -r.netPaise, link: `${base}/members/${r.memberId}` });

  return {
    endMonth: ctx.org.settings.endMonth ?? null,
    state: st ? { startedAt: st.startedAt, closedAt: st.closedAt ?? null, distributions: st.distributions, paidOut: st.payouts.length } : null,
    accounts: accounts.filter((a) => a.isActive || a.balancePaise !== 0),
    totals: {
      cashPaise,
      upadOutstandingPaise,
      memberFundsPaise,
      mandalOwnPaise,
      totalShares,
      perSharePaise: totalShares ? Math.trunc(mandalOwnPaise / totalShares) : 0,
      netPayoutPaise: rows.filter((r) => !r.paidOut).reduce((s, r) => s + r.netPaise, 0),
    },
    blockers,
    rows,
    canStart: blockers.length === 0 && !st?.closedAt,
    canClose: !!st && !st.closedAt && cashPaise === 0 && memberFundsPaise === 0 && upadOutstandingPaise === 0 && blockers.length === 0,
  };
}

/** Split a signed amount (a loss is shared too) by weight, exactly to the paisa. */
function splitSigned(amount: number, weights: { id: string; w: number }[]) {
  const m = splitByWeight(Math.abs(amount), weights);
  if (amount >= 0) return m;
  return new Map([...m.entries()].map(([k, v]) => [k, -v]));
}

/* ------------------------------------------------------------------ waive unpaid hapta */

export const WaiveSchema = z.object({ reason });

/** Waive every unpaid hapta due up to today (e.g. members agreed to settle without it). */
export async function waiveUnpaidHapta(ctx: OrgContext, input: z.infer<typeof WaiveSchema>) {
  const c = await cols();
  const today = todayIn(ctx.org.settings.timezone);
  const now = new Date();
  const r = await c.installments.updateMany(
    { organizationId: ctx.orgId, state: "active", dueDate: { $lte: today }, $expr: { $lt: [{ $add: ["$paidPaise", "$penaltyPaidPaise"] }, { $add: ["$amountPaise", "$penaltyPaise"] }] } },
    [{ $set: { state: "waived", stateReason: `Waived at closing: ${input.reason}`, updatedAt: now, history: { $concatArrays: ["$history", [{ at: now, by: ctx.user._id, action: "waived", reason: input.reason }]] } } }],
  );
  await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "settlement.waive_hapta", entityType: "organization", entityId: ctx.orgId, reason: input.reason, after: { waived: r.modifiedCount } });
  return { waived: r.modifiedCount };
}

/* ------------------------------------------------------------------ start: share out the Mandal's own money */

export const StartSchema = z.object({ date: dateOnly.optional(), note: optText(300) });

/**
 * Start closing: stop future hapta, and credit the Mandal's own money (donations, other income,
 * interest not yet shared…) to members' balances in proportion to their hapta shares. Can be run
 * again later to share out anything that came in afterwards.
 */
export async function startSettlement(ctx: OrgContext, input: z.infer<typeof StartSchema>) {
  const c = await cols();
  const today = todayIn(ctx.org.settings.timezone);
  const date = input.date ?? today;
  if (date > today) throw badRequest("The date can't be in the future");
  const preview = await settlementPreview(ctx);
  if (ctx.org.settings.settlement?.closedAt) throw conflict("This Mandal is already closed");
  if (preview.blockers.filter((b) => !b.key.startsWith("short:")).length) throw badRequest(`Finish these first: ${preview.blockers.map((b) => b.label).join("; ")}`);
  const sharers = preview.rows.filter((r) => r.shares > 0);
  if (!sharers.length) throw badRequest("There are no active members to share with");
  const amount = preview.totals.mandalOwnPaise;
  const now = new Date();
  let transactionId: ObjectId | null = null;
  const sourceId = new ObjectId();

  await withTransaction(async (session) => {
    if (amount !== 0) {
      const parts = sharers.filter((r) => r.mandalSharePaise !== 0);
      const gain = amount > 0;
      const txn = await postTransaction(
        {
          org: ctx.org,
          type: "closing_distribution",
          date,
          description: `Closing: Mandal's own money ${gain ? "shared out" : "loss shared"} — ${formatMoney(Math.abs(amount), ctx.org.settings.currency)} over ${preview.totals.totalShares} hapta shares`,
          lines: gain
            ? [{ accountKey: CLOSING_EQUITY, debitPaise: amount }, ...parts.map((r) => ({ accountKey: MEMBER_FUNDS, creditPaise: r.mandalSharePaise, memberId: r.memberId }))]
            : [{ accountKey: CLOSING_EQUITY, creditPaise: -amount }, ...parts.map((r) => ({ accountKey: MEMBER_FUNDS, debitPaise: -r.mandalSharePaise, memberId: r.memberId }))],
          createdBy: ctx.user._id,
          sourceType: "settlement",
          sourceId,
          reason: input.note,
        },
        session,
      );
      transactionId = txn._id;
      for (const r of parts) {
        await postMemberEntry(
          {
            org: ctx.org,
            memberId: r.memberId,
            date,
            kind: "adjustment",
            ...(gain ? { creditPaise: r.mandalSharePaise } : { debitPaise: -r.mandalSharePaise }),
            description: `Closing: share of the Mandal's own money (${r.shares} hapta share${r.shares === 1 ? "" : "s"})`,
            sourceType: "settlement",
            sourceId,
            transactionId: txn._id,
            dedupeKey: `settle:${sourceId.toHexString()}:${r.memberId.toHexString()}`,
            createdBy: ctx.user._id,
          },
          session,
        );
      }
    }
    // no more hapta after today
    await c.installments.updateMany(
      { organizationId: ctx.orgId, state: "active", paidPaise: 0, dueDate: { $gt: today } },
      [{ $set: { state: "cancelled", stateReason: "Mandal closing", updatedAt: now, history: { $concatArrays: ["$history", [{ at: now, by: ctx.user._id, action: "cancelled", reason: "Mandal closing" }]] } } }],
      { session },
    );
    await c.haptaSchemes.updateMany({ organizationId: ctx.orgId, status: { $in: ["active", "paused", "draft"] } }, { $set: { status: "closed", updatedAt: now } }, { session });
    const dist = { at: now, totalPaise: amount, transactionId, perShare: preview.totals.perSharePaise, shares: preview.totals.totalShares };
    const st = ctx.org.settings.settlement;
    if (st) await c.organizations.updateOne({ _id: ctx.orgId }, { $push: { "settings.settlement.distributions": dist }, $set: { updatedAt: now } }, { session });
    else {
      const fresh: SettlementState = { startedAt: now, startedBy: ctx.user._id, distributions: [dist], payouts: [], closedAt: null };
      await c.organizations.updateOne({ _id: ctx.orgId }, { $set: { "settings.settlement": fresh, updatedAt: now } }, { session });
    }
    await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "settlement.start", entityType: "organization", entityId: ctx.orgId, after: dist, reason: input.note }, session);
  });
  for (const r of sharers) {
    await notifyMember(ctx.orgId, r.memberId, { type: "settlement.started", title: "The Mandal is closing", body: `Your payout: ${formatMoney(r.netPaise, ctx.org.settings.currency)} (savings ${formatMoney(r.savingsPaise, ctx.org.settings.currency)}${r.mandalSharePaise ? ` + share of the Mandal's own money ${formatMoney(r.mandalSharePaise, ctx.org.settings.currency)}` : ""}${r.upadOwedPaise ? ` − upad ${formatMoney(r.upadOwedPaise, ctx.org.settings.currency)}` : ""}).`, link: `/org/${ctx.orgId}/my`, dedupeKey: `settle-start:${sourceId}:${r.memberId}` });
  }
  return { sharedPaise: amount, transactionId };
}

/* ------------------------------------------------------------------ pay each member out */

export const PayoutSchema = z.object({
  date: dateOnly.optional(),
  accountId: z.string().optional(),
  method: z.string().min(2).max(30).default("cash"),
  reference: optText(100),
  idempotencyKey,
});

/** Pay a member everything that's theirs; upad they still owe is taken off (settled from the payout). */
export async function payoutMember(ctx: OrgContext, memberId: ObjectId, input: z.infer<typeof PayoutSchema>) {
  const c = await cols();
  const st = ctx.org.settings.settlement;
  if (!st) throw badRequest("Start closing first (share out the Mandal's own money)");
  if (st.closedAt) throw conflict("This Mandal is already closed");
  if (st.payouts.some((p) => p.memberId.equals(memberId))) throw conflict("This member has already been paid out");
  const today = todayIn(ctx.org.settings.timezone);
  const date = input.date ?? today;
  const member = await c.members.findOne({ _id: memberId, organizationId: ctx.orgId }, { projection: { name: 1, balancePaise: 1 } });
  if (!member) throw notFound("Member");
  const loans = await c.fundLoans.find({ organizationId: ctx.orgId, memberId, status: "active" }).toArray();
  const fl = await fundLoanTotals(ctx.org, memberId);
  if (fl.interestDuePaise > 0) throw badRequest(`${member.name} still owes ${formatMoney(fl.interestDuePaise, ctx.org.settings.currency)} upad interest — collect it first`);
  const upad = loans.reduce((s, l) => s + l.outstandingPaise, 0);
  const gross = member.balancePaise ?? 0;
  const net = gross - upad;
  if (net < 0) throw badRequest(`${member.name} owes ${formatMoney(-net, ctx.org.settings.currency)} more than their balance — collect it first`);

  // 1) upad still owed is settled out of the payout
  for (const l of loans) {
    if (l.outstandingPaise <= 0) continue;
    await receiveFundLoanPayment(ctx, l._id, {
      interestAmount: 0,
      principalAmount: l.outstandingPaise,
      date,
      note: "Settled from the member's closing payout",
      accountId: input.accountId,
      method: "settlement",
      reference: undefined,
      idempotencyKey: `settle-upad:${l._id.toHexString()}`,
    });
  }
  // 2) pay out the whole balance
  let withdrawalId: ObjectId | null = null;
  if (gross > 0) {
    const w = await recordWithdrawal(ctx, {
      memberId: memberId.toHexString(),
      amount: gross,
      date,
      note: `Closing payout${upad ? ` (upad ${formatMoney(upad, ctx.org.settings.currency)} settled from it — paid ${formatMoney(net, ctx.org.settings.currency)})` : ""}${input.reference ? ` · ref ${input.reference}` : ""}`,
      accountId: input.accountId,
      allowExceedBalance: false,
      exceptionReason: undefined,
      confirmDuplicate: true,
      idempotencyKey: input.idempotencyKey,
    });
    withdrawalId = w.withdrawal._id;
  }
  const payout = { memberId, at: new Date(), netPaise: net, grossPaise: gross, upadSettledPaise: upad, withdrawalId };
  const r = await c.organizations.updateOne({ _id: ctx.orgId, "settings.settlement.payouts.memberId": { $ne: memberId } }, { $push: { "settings.settlement.payouts": payout }, $set: { updatedAt: new Date() } });
  if (r.modifiedCount !== 1) throw conflict("This member has already been paid out");
  await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "settlement.payout", entityType: "member", entityId: memberId, after: { ...payout, method: input.method } });
  await notifyMember(ctx.orgId, memberId, { type: "settlement.paid", title: "Closing payout", body: `${formatMoney(net, ctx.org.settings.currency)} paid to you${upad ? ` (after upad ${formatMoney(upad, ctx.org.settings.currency)})` : ""}. Thank you for being part of ${ctx.org.name}.`, link: `/org/${ctx.orgId}/my`, dedupeKey: `settle-paid:${memberId}` });
  return { ok: true, netPaise: net, grossPaise: gross, upadSettledPaise: upad, withdrawalId };
}

/* ------------------------------------------------------------------ close */

export const CloseSchema = z.object({ note: optText(300) });

/** Everyone is paid and the books are at zero: close the Mandal (read-only, history kept). */
export async function closeMandal(ctx: OrgContext, input: z.infer<typeof CloseSchema>) {
  const c = await cols();
  const p = await settlementPreview(ctx);
  if (!p.state) throw badRequest("Start closing first");
  if (!p.canClose) {
    const left = [
      p.totals.memberFundsPaise !== 0 ? `${formatMoney(p.totals.memberFundsPaise, ctx.org.settings.currency)} still in members' balances — pay everyone out` : "",
      p.totals.upadOutstandingPaise !== 0 ? `${formatMoney(p.totals.upadOutstandingPaise, ctx.org.settings.currency)} upad still out` : "",
      p.totals.cashPaise !== 0 ? `${formatMoney(p.totals.cashPaise, ctx.org.settings.currency)} still in the Mandal's accounts — share it out again or record where it went` : "",
      ...p.blockers.map((b) => b.label),
    ].filter(Boolean);
    throw badRequest(`Not ready to close: ${left.join("; ")}`);
  }
  const now = new Date();
  await c.organizations.updateOne(
    { _id: ctx.orgId },
    { $set: { status: "archived", statusReason: `Closed and settled on ${now.toISOString().slice(0, 10)}${input.note ? ` — ${input.note}` : ""}`, "settings.settlement.closedAt": now, updatedAt: now } },
  );
  await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "settlement.close", entityType: "organization", entityId: ctx.orgId, reason: input.note });
  await notifyRoles(ctx.orgId, ["admin", "manager"], { type: "settlement.closed", title: "Mandal closed", body: `${ctx.org.name} is closed and settled. Its history stays available to read.`, link: `/org/${ctx.orgId}`, dedupeKey: `settle-closed:${ctx.orgId}` });
  return { ok: true, closedAt: now };
}

export { ym as monthParam };
