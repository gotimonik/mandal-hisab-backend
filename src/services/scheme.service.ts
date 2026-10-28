import { ObjectId, type AnyBulkWriteOperation, type ClientSession } from "mongodb";
import { z } from "zod";
import { cols } from "@/lib/collections";
import { withTransaction } from "@/lib/db";
import { audit } from "@/lib/audit";
import { badRequest, conflict, notFound } from "@/lib/errors";
import { todayIn, utcAddMonths } from "@/lib/dates";
import type { OrgContext } from "@/lib/auth";
import type {
  HaptaSchemeDoc,
  InstallmentDoc,
  MemberSchemeEnrollmentDoc,
  OrganizationDoc,
} from "@/types/models";
import { dateOnly, money, optText, reason } from "@/validators/common";
import { amountFor, deriveStatus, generatePeriods, installmentCount, type ScheduleParams } from "./schedule";
import { notifyMember } from "./notification.service";
import { copy } from "./notification-copy";

const FREQUENCIES = [
  "weekly",
  "biweekly",
  "monthly",
  "bimonthly",
  "every_three_months",
  "quarterly",
  "half_yearly",
  "yearly",
  "custom",
  "one_time",
] as const;

export const SchemeInputSchema = z
  .object({
    name: z.string().trim().min(2, "Enter a scheme name").max(120),
    description: optText(1000),
    startDate: dateOnly,
    endDate: dateOnly.optional().nullable(),
    frequency: z.enum(FREQUENCIES),
    customInterval: z
      .object({ unit: z.enum(["day", "week", "month"]), count: z.number().int().min(1).max(365) })
      .optional()
      .nullable(),
    dueDay: z.number().int().min(1).max(31).optional().nullable(),
    amount: money(),
    amountMode: z.enum(["fixed", "member_specific"]).default("fixed"),
    numberOfInstallments: z.number().int().min(1).max(600).optional().nullable(),
    targetAmount: money().optional().nullable(),
    graceDays: z.number().int().min(0).max(90).default(0),
    lateFee: z
      .object({
        enabled: z.boolean(),
        type: z.enum(["fixed", "percent"]),
        value: z.number().int().min(0).max(10_000_000),
        graceDays: z.number().int().min(0).max(90),
      })
      .default({ enabled: false, type: "fixed", value: 0, graceDays: 0 }),
    status: z.enum(["draft", "active"]).default("active"),
    notes: optText(2000),
  })
  .superRefine((v, ctx) => {
    if (v.frequency === "custom" && !v.customInterval) ctx.addIssue({ code: "custom", path: ["customInterval"], message: "Choose the custom interval" });
    if (v.endDate && v.endDate < v.startDate) ctx.addIssue({ code: "custom", path: ["endDate"], message: "End date must be after start date" });
    if (v.lateFee.type === "percent" && v.lateFee.value > 10_000) ctx.addIssue({ code: "custom", path: ["lateFee", "value"], message: "Percentage too large" });
  });

export const EnrollSchema = z.object({
  members: z
    .array(z.object({ memberId: z.string(), amount: money().optional().nullable(), startDate: dateOnly.optional(), shares: z.number().int().min(1).max(50).optional() }))
    .min(1)
    .max(2000),
});

export const RevisionSchema = z.object({ effectiveFrom: dateOnly, amount: money(), reason: optText(300) });
export const OverrideSchema = z
  .object({
    sequence: z.number().int().min(1),
    dueDate: dateOnly.optional(),
    amount: money().optional(),
    skip: z.boolean().optional(),
    reason,
  })
  .refine((v) => v.dueDate || v.amount || v.skip, "Change the due date, amount, or skip the installment");

export const SchemeStatusSchema = z.object({ action: z.enum(["activate", "pause", "resume", "close"]), reason: optText(300) });

export const InstallmentActionSchema = z.object({
  action: z.enum(["set_due_date", "set_amount", "defer", "waive", "cancel", "reactivate"]),
  dueDate: dateOnly.optional(),
  amount: money().optional(),
  reason,
});

export const InstallmentListQuery = z.object({
  schemeId: z.string().optional(),
  memberId: z.string().optional(),
  status: z.enum(["upcoming", "pending", "partially_paid", "paid", "overdue", "deferred", "waived", "cancelled", "outstanding"]).optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});

export function scheduleParams(s: HaptaSchemeDoc, org: Pick<OrganizationDoc, "settings">): ScheduleParams {
  return {
    startDate: s.startDate,
    endDate: s.endDate,
    frequency: s.frequency,
    customInterval: s.customInterval,
    dueDay: s.dueDay,
    numberOfInstallments: s.numberOfInstallments,
    targetAmountPaise: s.targetAmountPaise,
    amountPaise: s.amountPaise,
    financialYearStartMonth: org.settings.financialYearStartMonth,
  };
}

export function horizonFor(org: Pick<OrganizationDoc, "settings">, today: Date) {
  return utcAddMonths(today, org.settings.installmentHorizonMonths);
}

