import { ObjectId } from "mongodb";
import { cols } from "@/lib/collections";
import { bpsOf, formatINR } from "@/lib/money";
import { diffDays, formatIndianDate, todayIn, utcAddDays } from "@/lib/dates";
import type { OrganizationDoc } from "@/types/models";
import { generateForEnrollment, horizonFor } from "./scheme.service";
import { notifyMember } from "./notification.service";

export interface JobReport {
  organizations: number;
  installmentsCreated: number;
  penaltiesApplied: number;
  loanPenaltiesApplied: number;
  remindersSent: number;
  errors: { organizationId: string; message: string }[];
}

/**
 * Daily maintenance, safe to run any number of times per day (every step is idempotent):
 *  1. extend open-ended hapta schedules up to the organization's horizon
 *  2. apply late fees once to installments / loan rows past their late-fee grace period
 *  3. send due-date and overdue reminders (deduplicated per installment/day)
 * Triggered by Vercel Cron → GET /api/v1/cron/daily (Authorization: Bearer CRON_SECRET).
 */
export async function runDailyJobs(now = new Date()): Promise<JobReport> {
  const c = await cols();
  const report: JobReport = { organizations: 0, installmentsCreated: 0, penaltiesApplied: 0, loanPenaltiesApplied: 0, remindersSent: 0, errors: [] };
  const orgs = c.organizations.find({ status: "active" });
  for await (const org of orgs) {
    report.organizations++;
    try {
      await runForOrg(org, now, report);
    } catch (e) {
      console.error("daily job failed for org", org._id.toHexString(), e);
      report.errors.push({ organizationId: org._id.toHexString(), message: e instanceof Error ? e.message : String(e) });
    }
  }
  return report;
}

const SYSTEM_ACTOR = new ObjectId("000000000000000000000000");

