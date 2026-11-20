import type { OrgContext } from "@/lib/auth";
import { cols } from "@/lib/collections";
import { todayIn } from "@/lib/dates";
import type { ObjectId } from "mongodb";
import { availableCashPaise, listAccounts } from "./account.service";
import { listMembers } from "./member.service";

/**
 * The Mandal's hisab sheet — one row per active member (shares, savings, hapta due, upad still
 * owed, upad interest due) and the Mandal's position, to share in the members' group as a photo
 * or PDF.
 *
 * "Each share" is worked out like the dashboard: cash + upad + hapta still to collect + upad
 * interest due, divided by the hapta shares (or by members when everyone pays one share).
 * Per member: their share (each share × their shares) and their net — the share less their own
 * upad, unpaid upad interest and hapta due. The nets add up to the cash in hand (less any rounding).
 */
export async function membersSheet(ctx: OrgContext) {
  const [list, cashPaise] = await Promise.all([listMembers(ctx, { status: "active", page: 1, pageSize: 5000 }), availableCashPaise(ctx.orgId)]);
  const interest = await interestByMonth(ctx, list.items.map((m) => m._id));
  const rows = list.items.map((m) => {
    const haptaDuePaise = m.outstandingPaise ?? 0;
    const interestDuePaise = m.upadInterestDuePaise ?? 0;
    return {
      memberId: m._id,
      membershipNumber: m.membershipNumber,
      name: m.name,
      shares: m.haptaShares ?? 1,
      savingsPaise: m.balancePaise ?? 0,
      haptaDuePaise,
      upadPaise: m.upadPaise ?? 0,
      interestDuePaise,
      /** unpaid upad interest of earlier months / of this month, and interest paid this month */
      interestPrevDuePaise: interest.prev.get(m._id.toHexString()) ?? 0,
      interestMonthDuePaise: interest.month.get(m._id.toHexString()) ?? 0,
      interestPaidMonthPaise: interest.paid.get(m._id.toHexString()) ?? 0,
      pendingPaise: haptaDuePaise + interestDuePaise,
    };
  });
  const sum = (k: "savingsPaise" | "haptaDuePaise" | "upadPaise" | "interestDuePaise" | "interestPrevDuePaise" | "interestMonthDuePaise" | "interestPaidMonthPaise" | "pendingPaise" | "shares") => rows.reduce((s, r) => s + r[k], 0);
  const totals = {
    shares: sum("shares"),
    savingsPaise: sum("savingsPaise"),
    haptaDuePaise: sum("haptaDuePaise"),
    upadPaise: sum("upadPaise"),
    interestDuePaise: sum("interestDuePaise"),
    interestPrevDuePaise: sum("interestPrevDuePaise"),
    interestMonthDuePaise: sum("interestMonthDuePaise"),
    interestPaidMonthPaise: sum("interestPaidMonthPaise"),
    pendingPaise: sum("pendingPaise"),
  };
  const totalPaise = cashPaise + totals.upadPaise + totals.haptaDuePaise + totals.interestDuePaise;
  const members = rows.length;
  const byShares = totals.shares !== members;
  const parts = byShares ? totals.shares : members;
  const eachPaise = parts > 0 ? Math.floor(totalPaise / parts) : 0;
  // each member's part of everything (by shares), and what is left for them once their own upad,
  // upad interest and hapta are settled — the nets add up to the cash in hand
  const withShare = rows.map((r) => {
    const sharePaise = eachPaise * (byShares ? r.shares : 1);
    return { ...r, sharePaise, netPaise: sharePaise - r.upadPaise - r.interestDuePaise - r.haptaDuePaise };
  });
  const { holders, movements } = await cashHolders(ctx);
  return {
    asOf: todayIn(ctx.org.settings.timezone),
    month: interest.monthKey,
    holders,
    movements,
    mandal: ctx.org.name,
    rows: withShare,
    shareTotalPaise: withShare.reduce((s, r) => s + r.sharePaise, 0),
    netTotalPaise: withShare.reduce((s, r) => s + r.netPaise, 0),
    totals,
    cashPaise,
    totalPaise,
    members,
    byShares,
    parts,
    eachPaise,
  };
}

