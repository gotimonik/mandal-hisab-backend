import { ObjectId } from "mongodb";
import { z } from "zod";
import { cols } from "@/lib/collections";
import { audit } from "@/lib/audit";
import { conflict, isDuplicateKeyError, notFound } from "@/lib/errors";
import { parseCsv } from "@/lib/csv";
import { todayIn } from "@/lib/dates";
import type { OrgContext } from "@/lib/auth";
import type { MemberDoc } from "@/types/models";
import { dateOnly, email, optText, phone } from "@/validators/common";
import { nextNumber } from "./ledger.service";

export const MemberInputSchema = z.object({
  name: z.string().trim().min(2, "Enter the member's name").max(120),
  membershipNumber: z
    .string()
    .trim()
    .max(30)
    .regex(/^[A-Za-z0-9/_-]*$/, "Letters, digits, / - _ only")
    .optional()
    .transform((v) => (v ? v.toUpperCase() : undefined)),
  phone,
  email: email.optional().or(z.literal("").transform(() => undefined)),
  address: optText(300),
  joiningDate: dateOnly.optional(),
  status: z.enum(["active", "inactive", "left"]).optional(),
  notes: optText(1000),
  /** Enroll in the Mandal's monthly hapta (default true when it is set up) */
  enrollInMonthlyHapta: z.boolean().optional(),
  /** First hapta month (YYYY-MM); default: current month */
  haptaStartMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM").optional(),
  /** On create with an email: email them an invitation to sign in to the Mandal (default true) */
  inviteToApp: z.boolean().optional(),
});

type MemberInput = Partial<z.infer<typeof MemberInputSchema>> & { name: string };

export const MemberListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(["active", "inactive", "left"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

function searchText(m: Pick<MemberDoc, "name" | "membershipNumber" | "phone" | "email">) {
  return [m.name, m.membershipNumber, m.phone, m.email].filter(Boolean).join(" ").toLowerCase();
}

async function autoNumber(orgId: ObjectId) {
  const n = await nextNumber(orgId, "member");
  return `M${String(n).padStart(4, "0")}`;
}

export async function createMember(ctx: OrgContext, input: MemberInput) {
  const c = await cols();
  const now = new Date();
  for (let attempt = 0; attempt < 5; attempt++) {
    const membershipNumber = input.membershipNumber ?? (await autoNumber(ctx.orgId));
    const doc: MemberDoc = {
      _id: new ObjectId(),
      organizationId: ctx.orgId,
      membershipNumber,
      name: input.name,
      phone: input.phone,
      email: input.email,
      address: input.address,
      joiningDate: input.joiningDate ?? todayIn(ctx.org.settings.timezone),
      status: input.status ?? "active",
      userId: null,
      notes: input.notes,
      searchText: "",
      createdAt: now,
      updatedAt: now,
    };
    doc.searchText = searchText(doc);
    try {
      await c.members.insertOne(doc);
      await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "member.create", entityType: "member", entityId: doc._id, after: { name: doc.name, membershipNumber } });
      if (input.enrollInMonthlyHapta !== false && doc.status === "active") {
        const { enrollInMonthlyHapta, monthOf } = await import("./monthly.service");
        // Default: from the joining month when one was given, else from the current month.
        await enrollInMonthlyHapta(ctx, [doc._id], input.haptaStartMonth ?? (input.joiningDate ? monthOf(input.joiningDate) : undefined));
      }
      return doc;
    } catch (e) {
      if (isDuplicateKeyError(e)) {
        if (input.membershipNumber) throw conflict(`Membership number ${membershipNumber} is already in use`);
        continue;
      }
      throw e;
    }
  }
  throw conflict("Could not allocate a membership number");
}

export async function updateMember(ctx: OrgContext, id: ObjectId, rawInput: Partial<z.infer<typeof MemberInputSchema>>) {
  const { enrollInMonthlyHapta: _e, haptaStartMonth: _h, ...input } = rawInput;
  const c = await cols();
  const before = await c.members.findOne({ _id: id, organizationId: ctx.orgId });
  if (!before) throw notFound("Member");
  const next = { ...before };
  for (const [k, v] of Object.entries(input)) if (v !== undefined) (next as Record<string, unknown>)[k] = v;
  next.searchText = searchText(next);
  next.updatedAt = new Date();
  try {
    await c.members.replaceOne({ _id: id, organizationId: ctx.orgId }, next);
  } catch (e) {
    if (isDuplicateKeyError(e)) throw conflict("Membership number already in use");
    throw e;
  }
  await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "member.update", entityType: "member", entityId: id, before: input && pick(before, Object.keys(input)), after: input });
  return next;
}

function pick(o: object, keys: string[]) {
  return Object.fromEntries(keys.map((k) => [k, (o as Record<string, unknown>)[k]]));
}

