import { ObjectId } from "mongodb";
import { z } from "zod";
import { cols } from "@/lib/collections";
import { withTransaction } from "@/lib/db";
import { audit } from "@/lib/audit";
import { badRequest, conflict } from "@/lib/errors";
import { formatDateOnly, todayIn } from "@/lib/dates";
import type { OrgContext } from "@/lib/auth";
import type { FundLoanDoc, MemberDoc, OpeningImportState } from "@/types/models";
import { dateOnly, money, optText, phone, rateString } from "@/validators/common";
import { FUND_LOANS, MEMBER_FUNDS, OPENING_EQUITY, faKey, fyNumber, postTransaction } from "./ledger.service";
import { postMemberEntry } from "./member-ledger.service";
import { createMember } from "./member.service";
import { monthOf, primaryScheme, rebuildMonthlyHapta, setupMonthlyHapta } from "./monthly.service";
import { refreshDuesFor } from "./fund-loan.service";

/**
 * Bring an existing Mandal into the app — one that has been running on paper for years.
 *
 * Nothing from before is re-entered month by month. The paper books are closed on a cutover
 * date and the position on that date is brought in once:
 *
 *   - each member: hapta shares + savings balance (an opening balance on their savings ledger)
 *   - each upad still running: the amount still owed, its monthly rate and any interest not yet
 *     paid. No cash moves (the money left the Mandal years ago): Dr upad given / Cr opening equity.
 *     Interest is charged from the month after the cutover; unpaid interest becomes a due in the
 *     cutover month, collected like any other.
 *   - cash in hand: the cash account's opening balance.
 *
 * What is left — cash + upad − members' savings — is the Mandal's own money (sits in opening
 * equity). The monthly hapta starts in the month after the cutover, so no old months show as due
 * and nobody is asked for a joining amount.
 *
 * Only for a Mandal with no money recorded yet, and only once. All money entries are written in
 * one transaction; members and the hapta are set up first and matched again on a retry (by id,
 * member number, phone or name), so running it twice never makes duplicates.
 */

const MAX_MEMBERS = 500;

const UpadRow = z.object({
  amount: money(),
  monthlyRate: rateString.optional(),
  /** when it was given (for the record only) */
  givenOn: dateOnly.optional(),
  /** interest owed up to the cutover and not yet paid */
  interestDue: money({ allowZero: true }).default(0),
});

const MemberRow = z.object({
  memberId: z.string().optional(),
  name: z.string().trim().min(2, "Enter the member's name").max(120),
  phone,
  membershipNumber: z
    .string()
    .trim()
    .max(30)
    .regex(/^[A-Za-z0-9/_-]*$/, "Letters, digits, / - _ only")
    .optional()
    .transform((v) => (v ? v.toUpperCase() : undefined)),
  joiningDate: dateOnly.optional(),
  shares: z.coerce.number().int().min(1, "At least 1 share").max(50, "At most 50 shares").default(1),
  savings: money({ allowZero: true }).default(0),
  upads: z.array(UpadRow).max(20).default([]),
});

export const OpeningImportSchema = z.object({
  /** the paper books are closed at the end of this day */
  cutoverDate: dateOnly,
  /** cash (and anything kept on UPI) in hand on the cutover date */
  cash: money({ allowZero: true }),
  /** monthly hapta per share, from the month after the cutover */
  haptaAmount: money(),
  haptaDueDay: z.coerce.number().int().min(1).max(28).default(10),
  /** default upad rate (% per month) for rows that don't give one; also saved as the Mandal default */
  upadRate: rateString.optional(),
  note: optText(300),
  members: z.array(MemberRow).min(1, "Add at least one member").max(MAX_MEMBERS),
  dryRun: z.boolean().default(true),
});
export type OpeningImportInput = z.infer<typeof OpeningImportSchema>;

const nextMonth = (m: string) => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 7);
};
const norm = (s?: string | null) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const digits = (s?: string | null) => (s ?? "").replace(/\D/g, "").slice(-10);

/* ------------------------------------------------------------------ status */

/** Why the import can't run here (empty = it can). */
async function blockers(ctx: OrgContext): Promise<string[]> {
  const c = await cols();
  const out: string[] = [];
  if (ctx.org.status !== "active") out.push("The Mandal isn't active");
  if (ctx.org.settings.openingImport) out.push("The old hisab has already been brought in");
  if (ctx.org.settings.settlement) out.push("The Mandal is being closed");
  const q = { organizationId: ctx.orgId };
  const [txns, payments, loans, ledger] = await Promise.all([
    c.financialTransactions.countDocuments(q, { limit: 1 }),
    c.payments.countDocuments(q, { limit: 1 }),
    c.fundLoans.countDocuments(q, { limit: 1 }),
    c.memberLedger.countDocuments(q, { limit: 1 }),
  ]);
  if (!ctx.org.settings.openingImport && (txns || payments || loans || ledger)) {
    out.push("Money has already been recorded in this Mandal. The import is only for a fresh start — correct single members with an opening balance or adjustment instead.");
  }
  return out;
}