export async function createScheme(ctx: OrgContext, input: z.infer<typeof SchemeInputSchema>) {
  const c = await cols();
  const now = new Date();
  const doc: HaptaSchemeDoc = {
    _id: new ObjectId(),
    organizationId: ctx.orgId,
    name: input.name,
    description: input.description,
    startDate: input.startDate,
    endDate: input.endDate ?? null,
    frequency: input.frequency,
    customInterval: input.frequency === "custom" ? input.customInterval ?? null : null,
    dueDay: input.dueDay ?? null,
    amountPaise: input.amount,
    amountMode: input.amountMode,
    numberOfInstallments: input.numberOfInstallments ?? null,
    targetAmountPaise: input.targetAmount ?? null,
    graceDays: input.graceDays,
    lateFee: input.lateFee,
    status: input.status,
    pausedAt: null,
    amountRevisions: [],
    overrides: [],
    notes: input.notes,
    createdBy: ctx.user._id,
    createdAt: now,
    updatedAt: now,
  };
  // validate it produces a sane schedule
  const total = installmentCount(scheduleParams(doc, ctx.org));
  if (total !== null && total > 600) throw badRequest("This scheme would create more than 600 installments");
  await c.haptaSchemes.insertOne(doc);
  await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "scheme.create", entityType: "scheme", entityId: doc._id, after: doc });
  return doc;
}

export async function updateSchemeMeta(ctx: OrgContext, id: ObjectId, input: { name?: string; description?: string; notes?: string; graceDays?: number; endDate?: Date | null }) {
  const c = await cols();
  const s = await getSchemeDoc(ctx, id);
  const $set: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(input)) if (v !== undefined) $set[k] = v;
  if (input.endDate && input.endDate < s.startDate) throw badRequest("End date must be after start date");
  await c.haptaSchemes.updateOne({ _id: id, organizationId: ctx.orgId }, { $set });
  if (input.endDate) {
    // Cancel future unpaid installments that now fall after the end date (history kept).
    await c.installments.updateMany(
      { organizationId: ctx.orgId, schemeId: id, dueDate: { $gt: input.endDate }, paidPaise: 0, state: "active" },
      { $set: { state: "cancelled", stateReason: "Scheme end date changed", updatedAt: new Date() } },
    );
  }
  await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "scheme.update", entityType: "scheme", entityId: id, before: { name: s.name, endDate: s.endDate, graceDays: s.graceDays }, after: input });
  return getSchemeDoc(ctx, id);
}

async function getSchemeDoc(ctx: OrgContext, id: ObjectId) {
  const c = await cols();
  const s = await c.haptaSchemes.findOne({ _id: id, organizationId: ctx.orgId });
  if (!s) throw notFound("Scheme");
  return s;
}

export async function listSchemes(ctx: OrgContext) {
  const c = await cols();
  const today = todayIn(ctx.org.settings.timezone);
  const schemes = await c.haptaSchemes.find({ organizationId: ctx.orgId }).sort({ status: 1, createdAt: -1 }).toArray();
  const stats = await c.installments
    .aggregate<{ _id: ObjectId; due: number; collected: number; members: ObjectId[] }>([
      { $match: { organizationId: ctx.orgId, state: "active", dueDate: { $lte: today } } },
      { $group: { _id: "$schemeId", due: { $sum: "$amountPaise" }, collected: { $sum: "$paidPaise" }, members: { $addToSet: "$memberId" } } },
    ])
    .toArray();
  const enrolled = await c.memberSchemeEnrollments
    .aggregate<{ _id: ObjectId; n: number }>([{ $match: { organizationId: ctx.orgId, status: "active" } }, { $group: { _id: "$schemeId", n: { $sum: 1 } } }])
    .toArray();
  const sm = new Map(stats.map((s) => [s._id.toHexString(), s]));
  const em = new Map(enrolled.map((e) => [e._id.toHexString(), e.n]));
  return schemes.map((s) => ({
    ...s,
    enrolledMembers: em.get(s._id.toHexString()) ?? 0,
    duePaise: sm.get(s._id.toHexString())?.due ?? 0,
    collectedPaise: sm.get(s._id.toHexString())?.collected ?? 0,
  }));
}

type Inst = { sequence: number; periodLabel: string; dueDate: Date; amountPaise: number; paidPaise: number };

/**
 * Totals and month-by-month status for one member's schedule in one scheme — past and
 * future months, so advance payments are visible. Used by the scheme page and "My schemes".
 */
export function scheduleProgress(installments: Inst[], today: Date) {
  const t0 = today.getTime();
  let duePaise = 0, paidPaise = 0, paidAheadPaise = 0, totalPaise = 0, totalPaidPaise = 0, paidCount = 0;
  let paidThrough: string | null = null, gap = false;
  let nextDue: { periodLabel: string; dueDate: Date; outstandingPaise: number } | null = null;
  const schedule = installments.map((i) => {
    const past = i.dueDate.getTime() <= t0;
    const paidUp = i.paidPaise >= i.amountPaise;
    totalPaise += i.amountPaise;
    totalPaidPaise += i.paidPaise;
    if (past) {
      duePaise += i.amountPaise;
      paidPaise += i.paidPaise;
    } else paidAheadPaise += i.paidPaise;
    if (paidUp) {
      paidCount++;
      if (!gap) paidThrough = i.periodLabel; // last month of the unbroken paid run from the start
    } else {
      gap = true;
      nextDue ??= { periodLabel: i.periodLabel, dueDate: i.dueDate, outstandingPaise: i.amountPaise - i.paidPaise };
    }
    const status = paidUp ? "paid" : i.paidPaise > 0 ? "partially_paid" : i.dueDate.getTime() < t0 ? "overdue" : past ? "due" : "upcoming";
    return { sequence: i.sequence, periodLabel: i.periodLabel, dueDate: i.dueDate, amountPaise: i.amountPaise, paidPaise: i.paidPaise, status };
  });
  return {
    // up to today
    duePaise,
    paidPaise,
    // the whole schedule
    paidAheadPaise,
    totalPaise,
    totalPaidPaise,
    installmentCount: installments.length,
    paidCount,
    paidThrough,
    nextDue,
    schedule,
  };
}