export async function listMembers(ctx: OrgContext, q: z.infer<typeof MemberListQuery>) {
  const c = await cols();
  const filter: Record<string, unknown> = { organizationId: ctx.orgId };
  if (q.status) filter.status = q.status;
  if (q.q) filter.searchText = { $regex: q.q.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&") };
  const [items, total] = await Promise.all([
    c.members
      .find(filter, { projection: { searchText: 0 } })
      .sort({ name: 1, _id: 1 })
      .skip((q.page - 1) * q.pageSize)
      .limit(q.pageSize)
      .toArray(),
    c.members.countDocuments(filter),
  ]);
  // Outstanding dues for the members on this page (one aggregation, not N queries).
  const today = todayIn(ctx.org.settings.timezone);
  const ids = items.map((m) => m._id);
  const dues = await c.installments
    .aggregate<{ _id: ObjectId; outstanding: number; overdue: number }>([
      { $match: { organizationId: ctx.orgId, memberId: { $in: ids }, state: "active", dueDate: { $lte: today } } },
      {
        $group: {
          _id: "$memberId",
          outstanding: { $sum: { $subtract: [{ $add: ["$amountPaise", "$penaltyPaise"] }, { $add: ["$paidPaise", "$penaltyPaidPaise"] }] } },
          overdue: { $sum: { $cond: [{ $lt: ["$paidPaise", "$amountPaise"] }, 1, 0] } },
        },
      },
    ])
    .toArray();
  const dueMap = new Map(dues.map((d) => [d._id.toHexString(), d]));
  return {
    items: items.map((m) => ({
      ...m,
      outstandingPaise: dueMap.get(m._id.toHexString())?.outstanding ?? 0,
      dueInstallments: dueMap.get(m._id.toHexString())?.overdue ?? 0,
    })),
    total,
    page: q.page,
    pageSize: q.pageSize,
  };
}

export async function getMember(ctx: OrgContext, id: ObjectId) {
  const c = await cols();
  const m = await c.members.findOne({ _id: id, organizationId: ctx.orgId }, { projection: { searchText: 0 } });
  if (!m) throw notFound("Member");
  const [enrollments, loans] = await Promise.all([
    c.memberSchemeEnrollments
      .aggregate([
        { $match: { organizationId: ctx.orgId, memberId: id } },
        { $lookup: { from: "haptaSchemes", localField: "schemeId", foreignField: "_id", as: "scheme" } },
        { $unwind: "$scheme" },
        { $project: { status: 1, amountPaise: 1, startDate: 1, "scheme._id": 1, "scheme.name": 1, "scheme.frequency": 1, "scheme.amountPaise": 1, "scheme.status": 1 } },
      ])
      .toArray(),
    c.loans.find({ organizationId: ctx.orgId, memberId: id }, { projection: { schedule: 0 } }).sort({ createdAt: -1 }).toArray(),
  ]);
  return { member: m, enrollments, loans };
}

/* ---------------------------------------------------------------- CSV import */

export interface ImportResult {
  created: number;
  skipped: { row: number; reason: string }[];
  errors: { row: number; message: string }[];
  dryRun: boolean;
}

const HEADER_ALIASES: Record<string, string> = {
  name: "name",
  "member name": "name",
  "full name": "name",
  membershipnumber: "membershipNumber",
  "membership number": "membershipNumber",
  "member no": "membershipNumber",
  "member number": "membershipNumber",
  phone: "phone",
  mobile: "phone",
  email: "email",
  address: "address",
  joiningdate: "joiningDate",
  "joining date": "joiningDate",
  notes: "notes",
};

/**
 * Import members from CSV. Validates every row first; duplicates are detected by
 * membership number (in file and in DB) and by phone number. With dryRun nothing is written.
 */
export async function importMembers(ctx: OrgContext, csvText: string, dryRun: boolean): Promise<ImportResult> {
  const rows = parseCsv(csvText);
  const result: ImportResult = { created: 0, skipped: [], errors: [], dryRun };
  if (rows.length < 2) {
    result.errors.push({ row: 1, message: "The file needs a header row and at least one member" });
    return result;
  }
  if (rows.length > 5001) {
    result.errors.push({ row: 1, message: "Import at most 5000 members at a time" });
    return result;
  }
  const headers = rows[0].map((h) => HEADER_ALIASES[h.trim().toLowerCase()] ?? null);
  if (!headers.includes("name")) {
    result.errors.push({ row: 1, message: "A 'name' column is required" });
    return result;
  }
  const c = await cols();
  const existing = await c.members.find({ organizationId: ctx.orgId }, { projection: { membershipNumber: 1, phone: 1 } }).toArray();
  const numbers = new Set(existing.map((m) => m.membershipNumber));
  const phones = new Set(existing.map((m) => m.phone).filter(Boolean) as string[]);
  const valid: z.infer<typeof MemberInputSchema>[] = [];

  rows.slice(1).forEach((r, idx) => {
    const rowNo = idx + 2;
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      if (h && r[i] !== undefined && r[i].trim() !== "") obj[h] = r[i].trim();
    });
    if (obj.joiningDate && /^\d{2}[-/]\d{2}[-/]\d{4}$/.test(obj.joiningDate)) {
      const [d, m, y] = obj.joiningDate.split(/[-/]/);
      obj.joiningDate = `${y}-${m}-${d}`; // accept Indian dd-mm-yyyy
    }
    const parsed = MemberInputSchema.safeParse(obj);
    if (!parsed.success) {
      result.errors.push({ row: rowNo, message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
      return;
    }
    const v = parsed.data;
    if (v.membershipNumber && numbers.has(v.membershipNumber)) {
      result.skipped.push({ row: rowNo, reason: `Duplicate membership number ${v.membershipNumber}` });
      return;
    }
    if (v.phone && phones.has(v.phone)) {
      result.skipped.push({ row: rowNo, reason: `Duplicate phone ${v.phone}` });
      return;
    }
    if (v.membershipNumber) numbers.add(v.membershipNumber);
    if (v.phone) phones.add(v.phone);
    valid.push(v);
  });

  if (dryRun || result.errors.length) {
    result.created = 0;
    return { ...result, created: dryRun ? valid.length : 0 };
  }
  for (const v of valid) {
    await createMember(ctx, v);
    result.created++;
  }
  await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "member.import", entityType: "member", after: { created: result.created, skipped: result.skipped.length } });
  return result;
}

