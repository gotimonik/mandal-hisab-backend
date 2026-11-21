import { ObjectId } from "mongodb";
import { z } from "zod";
import { cols } from "@/lib/collections";
import { audit } from "@/lib/audit";
import { badRequest, conflict, isDuplicateKeyError, notFound } from "@/lib/errors";
import { latinName } from "@/lib/transliterate";
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
  /** How many haptas they pay each month (e.g. 3 × ₹500). Default 1. */
  haptaShares: z.coerce.number().int().min(1, "At least 1").max(50, "At most 50").optional(),
  /** When changing hapta shares: first month it applies to (default this month) */
  sharesFromMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM").optional(),
  /** On create with an email: email them an invitation to sign in to the Mandal (default true) */
  inviteToApp: z.boolean().optional(),
});

type MemberInput = Partial<z.infer<typeof MemberInputSchema>> & { name: string };

export const MemberListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(["active", "inactive", "left"]).optional(),
  /** only members who owe something now: unpaid hapta due so far or unpaid upad interest */
  due: z
    .enum(["1", "true", "0", "false"])
    .optional()
    .transform((v) => v === "1" || v === "true"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

/** Lower-cased words a member is found by: a Gujarati / Hindi name also by its English spellings. */
function searchText(m: Pick<MemberDoc, "name" | "membershipNumber" | "phone" | "email" | "nameEnglish">) {
  return [m.name, m.nameEnglish, latinName(m.name), m.membershipNumber, m.phone, m.email].filter(Boolean).join(" ").toLowerCase();
}

const INDIC = /[\u0900-\u097F\u0A80-\u0AFF]/;

export const RenameSchema = z.object({
  items: z
    .array(z.object({ memberId: z.string(), name: z.string().trim().min(2, "Enter the member's name").max(120) }))
    .min(1, "Nothing to rename")
    .max(2000),
});

/**
 * Change many members' names at once (e.g. to Gujarati). When an English name becomes a
 * Gujarati / Hindi one, the English one is kept as `nameEnglish`, so searching "abhishek"
 * still finds "અભિષેક ગોટી".
 */
export async function renameMembers(ctx: OrgContext, input: z.infer<typeof RenameSchema>) {
  const c = await cols();
  const ids = input.items.map((i) => {
    if (!ObjectId.isValid(i.memberId)) throw badRequest("Invalid member");
    return new ObjectId(i.memberId);
  });
  const members = await c.members.find({ organizationId: ctx.orgId, _id: { $in: ids } }).toArray();
  const byId = new Map(members.map((m) => [m._id.toHexString(), m]));
  const changes: { id: ObjectId; from: string; to: string }[] = [];
  const now = new Date();
  for (const it of input.items) {
    const m = byId.get(it.memberId);
    if (!m) throw notFound("Member");
    const name = it.name.replace(/\s+/g, " ");
    if (name === m.name) continue;
    const nameEnglish = m.nameEnglish ?? (!INDIC.test(m.name) && INDIC.test(name) ? m.name : null);
    const next = { ...m, name, nameEnglish };
    await c.members.updateOne({ _id: m._id, organizationId: ctx.orgId }, { $set: { name, nameEnglish, searchText: searchText(next), updatedAt: now } });
    changes.push({ id: m._id, from: m.name, to: name });
  }
  if (changes.length) {
    await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "member.rename", entityType: "member", after: { renamed: changes.length, names: changes.map((x) => `${x.from} → ${x.to}`) } });
  }
  return { renamed: changes.length };
}

async function autoNumber(orgId: ObjectId) {
  const n = await nextNumber(orgId, "member");
  return `M${String(n).padStart(4, "0")}`;
}

export async function createMember(ctx: OrgContext, input: MemberInput) {
  const c = await cols();
  const now = new Date();
  // once members have been put in order, a new member goes at the end
  const last = await c.members.findOne({ organizationId: ctx.orgId, position: { $exists: true } }, { sort: { position: -1 }, projection: { position: 1 } });
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
      ...(input.haptaShares && input.haptaShares > 1 ? { haptaShares: input.haptaShares } : {}),
      ...(last ? { position: (last.position ?? 0) + 1 } : {}),
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
  const { enrollInMonthlyHapta: _e, haptaStartMonth: _h, inviteToApp: _i, sharesFromMonth, ...input } = rawInput;
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
  // a changed share count — or an explicit "apply from" month for the current one — re-prices the months
  if (input.haptaShares !== undefined && (input.haptaShares !== (before.haptaShares ?? 1) || sharesFromMonth)) {
    const { setHaptaShares } = await import("./monthly.service");
    const r = await setHaptaShares(ctx, id, input.haptaShares, sharesFromMonth);
    return { ...next, sharesInstallmentsUpdated: r.installmentsUpdated };
  }
  return next;
}

function pick(o: object, keys: string[]) {
  return Object.fromEntries(keys.map((k) => [k, (o as Record<string, unknown>)[k]]));
}

