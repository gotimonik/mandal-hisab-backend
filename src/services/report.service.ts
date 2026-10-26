import { ObjectId } from "mongodb";
import { z } from "zod";
import { cols } from "@/lib/collections";
import { badRequest, notFound } from "@/lib/errors";
import { financialYear, parseDateOnly, todayIn, utcAddDays, utcAddMonths } from "@/lib/dates";
import { paiseToRupeeString } from "@/lib/money";
import type { OrgContext } from "@/lib/auth";
import { dateOnly } from "@/validators/common";
import { FUND_LOANS, accountBalances, accountClass, accountLabels, faKey, normalBalance } from "./ledger.service";
import { fundLoanTotals } from "./fund-loan.service";
import { loanSummary } from "./loan.service";

export const ReportQuery = z.object({
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  asOf: dateOnly.optional(),
  groupBy: z.enum(["day", "month", "quarter", "year"]).default("month"),
  memberId: z.string().optional(),
  schemeId: z.string().optional(),
  accountId: z.string().optional(),
  accountKey: z.string().optional(),
  method: z.string().optional(),
  categoryKey: z.string().optional(),
  eventName: z.string().optional(),
  format: z.enum(["json", "csv"]).default("json"),
});
export type ReportParams = z.infer<typeof ReportQuery>;

/** Default range = current financial year to date. */
function range(ctx: OrgContext, q: ReportParams) {
  const today = todayIn(ctx.org.settings.timezone);
  const fy = financialYear(today, ctx.org.settings.financialYearStartMonth);
  const from = q.from ?? fy.start;
  const to = q.to ?? today;
  if (from > to) throw badRequest("From date must be before To date");
  return { from, to, today };
}

function periodExpr(groupBy: ReportParams["groupBy"], fyStartMonth: number) {
  switch (groupBy) {
    case "day":
      return { $dateToString: { format: "%Y-%m-%d", date: "$date" } };
    case "month":
      return { $dateToString: { format: "%Y-%m", date: "$date" } };
    case "year": {
      // financial year label e.g. 2026-27
      const y = { $year: "$date" };
      const startYear = { $cond: [{ $gte: [{ $month: "$date" }, fyStartMonth] }, y, { $subtract: [y, 1] }] };
      return fyStartMonth === 1
        ? { $toString: y }
        : { $concat: [{ $toString: startYear }, "-", { $substrBytes: [{ $toString: { $add: [startYear, 1] } }, 2, 2] }] };
    }
    case "quarter": {
      const y = { $year: "$date" };
      const m = { $month: "$date" };
      const offset = { $mod: [{ $add: [{ $subtract: [m, fyStartMonth] }, 12] }, 12] };
      const q = { $add: [{ $floor: { $divide: [offset, 3] } }, 1] };
      const startYear = { $cond: [{ $gte: [m, fyStartMonth] }, y, { $subtract: [y, 1] }] };
      return { $concat: [{ $toString: startYear }, "-Q", { $toString: q }] };
    }
  }
}

/* ------------------------------------------------------------------ dashboards */