const MOVEMENTS = 15;

/**
 * Who holds the Mandal's cash: every cash / UPI account with money in it (e.g. "Cash in hand",
 * "Cash — Rameshbhai"), and the latest transfers between them with their notes ("given to
 * Rameshbhai to keep"), so everyone in the group can see where the money is.
 */
async function cashHolders(ctx: OrgContext) {
  const c = await cols();
  const accounts = await listAccounts(ctx);
  const name = new Map(accounts.map((a) => [`fa:${a._id.toHexString()}`, a.name]));
  const holders = accounts.filter((a) => a.isActive || a.balancePaise !== 0).map((a) => ({ accountId: a._id, name: a.name, type: a.type, balancePaise: a.balancePaise }));

  const txns = await c.financialTransactions
    .find({ organizationId: ctx.orgId, type: "transfer", reversedBy: { $in: [null] } })
    .sort({ date: -1, createdAt: -1 })
    .limit(MOVEMENTS)
    .toArray();
  const lines = await c.ledgerEntries.find({ organizationId: ctx.orgId, transactionId: { $in: txns.map((t) => t._id) }, accountKey: { $regex: "^fa:" } }).toArray();
  const movements = txns
    .map((t) => {
      const mine = lines.filter((l) => l.transactionId.equals(t._id));
      const from = name.get(mine.find((l) => l.creditPaise > 0)?.accountKey ?? "") ?? "—";
      const to = name.get(mine.find((l) => l.debitPaise > 0)?.accountKey ?? "") ?? "—";
      // older transfers kept the note only in the description: "Transfer A → B — note"
      const prefix = `Transfer ${from} → ${to}`;
      const note = t.reason ?? (t.description.startsWith(`${prefix} — `) ? t.description.slice(prefix.length + 3) : undefined);
      return { date: t.date, from, to, amountPaise: t.amountPaise, note: note || null };
    })
    .reverse(); // oldest first, like a register
  return { holders, movements };
}

/**
 * Upad interest per member for this month's sheet: still unpaid from earlier months, still unpaid
 * for this month, and paid this month (by date paid, whichever month it was for).
 */
async function interestByMonth(ctx: OrgContext, memberIds: ObjectId[]) {
  const c = await cols();
  const today = todayIn(ctx.org.settings.timezone);
  const monthKey = today.toISOString().slice(0, 7);
  const monthStart = new Date(`${monthKey}-01T00:00:00.000Z`);
  const [dues, paid] = await Promise.all([
    c.fundLoanDues
      .aggregate<{ _id: { memberId: ObjectId; earlier: boolean }; due: number }>([
        { $match: { organizationId: ctx.orgId, memberId: { $in: memberIds }, period: { $lte: monthKey }, $expr: { $lt: ["$paidPaise", "$interestPaise"] } } },
        { $group: { _id: { memberId: "$memberId", earlier: { $lt: ["$period", monthKey] } }, due: { $sum: { $subtract: ["$interestPaise", "$paidPaise"] } } } },
      ])
      .toArray(),
    c.fundLoanPayments
      .aggregate<{ _id: ObjectId; paid: number }>([
        { $match: { organizationId: ctx.orgId, memberId: { $in: memberIds }, status: "valid", date: { $gte: monthStart, $lte: today }, interestPaise: { $gt: 0 } } },
        { $group: { _id: "$memberId", paid: { $sum: "$interestPaise" } } },
      ])
      .toArray(),
  ]);
  const prev = new Map<string, number>();
  const month = new Map<string, number>();
  for (const d of dues) (d._id.earlier ? prev : month).set(d._id.memberId.toHexString(), d.due);
  return { monthKey, prev, month, paid: new Map(paid.map((p) => [p._id.toHexString(), p.paid])) };
}