/** A member's own schemes ("My schemes"), active ones first. */
export async function memberSchemes(ctx: OrgContext, memberId: ObjectId) {
  const c = await cols();
  const today = todayIn(ctx.org.settings.timezone);
  const rows = await c.memberSchemeEnrollments
    .aggregate<{ _id: ObjectId; status: string; amountPaise?: number; startDate: Date; scheme: { _id: ObjectId; name: string; frequency: string; amountPaise: number; status: string; dueDay?: number }; installments: Inst[] }>([
      { $match: { organizationId: ctx.orgId, memberId } },
      { $lookup: { from: "haptaSchemes", localField: "schemeId", foreignField: "_id", as: "scheme" } },
      { $unwind: "$scheme" },
      {
        $lookup: {
          from: "installments",
          let: { e: "$_id" },
          pipeline: [
            { $match: { $expr: { $and: [{ $eq: ["$enrollmentId", "$$e"] }, { $eq: ["$state", "active"] }] } } },
            { $sort: { sequence: 1 } },
            { $project: { _id: 0, sequence: 1, periodLabel: 1, dueDate: 1, amountPaise: 1, paidPaise: 1 } },
          ],
          as: "installments",
        },
      },
      { $project: { status: 1, amountPaise: 1, startDate: 1, "scheme._id": 1, "scheme.name": 1, "scheme.frequency": 1, "scheme.amountPaise": 1, "scheme.status": 1, "scheme.dueDay": 1, installments: 1 } },
    ])
    .toArray();
  return rows
    .map(({ installments, ...e }) => ({ ...e, ...scheduleProgress(installments, today) }))
    .sort((a, b) => Number(b.status === "active") - Number(a.status === "active") || a.scheme.name.localeCompare(b.scheme.name));
}

export async function getScheme(ctx: OrgContext, id: ObjectId) {
  const c = await cols();
  const s = await getSchemeDoc(ctx, id);
  const today = todayIn(ctx.org.settings.timezone);
  type Row = { _id: ObjectId; status: string; amountPaise?: number; startDate: Date; lastSequence?: number; member: { _id: ObjectId; name: string; membershipNumber?: string }; installments: Inst[] };
  const rows = await c.memberSchemeEnrollments
    .aggregate<Row>([
      { $match: { organizationId: ctx.orgId, schemeId: id } },
      { $lookup: { from: "members", localField: "memberId", foreignField: "_id", as: "member" } },
      { $unwind: "$member" },
      {
        // the member's whole schedule (past and future), so advance payments show too
        $lookup: {
          from: "installments",
          let: { e: "$_id" },
          pipeline: [
            { $match: { $expr: { $and: [{ $eq: ["$enrollmentId", "$$e"] }, { $eq: ["$state", "active"] }] } } },
            { $sort: { sequence: 1 } },
            { $project: { _id: 0, sequence: 1, periodLabel: 1, dueDate: 1, amountPaise: 1, paidPaise: 1 } },
          ],
          as: "installments",
        },
      },
      {
        $project: {
          status: 1,
          amountPaise: 1,
          startDate: 1,
          lastSequence: 1,
          "member._id": 1,
          "member.name": 1,
          "member.membershipNumber": 1,
          installments: 1,
        },
      },
      { $sort: { "member.name": 1 } },
    ])
    .toArray();
  const enrollments = rows.map(({ installments, ...e }) => ({ ...e, ...scheduleProgress(installments, today) }));
  // Planned (scheme-level) schedule preview for the next 12 periods, before generation.
  const preview = generatePeriods(scheduleParams(s, ctx.org), horizonFor(ctx.org, today)).slice(0, 24).map((p) => ({
    ...p,
    ...amountFor({ schemeAmountPaise: s.amountPaise, revisions: s.amountRevisions, overrides: s.overrides }, p.sequence, p.dueDate),
    skipped: s.overrides.some((o) => o.sequence === p.sequence && o.skip),
    dueDate: s.overrides.find((o) => o.sequence === p.sequence && o.dueDate)?.dueDate ?? p.dueDate,
  }));
  return { scheme: s, enrollments, plannedSchedule: preview };
}

/**
 * Create installments for an enrollment up to `horizon`. Idempotent: uses
 * (organizationId, enrollmentId, sequence) unique key with $setOnInsert so re-runs and
 * concurrent runs never create duplicates.
 */