export async function adminDashboard(ctx: OrgContext) {
  const c = await cols();
  const { today } = range(ctx, ReportQuery.parse({}));
  const fy = financialYear(today, ctx.org.settings.financialYearStartMonth);
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const chartStart = utcAddMonths(monthStart, -11);
  const orgId = ctx.orgId;

  // Independent queries are started together and awaited once (one round trip instead of many).
  const ledgerP = c.ledgerEntries
    .aggregate<{
      allTime: { _id: string; d: number; c: number }[];
      fy: { _id: string; d: number; c: number }[];
      month: { _id: string; d: number; c: number }[];
      cashAll: { _id: string; v: number }[];
      cashMonth: { _id: string; v: number }[];
      chart: { _id: { p: string; cls: string }; net: number }[];
    }>([
      { $match: { organizationId: orgId } },
      {
        $facet: {
          allTime: [{ $group: { _id: "$accountKey", d: { $sum: "$debitPaise" }, c: { $sum: "$creditPaise" } } }],
          fy: [{ $match: { date: { $gte: fy.start, $lte: today } } }, { $group: { _id: "$accountKey", d: { $sum: "$debitPaise" }, c: { $sum: "$creditPaise" } } }],
          month: [{ $match: { date: { $gte: monthStart, $lte: today } } }, { $group: { _id: "$accountKey", d: { $sum: "$debitPaise" }, c: { $sum: "$creditPaise" } } }],
          // Cash actually received/paid by kind (reversals netted into what they reverse)
          cashAll: [{ $match: { accountKey: { $regex: "^fa:" } } }, { $group: { _id: { $ifNull: ["$originalType", "$transactionType"] }, v: { $sum: { $subtract: ["$debitPaise", "$creditPaise"] } } } }],
          cashMonth: [{ $match: { accountKey: { $regex: "^fa:" }, date: { $gte: monthStart, $lte: today } } }, { $group: { _id: { $ifNull: ["$originalType", "$transactionType"] }, v: { $sum: { $subtract: ["$debitPaise", "$creditPaise"] } } } }],
          chart: [
            { $match: { date: { $gte: chartStart }, accountKey: { $regex: "^(income|expense):" } } },
            {
              $group: {
                _id: { p: { $dateToString: { format: "%Y-%m", date: "$date" } }, cls: { $arrayElemAt: [{ $split: ["$accountKey", ":"] }, 0] } },
                net: { $sum: { $subtract: ["$creditPaise", "$debitPaise"] } },
              },
            },
          ],
        },
      },
    ])
    .toArray();

  const sumCls = (rows: { _id: string; d: number; c: number }[], cls: string, filter?: (k: string) => boolean) =>
    rows.filter((r) => accountClass(r._id) === cls && (!filter || filter(r._id))).reduce((s, r) => s + normalBalance(r._id, r.d, r.c), 0);
  const byKey = (rows: { _id: string; d: number; c: number }[], key: string) => {
    const r = rows.find((x) => x._id === key);
    return r ? normalBalance(key, r.d, r.c) : 0;
  };
  const RECEIPT_TYPES = ["hapta_collection", "other_income", "donation", "loan_repayment"];
  const cashIn = (rows: { _id: string; v: number }[], types: string[]) => rows.filter((r) => types.includes(r._id)).reduce((s, r) => s + r.v, 0);

  const owedExpr = { $subtract: [{ $add: ["$amountPaise", "$penaltyPaise"] }, { $add: ["$paidPaise", "$penaltyPaidPaise"] }] };
  const instP = c.installments
    .aggregate<{
      outstanding: { amt: number; n: number }[];
      overdue: { amt: number; n: number }[];
      upcoming: { amt: number; n: number }[];
      upcomingList: { _id: ObjectId; dueDate: Date; amountPaise: number; paidPaise: number; periodLabel: string; memberId: ObjectId; schemeId: ObjectId }[];
      fyPerf: { due: number; paid: number }[];
    }>([
      { $match: { organizationId: orgId, state: "active" } },
      {
        $facet: {
          outstanding: [{ $match: { dueDate: { $lte: today }, $expr: { $gt: [owedExpr, 0] } } }, { $group: { _id: null, amt: { $sum: owedExpr }, n: { $sum: 1 } } }],
          overdue: [{ $match: { dueDate: { $lt: today }, $expr: { $gt: [owedExpr, 0] } } }, { $group: { _id: null, amt: { $sum: owedExpr }, n: { $sum: 1 } } }],
          upcoming: [{ $match: { dueDate: { $gt: today, $lte: utcAddDays(today, 30) } } }, { $group: { _id: null, amt: { $sum: owedExpr }, n: { $sum: 1 } } }],
          upcomingList: [{ $match: { dueDate: { $gt: today, $lte: utcAddDays(today, 30) }, $expr: { $gt: [owedExpr, 0] } } }, { $sort: { dueDate: 1 } }, { $limit: 10 }],
          fyPerf: [{ $match: { dueDate: { $gte: fy.start, $lte: today } } }, { $group: { _id: null, due: { $sum: "$amountPaise" }, paid: { $sum: "$paidPaise" } } }],
        },
      },
    ])
    .toArray();
  const loanP = c.loans
    .aggregate<{ active: number; principal: number; interestOutstanding: number; applied: number }>([
      { $match: { organizationId: orgId } },
      {
        $facet: {
          a: [{ $match: { status: "active" } }, { $group: { _id: null, n: { $sum: 1 }, p: { $sum: "$outstandingPrincipalPaise" } } }],
          i: [
            { $match: { status: "active" } },
            { $unwind: "$schedule" },
            { $match: { "schedule.dueDate": { $lte: today }, "schedule.status": { $ne: "waived" } } },
            { $group: { _id: null, v: { $sum: { $subtract: ["$schedule.interestDuePaise", "$schedule.interestPaidPaise"] } } } },
          ],
          ap: [{ $match: { status: { $in: ["applied", "approved"] } } }, { $count: "n" }],
        },
      },
      {
        $project: {
          active: { $ifNull: [{ $arrayElemAt: ["$a.n", 0] }, 0] },
          principal: { $ifNull: [{ $arrayElemAt: ["$a.p", 0] }, 0] },
          interestOutstanding: { $ifNull: [{ $arrayElemAt: ["$i.v", 0] }, 0] },
          applied: { $ifNull: [{ $arrayElemAt: ["$ap.n", 0] }, 0] },
        },
      },
    ])
    .toArray();

  // This month's hapta: expected vs collected for installments due this month (all schemes)
  const mhP = c.installments
    .aggregate<{ e: number; p: number; o: number }>([
      { $match: { organizationId: orgId, state: "active", dueDate: { $gte: monthStart, $lte: utcAddDays(utcAddMonths(monthStart, 1), -1) } } },
      { $group: { _id: null, e: { $sum: { $add: ["$amountPaise", "$penaltyPaise"] } }, p: { $sum: { $add: ["$paidPaise", "$penaltyPaidPaise"] } }, o: { $sum: { $max: [0, owedExpr] } } } },
    ])
    .toArray();
  const curMonth = today.toISOString().slice(0, 7);
  const iaP = c.memberLedger
    .aggregate<{ interest: { m: number; f: number }[]; byKind: { _id: string; v: number }[] }>([
      { $match: { organizationId: orgId } },
      {
        $facet: {
          // by date credited: covers monthly interest runs and shares of interest paid on fund loans
          interest: [
            { $match: { kind: "interest", date: { $gte: fy.start } } },
            { $group: { _id: null, m: { $sum: { $cond: [{ $gte: ["$date", parseDateOnly(`${curMonth}-01`)] }, { $subtract: ["$creditPaise", "$debitPaise"] }, 0] } }, f: { $sum: { $subtract: ["$creditPaise", "$debitPaise"] } } } },
          ],
          // what makes up the total member balances (all time)
          byKind: [{ $group: { _id: "$kind", v: { $sum: { $subtract: ["$creditPaise", "$debitPaise"] } } } }],
        },
      },
    ])
    .toArray();

  const [
    [ledgerFacet],
    [instFacet],
    schemes,
    [loanAgg],
    [mh],
    [ia],
    fundLoans,
    totalMembers,
    wd,
    [activeAgg, pendingPayments, pendingExpenses, pendingMemberships, accounts, recent, pendingUpadRequests, pendingUpadPayments],
  ] = await Promise.all([
    ledgerP,
    instP,
    c.haptaSchemes.find({ organizationId: orgId }, { projection: { name: 1, graceDays: 1, status: 1 } }).toArray(),
    loanP,
    mhP,
    iaP,
    fundLoanTotals(ctx.org),
    c.members.countDocuments({ organizationId: orgId, status: { $ne: "left" } }),
    c.withdrawals.find({ organizationId: orgId, status: "paid" }).sort({ date: -1, createdAt: -1 }).limit(5).toArray(),
    Promise.all([
      c.members
        .aggregate<{ n: number; shares: number }>([{ $match: { organizationId: orgId, status: "active" } }, { $group: { _id: null, n: { $sum: 1 }, shares: { $sum: { $ifNull: ["$haptaShares", 1] } } } }])
        .toArray()
        .then(([r]) => r ?? { n: 0, shares: 0 }),
      c.payments.countDocuments({ organizationId: orgId, status: "pending" }),
      c.expenses.countDocuments({ organizationId: orgId, status: "pending" }),
      c.organizationMemberships.countDocuments({ organizationId: orgId, status: "pending" }),
      c.financialAccounts.find({ organizationId: orgId }, { projection: { name: 1, type: 1, isActive: 1 } }).toArray(),
      c.financialTransactions.find({ organizationId: orgId }).sort({ date: -1, _id: -1 }).limit(10).toArray(),
      c.upadRequests.countDocuments({ organizationId: orgId, status: "pending" }),
      c.upadPaymentClaims.countDocuments({ organizationId: orgId, status: "pending" }),
    ]),
  ]);
  const activeMembers = activeAgg.n;
  const monthHapta = { expected: mh?.e ?? 0, collected: mh?.p ?? 0, outstanding: mh?.o ?? 0 };
  const interest = { month: ia?.interest[0]?.m ?? 0, fy: ia?.interest[0]?.f ?? 0 };
  const kindTotal = (k: string) => ia?.byKind.find((x) => x._id === k)?.v ?? 0;
  const balanceParts = {
    openingPaise: kindTotal("opening"),
    haptaPaise: kindTotal("hapta"),
    interestPaise: kindTotal("interest"),
    withdrawalsPaise: -kindTotal("withdrawal"),
    // anything else (adjustments, reversals of other kinds) so the parts always add up
    otherPaise: (ia?.byKind ?? []).filter((x) => !["opening", "hapta", "interest", "withdrawal"].includes(x._id)).reduce((s, x) => s + x.v, 0),
  };

  // Overdue respects each scheme's grace days.
  const graceMax = Math.max(0, ...schemes.map((s) => s.graceDays));
  let overdue = instFacet.overdue[0] ?? { amt: 0, n: 0 };
  if (graceMax > 0) {
    const overdueAgg = await c.installments
      .aggregate<{ amt: number; n: number }>([
        { $match: { organizationId: orgId, state: "active", dueDate: { $lt: today }, $expr: { $gt: [owedExpr, 0] } } },
        { $lookup: { from: "haptaSchemes", localField: "schemeId", foreignField: "_id", as: "s" } },
        { $set: { grace: { $ifNull: [{ $arrayElemAt: ["$s.graceDays", 0] }, 0] } } },
        { $match: { $expr: { $lt: [{ $dateAdd: { startDate: "$dueDate", unit: "day", amount: "$grace" } }, today] } } },
        { $group: { _id: null, amt: { $sum: owedExpr }, n: { $sum: 1 } } },
      ])
      .toArray();
    overdue = overdueAgg[0] ?? { amt: 0, n: 0 };
  }

  // second round: lookups that depend on the results above
  const [wdm, members] = await Promise.all([
    c.members.find({ _id: { $in: wd.map((w) => w.memberId) } }, { projection: { name: 1 } }).toArray(),
    c.members.find({ _id: { $in: instFacet.upcomingList.map((u) => u.memberId) } }, { projection: { name: 1 } }).toArray(),
  ]);
  const recentWithdrawals = wd.map((w) => ({ _id: w._id, number: w.number, date: w.date, amountPaise: w.amountPaise, memberId: w.memberId, memberName: wdm.find((m) => m._id.equals(w.memberId))?.name ?? "" }));

  const mm = new Map(members.map((m) => [m._id.toHexString(), m.name]));
  const sm = new Map(schemes.map((s) => [s._id.toHexString(), s.name]));

  const months: string[] = [];
  for (let i = 0; i < 12; i++) {
    const d = utcAddMonths(chartStart, i);
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  const chart = months.map((m) => ({
    month: m,
    incomePaise: ledgerFacet.chart.filter((x) => x._id.p === m && x._id.cls === "income").reduce((s, x) => s + x.net, 0),
    expensePaise: -ledgerFacet.chart.filter((x) => x._id.p === m && x._id.cls === "expense").reduce((s, x) => s + x.net, 0),
  }));
  const perf = instFacet.fyPerf[0] ?? { due: 0, paid: 0 };

  return {
    asOf: today,
    financialYear: fy.label,
    totals: {
      totalCollectedPaise: cashIn(ledgerFacet.cashAll, RECEIPT_TYPES),
      fyIncomePaise: sumCls(ledgerFacet.fy, "income"),
      fyExpensesPaise: sumCls(ledgerFacet.fy, "expense"),
      fySurplusPaise: sumCls(ledgerFacet.fy, "income") - sumCls(ledgerFacet.fy, "expense"),
      monthCollectionsPaise: cashIn(ledgerFacet.cashMonth, RECEIPT_TYPES),
      monthHaptaCashPaise: cashIn(ledgerFacet.cashMonth, ["hapta_collection"]),
      monthWithdrawalsPaise: -cashIn(ledgerFacet.cashMonth, ["withdrawal"]),
      totalMemberBalancesPaise: byKey(ledgerFacet.allTime, "liability:member_funds"),
      /** opening + hapta + interest − withdrawals (+ other adjustments) = total member balances */
      memberBalanceParts: balanceParts,
      mandalCashPaise: accounts.reduce((s, a) => s + byKey(ledgerFacet.allTime, faKey(a._id)), 0),
      mandalSurplusPaise: accounts.reduce((s, a) => s + byKey(ledgerFacet.allTime, faKey(a._id)), 0) + byKey(ledgerFacet.allTime, "asset:loans_receivable") + byKey(ledgerFacet.allTime, FUND_LOANS) - byKey(ledgerFacet.allTime, "liability:member_funds"),
      fundLoansOutstandingPaise: fundLoans.outstandingPaise,
      fundLoanInterestDuePaise: fundLoans.interestDuePaise,
      activeFundLoans: fundLoans.activeLoans,
      /** cash + money lent out of the fund */
      mandalFundPaise: accounts.reduce((s, a) => s + byKey(ledgerFacet.allTime, faKey(a._id)), 0) + fundLoans.outstandingPaise,
      monthExpectedPaise: monthHapta.expected,
      monthCollectedAgainstDuePaise: monthHapta.collected,
      monthPendingPaise: monthHapta.outstanding,
      interestThisMonthPaise: interest.month,
      interestThisFyPaise: interest.fy,
      totalMembers: totalMembers,
      monthExpensesPaise: sumCls(ledgerFacet.month, "expense"),
      outstandingHaptaPaise: instFacet.outstanding[0]?.amt ?? 0,
      outstandingInstallments: instFacet.outstanding[0]?.n ?? 0,
      overdueAmountPaise: overdue.amt,
      overdueInstallments: overdue.n,
      upcoming30DaysPaise: instFacet.upcoming[0]?.amt ?? 0,
      activeMembers,
      /** Σ hapta shares of active members (a member paying 3 haptas counts 3) */
      activeShares: activeAgg.shares,
      activeSchemes: schemes.filter((s) => s.status === "active").length,
      activeLoans: loanAgg?.active ?? 0,
      loanOutstandingPrincipalPaise: loanAgg?.principal ?? 0,
      interestCollectedPaise: byKey(ledgerFacet.allTime, "income:interest"),
      interestOutstandingPaise: loanAgg?.interestOutstanding ?? 0,
      cashBalancePaise: accounts.filter((a) => a.type === "cash").reduce((s, a) => s + byKey(ledgerFacet.allTime, faKey(a._id)), 0),
      bankBalancePaise: accounts.filter((a) => a.type !== "cash").reduce((s, a) => s + byKey(ledgerFacet.allTime, faKey(a._id)), 0),
    },
    accounts: accounts.map((a) => ({ _id: a._id, name: a.name, type: a.type, isActive: a.isActive, balancePaise: byKey(ledgerFacet.allTime, faKey(a._id)) })),
    pending: { payments: pendingPayments, expenses: pendingExpenses, memberships: pendingMemberships, loans: loanAgg?.applied ?? 0, upadRequests: pendingUpadRequests, upadPayments: pendingUpadPayments },
    collectionPerformance: { duePaise: perf.due, collectedPaise: perf.paid, percent: perf.due ? Math.round((perf.paid / perf.due) * 1000) / 10 : 100 },
    upcomingDues: instFacet.upcomingList.map((u) => ({ ...u, memberName: mm.get(u.memberId.toHexString()) ?? "", schemeName: sm.get(u.schemeId.toHexString()) ?? "" })),
    recentTransactions: recent,
    recentWithdrawals,
    monthlyChart: chart,
  };
}

export async function managerDashboard(ctx: OrgContext) {
  const full = await adminDashboard(ctx);
  const showMoney = ctx.can("reports.sensitive");
  return {
    asOf: full.asOf,
    financialYear: full.financialYear,
    totals: {
      monthCollectionsPaise: full.totals.monthCollectionsPaise,
      outstandingHaptaPaise: full.totals.outstandingHaptaPaise,
      outstandingInstallments: full.totals.outstandingInstallments,
      overdueAmountPaise: full.totals.overdueAmountPaise,
      overdueInstallments: full.totals.overdueInstallments,
      upcoming30DaysPaise: full.totals.upcoming30DaysPaise,
      activeMembers: full.totals.activeMembers,
      activeShares: full.totals.activeShares,
      activeSchemes: full.totals.activeSchemes,
      totalMembers: full.totals.totalMembers,
      monthExpectedPaise: full.totals.monthExpectedPaise,
      monthCollectedAgainstDuePaise: full.totals.monthCollectedAgainstDuePaise,
      monthPendingPaise: full.totals.monthPendingPaise,
      monthHaptaCashPaise: full.totals.monthHaptaCashPaise,
      mandalCashPaise: full.totals.mandalCashPaise,
      totalMemberBalancesPaise: full.totals.totalMemberBalancesPaise,
      interestThisMonthPaise: full.totals.interestThisMonthPaise,
      monthWithdrawalsPaise: full.totals.monthWithdrawalsPaise,
      fundLoansOutstandingPaise: full.totals.fundLoansOutstandingPaise,
      fundLoanInterestDuePaise: full.totals.fundLoanInterestDuePaise,
      activeFundLoans: full.totals.activeFundLoans,
      mandalFundPaise: full.totals.mandalFundPaise,
      ...(showMoney ? { fyIncomePaise: full.totals.fyIncomePaise, fyExpensesPaise: full.totals.fyExpensesPaise } : {}),
    },
    accounts: full.accounts,
    pending: full.pending,
    collectionPerformance: full.collectionPerformance,
    upcomingDues: full.upcomingDues,
    recentTransactions: full.recentTransactions,
    recentWithdrawals: full.recentWithdrawals,
    monthlyChart: showMoney ? full.monthlyChart : undefined,
  };
}

export async function memberDashboard(ctx: OrgContext) {
  const memberId = ctx.membership.memberId;
  if (!memberId) return { linked: false };
  const c = await cols();
  const today = todayIn(ctx.org.settings.timezone);
  const [member, insts, receipts, loans] = await Promise.all([
    c.members.findOne({ _id: memberId, organizationId: ctx.orgId }, { projection: { searchText: 0 } }),
    c.installments.find({ organizationId: ctx.orgId, memberId, state: { $in: ["active", "waived"] } }, { projection: { history: 0 } }).sort({ dueDate: 1 }).toArray(),
    c.receipts.find({ organizationId: ctx.orgId, memberId }).sort({ date: -1 }).limit(10).toArray(),
    c.loans.find({ organizationId: ctx.orgId, memberId, status: { $in: ["active", "approved", "applied", "closed"] } }).toArray(),
  ]);
  const active = insts.filter((i) => i.state === "active");
  const owed = (i: (typeof insts)[number]) => i.amountPaise + i.penaltyPaise - i.paidPaise - i.penaltyPaidPaise;
  const next = active.find((i) => owed(i) > 0 && i.dueDate >= today) ?? active.find((i) => owed(i) > 0);
  return {
    linked: true,
    member,
    totals: {
      totalPaidPaise: insts.reduce((s, i) => s + i.paidPaise + i.penaltyPaidPaise, 0),
      outstandingPaise: active.filter((i) => i.dueDate <= today).reduce((s, i) => s + Math.max(0, owed(i)), 0),
      overduePaise: active.filter((i) => i.dueDate < today).reduce((s, i) => s + Math.max(0, owed(i)), 0),
      upcomingPaise: active.filter((i) => i.dueDate > today).reduce((s, i) => s + Math.max(0, owed(i)), 0),
    },
    nextInstallment: next ? { _id: next._id, dueDate: next.dueDate, periodLabel: next.periodLabel, amountPaise: owed(next) } : null,
    savings: await memberSavingsSummary(ctx.orgId, memberId),
    fundLoans: await fundLoanTotals(ctx.org, memberId),
    /** what this member pays each month: the hapta × their shares */
    monthlyHaptaPaise: ctx.org.settings.monthlyHapta ? ctx.org.settings.monthlyHapta.amountPaise * (member?.haptaShares ?? 1) : null,
    haptaShares: member?.haptaShares ?? 1,
    receipts,
    loans: loans.map((l) => {
      const { schedule: _s, ...rest } = l;
      return { ...rest, summary: l.status === "active" ? loanSummary(l, today) : null };
    }),
  };
}

/* ------------------------------------------------------------------ financial statements */

export async function incomeExpense(ctx: OrgContext, q: ReportParams) {
  const { from, to } = range(ctx, q);
  const labels = await accountLabels(ctx.org);
  const rows = await accountBalances(ctx.orgId, { from, asOf: to });
  const income = rows.filter((r) => accountClass(r.accountKey) === "income").map((r) => ({ accountKey: r.accountKey, name: labels[r.accountKey] ?? r.accountKey, amountPaise: r.balancePaise }));
  const expense = rows.filter((r) => accountClass(r.accountKey) === "expense").map((r) => ({ accountKey: r.accountKey, name: labels[r.accountKey] ?? r.accountKey, amountPaise: r.balancePaise }));
  const ti = income.reduce((s, r) => s + r.amountPaise, 0);
  const te = expense.reduce((s, r) => s + r.amountPaise, 0);
  return { from, to, income, expense, totalIncomePaise: ti, totalExpensePaise: te, surplusPaise: ti - te };
}

export async function trialBalance(ctx: OrgContext, q: ReportParams) {
  const asOf = q.asOf ?? q.to ?? todayIn(ctx.org.settings.timezone);
  const labels = await accountLabels(ctx.org);
  const rows = await accountBalances(ctx.orgId, { asOf });
  const lines = rows.map((r) => {
    const net = r.debitPaise - r.creditPaise;
    return { accountKey: r.accountKey, name: labels[r.accountKey] ?? r.accountKey, class: accountClass(r.accountKey), debitPaise: net > 0 ? net : 0, creditPaise: net < 0 ? -net : 0 };
  });
  const td = lines.reduce((s, l) => s + l.debitPaise, 0);
  const tc = lines.reduce((s, l) => s + l.creditPaise, 0);
  return { asOf, lines, totalDebitPaise: td, totalCreditPaise: tc, balanced: td === tc };
}

export async function balanceSheet(ctx: OrgContext, q: ReportParams) {
  const asOf = q.asOf ?? q.to ?? todayIn(ctx.org.settings.timezone);
  const labels = await accountLabels(ctx.org);
  const rows = await accountBalances(ctx.orgId, { asOf });
  const pick = (cls: string) => rows.filter((r) => accountClass(r.accountKey) === cls).map((r) => ({ accountKey: r.accountKey, name: labels[r.accountKey] ?? r.accountKey, amountPaise: r.balancePaise }));
  const assets = pick("asset");
  const liabilities = pick("liability");
  const equity = pick("equity");
  const surplus = rows.filter((r) => accountClass(r.accountKey) === "income").reduce((s, r) => s + r.balancePaise, 0) - rows.filter((r) => accountClass(r.accountKey) === "expense").reduce((s, r) => s + r.balancePaise, 0);
  equity.push({ accountKey: "equity:accumulated_surplus", name: "Accumulated surplus (income − expenses)", amountPaise: surplus });
  const ta = assets.reduce((s, r) => s + r.amountPaise, 0);
  const tl = liabilities.reduce((s, r) => s + r.amountPaise, 0);
  const te = equity.reduce((s, r) => s + r.amountPaise, 0);
  return { asOf, assets, liabilities, equity, totalAssetsPaise: ta, totalLiabilitiesPaise: tl, totalEquityPaise: te, balanced: ta === tl + te };
}

export async function accountSummary(ctx: OrgContext, q: ReportParams) {
  const { from, to } = range(ctx, q);
  const c = await cols();
  const accounts = await c.financialAccounts.find({ organizationId: ctx.orgId }).sort({ name: 1 }).toArray();
  const before = await accountBalances(ctx.orgId, { asOf: utcAddDays(from, -1), prefix: "fa:" });
  const during = await accountBalances(ctx.orgId, { from, asOf: to, prefix: "fa:" });
  const bm = new Map(before.map((b) => [b.accountKey, b.balancePaise]));
  const dm = new Map(during.map((d) => [d.accountKey, d]));
  const rows = accounts
    .filter((a) => !q.accountId || a._id.toHexString() === q.accountId)
    .map((a) => {
      const k = faKey(a._id);
      const opening = bm.get(k) ?? 0;
      const d = dm.get(k);
      const receipts = d?.debitPaise ?? 0;
      const payments = d?.creditPaise ?? 0;
      return { accountId: a._id, name: a.name, type: a.type, openingPaise: opening, receiptsPaise: receipts, paymentsPaise: payments, closingPaise: opening + receipts - payments };
    });
  return { from, to, rows, totals: rows.reduce((t, r) => ({ openingPaise: t.openingPaise + r.openingPaise, receiptsPaise: t.receiptsPaise + r.receiptsPaise, paymentsPaise: t.paymentsPaise + r.paymentsPaise, closingPaise: t.closingPaise + r.closingPaise }), { openingPaise: 0, receiptsPaise: 0, paymentsPaise: 0, closingPaise: 0 }) };
}

/** Cash flow: movement in cash/bank/UPI accounts by transaction type (inter-account transfers excluded). */
export async function cashFlow(ctx: OrgContext, q: ReportParams) {
  const { from, to } = range(ctx, q);
  const c = await cols();
  const rows = await c.ledgerEntries
    .aggregate<{ _id: string; inflow: number; outflow: number }>([
      { $match: { organizationId: ctx.orgId, accountKey: { $regex: "^fa:" }, date: { $gte: from, $lte: to }, transactionType: { $ne: "transfer" } } },
      { $group: { _id: "$transactionType", inflow: { $sum: "$debitPaise" }, outflow: { $sum: "$creditPaise" } } },
      { $sort: { _id: 1 } },
    ])
    .toArray();
  const LABEL: Record<string, string> = {
    opening_balance: "Opening balances",
    hapta_collection: "Hapta collections",
    other_income: "Other income & fees",
    donation: "Donations",
    expense: "Expenses paid",
    expense_reimbursement: "Expense reimbursements",
    loan_disbursement: "Loans disbursed",
    loan_repayment: "Loan repayments received",
    adjustment: "Adjustments",
    reversal: "Reversals & refunds",
  };
  const SECTION: Record<string, string> = {
    hapta_collection: "operating",
    other_income: "operating",
    donation: "operating",
    expense: "operating",
    expense_reimbursement: "operating",
    loan_disbursement: "lending",
    loan_repayment: "lending",
    opening_balance: "other",
    adjustment: "other",
    reversal: "other",
  };
  const opening = (await accountBalances(ctx.orgId, { asOf: utcAddDays(from, -1), prefix: "fa:" })).reduce((s, r) => s + r.balancePaise, 0);
  const lines = rows.map((r) => ({ type: r._id, name: LABEL[r._id] ?? r._id, section: SECTION[r._id] ?? "other", inflowPaise: r.inflow, outflowPaise: r.outflow, netPaise: r.inflow - r.outflow }));
  const net = lines.reduce((s, l) => s + l.netPaise, 0);
  return { from, to, openingCashPaise: opening, lines, netChangePaise: net, closingCashPaise: opening + net };
}

export async function ledgerAccount(ctx: OrgContext, q: ReportParams) {
  if (!q.accountKey) throw badRequest("accountKey is required");
  accountClass(q.accountKey);
  const { from, to } = range(ctx, q);
  const c = await cols();
  const before = await accountBalances(ctx.orgId, { asOf: utcAddDays(from, -1), prefix: q.accountKey });
  const opening = before.find((b) => b.accountKey === q.accountKey)?.balancePaise ?? 0;
  const lines = await c.ledgerEntries.find({ organizationId: ctx.orgId, accountKey: q.accountKey, date: { $gte: from, $lte: to } }).sort({ date: 1, createdAt: 1, _id: 1 }).limit(5000).toArray();
  const txns = await c.financialTransactions.find({ _id: { $in: lines.map((l) => l.transactionId) } }, { projection: { number: 1, description: 1 } }).toArray();
  const tm = new Map(txns.map((t) => [t._id.toHexString(), t]));
  let bal = opening;
  const labels = await accountLabels(ctx.org);
  return {
    accountKey: q.accountKey,
    name: labels[q.accountKey] ?? q.accountKey,
    from,
    to,
    openingPaise: opening,
    lines: lines.map((l) => {
      bal += normalBalance(q.accountKey!, l.debitPaise, l.creditPaise);
      const t = tm.get(l.transactionId.toHexString());
      return { date: l.date, number: t?.number, description: t?.description, debitPaise: l.debitPaise, creditPaise: l.creditPaise, balancePaise: bal };
    }),
    closingPaise: bal,
  };
}

/* ------------------------------------------------------------------ collections & hapta */

export async function collections(ctx: OrgContext, q: ReportParams) {
  const { from, to } = range(ctx, q);
  const c = await cols();
  const match: Record<string, unknown> = {
    organizationId: ctx.orgId,
    date: { $gte: from, $lte: to },
    accountKey: { $regex: "^(income:|asset:loans_receivable$|liability:member_funds$)" },
  };
  if (q.memberId && ObjectId.isValid(q.memberId)) match.memberId = new ObjectId(q.memberId);
  const rows = await c.ledgerEntries
    .aggregate<{ _id: { p: string; k: string }; amt: number }>([
      { $match: match },
      // loans receivable: only principal repaid (credits) is a collection
      {
        $project: {
          date: 1,
          accountKey: 1,
          amt: {
            $switch: {
              branches: [
                { case: { $eq: ["$accountKey", "asset:loans_receivable"] }, then: { $cond: [{ $eq: [{ $ifNull: ["$originalType", "$transactionType"] }, "loan_repayment"] }, { $subtract: ["$creditPaise", "$debitPaise"] }, 0] } },
                // member-savings Mandals: hapta is credited to member funds, not income
                { case: { $eq: ["$accountKey", "liability:member_funds"] }, then: { $cond: [{ $eq: [{ $ifNull: ["$originalType", "$transactionType"] }, "hapta_collection"] }, { $subtract: ["$creditPaise", "$debitPaise"] }, 0] } },
              ],
              default: { $subtract: ["$creditPaise", "$debitPaise"] },
            },
          },
        },
      },
      { $group: { _id: { p: periodExpr(q.groupBy, ctx.org.settings.financialYearStartMonth), k: "$accountKey" }, amt: { $sum: "$amt" } } },
      { $sort: { "_id.p": 1 } },
    ])
    .toArray();
  const labels = await accountLabels(ctx.org);
  labels["asset:loans_receivable"] = "Loan principal repaid";
  labels["liability:member_funds"] = "Hapta (member savings)";
  const periods = [...new Set(rows.filter((r) => r.amt !== 0).map((r) => r._id.p))];
  const keys = [...new Set(rows.filter((r) => r.amt !== 0).map((r) => r._id.k))].sort();
  const table = periods.map((p) => {
    const byCat: Record<string, number> = {};
    for (const k of keys) byCat[k] = rows.find((r) => r._id.p === p && r._id.k === k)?.amt ?? 0;
    return { period: p, byCategory: byCat, totalPaise: Object.values(byCat).reduce((s, v) => s + v, 0) };
  });
  return {
    from,
    to,
    groupBy: q.groupBy,
    categories: keys.map((k) => ({ key: k, name: labels[k] ?? k })),
    rows: table,
    totalPaise: table.reduce((s, r) => s + r.totalPaise, 0),
  };
}

export async function haptaReport(ctx: OrgContext, q: ReportParams) {
  const { from, to, today } = range(ctx, q);
  const c = await cols();
  const match: Record<string, unknown> = { organizationId: ctx.orgId, dueDate: { $gte: from, $lte: to }, state: { $in: ["active", "waived"] } };
  if (q.schemeId && ObjectId.isValid(q.schemeId)) match.schemeId = new ObjectId(q.schemeId);
  if (q.memberId && ObjectId.isValid(q.memberId)) match.memberId = new ObjectId(q.memberId);
  const rows = await c.installments
    .aggregate<{ _id: ObjectId; due: number; paid: number; waived: number; count: number; members: ObjectId[]; overdue: number }>([
      { $match: match },
      {
        $group: {
          _id: "$schemeId",
          due: { $sum: { $cond: [{ $eq: ["$state", "active"] }, "$amountPaise", "$paidPaise"] } },
          paid: { $sum: "$paidPaise" },
          waived: { $sum: { $cond: [{ $eq: ["$state", "waived"] }, { $subtract: ["$amountPaise", "$paidPaise"] }, 0] } },
          count: { $sum: 1 },
          members: { $addToSet: "$memberId" },
          overdue: { $sum: { $cond: [{ $and: [{ $eq: ["$state", "active"] }, { $lt: ["$dueDate", today] }, { $lt: ["$paidPaise", "$amountPaise"] }] }, { $subtract: ["$amountPaise", "$paidPaise"] }, 0] } },
        },
      },
    ])
    .toArray();
  const schemes = await c.haptaSchemes.find({ organizationId: ctx.orgId }, { projection: { name: 1, frequency: 1, amountPaise: 1 } }).toArray();
  const sm = new Map(schemes.map((s) => [s._id.toHexString(), s]));
  const out = rows.map((r) => ({
    schemeId: r._id,
    schemeName: sm.get(r._id.toHexString())?.name ?? "",
    frequency: sm.get(r._id.toHexString())?.frequency,
    installments: r.count,
    members: r.members.length,
    duePaise: r.due,
    collectedPaise: r.paid,
    waivedPaise: r.waived,
    outstandingPaise: r.due - r.paid,
    overduePaise: r.overdue,
    collectionPercent: r.due ? Math.round((r.paid / r.due) * 1000) / 10 : 100,
  }));
  return { from, to, rows: out, totals: { duePaise: out.reduce((s, r) => s + r.duePaise, 0), collectedPaise: out.reduce((s, r) => s + r.collectedPaise, 0), outstandingPaise: out.reduce((s, r) => s + r.outstandingPaise, 0), overduePaise: out.reduce((s, r) => s + r.overduePaise, 0) } };
}

export async function overdueReport(ctx: OrgContext, q: ReportParams) {
  const today = todayIn(ctx.org.settings.timezone);
  const c = await cols();
  const match: Record<string, unknown> = { organizationId: ctx.orgId, state: "active", dueDate: { $lt: today }, $expr: { $lt: [{ $add: ["$paidPaise", "$penaltyPaidPaise"] }, { $add: ["$amountPaise", "$penaltyPaise"] }] } };
  if (q.schemeId && ObjectId.isValid(q.schemeId)) match.schemeId = new ObjectId(q.schemeId);
  if (q.memberId && ObjectId.isValid(q.memberId)) match.memberId = new ObjectId(q.memberId);
  const rows = await c.installments
    .aggregate([
      { $match: match },
      { $lookup: { from: "haptaSchemes", localField: "schemeId", foreignField: "_id", as: "s" } },
      { $lookup: { from: "members", localField: "memberId", foreignField: "_id", as: "m" } },
      { $set: { grace: { $ifNull: [{ $arrayElemAt: ["$s.graceDays", 0] }, 0] } } },
      { $match: { $expr: { $lt: [{ $dateAdd: { startDate: "$dueDate", unit: "day", amount: "$grace" } }, today] } } },
      {
        $project: {
          dueDate: 1,
          periodLabel: 1,
          amountPaise: 1,
          paidPaise: 1,
          penaltyPaise: 1,
          penaltyPaidPaise: 1,
          memberId: 1,
          schemeId: 1,
          schemeName: { $arrayElemAt: ["$s.name", 0] },
          memberName: { $arrayElemAt: ["$m.name", 0] },
          membershipNumber: { $arrayElemAt: ["$m.membershipNumber", 0] },
          phone: { $arrayElemAt: ["$m.phone", 0] },
          outstandingPaise: { $subtract: [{ $add: ["$amountPaise", "$penaltyPaise"] }, { $add: ["$paidPaise", "$penaltyPaidPaise"] }] },
          daysOverdue: { $dateDiff: { startDate: "$dueDate", endDate: today, unit: "day" } },
        },
      },
      { $sort: { dueDate: 1 } },
      { $limit: 5000 },
    ])
    .toArray();
  return { asOf: today, rows, totalOutstandingPaise: rows.reduce((s, r) => s + (r.outstandingPaise as number), 0) };
}

/* ------------------------------------------------------------------ member statement */

export async function memberStatement(ctx: OrgContext, memberIdRaw: string, q: ReportParams) {
  if (!ObjectId.isValid(memberIdRaw)) throw notFound("Member");
  const memberId = new ObjectId(memberIdRaw);
  const c = await cols();
  const member = await c.members.findOne({ _id: memberId, organizationId: ctx.orgId }, { projection: { searchText: 0 } });
  if (!member) throw notFound("Member");
  const { from, to } = range(ctx, { ...q, from: q.from ?? member.joiningDate });
  const schemes = await c.haptaSchemes.find({ organizationId: ctx.orgId }, { projection: { name: 1 } }).toArray();
  const sm = new Map(schemes.map((s) => [s._id.toHexString(), s.name]));

  // Dues (debits): installments that fell due; waivers as credits.
  const insts = await c.installments.find({ organizationId: ctx.orgId, memberId, state: { $in: ["active", "waived"] }, dueDate: { $lte: to } }).toArray();
  // Payments (credits) and their reversals (debits) from the ledger.
  const txns = await c.financialTransactions.find({ organizationId: ctx.orgId, memberId, date: { $lte: to }, type: { $in: ["hapta_collection", "reversal"] } }).toArray();
  const origIds = txns.filter((t) => t.type === "reversal" && t.reversalOf).map((t) => t.reversalOf!);
  const origs = await c.financialTransactions.find({ _id: { $in: origIds } }, { projection: { type: 1 } }).toArray();
  const origType = new Map(origs.map((o) => [o._id.toHexString(), o.type]));

  type Line = { date: Date; description: string; debitPaise: number; creditPaise: number; ref?: string };
  const lines: Line[] = [];
  for (const i of insts) {
    const label = `${sm.get(i.schemeId.toHexString()) ?? "Hapta"} — ${i.periodLabel}`;
    lines.push({ date: i.dueDate, description: `Due: ${label}`, debitPaise: i.amountPaise + i.penaltyPaise, creditPaise: 0 });
    if (i.state === "waived") lines.push({ date: i.dueDate, description: `Waived: ${label}${i.stateReason ? ` (${i.stateReason})` : ""}`, debitPaise: 0, creditPaise: i.amountPaise + i.penaltyPaise - i.paidPaise - i.penaltyPaidPaise });
  }
  for (const t of txns) {
    if (t.type === "hapta_collection") lines.push({ date: t.date, description: t.description, debitPaise: 0, creditPaise: t.amountPaise, ref: t.number });
    else if (t.reversalOf && origType.get(t.reversalOf.toHexString()) === "hapta_collection") lines.push({ date: t.date, description: t.description, debitPaise: t.amountPaise, creditPaise: 0, ref: t.number });
  }
  lines.sort((a, b) => a.date.getTime() - b.date.getTime() || b.debitPaise - a.debitPaise);
  const openingLines = lines.filter((l) => l.date < from);
  const periodLines = lines.filter((l) => l.date >= from);
  const opening = openingLines.reduce((s, l) => s + l.debitPaise - l.creditPaise, 0);
  let bal = opening;
  const withBal = periodLines.map((l) => {
    bal += l.debitPaise - l.creditPaise;
    return { ...l, balancePaise: bal };
  });
  const loans = await c.loans.find({ organizationId: ctx.orgId, memberId, status: { $in: ["active", "closed"] } }).toArray();
  const today = todayIn(ctx.org.settings.timezone);
  return {
    member,
    from,
    to,
    openingBalancePaise: opening,
    lines: withBal,
    totalDebitPaise: periodLines.reduce((s, l) => s + l.debitPaise, 0),
    totalCreditPaise: periodLines.reduce((s, l) => s + l.creditPaise, 0),
    closingBalancePaise: bal,
    note: "Positive balance = amount owed by the member; negative = paid in advance.",
    loans: loans.map((l) => ({ loanNumber: l.loanNumber, status: l.status, principalPaise: l.principalPaise, summary: loanSummary(l, today) })),
  };
}

/* ------------------------------------------------------------------ loans & interest */

export async function loanOutstandingReport(ctx: OrgContext) {
  const c = await cols();
  const today = todayIn(ctx.org.settings.timezone);
  const loans = await c.loans.find({ organizationId: ctx.orgId, status: "active" }).toArray();
  const members = await c.members.find({ _id: { $in: loans.map((l) => l.memberId) } }, { projection: { name: 1, membershipNumber: 1 } }).toArray();
  const mm = new Map(members.map((m) => [m._id.toHexString(), m]));
  const rows = loans.map((l) => {
    const s = loanSummary(l, today);
    return { loanId: l._id, loanNumber: l.loanNumber, memberName: mm.get(l.memberId.toHexString())?.name, method: l.interestMethod, annualRate: l.annualRate, principalPaise: l.principalPaise, ...s };
  });
  return {
    asOf: today,
    rows,
    totals: {
      principalPaise: rows.reduce((s, r) => s + (r.principalPaise ?? 0), 0),
      outstandingPrincipalPaise: rows.reduce((s, r) => s + r.outstandingPrincipalPaise, 0),
      interestOutstandingPaise: rows.reduce((s, r) => s + r.interestOutstandingPaise, 0),
      overdueAmountPaise: rows.reduce((s, r) => s + r.overdueAmountPaise, 0),
    },
  };
}

export async function interestReport(ctx: OrgContext, q: ReportParams) {
  const { from, to } = range(ctx, q);
  const c = await cols();
  const today = todayIn(ctx.org.settings.timezone);
  const loans = await c.loans.find({ organizationId: ctx.orgId, status: { $in: ["active", "closed"] } }).toArray();
  const members = await c.members.find({ _id: { $in: loans.map((l) => l.memberId) } }, { projection: { name: 1 } }).toArray();
  const mm = new Map(members.map((m) => [m._id.toHexString(), m.name]));
  const rows = loans.map((l) => {
    const inRange = l.schedule.filter((r) => r.dueDate >= from && r.dueDate <= to && r.status !== "waived");
    return {
      loanNumber: l.loanNumber,
      memberName: mm.get(l.memberId.toHexString()),
      method: l.interestMethod,
      rates: l.rateHistory.map((h) => ({ annualRate: h.annualRate, effectiveFrom: h.effectiveFrom })),
      interestChargedPaise: inRange.reduce((s, r) => s + r.interestDuePaise, 0),
      interestPaidPaise: inRange.reduce((s, r) => s + r.interestPaidPaise, 0),
      interestOutstandingPaise: inRange.filter((r) => r.dueDate <= today).reduce((s, r) => s + r.interestDuePaise - r.interestPaidPaise, 0),
      scheduledNotYetDuePaise: inRange.filter((r) => r.dueDate > today).reduce((s, r) => s + r.interestDuePaise - r.interestPaidPaise, 0),
    };
  });
  const [inc] = await c.ledgerEntries
    .aggregate<{ v: number }>([{ $match: { organizationId: ctx.orgId, accountKey: "income:interest", date: { $gte: from, $lte: to } } }, { $group: { _id: null, v: { $sum: { $subtract: ["$creditPaise", "$debitPaise"] } } } }])
    .toArray();
  const calcs = await c.interestCalculations.find({ organizationId: ctx.orgId, createdAt: { $gte: from } }).sort({ createdAt: -1 }).limit(200).toArray();
  return { from, to, rows, interestReceivedPaise: inc?.v ?? 0, calculations: calcs };
}

/* ------------------------------------------------------------------ donations & events */

export async function donationReport(ctx: OrgContext, q: ReportParams) {
  const { from, to } = range(ctx, q);
  const c = await cols();
  const match: Record<string, unknown> = { organizationId: ctx.orgId, status: "verified", date: { $gte: from, $lte: to } };
  if (q.eventName) match.eventName = q.eventName;
  if (q.method) match.method = q.method;
  const [items, byEvent, byMethod] = await Promise.all([
    c.donations.find(match).sort({ date: 1 }).limit(5000).toArray(),
    c.donations.aggregate<{ _id: string | null; t: number; n: number }>([{ $match: match }, { $group: { _id: "$eventName", t: { $sum: "$amountPaise" }, n: { $sum: 1 } } }, { $sort: { t: -1 } }]).toArray(),
    c.donations.aggregate<{ _id: string; t: number; n: number }>([{ $match: match }, { $group: { _id: "$method", t: { $sum: "$amountPaise" }, n: { $sum: 1 } } }]).toArray(),
  ]);
  return {
    from,
    to,
    items,
    byEvent: byEvent.map((b) => ({ eventName: b._id ?? "General", totalPaise: b.t, count: b.n })),
    byMethod: byMethod.map((b) => ({ method: b._id, totalPaise: b.t, count: b.n })),
    totalPaise: items.reduce((s, i) => s + i.amountPaise, 0),
  };
}

export async function eventReport(ctx: OrgContext, q: ReportParams) {
  const { from, to } = range(ctx, q);
  const c = await cols();
  const eventFilter = q.eventName ? q.eventName : { $nin: [null, ""] };
  const rows = await c.ledgerEntries
    .aggregate<{ _id: { e: string; cls: string }; v: number }>([
      { $match: { organizationId: ctx.orgId, date: { $gte: from, $lte: to }, accountKey: { $regex: "^(income|expense):" } } },
      { $lookup: { from: "financialTransactions", localField: "transactionId", foreignField: "_id", as: "t", pipeline: [{ $project: { eventName: 1, organizationId: 1 } }] } },
      { $set: { eventName: { $arrayElemAt: ["$t.eventName", 0] } } },
      { $match: { eventName: eventFilter } },
      {
        $group: {
          _id: { e: "$eventName", cls: { $arrayElemAt: [{ $split: ["$accountKey", ":"] }, 0] } },
          v: { $sum: { $cond: [{ $eq: [{ $arrayElemAt: [{ $split: ["$accountKey", ":"] }, 0] }, "income"] }, { $subtract: ["$creditPaise", "$debitPaise"] }, { $subtract: ["$debitPaise", "$creditPaise"] }] } },
        },
      },
    ])
    .toArray();
  const events = [...new Set(rows.map((r) => r._id.e))].filter(Boolean).sort();
  const out = events.map((e) => {
    const inc = rows.find((r) => r._id.e === e && r._id.cls === "income")?.v ?? 0;
    const exp = rows.find((r) => r._id.e === e && r._id.cls === "expense")?.v ?? 0;
    return { eventName: e, incomePaise: inc, expensePaise: exp, netPaise: inc - exp };
  });
  return { from, to, rows: out };
}

/* ------------------------------------------------------------------ CSV */

const r = paiseToRupeeString;
const dd = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : (d as string));