/** Members who owe something now: hapta due so far not fully paid, or upad interest not paid. */
async function membersWithDues(ctx: OrgContext): Promise<ObjectId[]> {
  const c = await cols();
  const today = todayIn(ctx.org.settings.timezone);
  const { refreshFundLoanDues } = await import("./fund-loan.service");
  await refreshFundLoanDues(ctx.org);
  const [hapta, interest] = await Promise.all([
    c.installments.distinct("memberId", {
      organizationId: ctx.orgId,
      state: "active",
      dueDate: { $lte: today },
      $expr: { $lt: [{ $add: ["$paidPaise", "$penaltyPaidPaise"] }, { $add: ["$amountPaise", "$penaltyPaise"] }] },
    }),
    c.fundLoanDues.distinct("memberId", { organizationId: ctx.orgId, $expr: { $lt: ["$paidPaise", "$interestPaise"] } }),
  ]);
  return [...hapta, ...interest] as ObjectId[];
}

export async function listMembers(ctx: OrgContext, q: Omit<z.infer<typeof MemberListQuery>, "due"> & { due?: boolean }) {
  const c = await cols();
  const filter: Record<string, unknown> = { organizationId: ctx.orgId };
  if (q.status) filter.status = q.status;
  if (q.q) filter.searchText = { $regex: q.q.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&") };
  if (q.due) filter._id = { $in: await membersWithDues(ctx) };
  const [items, total] = await Promise.all([
    c.members
      .find(filter, { projection: { searchText: 0 } })
      // the Mandal's own order when it has one (members without a place: by name)
      .sort({ position: 1, name: 1, _id: 1 })
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
  // Upad still owed and its unpaid interest, for the same members (dues brought up to date first)
  const { refreshFundLoanDues } = await import("./fund-loan.service");
  await refreshFundLoanDues(ctx.org);
  const [loans, interest] = await Promise.all([
    c.fundLoans
      .aggregate<{ _id: ObjectId; owed: number }>([{ $match: { organizationId: ctx.orgId, memberId: { $in: ids }, status: "active" } }, { $group: { _id: "$memberId", owed: { $sum: "$outstandingPaise" } } }])
      .toArray(),
    c.fundLoanDues
      .aggregate<{ _id: ObjectId; due: number }>([
        { $match: { organizationId: ctx.orgId, memberId: { $in: ids }, $expr: { $lt: ["$paidPaise", "$interestPaise"] } } },
        { $group: { _id: "$memberId", due: { $sum: { $subtract: ["$interestPaise", "$paidPaise"] } } } },
      ])
      .toArray(),
  ]);
  const loanMap = new Map(loans.map((l) => [l._id.toHexString(), l.owed]));
  const interestMap = new Map(interest.map((d) => [d._id.toHexString(), d.due]));
  return {
    items: items.map((m) => {
      const k = m._id.toHexString();
      return {
        ...m,
        /** unpaid hapta (incl. late fees) due so far */
        outstandingPaise: dueMap.get(k)?.outstanding ?? 0,
        dueInstallments: dueMap.get(k)?.overdue ?? 0,
        /** upad principal still owed */
        upadPaise: loanMap.get(k) ?? 0,
        /** upad interest due and not yet paid */
        upadInterestDuePaise: interestMap.get(k) ?? 0,
      };
    }),
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


/* ---------------------------------------------------------------- the Mandal's own order */

export const OrderSchema = z.object({ memberIds: z.array(z.string()).min(1).max(5000) });

/** In order of `position`, then name — for lists built in memory. */
export function memberOrder(a: { position?: number; name?: string } | null | undefined, b: { position?: number; name?: string } | null | undefined) {
  const pa = a?.position ?? Number.MAX_SAFE_INTEGER;
  const pb = b?.position ?? Number.MAX_SAFE_INTEGER;
  return pa - pb || (a?.name ?? "").localeCompare(b?.name ?? "");
}

/**
 * Put the members in the Mandal's own order (dragged into place). Members not in the list keep
 * their order after the listed ones, so every member ends up with a place.
 */
export async function reorderMembers(ctx: OrgContext, input: z.infer<typeof OrderSchema>) {
  const c = await cols();
  const all = await c.members.find({ organizationId: ctx.orgId }, { projection: { position: 1, name: 1 } }).toArray();
  const byId = new Map(all.map((m) => [m._id.toHexString(), m]));
  const seen = new Set<string>();
  const ordered: ObjectId[] = [];
  for (const id of input.memberIds) {
    const m = byId.get(id);
    if (!m) throw notFound("Member");
    if (seen.has(id)) throw badRequest("A member is in the list twice");
    seen.add(id);
    ordered.push(m._id);
  }
  ordered.push(...all.filter((m) => !seen.has(m._id.toHexString())).sort(memberOrder).map((m) => m._id));
  const now = new Date();
  await c.members.bulkWrite(ordered.map((_id, i) => ({ updateOne: { filter: { _id, organizationId: ctx.orgId }, update: { $set: { position: i + 1, updatedAt: now } } } })));
  await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "member.reorder", entityType: "member", after: { members: ordered.length } });
  return { ordered: ordered.length };
}