export async function generateForEnrollment(
  org: Pick<OrganizationDoc, "_id" | "settings">,
  scheme: HaptaSchemeDoc,
  enrollment: MemberSchemeEnrollmentDoc,
  horizon: Date,
  actorId: ObjectId,
  session?: ClientSession,
): Promise<number> {
  if (scheme.status !== "active" || enrollment.status !== "active") return 0;
  const c = await cols();
  const params = scheduleParams(scheme, org);
  const all = generatePeriods(params, horizon, enrollment.lastSequence);
  if (all.length === 0) return 0;
  // Periods before the member's own start date are not owed by this member.
  const periods = all.filter((p) => p.dueDate >= enrollment.startDate);
  const now = new Date();
  const ops: AnyBulkWriteOperation<InstallmentDoc>[] = periods.map((p) => {
    const ov = scheme.overrides.find((o) => o.sequence === p.sequence);
    const amt = amountFor(
      { schemeAmountPaise: scheme.amountPaise, memberAmountPaise: enrollment.amountPaise, revisions: scheme.amountRevisions, overrides: scheme.overrides },
      p.sequence,
      p.dueDate,
    );
    const shares = enrollment.shares && enrollment.shares > 1 ? enrollment.shares : 1;
    const doc: InstallmentDoc = {
      _id: new ObjectId(),
      organizationId: org._id,
      schemeId: scheme._id,
      enrollmentId: enrollment._id,
      memberId: enrollment.memberId,
      sequence: p.sequence,
      periodLabel: p.periodLabel,
      dueDate: ov?.dueDate ?? p.dueDate,
      amountPaise: amt.amountPaise * shares,
      ...(shares > 1 ? { shares } : {}),
      penaltyPaise: 0,
      paidPaise: 0,
      penaltyPaidPaise: 0,
      state: ov?.skip ? "cancelled" : "active",
      stateReason: ov?.skip ? `Skipped: ${ov.reason}` : undefined,
      amountSource: amt.source,
      history: [{ at: now, by: actorId, action: "generated" }],
      createdAt: now,
      updatedAt: now,
    };
    const { _id, ...rest } = doc;
    return {
      updateOne: {
        filter: { organizationId: org._id, enrollmentId: enrollment._id, sequence: p.sequence },
        update: { $setOnInsert: { _id, ...rest } },
        upsert: true,
      },
    };
  });
  let created = 0;
  if (ops.length) {
    const r = await c.installments.bulkWrite(ops, { ordered: false, session });
    created = r.upsertedCount;
  }
  const last = all[all.length - 1].sequence;
  await c.memberSchemeEnrollments.updateOne(
    { _id: enrollment._id, lastSequence: { $lt: last } },
    { $set: { lastSequence: last, generatedUpTo: horizon, updatedAt: now } },
    { session },
  );
  return created;
}

export async function enrollMembers(ctx: OrgContext, schemeId: ObjectId, input: z.infer<typeof EnrollSchema>) {
  const c = await cols();
  const s = await getSchemeDoc(ctx, schemeId);
  if (s.status === "closed") throw badRequest("Cannot enroll members in a closed scheme");
  const ids = input.members.map((m) => {
    if (!ObjectId.isValid(m.memberId)) throw badRequest("Invalid member id");
    return new ObjectId(m.memberId);
  });
  const found = await c.members.find({ _id: { $in: ids }, organizationId: ctx.orgId, status: "active" }).project({ _id: 1, name: 1 }).toArray();
  if (found.length !== ids.length) throw badRequest("Some members were not found or are inactive");
  if (s.amountMode === "member_specific" && input.members.some((m) => !m.amount)) {
    // allowed: falls back to scheme amount
  }
  const today = todayIn(ctx.org.settings.timezone);
  const horizon = horizonFor(ctx.org, today);
  const now = new Date();
  let enrolled = 0;
  let installments = 0;
  for (const m of input.members) {
    const memberId = new ObjectId(m.memberId);
    const enrollment: MemberSchemeEnrollmentDoc = {
      _id: new ObjectId(),
      organizationId: ctx.orgId,
      schemeId,
      memberId,
      amountPaise: m.amount ?? null,
      ...(m.shares && m.shares > 1 ? { shares: m.shares } : {}),
      startDate: m.startDate ?? s.startDate,
      status: "active",
      generatedUpTo: null,
      lastSequence: 0,
      createdAt: now,
      updatedAt: now,
    };
    const r = await c.memberSchemeEnrollments.updateOne(
      { organizationId: ctx.orgId, schemeId, memberId },
      { $setOnInsert: enrollment },
      { upsert: true },
    );
    if (r.upsertedCount === 0) continue; // already enrolled
    enrolled++;
    installments += await generateForEnrollment(ctx.org, s, enrollment, horizon, ctx.user._id);
    await notifyMember(ctx.orgId, memberId, {
      type: "scheme.assigned",
      copy: copy("scheme.assigned", { scheme: s.name, amountPaise: s.amountPaise }, ctx.org.settings.currency),
      link: `/org/${ctx.orgId}/my`,
      dedupeKey: `scheme-assign:${schemeId}:${memberId}`,
    });
  }
  await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "scheme.enroll", entityType: "scheme", entityId: schemeId, after: { enrolled, installments } });
  return { enrolled, installmentsCreated: installments };
}

export async function exitEnrollment(ctx: OrgContext, schemeId: ObjectId, memberId: ObjectId, reasonText: string) {
  const c = await cols();
  const e = await c.memberSchemeEnrollments.findOne({ organizationId: ctx.orgId, schemeId, memberId, status: "active" });
  if (!e) throw notFound("Enrollment");
  const today = todayIn(ctx.org.settings.timezone);
  await withTransaction(async (session) => {
    await c.memberSchemeEnrollments.updateOne({ _id: e._id }, { $set: { status: "exited", updatedAt: new Date() } }, { session });
    await c.installments.updateMany(
      { organizationId: ctx.orgId, enrollmentId: e._id, dueDate: { $gt: today }, paidPaise: 0, state: "active" },
      { $set: { state: "cancelled", stateReason: `Member exited scheme: ${reasonText}`, updatedAt: new Date() } },
      { session },
    );
    await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "scheme.exit", entityType: "enrollment", entityId: e._id, reason: reasonText }, session);
  });
  return { ok: true };
}