async function runForOrg(org: OrganizationDoc, now: Date, report: JobReport) {
  const c = await cols();
  const today = todayIn(org.settings.timezone, now);

  // 1. generation
  const schemes = await c.haptaSchemes.find({ organizationId: org._id, status: "active" }).toArray();
  const horizon = horizonFor(org, today);
  for (const s of schemes) {
    const enrollments = c.memberSchemeEnrollments.find({ organizationId: org._id, schemeId: s._id, status: "active", $or: [{ generatedUpTo: null }, { generatedUpTo: { $lt: horizon } }] });
    for await (const e of enrollments) report.installmentsCreated += await generateForEnrollment(org, s, e, horizon, SYSTEM_ACTOR);
  }

  // 2a. hapta late fees (applied once; penaltyPaise === 0 guard makes it idempotent)
  for (const s of schemes.filter((x) => x.lateFee.enabled && x.lateFee.value > 0)) {
    const cutoff = utcAddDays(today, -(s.lateFee.graceDays + 1));
    const late = await c.installments
      .find({ organizationId: org._id, schemeId: s._id, state: "active", penaltyPaise: 0, dueDate: { $lte: cutoff }, $expr: { $lt: ["$paidPaise", "$amountPaise"] } })
      .limit(5000)
      .toArray();
    for (const i of late) {
      const fee = s.lateFee.type === "fixed" ? s.lateFee.value : bpsOf(i.amountPaise, s.lateFee.value);
      if (fee <= 0) continue;
      const r = await c.installments.updateOne(
        { _id: i._id, penaltyPaise: 0 },
        { $set: { penaltyPaise: fee, updatedAt: new Date() }, $push: { history: { at: new Date(), by: SYSTEM_ACTOR, action: "late_fee_applied", to: fee } } },
      );
      report.penaltiesApplied += r.modifiedCount;
    }
  }

  // 2b. loan late fees per overdue row
  const loans = await c.loans.find({ organizationId: org._id, status: "active", "lateFee.enabled": true }).toArray();
  for (const l of loans) {
    let changed = false;
    const rows = l.schedule.map((row) => {
      const owed = row.principalDuePaise - row.principalPaidPaise + row.interestDuePaise - row.interestPaidPaise;
      if (row.status === "waived" || row.penaltyPaise > 0 || owed <= 0) return row;
      if (diffDays(today, row.dueDate) <= l.lateFee.graceDays) return row;
      const fee = l.lateFee.type === "fixed" ? l.lateFee.value : bpsOf(row.totalDuePaise, l.lateFee.value);
      if (fee <= 0) return row;
      changed = true;
      report.loanPenaltiesApplied++;
      return { ...row, penaltyPaise: fee };
    });
    if (changed) await c.loans.updateOne({ _id: l._id, updatedAt: l.updatedAt }, { $set: { schedule: rows, updatedAt: new Date() } });
  }

  // 3. reminders
  for (const days of org.settings.reminderDaysBefore) {
    const target = utcAddDays(today, days);
    const due = await c.installments
      .find({ organizationId: org._id, state: "active", dueDate: target, $expr: { $lt: [{ $add: ["$paidPaise", "$penaltyPaidPaise"] }, { $add: ["$amountPaise", "$penaltyPaise"] }] } })
      .limit(10000)
      .toArray();
    for (const i of due) {
      const owed = i.amountPaise + i.penaltyPaise - i.paidPaise - i.penaltyPaidPaise;
      const sent = await notifyMember(org._id, i.memberId, {
        type: "installment.reminder",
        title: days === 0 ? "Hapta due today" : `Hapta due in ${days} day${days === 1 ? "" : "s"}`,
        body: `${i.periodLabel}: ${formatINR(owed)} due on ${formatIndianDate(i.dueDate)}.`,
        link: `/org/${org._id}/my`,
        dedupeKey: `due:${i._id}:${days}`,
      });
      if (sent) report.remindersSent++;
    }
  }
  if (org.settings.overdueReminderEveryDays > 0) {
    const every = org.settings.overdueReminderEveryDays;
    const overdue = await c.installments
      .find({ organizationId: org._id, state: "active", dueDate: { $lt: today }, $expr: { $lt: [{ $add: ["$paidPaise", "$penaltyPaidPaise"] }, { $add: ["$amountPaise", "$penaltyPaise"] }] } })
      .limit(10000)
      .toArray();
    for (const i of overdue) {
      const late = diffDays(today, i.dueDate);
      if (late % every !== 0) continue;
      const owed = i.amountPaise + i.penaltyPaise - i.paidPaise - i.penaltyPaidPaise;
      const sent = await notifyMember(org._id, i.memberId, {
        type: "installment.overdue",
        title: "Hapta overdue",
        body: `${i.periodLabel}: ${formatINR(owed)} is ${late} days overdue.`,
        link: `/org/${org._id}/my`,
        dedupeKey: `overdue:${i._id}:${late}`,
      });
      if (sent) report.remindersSent++;
    }
  }
  for (const l of await c.loans.find({ organizationId: org._id, status: "active" }).toArray()) {
    for (const days of org.settings.reminderDaysBefore) {
      const target = utcAddDays(today, days);
      const row = l.schedule.find((r) => r.status !== "waived" && r.dueDate.getTime() === target.getTime());
      if (!row) continue;
      const owed = row.principalDuePaise - row.principalPaidPaise + row.interestDuePaise - row.interestPaidPaise + row.penaltyPaise - row.penaltyPaidPaise;
      if (owed <= 0) continue;
      const sent = await notifyMember(org._id, l.memberId, {
        type: "loan.reminder",
        title: days === 0 ? "Loan installment due today" : `Loan installment due in ${days} day${days === 1 ? "" : "s"}`,
        body: `${l.loanNumber} installment #${row.sequence}: ${formatINR(owed)} due on ${formatIndianDate(row.dueDate)}.`,
        link: `/org/${org._id}/my`,
        dedupeKey: `loan-due:${l._id}:${row.sequence}:${days}`,
      });
      if (sent) report.remindersSent++;
    }
  }
}
