import { formatMoney } from "@/lib/currency";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { cols } from "@/lib/collections";
import { withTransaction } from "@/lib/db";
import { audit } from "@/lib/audit";
import { AppError, badRequest, isDuplicateKeyError, notFound } from "@/lib/errors";
import { roundHalfUp } from "@/lib/money";
import { todayIn, utcAddDays } from "@/lib/dates";
import type { OrgContext } from "@/lib/auth";
import type { InterestRunDoc, InterestSettings } from "@/types/models";
import { idempotencyKey, money, optText, rateString } from "@/validators/common";
import { percentToRational } from "./interest";
import { MEMBER_FUNDS, MEMBER_INTEREST_EXPENSE, postTransaction } from "./ledger.service";
import { balancesAsOf, postMemberEntry } from "./member-ledger.service";
import { firstOfMonth, lastOfMonth, month, monthOf } from "./monthly.service";
import { notifyMember } from "./notification.service";

/**
 * Monthly interest (વ્યાજ) credited to members.
 *
 * Modes
 *  - manual: the admin enters an amount for each member.
 *  - rate:   interest = eligible balance × monthly rate %, rounded half-up to the paisa.
 *
 * Eligible balance (rate mode), configurable per Mandal (settings.interest.basis):
 *  - previous_month_closing (default): the member's savings balance at the END OF THE PREVIOUS
 *    MONTH (opening + hapta + interest + credits − withdrawals − debits up to that day).
 *    Money paid during the month earns interest from the next month.
 *  - hapta_contributions: only the member's net hapta contributions up to the end of the
 *    previous month (interest does not compound, withdrawals are ignored).
 *  Members with a zero or negative eligible balance get no interest.
 *
 * Books: Dr "Interest credited to members" (Mandal expense) / Cr member funds. No cash moves:
 * cash only leaves when a member actually withdraws.
 *
 * Every finalized line stores the period, mode, rate, eligible balance and amount. A member can
 * be credited only once per period (unique dedupe key `interest:<period>:<member>`); finalized
 * credits are never edited — corrections are member balance adjustments.
 */

export const PreviewSchema = z.object({
  period: month,
  mode: z.enum(["manual", "rate"]),
  monthlyRate: rateString.optional(),
  basis: z.enum(["previous_month_closing", "hapta_contributions"]).optional(),
});

export const FinalizeSchema = PreviewSchema.extend({
  /** manual mode: amount per member (rupee strings). Ignored in rate mode (server recomputes). */
  entries: z.array(z.object({ memberId: z.string(), amount: money({ allowZero: true }) })).max(5000).default([]),
  note: optText(300),
  idempotencyKey,
});

export function rateInterest(balancePaise: number, monthlyRate: string): number {
  if (balancePaise <= 0) return 0;
  const r = percentToRational(monthlyRate);
  return Number(roundHalfUp(BigInt(balancePaise) * r.num, r.den));
}

interface PreviewRow {
  memberId: ObjectId;
  name: string;
  membershipNumber: string;
  currentBalancePaise: number;
  eligibleBalancePaise: number | null;
  interestPaise: number;
  alreadyCredited: boolean;
}

function checkPeriod(ctx: OrgContext, period: string) {
  const today = todayIn(ctx.org.settings.timezone);
  if (period > monthOf(today)) throw badRequest("Interest can't be credited for a future month");
}

export async function previewInterest(ctx: OrgContext, input: z.infer<typeof PreviewSchema>) {
  checkPeriod(ctx, input.period);
  const c = await cols();
  const s: InterestSettings = ctx.org.settings.interest;
  const rate = input.monthlyRate ?? s.monthlyRate;
  const basis = input.basis ?? s.basis;
  const basisDate = utcAddDays(firstOfMonth(input.period), -1);
  const members = await c.members.find({ organizationId: ctx.orgId, status: "active" }, { projection: { name: 1, membershipNumber: 1, balancePaise: 1 } }).sort({ name: 1 }).toArray();
  const eligible = await balancesAsOf(ctx.orgId, basisDate, basis === "hapta_contributions" ? { kinds: ["hapta"] } : {});
  const credited = await c.memberLedger.distinct("memberId", { organizationId: ctx.orgId, kind: "interest", period: input.period, creditPaise: { $gt: 0 } });
  const done = new Set(credited.map((x) => x.toHexString()));
  const rows: PreviewRow[] = members.map((m) => {
    const bal = eligible.get(m._id.toHexString()) ?? 0;
    const already = done.has(m._id.toHexString());
    return {
      memberId: m._id,
      name: m.name,
      membershipNumber: m.membershipNumber,
      currentBalancePaise: m.balancePaise ?? 0,
      eligibleBalancePaise: bal,
      interestPaise: input.mode === "rate" && !already ? rateInterest(bal, rate) : 0,
      alreadyCredited: already,
    };
  });
  return {
    period: input.period,
    mode: input.mode,
    monthlyRate: input.mode === "rate" ? rate : null,
    basis: input.mode === "rate" ? basis : null,
    basisDate,
    creditDate: creditDateFor(ctx, input.period),
    rows,
    totalPaise: rows.reduce((t, r) => t + r.interestPaise, 0),
    alreadyCreditedCount: rows.filter((r) => r.alreadyCredited).length,
  };
}

function creditDateFor(ctx: OrgContext, period: string) {
  const today = todayIn(ctx.org.settings.timezone);
  const last = lastOfMonth(period);
  return last < today ? last : today;
}