/** Extend schedules for all active enrollments of a scheme up to the horizon. */
export async function generateScheme(ctx: Pick<OrgContext, "org" | "orgId"> & { user: { _id: ObjectId } }, schemeId: ObjectId, upTo?: Date) {
  const c = await cols();
  const s = await c.haptaSchemes.findOne({ _id: schemeId, organizationId: ctx.orgId });
  if (!s) throw notFound("Scheme");
  const today = todayIn(ctx.org.settings.timezone);
  const horizon = upTo ?? horizonFor(ctx.org, today);
  let created = 0;
  const cursor = c.memberSchemeEnrollments.find({ organizationId: ctx.orgId, schemeId, status: "active" });
  for await (const e of cursor) created += await generateForEnrollment(ctx.org, s, e, horizon, ctx.user._id);
  return { installmentsCreated: created };
}

export async function changeSchemeStatus(ctx: OrgContext, schemeId: ObjectId, input: z.infer<typeof SchemeStatusSchema>) {
  const c = await cols();
  const s = await getSchemeDoc(ctx, schemeId);
  const today = todayIn(ctx.org.settings.timezone);
  const now = new Date();
  const map = {
    activate: { from: ["draft"], to: "active" },
    pause: { from: ["active"], to: "paused" },
    resume: { from: ["paused"], to: "active" },
    close: { from: ["active", "paused", "draft"], to: "closed" },
  } as const;
  const t = map[input.action];
  if (!(t.from as readonly string[]).includes(s.status)) throw badRequest(`Cannot ${input.action} a ${s.status} scheme`);
  await withTransaction(async (session) => {
    await c.haptaSchemes.updateOne({ _id: s._id }, { $set: { status: t.to, pausedAt: t.to === "paused" ? now : null, updatedAt: now } }, { session });
    if (input.action === "pause") {
      // Future unpaid installments are held (deferred) while paused.
      await c.installments.updateMany(
        { organizationId: ctx.orgId, schemeId, dueDate: { $gt: today }, paidPaise: 0, state: "active" },
        { $set: { state: "deferred", stateReason: "Scheme paused", updatedAt: now } },
        { session },
      );
    }
    if (input.action === "resume") {
      await c.installments.updateMany(
        { organizationId: ctx.orgId, schemeId, state: "deferred", stateReason: "Scheme paused", dueDate: { $gt: today } },
        { $set: { state: "active", updatedAt: now }, $unset: { stateReason: "" } },
        { session },
      );
      // Installments that fell due during the pause are waived (documented policy).
      await c.installments.updateMany(
        { organizationId: ctx.orgId, schemeId, state: "deferred", stateReason: "Scheme paused", dueDate: { $lte: today } },
        { $set: { state: "waived", stateReason: "Fell due while scheme was paused", updatedAt: now } },
        { session },
      );
    }
    if (input.action === "close") {
      await c.installments.updateMany(
        { organizationId: ctx.orgId, schemeId, dueDate: { $gt: today }, paidPaise: 0, state: { $in: ["active", "deferred"] } },
        { $set: { state: "cancelled", stateReason: "Scheme closed", updatedAt: now } },
        { session },
      );
    }
    await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: `scheme.${input.action}`, entityType: "scheme", entityId: schemeId, before: { status: s.status }, after: { status: t.to }, reason: input.reason }, session);
  });
  if (input.action === "activate" || input.action === "resume") await generateScheme(ctx, schemeId);
  return { status: t.to };
}

/**
 * Change the scheme amount from a date onwards. History is preserved: installments
 * that are already (partly) paid, or due before the effective date, are not touched.
 */
export async function reviseAmount(ctx: OrgContext, schemeId: ObjectId, input: z.infer<typeof RevisionSchema>) {
  const c = await cols();
  const s = await getSchemeDoc(ctx, schemeId);
  const now = new Date();
  const rev = { effectiveFrom: input.effectiveFrom, amountPaise: input.amount, reason: input.reason, createdBy: ctx.user._id, createdAt: now };
  let updated = 0;
  await withTransaction(async (session) => {
    await c.haptaSchemes.updateOne({ _id: s._id }, { $push: { amountRevisions: rev }, $set: { updatedAt: now } }, { session });
    const r = await c.installments.updateMany(
      {
        organizationId: ctx.orgId,
        schemeId,
        dueDate: { $gte: input.effectiveFrom },
        paidPaise: 0,
        state: "active",
        amountSource: { $in: ["scheme", "revision"] },
      },
      [
        {
          $set: {
            history: { $concatArrays: ["$history", [{ at: now, by: ctx.user._id, action: "amount_revised", from: "$amountPaise", to: { $multiply: [input.amount, { $ifNull: ["$shares", 1] }] }, reason: input.reason ?? "Scheme amount revised" }]] },
            // members with hapta shares pay the new amount × their shares
            amountPaise: { $multiply: [input.amount, { $ifNull: ["$shares", 1] }] },
            amountSource: "revision",
            updatedAt: now,
          },
        },
      ],
      { session },
    );
    updated = r.modifiedCount;
    await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "scheme.amount_revision", entityType: "scheme", entityId: schemeId, before: { amountPaise: s.amountPaise }, after: rev, reason: input.reason }, session);
  });
  return { installmentsUpdated: updated };
}