export function toTable(kind: string, data: Record<string, unknown>): { headers: string[]; rows: unknown[][] } {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const d = data as any;
  switch (kind) {
    case "income-expense":
      return {
        headers: ["Type", "Account", "Amount (₹)"],
        rows: [
          ...d.income.map((x: any) => ["Income", x.name, r(x.amountPaise)]),
          ["", "Total income", r(d.totalIncomePaise)],
          ...d.expense.map((x: any) => ["Expense", x.name, r(x.amountPaise)]),
          ["", "Total expenses", r(d.totalExpensePaise)],
          ["", "Surplus / (deficit)", r(d.surplusPaise)],
        ],
      };
    case "trial-balance":
      return { headers: ["Account", "Class", "Debit (₹)", "Credit (₹)"], rows: [...d.lines.map((l: any) => [l.name, l.class, r(l.debitPaise), r(l.creditPaise)]), ["Total", "", r(d.totalDebitPaise), r(d.totalCreditPaise)]] };
    case "balance-sheet":
      return {
        headers: ["Section", "Account", "Amount (₹)"],
        rows: [
          ...d.assets.map((x: any) => ["Assets", x.name, r(x.amountPaise)]),
          ["Assets", "Total", r(d.totalAssetsPaise)],
          ...d.liabilities.map((x: any) => ["Liabilities", x.name, r(x.amountPaise)]),
          ...d.equity.map((x: any) => ["Equity", x.name, r(x.amountPaise)]),
          ["Liabilities + Equity", "Total", r(d.totalLiabilitiesPaise + d.totalEquityPaise)],
        ],
      };
    case "account-summary":
      return { headers: ["Account", "Type", "Opening (₹)", "Receipts (₹)", "Payments (₹)", "Closing (₹)"], rows: d.rows.map((x: any) => [x.name, x.type, r(x.openingPaise), r(x.receiptsPaise), r(x.paymentsPaise), r(x.closingPaise)]) };
    case "cash-flow":
      return { headers: ["Item", "Section", "Inflow (₹)", "Outflow (₹)", "Net (₹)"], rows: [["Opening cash & bank", "", "", "", r(d.openingCashPaise)], ...d.lines.map((l: any) => [l.name, l.section, r(l.inflowPaise), r(l.outflowPaise), r(l.netPaise)]), ["Closing cash & bank", "", "", "", r(d.closingCashPaise)]] };
    case "collections":
      return { headers: ["Period", ...d.categories.map((c: any) => `${c.name} (₹)`), "Total (₹)"], rows: d.rows.map((x: any) => [x.period, ...d.categories.map((c: any) => r(x.byCategory[c.key] ?? 0)), r(x.totalPaise)]) };
    case "hapta":
      return { headers: ["Scheme", "Members", "Installments", "Due (₹)", "Collected (₹)", "Outstanding (₹)", "Overdue (₹)", "Collection %"], rows: d.rows.map((x: any) => [x.schemeName, x.members, x.installments, r(x.duePaise), r(x.collectedPaise), r(x.outstandingPaise), r(x.overduePaise), x.collectionPercent]) };
    case "overdue":
      return { headers: ["Member", "Member No", "Phone", "Scheme", "Period", "Due date", "Days overdue", "Outstanding (₹)"], rows: d.rows.map((x: any) => [x.memberName, x.membershipNumber, x.phone, x.schemeName, x.periodLabel, dd(x.dueDate), x.daysOverdue, r(x.outstandingPaise)]) };
    case "member-statement":
      return { headers: ["Date", "Description", "Ref", "Debit (₹)", "Credit (₹)", "Balance (₹)"], rows: [["", "Opening balance", "", "", "", r(d.openingBalancePaise)], ...d.lines.map((l: any) => [dd(l.date), l.description, l.ref ?? "", r(l.debitPaise), r(l.creditPaise), r(l.balancePaise)]), ["", "Closing balance", "", r(d.totalDebitPaise), r(d.totalCreditPaise), r(d.closingBalancePaise)]] };
    case "loans":
      return { headers: ["Loan", "Member", "Method", "Rate %", "Principal (₹)", "Outstanding principal (₹)", "Interest outstanding (₹)", "Overdue (₹)"], rows: d.rows.map((x: any) => [x.loanNumber, x.memberName, x.method, x.annualRate, r(x.principalPaise ?? 0), r(x.outstandingPrincipalPaise), r(x.interestOutstandingPaise), r(x.overdueAmountPaise)]) };
    case "interest":
      return { headers: ["Loan", "Member", "Method", "Charged (₹)", "Paid (₹)", "Outstanding (₹)", "Scheduled, not due (₹)"], rows: d.rows.map((x: any) => [x.loanNumber, x.memberName, x.method, r(x.interestChargedPaise), r(x.interestPaidPaise), r(x.interestOutstandingPaise), r(x.scheduledNotYetDuePaise)]) };
    case "donations":
      return { headers: ["Date", "Donor", "PAN", "Event", "Purpose", "Method", "Reference", "Amount (₹)"], rows: d.items.map((x: any) => [dd(x.date), x.donorName, x.donorPan ?? "", x.eventName ?? "", x.purpose ?? "", x.method, x.reference ?? "", r(x.amountPaise)]) };
    case "events":
      return { headers: ["Event", "Income (₹)", "Expenses (₹)", "Net (₹)"], rows: d.rows.map((x: any) => [x.eventName, r(x.incomePaise), r(x.expensePaise), r(x.netPaise)]) };
    case "ledger":
      return { headers: ["Date", "Txn", "Description", "Debit (₹)", "Credit (₹)", "Balance (₹)"], rows: [["", "", "Opening", "", "", r(d.openingPaise)], ...d.lines.map((l: any) => [dd(l.date), l.number, l.description, r(l.debitPaise), r(l.creditPaise), r(l.balancePaise)])] };
    case "monthly":
      return {
        headers: ["Member", "Member No", "Opening (₹)", "Hapta (₹)", "Interest (₹)", "Withdrawals (₹)", "Other (₹)", "Closing (₹)"],
        rows: [
          ...d.members.map((x: any) => [x.name, x.membershipNumber, r(x.openingPaise), r(x.haptaPaise), r(x.interestPaise), r(x.withdrawalsPaise), r(x.otherPaise), r(x.closingPaise)]),
          ["Total", "", r(d.memberTotals.openingPaise), r(d.memberTotals.haptaPaise), r(d.memberTotals.interestPaise), r(d.memberTotals.withdrawalsPaise), r(d.memberTotals.otherPaise), r(d.memberTotals.closingPaise)],
        ],
      };
    case "cashbook":
      return {
        headers: ["Date", "Txn", "Particulars", "Member", "Account", "Receipt (₹)", "Payment (₹)", "Balance (₹)"],
        rows: [["", "", "Opening balance", "", "", "", "", r(d.openingBalancePaise)], ...d.lines.map((l: any) => [dd(l.date), l.number, l.description, l.memberName ?? "", l.accountName, l.receiptPaise ? r(l.receiptPaise) : "", l.paymentPaise ? r(l.paymentPaise) : "", r(l.balancePaise)]), ["", "", "Closing balance", "", "", r(d.summary.totalReceiptsPaise), r(d.summary.totalPaymentsPaise), r(d.closingBalancePaise)]],
      };
    case "member-ledger":
      return {
        headers: ["Date", "Type", "Particulars", "Credit (₹)", "Debit (₹)", "Balance (₹)"],
        rows: [["", "", "Opening balance", "", "", r(d.openingBalancePaise)], ...d.lines.map((l: any) => [dd(l.date), l.kind, l.description, l.creditPaise ? r(l.creditPaise) : "", l.debitPaise ? r(l.debitPaise) : "", l.balancePaise !== undefined ? r(l.balancePaise) : ""])],
      };
    default:
      throw badRequest("CSV export is not available for this report");
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/* ------------------------------------------------------------------ monthly summary */

/**
 * One month at a glance: hapta expected vs collected, interest credited, withdrawals,
 * cash in/out, and a member-wise savings table (opening → closing).
 */
export async function monthlyReport(ctx: OrgContext, monthStr?: string) {
  const { monthView, firstOfMonth, lastOfMonth, monthOf } = await import("./monthly.service");
  const { cashBook } = await import("./cashbook.service");
  const c = await cols();
  const today = todayIn(ctx.org.settings.timezone);
  const m = monthStr && /^\d{4}-(0[1-9]|1[0-2])$/.test(monthStr) ? monthStr : monthOf(today);
  const from = firstOfMonth(m);
  const to = lastOfMonth(m);
  const [view, cash] = await Promise.all([monthView(ctx, { month: m }), cashBook(ctx, { from, to })]);
  const members = await c.members.find({ organizationId: ctx.orgId }, { projection: { name: 1, membershipNumber: 1, status: 1 } }).sort({ name: 1 }).toArray();
  const agg = await c.memberLedger
    .aggregate<{ _id: { m: ObjectId; k: string; inMonth: boolean }; v: number }>([
      { $match: { organizationId: ctx.orgId, date: { $lte: to } } },
      { $group: { _id: { m: "$memberId", k: "$kind", inMonth: { $gte: ["$date", from] } }, v: { $sum: { $subtract: ["$creditPaise", "$debitPaise"] } } } },
    ])
    .toArray();
  const get = (id: ObjectId, k: string | null, inMonth: boolean | null) =>
    agg.filter((a) => a._id.m.equals(id) && (k === null || a._id.k === k) && (inMonth === null || a._id.inMonth === inMonth)).reduce((s, a) => s + a.v, 0);
  const rows = members
    .map((mem) => {
      const opening = get(mem._id, null, false);
      const hapta = get(mem._id, "hapta", true);
      const interest = get(mem._id, "interest", true);
      const withdrawals = -get(mem._id, "withdrawal", true);
      const other = get(mem._id, "adjustment", true) + get(mem._id, "opening", true);
      return { memberId: mem._id, name: mem.name, membershipNumber: mem.membershipNumber, openingPaise: opening, haptaPaise: hapta, interestPaise: interest, withdrawalsPaise: withdrawals, otherPaise: other, closingPaise: opening + hapta + interest - withdrawals + other };
    })
    .filter((r) => r.openingPaise || r.haptaPaise || r.interestPaise || r.withdrawalsPaise || r.otherPaise || r.closingPaise);
  const sum = (k: keyof (typeof rows)[number]) => rows.reduce((s, r) => s + (r[k] as number), 0);
  const memberClosing = sum("closingPaise");
  const { fundLoanMonth } = await import("./fund-loan.service");
  const [loanMonth, [lent]] = await Promise.all([
    fundLoanMonth(ctx, m),
    c.ledgerEntries.aggregate<{ v: number }>([{ $match: { organizationId: ctx.orgId, accountKey: FUND_LOANS, date: { $lte: to } } }, { $group: { _id: null, v: { $sum: { $subtract: ["$debitPaise", "$creditPaise"] } } } }]).toArray(),
  ]);
  const loansOutstanding = lent?.v ?? 0;
  return {
    month: m,
    from,
    to,
    hapta: view.summary,
    interestCreditedPaise: sum("interestPaise"),
    withdrawalsPaidPaise: sum("withdrawalsPaise"),
    cash: { openingPaise: cash.openingBalancePaise, ...cash.summary, closingPaise: cash.closingBalancePaise },
    members: rows,
    memberTotals: { openingPaise: sum("openingPaise"), haptaPaise: sum("haptaPaise"), interestPaise: sum("interestPaise"), withdrawalsPaise: sum("withdrawalsPaise"), otherPaise: sum("otherPaise"), closingPaise: memberClosing },
    fundLoans: { ...loanMonth.summary, outstandingAtMonthEndPaise: loansOutstanding, rows: loanMonth.rows },
    /** Mandal fund at month end = cash + loans still out with members. */
    mandalFundPaise: cash.closingBalancePaise + loansOutstanding,
    /** Fund minus what is owed to members (positive = Mandal's own funds). */
    mandalSurplusPaise: cash.closingBalancePaise + loansOutstanding - memberClosing,
  };
}

/** Member's savings at a glance: balance and totals by kind, plus the latest entries. */
export async function memberSavingsSummary(orgId: ObjectId, memberId: ObjectId) {
  const c = await cols();
  const [m, byKind, recent] = await Promise.all([
    c.members.findOne({ _id: memberId, organizationId: orgId }, { projection: { balancePaise: 1 } }),
    c.memberLedger.aggregate<{ _id: string; v: number }>([{ $match: { organizationId: orgId, memberId } }, { $group: { _id: "$kind", v: { $sum: { $subtract: ["$creditPaise", "$debitPaise"] } } } }]).toArray(),
    c.memberLedger.find({ organizationId: orgId, memberId }).sort({ date: -1, createdAt: -1 }).limit(8).toArray(),
  ]);
  const k = (x: string) => byKind.find((b) => b._id === x)?.v ?? 0;
  return {
    balancePaise: m?.balancePaise ?? 0,
    openingPaise: k("opening"),
    haptaPaise: k("hapta"),
    interestPaise: k("interest"),
    withdrawalsPaise: -k("withdrawal"),
    adjustmentsPaise: k("adjustment"),
    recent,
  };
}