export async function finalizeInterest(ctx: OrgContext, input: z.infer<typeof FinalizeSchema>) {
  const c = await cols();
  const existing = await c.interestRuns.findOne({ organizationId: ctx.orgId, idempotencyKey: input.idempotencyKey });
  if (existing) return { run: existing, duplicate: true };
  const preview = await previewInterest(ctx, input);
  const byId = new Map(preview.rows.map((r) => [r.memberId.toHexString(), r]));
  let lines: { row: PreviewRow; amount: number }[];
  if (input.mode === "rate") {
    lines = preview.rows.filter((r) => !r.alreadyCredited && r.interestPaise > 0).map((r) => ({ row: r, amount: r.interestPaise }));
  } else {
    lines = [];
    const seen = new Set<string>();
    for (const e of input.entries) {
      if (e.amount <= 0) continue;
      if (seen.has(e.memberId)) throw badRequest("Each member can appear only once");
      seen.add(e.memberId);
      const row = byId.get(e.memberId);
      if (!row) throw notFound("Member");
      if (row.alreadyCredited) throw new AppError("CONFLICT", `${row.name} has already been credited interest for ${input.period}`);
      lines.push({ row, amount: e.amount });
    }
  }
  if (lines.length === 0) throw badRequest("There is no interest to credit");
  const total = lines.reduce((t, l) => t + l.amount, 0);
  const creditDate = preview.creditDate;

  try {
    const run = await withTransaction(async (session) => {
      const runId = new ObjectId();
      const txn = await postTransaction(
        {
          org: ctx.org,
          type: "interest_credit",
          date: creditDate,
          description: `Interest for ${input.period} credited to ${lines.length} member${lines.length === 1 ? "" : "s"}${input.mode === "rate" ? ` @ ${preview.monthlyRate}% per month` : " (manual)"}`,
          lines: [{ accountKey: MEMBER_INTEREST_EXPENSE, debitPaise: total }, ...lines.map((l) => ({ accountKey: MEMBER_FUNDS, creditPaise: l.amount, memberId: l.row.memberId }))],
          createdBy: ctx.user._id,
          sourceType: "interestRun",
          sourceId: runId,
          reason: input.note,
        },
        session,
      );
      const entries: InterestRunDoc["entries"] = [];
      for (const l of lines) {
        const { entry } = await postMemberEntry(
          {
            org: ctx.org,
            memberId: l.row.memberId,
            date: creditDate,
            kind: "interest",
            creditPaise: l.amount,
            description:
              input.mode === "rate"
                ? `Interest ${input.period}: ${preview.monthlyRate}% on ${formatMoney(l.row.eligibleBalancePaise!, ctx.org.settings.currency)}`
                : `Interest ${input.period} (manual)`,
            period: input.period,
            sourceType: "interestRun",
            sourceId: runId,
            transactionId: txn._id,
            dedupeKey: `interest:${input.period}:${l.row.memberId.toHexString()}`,
            createdBy: ctx.user._id,
          },
          session,
        );
        entries.push({ memberId: l.row.memberId, eligibleBalancePaise: input.mode === "rate" ? l.row.eligibleBalancePaise : null, interestPaise: l.amount, ledgerEntryId: entry._id });
      }
      const doc: InterestRunDoc = {
        _id: runId,
        organizationId: ctx.orgId,
        period: input.period,
        mode: input.mode,
        monthlyRate: preview.monthlyRate,
        basis: preview.basis,
        basisDate: input.mode === "rate" ? preview.basisDate : null,
        creditDate,
        entries,
        totalPaise: total,
        status: "finalized",
        transactionId: txn._id,
        idempotencyKey: input.idempotencyKey,
        note: input.note,
        createdBy: ctx.user._id,
        createdAt: new Date(),
      };
      await c.interestRuns.insertOne(doc, { session });
      await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "interest.finalize", entityType: "interestRun", entityId: runId, after: { period: input.period, mode: input.mode, rate: preview.monthlyRate, members: lines.length, totalPaise: total } }, session);
      return doc;
    });
    for (const l of lines) {
      await notifyMember(ctx.orgId, l.row.memberId, { type: "interest.credited", title: "Interest credited", body: `${formatMoney(l.amount, ctx.org.settings.currency)} interest for ${input.period} was added to your balance.`, link: `/org/${ctx.orgId}/my`, dedupeKey: `interest:${input.period}` });
    }
    return { run, duplicate: false };
  } catch (e) {
    if (isDuplicateKeyError(e)) {
      const again = await c.interestRuns.findOne({ organizationId: ctx.orgId, idempotencyKey: input.idempotencyKey });
      if (again) return { run: again, duplicate: true };
      throw new AppError("CONFLICT", `Interest for ${input.period} was already credited to one of these members`);
    }
    throw e;
  }
}

export async function listInterestRuns(ctx: OrgContext) {
  const c = await cols();
  const runs = await c.interestRuns.find({ organizationId: ctx.orgId }, { projection: { entries: 0 } }).sort({ period: -1, createdAt: -1 }).limit(120).toArray();
  const users = await c.users.find({ _id: { $in: runs.map((r) => r.createdBy) } }, { projection: { name: 1 } }).toArray();
  const um = new Map(users.map((u) => [u._id.toHexString(), u.name]));
  return runs.map((r) => ({ ...r, createdByName: um.get(r.createdBy.toHexString()) ?? null }));
}

export async function getInterestRun(ctx: OrgContext, id: ObjectId) {
  const c = await cols();
  const run = await c.interestRuns.findOne({ _id: id, organizationId: ctx.orgId });
  if (!run) throw notFound("Interest distribution");
  const members = await c.members.find({ _id: { $in: run.entries.map((e) => e.memberId) } }, { projection: { name: 1, membershipNumber: 1 } }).toArray();
  const mm = new Map(members.map((m) => [m._id.toHexString(), m]));
  return { ...run, entries: run.entries.map((e) => ({ ...e, member: mm.get(e.memberId.toHexString()) ?? null })) };
}