/** Scheme-wide change for one period (sequence): due date, amount, or skip. */
export async function setOverride(ctx: OrgContext, schemeId: ObjectId, input: z.infer<typeof OverrideSchema>) {
  const c = await cols();
  const s = await getSchemeDoc(ctx, schemeId);
  const now = new Date();
  const ov = { sequence: input.sequence, dueDate: input.dueDate, amountPaise: input.amount, skip: input.skip, reason: input.reason, createdBy: ctx.user._id, createdAt: now };
  let updated = 0;
  await withTransaction(async (session) => {
    await c.haptaSchemes.updateOne({ _id: s._id }, { $pull: { overrides: { sequence: input.sequence } } }, { session });
    await c.haptaSchemes.updateOne({ _id: s._id }, { $push: { overrides: ov }, $set: { updatedAt: now } }, { session });
    const base = { organizationId: ctx.orgId, schemeId, sequence: input.sequence };
    if (input.dueDate) {
      const r = await c.installments.updateMany(
        { ...base, state: { $in: ["active", "deferred"] }, $expr: { $lt: ["$paidPaise", "$amountPaise"] } },
        [{ $set: { history: { $concatArrays: ["$history", [{ at: now, by: ctx.user._id, action: "due_date_changed", from: "$dueDate", to: input.dueDate, reason: input.reason }]] }, dueDate: input.dueDate, updatedAt: now } }],
        { session },
      );
      updated += r.modifiedCount;
    }
    if (input.amount) {
      const r = await c.installments.updateMany(
        { ...base, state: "active", paidPaise: 0 },
        [{ $set: { history: { $concatArrays: ["$history", [{ at: now, by: ctx.user._id, action: "amount_changed", from: "$amountPaise", to: { $multiply: [input.amount, { $ifNull: ["$shares", 1] }] }, reason: input.reason }]] }, amountPaise: { $multiply: [input.amount, { $ifNull: ["$shares", 1] }] }, amountSource: "override", updatedAt: now } }],
        { session },
      );
      updated += r.modifiedCount;
    }
    if (input.skip) {
      const r = await c.installments.updateMany(
        { ...base, state: "active", paidPaise: 0 },
        [{ $set: { history: { $concatArrays: ["$history", [{ at: now, by: ctx.user._id, action: "skipped", reason: input.reason }]] }, state: "cancelled", stateReason: `Skipped: ${input.reason}`, updatedAt: now } }],
        { session },
      );
      updated += r.modifiedCount;
    }
    await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "scheme.override", entityType: "scheme", entityId: schemeId, after: ov, reason: input.reason }, session);
  });
  return { installmentsUpdated: updated };
}

/* ------------------------------------------------------------ installments */

export async function listInstallments(ctx: OrgContext, q: z.infer<typeof InstallmentListQuery>, restrictMemberId?: ObjectId) {
  const c = await cols();
  const today = todayIn(ctx.org.settings.timezone);
  const filter: Record<string, unknown> = { organizationId: ctx.orgId };
  if (q.schemeId) filter.schemeId = new ObjectId(q.schemeId);
  if (restrictMemberId) filter.memberId = restrictMemberId;
  else if (q.memberId) filter.memberId = new ObjectId(q.memberId);
  const due: Record<string, Date> = {};
  if (q.from) due.$gte = q.from;
  if (q.to) due.$lte = q.to;
  if (Object.keys(due).length) filter.dueDate = due;
  // Status filters are translated to amount/date conditions (status is derived, not stored).
  const owing = { $expr: { $lt: [{ $add: ["$paidPaise", "$penaltyPaidPaise"] }, { $add: ["$amountPaise", "$penaltyPaise"] }] } };
  switch (q.status) {
    case "paid":
      Object.assign(filter, { state: "active", $expr: { $gte: [{ $add: ["$paidPaise", "$penaltyPaidPaise"] }, { $add: ["$amountPaise", "$penaltyPaise"] }] } });
      break;
    case "outstanding":
      Object.assign(filter, { state: "active", ...owing, dueDate: { ...(filter.dueDate as object), $lte: today } });
      break;
    case "overdue":
    case "pending":
    case "partially_paid":
    case "upcoming":
      Object.assign(filter, { state: "active", ...owing });
      break;
    case "deferred":
    case "waived":
    case "cancelled":
      filter.state = q.status;
      break;
  }
  const schemes = await c.haptaSchemes.find({ organizationId: ctx.orgId }, { projection: { name: 1, graceDays: 1 } }).toArray();
  const sm = new Map(schemes.map((s) => [s._id.toHexString(), s]));
  const derivedFilter = q.status && ["overdue", "pending", "partially_paid", "upcoming"].includes(q.status) ? q.status : null;
  let items: InstallmentDoc[];
  let total: number;
  if (derivedFilter) {
    // narrow with date bounds then derive; bounded by pageSize * page window
    const all = await c.installments.find(filter).sort({ dueDate: 1, _id: 1 }).limit(5000).toArray();
    const f = all.filter((i) => deriveStatus(i, today, sm.get(i.schemeId.toHexString())?.graceDays ?? 0) === derivedFilter);
    total = f.length;
    items = f.slice((q.page - 1) * q.pageSize, q.page * q.pageSize);
  } else {
    [items, total] = await Promise.all([
      c.installments.find(filter, { projection: { history: 0 } }).sort({ dueDate: 1, _id: 1 }).skip((q.page - 1) * q.pageSize).limit(q.pageSize).toArray(),
      c.installments.countDocuments(filter),
    ]);
  }
  const memberIds = [...new Set(items.map((i) => i.memberId.toHexString()))].map((h) => new ObjectId(h));
  const members = await c.members.find({ _id: { $in: memberIds } }, { projection: { name: 1, membershipNumber: 1 } }).toArray();
  const mm = new Map(members.map((m) => [m._id.toHexString(), m]));
  return {
    items: items.map((i) => ({
      ...i,
      history: undefined,
      status: deriveStatus(i, today, sm.get(i.schemeId.toHexString())?.graceDays ?? 0),
      outstandingPaise: i.state === "active" ? Math.max(0, i.amountPaise + i.penaltyPaise - i.paidPaise - i.penaltyPaidPaise) : 0,
      schemeName: sm.get(i.schemeId.toHexString())?.name ?? "",
      member: mm.get(i.memberId.toHexString()) ?? null,
    })),
    total,
    page: q.page,
    pageSize: q.pageSize,
  };
}