export async function importStatus(ctx: OrgContext) {
  const c = await cols();
  const [b, members, cash, scheme] = await Promise.all([
    blockers(ctx),
    c.members.find({ organizationId: ctx.orgId, status: "active" }, { projection: { name: 1, phone: 1, membershipNumber: 1, haptaShares: 1, joiningDate: 1, userId: 1 } }).sort({ membershipNumber: 1 }).toArray(),
    c.financialAccounts.findOne({ organizationId: ctx.orgId, type: "cash", isActive: true }, { sort: { createdAt: 1 }, projection: { name: 1 } }),
    primaryScheme(ctx.orgId),
  ]);
  const h = ctx.org.settings.monthlyHapta;
  return {
    canImport: b.length === 0,
    blockers: b,
    done: ctx.org.settings.openingImport ?? null,
    today: formatDateOnly(todayIn(ctx.org.settings.timezone)),
    monthlyHapta: h && scheme ? { amountPaise: h.amountPaise, dueDay: h.dueDay, startMonth: monthOf(h.startDate) } : null,
    upadRate: ctx.org.settings.fundLoans?.defaultMonthlyRate ?? null,
    cashAccount: cash ? { _id: cash._id, name: cash.name } : null,
    members: members.map((m) => ({ _id: m._id, name: m.name, phone: m.phone ?? null, membershipNumber: m.membershipNumber, shares: m.haptaShares ?? 1, joiningDate: m.joiningDate, hasLogin: !!m.userId })),
  };
}

/* ------------------------------------------------------------------ check + import */

interface RowIssue {
  row: number; // 1-based position in the list
  name?: string;
  message: string;
}