export const InstallmentGroupQuery = z.object({
  by: z.enum(["scheme", "member"]),
  schemeId: z.string().optional(),
  memberId: z.string().optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(30),
});

type GroupRow = {
  _id: ObjectId;
  x?: { name: string; membershipNumber?: string; frequency?: string; amountPaise?: number };
  count: number;
  paidCount: number;
  others: number;
  plannedPaise: number;
  paidPaise: number;
  outstandingPaise: number;
  overduePaise: number;
  overdueCount: number;
  upcomingPaise: number;
  paidAheadPaise: number;
  nextDue: Date | null;
};

/**
 * Installments rolled up per scheme or per member: how much is planned, paid, still due, overdue
 * (respecting each scheme's grace days), upcoming, and paid ahead.
 */
export async function groupInstallments(ctx: OrgContext, q: z.infer<typeof InstallmentGroupQuery>) {
  const c = await cols();
  const today = todayIn(ctx.org.settings.timezone);
  const match: Record<string, unknown> = { organizationId: ctx.orgId, state: "active" };
  if (q.schemeId && ObjectId.isValid(q.schemeId)) match.schemeId = new ObjectId(q.schemeId);
  if (q.memberId && ObjectId.isValid(q.memberId)) match.memberId = new ObjectId(q.memberId);
  const due: Record<string, Date> = {};
  if (q.from) due.$gte = q.from;
  if (q.to) due.$lte = q.to;
  if (Object.keys(due).length) match.dueDate = due;
  const key = q.by === "scheme" ? "$schemeId" : "$memberId";
  const owed = { $max: [0, { $subtract: [{ $add: ["$amountPaise", "$penaltyPaise"] }, { $add: ["$paidPaise", "$penaltyPaidPaise"] }] }] };
  const paid = { $add: ["$paidPaise", "$penaltyPaidPaise"] };
  const overdueCond = { $lt: [{ $dateAdd: { startDate: "$dueDate", unit: "day", amount: "$grace" } }, today] };
  const [r] = await c.installments
    .aggregate<{ rows: GroupRow[]; total: { n: number }[]; sums: Partial<Record<"outstandingPaise" | "overduePaise" | "paidPaise" | "paidAheadPaise", number>>[] }>([
      { $match: match },
      { $lookup: { from: "haptaSchemes", localField: "schemeId", foreignField: "_id", as: "s", pipeline: [{ $project: { graceDays: 1 } }] } },
      { $set: { grace: { $ifNull: [{ $arrayElemAt: ["$s.graceDays", 0] }, 0] }, owed, paidAll: paid } },
      {
        $group: {
          _id: key,
          count: { $sum: 1 },
          others: { $addToSet: q.by === "scheme" ? "$memberId" : "$schemeId" },
          plannedPaise: { $sum: { $add: ["$amountPaise", "$penaltyPaise"] } },
          paidPaise: { $sum: "$paidAll" },
          outstandingPaise: { $sum: { $cond: [{ $lte: ["$dueDate", today] }, "$owed", 0] } },
          overduePaise: { $sum: { $cond: [{ $and: [overdueCond, { $gt: ["$owed", 0] }] }, "$owed", 0] } },
          overdueCount: { $sum: { $cond: [{ $and: [overdueCond, { $gt: ["$owed", 0] }] }, 1, 0] } },
          upcomingPaise: { $sum: { $cond: [{ $gt: ["$dueDate", today] }, "$owed", 0] } },
          paidAheadPaise: { $sum: { $cond: [{ $gt: ["$dueDate", today] }, "$paidAll", 0] } },
          paidCount: { $sum: { $cond: [{ $lte: ["$owed", 0] }, 1, 0] } },
          nextDue: { $min: { $cond: [{ $gt: ["$owed", 0] }, "$dueDate", null] } },
        },
      },
      { $lookup: q.by === "scheme" ? { from: "haptaSchemes", localField: "_id", foreignField: "_id", as: "x", pipeline: [{ $project: { name: 1, frequency: 1, amountPaise: 1 } }] } : { from: "members", localField: "_id", foreignField: "_id", as: "x", pipeline: [{ $project: { name: 1, membershipNumber: 1 } }] } },
      { $set: { x: { $arrayElemAt: ["$x", 0] }, others: { $size: "$others" } } },
      { $sort: { "x.name": 1, _id: 1 } },
      {
        $facet: {
          rows: [{ $skip: (q.page - 1) * q.pageSize }, { $limit: q.pageSize }],
          total: [{ $count: "n" }],
          sums: [{ $group: { _id: null, outstandingPaise: { $sum: "$outstandingPaise" }, overduePaise: { $sum: "$overduePaise" }, paidPaise: { $sum: "$paidPaise" }, paidAheadPaise: { $sum: "$paidAheadPaise" } } }],
        },
      },
    ])
    .toArray();
  const sums = r?.sums[0] ?? {};
  return {
    by: q.by,
    items: (r?.rows ?? []).map((g) => ({
      _id: g._id,
      name: g.x?.name ?? "—",
      membershipNumber: g.x?.membershipNumber,
      frequency: g.x?.frequency,
      amountPaise: g.x?.amountPaise,
      count: g.count,
      paidCount: g.paidCount,
      /** members in this scheme, or schemes this member is in */
      others: g.others,
      plannedPaise: g.plannedPaise,
      paidPaise: g.paidPaise,
      outstandingPaise: g.outstandingPaise,
      overduePaise: g.overduePaise,
      overdueCount: g.overdueCount,
      upcomingPaise: g.upcomingPaise,
      paidAheadPaise: g.paidAheadPaise,
      nextDue: g.nextDue ?? null,
    })),
    totals: { outstandingPaise: sums.outstandingPaise ?? 0, overduePaise: sums.overduePaise ?? 0, paidPaise: sums.paidPaise ?? 0, paidAheadPaise: sums.paidAheadPaise ?? 0 },
    total: r?.total[0]?.n ?? 0,
    page: q.page,
    pageSize: q.pageSize,
  };
}

export async function getInstallment(ctx: OrgContext, id: ObjectId) {
  const c = await cols();
  const i = await c.installments.findOne({ _id: id, organizationId: ctx.orgId });
  if (!i) throw notFound("Installment");
  const scheme = await c.haptaSchemes.findOne({ _id: i.schemeId, organizationId: ctx.orgId }, { projection: { name: 1, graceDays: 1 } });
  const payments = await c.payments
    .find({ organizationId: ctx.orgId, "allocations.installmentId": id }, { projection: { amountPaise: 1, date: 1, status: 1, allocations: 1, method: 1, receiptId: 1 } })
    .sort({ date: 1 })
    .toArray();
  return { installment: { ...i, status: deriveStatus(i, todayIn(ctx.org.settings.timezone), scheme?.graceDays ?? 0), schemeName: scheme?.name }, payments };
}

export async function installmentAction(ctx: OrgContext, id: ObjectId, input: z.infer<typeof InstallmentActionSchema>) {
  const c = await cols();
  const i = await c.installments.findOne({ _id: id, organizationId: ctx.orgId });
  if (!i) throw notFound("Installment");
  const now = new Date();
  const h = (action: string, from?: unknown, to?: unknown) => ({ at: now, by: ctx.user._id, action, from, to, reason: input.reason });
  const $set: Partial<InstallmentDoc> = { updatedAt: now };
  let entry;
  const fullyPaid = i.paidPaise >= i.amountPaise;
  switch (input.action) {
    case "set_due_date":
      if (!input.dueDate) throw badRequest("New due date is required");
      if (fullyPaid) throw badRequest("This installment is already paid");
      $set.dueDate = input.dueDate;
      entry = h("due_date_changed", i.dueDate, input.dueDate);
      break;
    case "set_amount":
      if (!input.amount) throw badRequest("New amount is required");
      if (input.amount < i.paidPaise) throw badRequest("Amount cannot be less than what has already been paid");
      $set.amountPaise = input.amount;
      $set.amountSource = "override";
      entry = h("amount_changed", i.amountPaise, input.amount);
      break;
    case "defer":
      if (i.state !== "active" || fullyPaid) throw badRequest("Only unpaid active installments can be deferred");
      $set.state = "deferred";
      $set.stateReason = input.reason;
      if (input.dueDate) $set.dueDate = input.dueDate;
      entry = h("deferred", i.dueDate, input.dueDate);
      break;
    case "waive":
      if (i.state !== "active" || fullyPaid) throw badRequest("Only unpaid active installments can be waived");
      $set.state = "waived";
      $set.stateReason = input.reason;
      entry = h("waived", i.amountPaise - i.paidPaise);
      break;
    case "cancel":
      if (i.paidPaise > 0 || i.penaltyPaidPaise > 0) throw badRequest("Reverse the payments on this installment before cancelling it");
      $set.state = "cancelled";
      $set.stateReason = input.reason;
      entry = h("cancelled");
      break;
    case "reactivate":
      if (i.state === "active") throw badRequest("Installment is already active");
      $set.state = "active";
      $set.stateReason = undefined;
      if (input.dueDate) $set.dueDate = input.dueDate;
      entry = h("reactivated", i.state, "active");
      break;
  }
  // Optimistic concurrency: only apply if nothing paid changed meanwhile.
  const r = await c.installments.updateOne(
    { _id: id, organizationId: ctx.orgId, paidPaise: i.paidPaise, state: i.state },
    { $set, $push: { history: entry } },
  );
  if (r.modifiedCount !== 1) throw conflict("The installment changed while you were editing; please retry");
  await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: `installment.${input.action}`, entityType: "installment", entityId: id, before: { dueDate: i.dueDate, amountPaise: i.amountPaise, state: i.state }, after: $set, reason: input.reason });
  if (input.action === "set_due_date" || input.action === "set_amount") {
    await notifyMember(ctx.orgId, i.memberId, {
      type: "installment.changed",
      copy: copy("installment.changed", { scheme: (await c.haptaSchemes.findOne({ _id: i.schemeId }, { projection: { name: 1 } }))?.name ?? "", period: i.periodLabel, change: input.action === "set_due_date" ? "due_date" : "amount", reason: input.reason }, ctx.org.settings.currency),
      link: `/org/${ctx.orgId}/my`,
      dedupeKey: `inst-change:${id}:${now.getTime()}`,
    });
  }
  return getInstallment(ctx, id);
}