export async function importOpening(ctx: OrgContext, input: OpeningImportInput) {
  const c = await cols();
  const today = todayIn(ctx.org.settings.timezone);
  const cutover = input.cutoverDate;
  const errors: RowIssue[] = [];
  const warnings: RowIssue[] = [];
  if (cutover > today) errors.push({ row: 0, message: "The closing date can't be in the future" });
  const haptaStartMonth = nextMonth(monthOf(cutover));
  const defaultRate = input.upadRate ?? ctx.org.settings.fundLoans?.defaultMonthlyRate;

  /* --- match rows to members already in the app (never create the same person twice) */
  const existing = await c.members.find({ organizationId: ctx.orgId }).toArray();
  const byId = new Map(existing.map((m) => [m._id.toHexString(), m]));
  const used = new Set<string>();
  const matchOf = (r: OpeningImportInput["members"][number]): MemberDoc | null => {
    if (r.memberId) return byId.get(r.memberId) ?? null;
    const free = existing.filter((m) => !used.has(m._id.toHexString()));
    return (
      (r.membershipNumber && free.find((m) => m.membershipNumber === r.membershipNumber)) ||
      (digits(r.phone).length === 10 && free.find((m) => digits(m.phone) === digits(r.phone))) ||
      free.find((m) => norm(m.name) === norm(r.name)) ||
      null
    );
  };

  const rows = input.members.map((r, i) => {
    const row = i + 1;
    const match = matchOf(r);
    if (r.memberId && !match) errors.push({ row, name: r.name, message: "This member isn't in the Mandal any more — reload the page" });
    if (match) {
      if (used.has(match._id.toHexString())) errors.push({ row, name: r.name, message: `${match.name} is in the list twice` });
      used.add(match._id.toHexString());
      if (match.status !== "active") errors.push({ row, name: r.name, message: `${match.name} is not an active member` });
    }
    if (r.joiningDate && r.joiningDate > cutover) errors.push({ row, name: r.name, message: "Joined after the closing date — add them in the app after the import instead" });
    r.upads.forEach((u, k) => {
      const label = r.upads.length > 1 ? `Upad ${k + 1}: ` : "Upad: ";
      if (u.givenOn && u.givenOn > cutover) errors.push({ row, name: r.name, message: `${label}given after the closing date — record it in the app instead` });
      if (!(u.monthlyRate ?? defaultRate) || Number(u.monthlyRate ?? defaultRate) <= 0) errors.push({ row, name: r.name, message: `${label}enter the monthly interest rate` });
    });
    return { row, input: r, match };
  });

  // two new rows for the same person
  const seen = new Map<string, number>();
  for (const r of rows) {
    if (r.match) continue;
    const keys = [r.input.membershipNumber && `n:${r.input.membershipNumber}`, digits(r.input.phone).length === 10 && `p:${digits(r.input.phone)}`].filter(Boolean) as string[];
    for (const k of keys) {
      if (seen.has(k)) errors.push({ row: r.row, name: r.input.name, message: `Same ${k.startsWith("n:") ? "member number" : "phone"} as row ${seen.get(k)}` });
      else seen.set(k, r.row);
    }
  }

  const left = existing.filter((m) => m.status === "active" && !used.has(m._id.toHexString()));
  if (left.length) warnings.push({ row: 0, message: `${left.map((m) => m.name).join(", ")} ${left.length === 1 ? "is" : "are"} in the app but not in this list — they start with ₹0 savings` });

  /* --- totals and the tally */
  const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((s, r) => s + f(r), 0);
  const totals = {
    members: rows.length,
    newMembers: rows.filter((r) => !r.match).length,
    shares: sum((r) => r.input.shares) + left.reduce((s, m) => s + (m.haptaShares ?? 1), 0),
    savingsPaise: sum((r) => r.input.savings),
    upadCount: sum((r) => r.input.upads.length),
    upadPaise: sum((r) => r.input.upads.reduce((s, u) => s + u.amount, 0)),
    interestDuePaise: sum((r) => r.input.upads.reduce((s, u) => s + u.interestDue, 0)),
    cashPaise: input.cash,
    mandalOwnPaise: 0,
    haptaPerMonthPaise: 0,
  };
  totals.mandalOwnPaise = totals.cashPaise + totals.upadPaise - totals.savingsPaise;
  totals.haptaPerMonthPaise = totals.shares * input.haptaAmount;
  if (totals.mandalOwnPaise < 0) {
    warnings.push({ row: 0, message: "Cash + upad is less than members' savings — the Mandal is short. Check the figures; if it's right, the shortfall shows as a loss." });
  }

  const preview = {
    dryRun: input.dryRun,
    cutoverDate: formatDateOnly(cutover),
    haptaStartMonth,
    totals,
    errors,
    warnings,
    rows: rows.map((r) => ({ row: r.row, name: r.input.name, matched: r.match ? { _id: r.match._id, name: r.match.name, membershipNumber: r.match.membershipNumber } : null })),
  };
  const b = await blockers(ctx);
  if (b.length) throw conflict(b[0]);
  if (input.dryRun || errors.length) return { ...preview, imported: false };

  /* ================================================================ write */

  // 1. members (not money — matched again on a retry)
  const memberIds: ObjectId[] = [];
  for (const r of rows) {
    if (r.match) {
      const set: Record<string, unknown> = { updatedAt: new Date() };
      if (r.input.joiningDate) set.joiningDate = r.input.joiningDate;
      const update: Record<string, unknown> = { $set: set };
      if (r.input.shares > 1) set.haptaShares = r.input.shares;
      else update.$unset = { haptaShares: "" };
      await c.members.updateOne({ _id: r.match._id }, update);
      memberIds.push(r.match._id);
    } else {
      const doc = await createMember(ctx, {
        name: r.input.name,
        phone: r.input.phone,
        membershipNumber: r.input.membershipNumber,
        joiningDate: r.input.joiningDate ?? cutover,
        haptaShares: r.input.shares,
        enrollInMonthlyHapta: false,
        inviteToApp: false,
      });
      memberIds.push(doc._id);
    }
  }
  // founders: nobody brought in owes a joining amount
  await c.members.updateMany({ organizationId: ctx.orgId, _id: { $in: memberIds }, "joining.status": "due" }, { $unset: { joining: "" } });

  // 2. monthly hapta from the month after the cutover (nothing has been paid, so it is rebuilt);
  //    everyone brought in is a founding member: no joining amount
  if (!(await primaryScheme(ctx.orgId))) {
    await setupMonthlyHapta(ctx, { amount: input.haptaAmount, startMonth: haptaStartMonth, dueDay: input.haptaDueDay, enrollAllActive: false });
  }
  await rebuildMonthlyHapta(ctx, { startMonth: haptaStartMonth, amountPaise: input.haptaAmount, dueDay: input.haptaDueDay, founders: true });

  // 3. money — all or nothing
  const cash = await c.financialAccounts.findOne({ organizationId: ctx.orgId, type: "cash", isActive: true }, { sort: { createdAt: 1 } });
  if (!cash) throw badRequest("Create a cash account first");
  const state: OpeningImportState = {
    at: new Date(),
    by: ctx.user._id,
    cutoverDate: cutover,
    haptaStartMonth,
    members: totals.members,
    savingsPaise: totals.savingsPaise,
    upadPaise: totals.upadPaise,
    interestDuePaise: totals.interestDuePaise,
    cashPaise: totals.cashPaise,
    mandalOwnPaise: totals.mandalOwnPaise,
    note: input.note,
  };
  const loans: FundLoanDoc[] = await withTransaction(async (session) => {
    // the marker first: a second import (even a concurrent one) stops here
    const marked = await c.organizations.updateOne({ _id: ctx.orgId, "settings.openingImport": { $in: [null] } }, { $set: { "settings.openingImport": state, updatedAt: new Date() } }, { session });
    if (marked.modifiedCount !== 1) throw conflict("The old hisab has already been brought in");
    if (input.upadRate) await c.organizations.updateOne({ _id: ctx.orgId }, { $set: { "settings.fundLoans.defaultMonthlyRate": input.upadRate } }, { session });

    const by = ctx.user._id;
    const why = `Brought forward from the paper hisab (closed ${formatDateOnly(cutover)})`;
    if (input.cash > 0) {
      await c.financialAccounts.updateOne({ _id: cash._id }, { $set: { openingBalancePaise: input.cash, openingDate: cutover, updatedAt: new Date() } }, { session });
      await postTransaction(
        {
          org: ctx.org,
          type: "opening_balance",
          date: cutover,
          description: `Opening balance — ${cash.name}`,
          lines: [
            { accountKey: faKey(cash._id), debitPaise: input.cash },
            { accountKey: OPENING_EQUITY, creditPaise: input.cash },
          ],
          createdBy: by,
          sourceType: "account",
          sourceId: cash._id,
          reason: why,
        },
        session,
      );
    }

    const made: FundLoanDoc[] = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].input;
      const memberId = memberIds[i];
      if (r.savings > 0) {
        const sourceId = new ObjectId();
        const txn = await postTransaction(
          {
            org: ctx.org,
            type: "member_opening",
            date: cutover,
            description: `Opening balance — ${r.name}`,
            lines: [
              { accountKey: OPENING_EQUITY, debitPaise: r.savings },
              { accountKey: MEMBER_FUNDS, creditPaise: r.savings, memberId },
            ],
            createdBy: by,
            memberId,
            sourceType: "memberOpening",
            sourceId,
            reason: why,
          },
          session,
        );
        await postMemberEntry(
          { org: ctx.org, memberId, date: cutover, kind: "opening", creditPaise: r.savings, description: "Savings brought forward from the paper hisab", sourceType: "opening", sourceId, transactionId: txn._id, dedupeKey: `opening:${memberId.toHexString()}`, createdBy: by },
          session,
        );
      }
      for (const u of r.upads) {
        const id = new ObjectId();
        const rate = (u.monthlyRate ?? defaultRate)!;
        const number = await fyNumber(ctx.org, "UPAD", cutover, session);
        const given = u.givenOn ? ` (given ${formatDateOnly(u.givenOn)})` : "";
        const txn = await postTransaction(
          {
            org: ctx.org,
            // a fund_loan_given with no cash line: only the upad screen can cancel it
            type: "fund_loan_given",
            date: cutover,
            description: `Upad ${number} to ${r.name} @ ${rate}% per month — brought forward${given}`,
            lines: [
              { accountKey: FUND_LOANS, debitPaise: u.amount, memberId },
              { accountKey: OPENING_EQUITY, creditPaise: u.amount },
            ],
            createdBy: by,
            memberId,
            sourceType: "fundLoan",
            sourceId: id,
            reason: why,
          },
          session,
        );
        const now = new Date();
        const loan: FundLoanDoc = {
          _id: id,
          organizationId: ctx.orgId,
          number,
          memberId,
          principalPaise: u.amount,
          outstandingPaise: u.amount,
          monthlyRate: rate,
          date: cutover,
          firstInterestMonth: haptaStartMonth,
          accountId: cash._id,
          note: `Brought forward from the paper hisab${given}`,
          status: "active",
          closedAt: null,
          idempotencyKey: `opening:${id.toHexString()}`,
          transactionId: txn._id,
          createdBy: by,
          createdAt: now,
          updatedAt: now,
        };
        await c.fundLoans.insertOne(loan, { session });
        if (u.interestDue > 0) {
          // interest owed up to the cutover: one due in the cutover month, paid like any other
          await c.fundLoanDues.insertOne(
            { _id: new ObjectId(), organizationId: ctx.orgId, loanId: id, memberId, period: monthOf(cutover), dueDate: cutover, principalBasisPaise: u.amount, monthlyRate: rate, interestPaise: u.interestDue, paidPaise: 0, createdAt: now, updatedAt: now },
            { session },
          );
        }
        made.push(loan);
      }
    }
    await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "org.opening_import", entityType: "organization", entityId: ctx.orgId, after: { ...state, by: undefined } }, session);
    return made;
  });
  ctx.org.settings.openingImport = state;

  // interest from the month after the cutover up to now
  if (loans.length) await refreshDuesFor(ctx.org, loans);
  return { ...preview, imported: true };
}
