import { ObjectId } from "mongodb";
import { z } from "zod";
import { env } from "@/config/env";
import { cols } from "@/lib/collections";
import { withTransaction } from "@/lib/db";
import { hashToken, joinCode, randomToken } from "@/lib/crypto";
import { AppError, badRequest, conflict, forbidden, isDuplicateKeyError, notFound } from "@/lib/errors";
import { audit } from "@/lib/audit";
import { defaultSettings } from "@/lib/org-defaults";
import type { AuthContext, OrgContext } from "@/lib/auth";
import type {
  OrganizationDoc,
  OrganizationMembershipDoc,
  OrgRole,
} from "@/types/models";
import { email, money, optText, phone, reason } from "@/validators/common";
import { requireOrgAccess } from "@/lib/auth";
import { todayIn } from "@/lib/dates";
import { createMember } from "./member.service";
import { rateLimit } from "@/lib/rate-limit";
import { notify } from "./notification.service";
import { emailConfigured, sendEmail } from "./email.service";

export { DEFAULT_EXPENSE_CATEGORIES, defaultSettings } from "@/lib/org-defaults";

const OrgProfileFields = {
  address: optText(300),
  city: optText(100),
  state: optText(100),
  pincode: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Enter a 6-digit PIN code")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  contactPhone: phone,
  contactEmail: email.optional().or(z.literal("").transform(() => undefined)),
  registrationNumber: optText(100),
  registrationDetails: optText(500),
  logoUrl: z.string().url().max(500).optional().or(z.literal("").transform(() => undefined)),
};

export const CreateOrgSchema = z.object({
  name: z.string().trim().min(3, "Enter the Mandal name").max(120),
  description: optText(500),
  ...OrgProfileFields,
  financialYearStartMonth: z.coerce.number().int().min(1).max(12).default(4),
  /** Monthly hapta per member, e.g. "500". Optional — can be set up later in Settings. */
  monthlyHaptaAmount: money().optional(),
  haptaStartMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM").optional(),
  haptaDueDay: z.coerce.number().int().min(1).max(28).default(10),
  /** Last month the Mandal runs (YYYY-MM). Optional — no end date by default. */
  endMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM").optional(),
  /** Also add the creator as a contributing member */
  creatorIsMember: z.boolean().default(true),
});

export const UpdateOrgSchema = z.object({
  name: z.string().trim().min(3).max(120).optional(),
  description: optText(500),
  ...OrgProfileFields,
  settings: z
    .object({
      financialYearStartMonth: z.number().int().min(1).max(12),
      timezone: z.string().min(3).max(64).refine((tz) => {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      }, "Unknown timezone"),
      receiptPrefix: z.string().trim().regex(/^[A-Z0-9-]{2,10}$/, "2–10 capital letters/digits"),
      requirePaymentVerification: z.boolean(),
      expenseApprovalThresholdPaise: z.number().int().min(0),
      reminderDaysBefore: z.array(z.number().int().min(0).max(30)).max(5),
      overdueReminderEveryDays: z.number().int().min(0).max(90),
      managerPermissions: z.object({
        canCreateLoans: z.boolean(),
        canApproveLoans: z.boolean(),
        canModifyInterest: z.boolean(),
        canApproveExpenses: z.boolean(),
        canVerifyPayments: z.boolean(),
        canManageSchemes: z.boolean(),
        canAccessSensitiveReports: z.boolean(),
        canManageAccounts: z.boolean(),
        canRecordWithdrawals: z.boolean().default(false),
        canDistributeInterest: z.boolean().default(false),
      }),
      expenseCategories: z
        .array(
          z.object({
            key: z.string().regex(/^[a-z0-9_]{2,40}$/),
            name: z.string().trim().min(2).max(60),
            isActive: z.boolean(),
          }),
        )
        .min(1)
        .max(100),
      paymentMethods: z.array(z.string().regex(/^[a-z0-9_]{2,30}$/)).min(1).max(20),
      installmentHorizonMonths: z.number().int().min(1).max(60),
      haptaTreatment: z.enum(["member_savings", "income"]),
      interest: z.object({
        defaultMode: z.enum(["manual", "rate"]),
        monthlyRate: z.string().regex(/^\d{1,3}(\.\d{1,4})?$/, "Enter a rate like 1 or 0.75"),
        basis: z.enum(["previous_month_closing", "hapta_contributions"]),
      }),
      withdrawals: z.object({ allowExceptions: z.boolean() }),
      fundLoans: z.object({
        defaultMonthlyRate: z.string().regex(/^\d{1,3}(\.\d{1,4})?$/, "Enter a rate like 2 or 1.5"),
        dueDay: z.number().int().min(1).max(28),
        allowMemberRequests: z.boolean().default(true),
      }),
      membership: z.object({ discoverable: z.boolean(), allowJoinRequests: z.boolean(), autoCreateMember: z.boolean() }),
    })
    .partial()
    .optional(),
});

function slugify(name: string) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "mandal"
  );
}

export function publicOrg(o: OrganizationDoc) {
  return {
    id: o._id,
    name: o.name,
    description: o.description ?? null,
    code: o.code,
    slug: o.slug,
    logoUrl: o.logoUrl ?? null,
    address: o.address ?? null,
    city: o.city ?? null,
    state: o.state ?? null,
    pincode: o.pincode ?? null,
    contactPhone: o.contactPhone ?? null,
    contactEmail: o.contactEmail ?? null,
    registrationNumber: o.registrationNumber ?? null,
    registrationDetails: o.registrationDetails ?? null,
    status: o.status,
    statusReason: o.statusReason ?? null,
    settings: o.settings,
    createdAt: o.createdAt,
  };
}

export async function createOrganization(auth: AuthContext, input: z.infer<typeof CreateOrgSchema>, ip: string) {
  const policy = env().ORG_REGISTRATION_POLICY;
  if (policy === "disabled" && !auth.user.isPlatformAdmin) throw forbidden("New organization registration is disabled");
  await rateLimit(`org-create:${auth.user._id}`, 5, 86400);
  const c = await cols();
  const now = new Date();
  const settings = defaultSettings();
  settings.financialYearStartMonth = input.financialYearStartMonth;
  const status = policy === "open" || auth.user.isPlatformAdmin ? "active" : "pending";
  const base = slugify(input.name);

  for (let attempt = 0; attempt < 5; attempt++) {
    const { financialYearStartMonth: _fy, monthlyHaptaAmount: _a, haptaStartMonth: _m, haptaDueDay: _d, creatorIsMember: _c, endMonth: _end, ...profile } = input;
    const org: OrganizationDoc = {
      _id: new ObjectId(),
      ...profile,
      name: input.name,
      code: joinCode(),
      slug: attempt === 0 ? base : `${base}-${joinCode(4).toLowerCase()}`,
      status,
      createdBy: auth.user._id,
      settings,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await withTransaction(async (session) => {
        await c.organizations.insertOne(org, { session });
        await c.organizationMemberships.insertOne(
          {
            _id: new ObjectId(),
            organizationId: org._id,
            userId: auth.user._id,
            role: "admin",
            status: "active",
            approvedBy: auth.user._id,
            approvedAt: now,
            createdAt: now,
            updatedAt: now,
          },
          { session },
        );
        // Every Mandal starts with a cash-in-hand account.
        await c.financialAccounts.insertOne(
          {
            _id: new ObjectId(),
            organizationId: org._id,
            name: "Cash in hand",
            type: "cash",
            openingBalancePaise: 0,
            openingDate: now,
            isActive: true,
            createdBy: auth.user._id,
            createdAt: now,
            updatedAt: now,
          },
          { session },
        );
        await audit(
          { organizationId: org._id, actorId: auth.user._id, action: "organization.create", entityType: "organization", entityId: org._id, after: { name: org.name, status }, ip },
          session,
        );
      });
      await afterCreate(auth, org, input);
      return publicOrg((await c.organizations.findOne({ _id: org._id }))!);
    } catch (e) {
      if (isDuplicateKeyError(e)) continue; // code/slug collision → retry
      throw e;
    }
  }
  throw conflict("Could not create organization, please try again");
}

/** Creator as member + monthly hapta set-up (outside the creation transaction; both idempotent). */
async function afterCreate(auth: AuthContext, org: OrganizationDoc, input: z.infer<typeof CreateOrgSchema>) {
  const ctx = await requireOrgAccess(auth, org._id.toHexString(), "org.view");
  const { firstOfMonth, monthOf, setupMonthlyHapta } = await import("./monthly.service");
  const start = input.haptaStartMonth ?? monthOf(todayIn(org.settings.timezone));
  if (input.creatorIsMember) {
    const m = await createMember(ctx, { name: auth.user.name, phone: auth.user.phone, email: auth.user.email, joiningDate: firstOfMonth(start), enrollInMonthlyHapta: false });
    await linkMember(ctx, ctx.membership._id, auth.user._id, m._id);
  }
  if (input.monthlyHaptaAmount) {
    await setupMonthlyHapta(ctx, { amount: input.monthlyHaptaAmount, startMonth: start, dueDay: input.haptaDueDay, enrollAllActive: true });
  }
  if (input.endMonth) {
    if (input.endMonth < start) throw badRequest("The Mandal can't end before its hapta starts");
    const { setEndMonth } = await import("./settlement.service");
    await setEndMonth(await requireOrgAccess(auth, org._id.toHexString(), "org.view"), { endMonth: input.endMonth });
  }
}

async function linkMember(ctx: OrgContext, membershipId: ObjectId, userId: ObjectId, memberId: ObjectId) {
  const c = await cols();
  await c.organizationMemberships.updateOne({ _id: membershipId, organizationId: ctx.orgId }, { $set: { memberId, updatedAt: new Date() } });
  await c.members.updateOne({ _id: memberId, organizationId: ctx.orgId }, { $set: { userId, updatedAt: new Date() } });
}

/**
 * Give an app user a member record in this Mandal (re-using an unlinked record with the same
 * email if one exists) and enroll them in the monthly hapta from `startMonth`.
 */
async function ensureMemberForUser(ctx: OrgContext, membershipId: ObjectId, userId: ObjectId, startMonth?: string) {
  const c = await cols();
  const user = await c.users.findOne({ _id: userId });
  if (!user) return null;
  let member = await c.members.findOne({ organizationId: ctx.orgId, userId });
  if (!member && user.email) member = await c.members.findOne({ organizationId: ctx.orgId, email: user.email, $or: [{ userId: null }, { userId: { $exists: false } }] });
  const { enrollInMonthlyHapta, firstOfMonth, monthOf } = await import("./monthly.service");
  const start = startMonth ?? monthOf(todayIn(ctx.org.settings.timezone));
  if (!member) member = await createMember(ctx, { name: user.name, phone: user.phone, email: user.email, joiningDate: firstOfMonth(start), enrollInMonthlyHapta: false });
  await linkMember(ctx, membershipId, userId, member._id);
  if (member.status === "active") await enrollInMonthlyHapta(ctx, [member._id], start);
  return member._id;
}

/** Find Mandals by name (only those that allow being discovered). Returns no financial data. */
export async function searchOrganizations(auth: AuthContext, q: string) {
  const c = await cols();
  const rx = q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const orgs = await c.organizations
    .find({ status: "active", name: { $regex: rx, $options: "i" }, "settings.membership.discoverable": { $ne: false } }, { projection: { name: 1, city: 1, description: 1, "settings.membership": 1 } })
    .limit(20)
    .toArray();
  const mine = await c.organizationMemberships.find({ userId: auth.user._id, organizationId: { $in: orgs.map((o) => o._id) } }, { projection: { organizationId: 1, status: 1 } }).toArray();
  return orgs.map((o) => ({
    id: o._id,
    name: o.name,
    city: o.city ?? null,
    description: o.description ?? null,
    acceptsJoinRequests: o.settings?.membership?.allowJoinRequests !== false,
    myStatus: mine.find((m) => m.organizationId.equals(o._id))?.status ?? null,
  }));
}

export async function lookupByCode(code: string) {
  const c = await cols();
  const org = await c.organizations.findOne({ code: code.trim().toUpperCase(), status: { $in: ["active", "pending"] } });
  if (!org) throw notFound("Organization");
  return { id: org._id, name: org.name, city: org.city ?? null, status: org.status };
}

export const JoinSchema = z
  .object({ code: z.string().trim().min(4).max(20).optional(), organizationId: z.string().optional(), message: optText(300) })
  .refine((v) => v.code || v.organizationId, "Enter the Mandal code or choose a Mandal");

export async function requestToJoin(auth: AuthContext, input: z.infer<typeof JoinSchema>) {
  await rateLimit(`join:${auth.user._id}`, 20, 3600);
  const c = await cols();
  const org = input.code
    ? await c.organizations.findOne({ code: input.code.toUpperCase(), status: { $in: ["active", "pending"] } })
    : ObjectId.isValid(input.organizationId!)
      ? await c.organizations.findOne({ _id: new ObjectId(input.organizationId!), status: "active", "settings.membership.discoverable": { $ne: false } })
      : null;
  if (!org) throw notFound("Organization");
  if (org.settings?.membership?.allowJoinRequests === false) throw forbidden("This Mandal is not accepting join requests. Ask the admin for an invitation.");
  const existing = await c.organizationMemberships.findOne({ organizationId: org._id, userId: auth.user._id });
  if (existing) {
    if (existing.status === "active") throw conflict("You are already a member of this organization");
    if (existing.status === "pending") return { status: "pending", organizationId: org._id };
    if (existing.status === "deactivated") throw forbidden("Your access to this organization was deactivated");
    // previously rejected: allow re-request
    await c.organizationMemberships.updateOne(
      { _id: existing._id },
      { $set: { status: "pending", role: "member", requestMessage: input.message, updatedAt: new Date() } },
    );
  } else {
    const now = new Date();
    await c.organizationMemberships.insertOne({
      _id: new ObjectId(),
      organizationId: org._id,
      userId: auth.user._id,
      role: "member", // never client-controlled
      status: "pending",
      requestMessage: input.message,
      createdAt: now,
      updatedAt: now,
    });
  }
  const admins = await c.organizationMemberships.find({ organizationId: org._id, role: "admin", status: "active" }).toArray();
  for (const a of admins) {
    await notify({
      organizationId: org._id,
      userId: a.userId,
      type: "membership.request",
      title: "New join request",
      body: `${auth.user.name} has requested to join ${org.name}.`,
      link: `/org/${org._id}/users`,
      dedupeKey: `join:${org._id}:${auth.user._id}:${Date.now()}`,
    });
  }
  await audit({ organizationId: org._id, actorId: auth.user._id, action: "membership.request", entityType: "membership" });
  return { status: "pending", organizationId: org._id };
}

export async function getOrganization(ctx: OrgContext) {
  return { ...publicOrg(ctx.org), myRole: ctx.role, myPermissions: [...ctx.permissions], myMemberId: ctx.membership.memberId ?? null };
}

export async function updateOrganization(ctx: OrgContext, input: z.infer<typeof UpdateOrgSchema>) {
  const c = await cols();
  const { settings, ...profile } = input;
  const $set: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(profile)) if (v !== undefined) $set[k] = v;
  if (settings) {
    if (settings.expenseCategories) {
      // categories referenced by the ledger must never disappear; deactivate instead
      const keys = new Set(settings.expenseCategories.map((x) => x.key));
      const missing = ctx.org.settings.expenseCategories.filter((x) => !keys.has(x.key));
      if (missing.length) throw badRequest(`Expense categories cannot be deleted, deactivate instead: ${missing.map((m) => m.name).join(", ")}`);
    }
    if (settings.expenseCategories?.some((x) => x.key === "member_interest")) throw badRequest("'member_interest' is a reserved category key");
    if (settings.haptaTreatment && settings.haptaTreatment !== ctx.org.settings.haptaTreatment) {
      const used = await c.financialTransactions.countDocuments({ organizationId: ctx.orgId, type: "hapta_collection" });
      if (used > 0) throw badRequest("Hapta treatment can't be changed after hapta has been recorded — it would make existing balances inconsistent");
    }
    for (const [k, v] of Object.entries(settings)) if (v !== undefined) $set[`settings.${k}`] = v;
  }
  const after = await c.organizations.findOneAndUpdate({ _id: ctx.orgId }, { $set }, { returnDocument: "after" });
  await audit({
    organizationId: ctx.orgId,
    actorId: ctx.user._id,
    action: "organization.update",
    entityType: "organization",
    entityId: ctx.orgId,
    before: { ...profile, settings: settings ? Object.fromEntries(Object.keys(settings).map((k) => [k, (ctx.org.settings as unknown as Record<string, unknown>)[k]])) : undefined },
    after: input,
  });
  return publicOrg(after!);
}

/* ------------------------------------------------------------ memberships */

export async function listMemberships(ctx: OrgContext, status?: string) {
  const c = await cols();
  const match: Record<string, unknown> = { organizationId: ctx.orgId };
  if (status) match.status = status;
  const rows = await c.organizationMemberships
    .aggregate([
      { $match: match },
      { $lookup: { from: "users", localField: "userId", foreignField: "_id", as: "user" } },
      { $unwind: "$user" },
      { $lookup: { from: "members", localField: "memberId", foreignField: "_id", as: "member" } },
      {
        $project: {
          role: 1,
          status: 1,
          requestMessage: 1,
          createdAt: 1,
          approvedAt: 1,
          memberId: 1,
          "user._id": 1,
          "user.name": 1,
          "user.email": 1,
          "user.phone": 1,
          member: { $arrayElemAt: [{ $map: { input: "$member", in: { _id: "$$this._id", name: "$$this.name", membershipNumber: "$$this.membershipNumber" } } }, 0] },
        },
      },
      { $sort: { status: 1, createdAt: -1 } },
    ])
    .toArray();
  return rows;
}

export const MembershipActionSchema = z.object({
  action: z.enum(["approve", "reject", "deactivate", "reactivate", "change_role", "link_member"]),
  role: z.enum(["admin", "manager", "member"]).optional(),
  memberId: z.string().optional().nullable(),
  /** On approve: create (or reuse) the member record and enroll in the monthly hapta. Defaults to the Mandal setting. */
  createMember: z.boolean().optional(),
  haptaStartMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  reason: optText(300),
});

export async function updateMembership(ctx: OrgContext, membershipId: ObjectId, input: z.infer<typeof MembershipActionSchema>) {
  const c = await cols();
  const m = await c.organizationMemberships.findOne({ _id: membershipId, organizationId: ctx.orgId });
  if (!m) throw notFound("Membership");
  const isSelf = m.userId.equals(ctx.user._id);
  const $set: Partial<OrganizationMembershipDoc> = { updatedAt: new Date() };
  let memberLink: ObjectId | null | undefined;
  if (input.memberId !== undefined) {
    if (input.memberId === null || input.memberId === "") memberLink = null;
    else {
      if (!ObjectId.isValid(input.memberId)) throw badRequest("Invalid member");
      const mem = await c.members.findOne({ _id: new ObjectId(input.memberId), organizationId: ctx.orgId });
      if (!mem) throw notFound("Member");
      if (mem.userId && !mem.userId.equals(m.userId)) throw conflict("This member record is already linked to another user");
      memberLink = mem._id;
    }
  }

  switch (input.action) {
    case "approve":
      if (m.status !== "pending") throw badRequest("Only pending requests can be approved");
      $set.status = "active";
      $set.role = input.role ?? "member";
      $set.approvedBy = ctx.user._id;
      $set.approvedAt = new Date();
      break;
    case "reject":
      if (m.status !== "pending") throw badRequest("Only pending requests can be rejected");
      $set.status = "rejected";
      break;
    case "deactivate":
      if (isSelf) throw badRequest("You cannot deactivate yourself");
      $set.status = "deactivated";
      break;
    case "reactivate":
      if (m.status !== "deactivated") throw badRequest("Membership is not deactivated");
      $set.status = "active";
      break;
    case "change_role":
      if (!input.role) throw badRequest("Role is required");
      if (isSelf && input.role !== "admin") throw badRequest("You cannot remove your own admin role");
      $set.role = input.role as OrgRole;
      break;
    case "link_member":
      if (memberLink === undefined && !input.createMember) throw badRequest("memberId is required");
      if (m.status !== "active") throw badRequest("Only active users can be linked to a member record");
      break;
  }
  if (memberLink !== undefined) $set.memberId = memberLink;

  // Never leave an organization without an active admin.
  const losingAdmin = m.role === "admin" && m.status === "active" && (($set.role && $set.role !== "admin") || $set.status === "deactivated");
  if (losingAdmin) {
    const admins = await c.organizationMemberships.countDocuments({ organizationId: ctx.orgId, role: "admin", status: "active" });
    if (admins <= 1) throw badRequest("The organization must keep at least one active admin");
  }

  await withTransaction(async (session) => {
    await c.organizationMemberships.updateOne({ _id: m._id }, { $set }, { session });
    if (memberLink !== undefined) {
      if (m.memberId) await c.members.updateOne({ _id: m.memberId, organizationId: ctx.orgId }, { $set: { userId: null } }, { session });
      if (memberLink) await c.members.updateOne({ _id: memberLink, organizationId: ctx.orgId }, { $set: { userId: m.userId } }, { session });
    }
    await audit(
      {
        organizationId: ctx.orgId,
        actorId: ctx.user._id,
        action: `membership.${input.action}`,
        entityType: "membership",
        entityId: m._id,
        before: { role: m.role, status: m.status, memberId: m.memberId },
        after: $set,
        reason: input.reason,
      },
      session,
    );
  });
  // Approving without picking an existing record (memberId absent, null or "") gives the person
  // a member record per the Mandal setting; "Add as member" on an already-active user does the same.
  const wantsNewMember =
    (input.action === "approve" && (input.createMember ?? ctx.org.settings.membership.autoCreateMember)) ||
    (input.action === "link_member" && input.createMember === true);
  if (wantsNewMember && !memberLink && !m.memberId) {
    await ensureMemberForUser(ctx, m._id, m.userId, input.haptaStartMonth);
  }
  if (input.action === "approve" || input.action === "reject") {
    await notify({
      organizationId: ctx.orgId,
      userId: m.userId,
      type: `membership.${input.action}`,
      title: input.action === "approve" ? "Membership approved" : "Membership request declined",
      body: input.action === "approve" ? `You can now access ${ctx.org.name}.` : `Your request to join ${ctx.org.name} was declined.`,
      link: input.action === "approve" ? `/org/${ctx.orgId}` : "/onboarding",
      dedupeKey: `membership:${m._id}:${input.action}:${Date.now()}`,
    });
  }
  return { ok: true };
}

/* ------------------------------------------------------------ invitations */

export const InviteSchema = z.object({
  email,
  role: z.enum(["admin", "manager", "member"]).default("member"),
  memberId: z.string().optional(),
});

const esc = (v: string) => v.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/**
 * Invite someone by email to sign in to this Mandal, optionally linked to their member record.
 * - New to MandalHisab: the link opens registration with the email filled in, then joins the Mandal.
 * - Already registered: the link (and an in-app banner) lets them join with one tap.
 * Any earlier pending invitation for the same email is replaced.
 */
export async function createInvitation(ctx: OrgContext, input: z.infer<typeof InviteSchema>) {
  await rateLimit(`invite:${ctx.orgId}`, 100, 86400);
  const c = await cols();
  let member: { _id: ObjectId; name: string; userId?: ObjectId | null } | null = null;
  if (input.memberId) {
    if (!ObjectId.isValid(input.memberId)) throw notFound("Member");
    member = await c.members.findOne({ _id: new ObjectId(input.memberId), organizationId: ctx.orgId }, { projection: { name: 1, userId: 1 } });
    if (!member) throw notFound("Member");
    if (member.userId) throw conflict(`${member.name} already has an app login linked`);
  }
  const invitee = await c.users.findOne({ email: input.email }, { projection: { _id: 1, name: 1 } });
  if (invitee) {
    const ms = await c.organizationMemberships.findOne({ organizationId: ctx.orgId, userId: invitee._id, status: "active" });
    // already in the Mandal: only useful when it links them to their member record
    if (ms && (!member || ms.memberId)) throw conflict("This person is already a member of this Mandal");
  }
  const token = randomToken();
  const now = new Date();
  await c.invitations.updateMany({ organizationId: ctx.orgId, email: input.email, status: "pending" }, { $set: { status: "revoked", updatedAt: now } });
  const invitationId = new ObjectId();
  await c.invitations.insertOne({
    _id: invitationId,
    organizationId: ctx.orgId,
    email: input.email,
    role: input.role,
    memberId: member?._id ?? null,
    tokenHash: hashToken(token),
    status: "pending",
    invitedBy: ctx.user._id,
    expiresAt: new Date(now.getTime() + 7 * 86_400_000),
    createdAt: now,
    updatedAt: now,
  });
  const base = env().FRONTEND_URL;
  const acceptPath = `/invite?token=${encodeURIComponent(token)}`;
  // new people register first (email pre-filled), then land on the invitation
  const registerQs = new URLSearchParams({ email: input.email, ...(member ? { name: member.name } : {}), next: acceptPath });
  const link = invitee ? `${base}${acceptPath}` : `${base}/register?${registerQs.toString()}`;
  const greeting = invitee?.name ? `Namaste ${invitee.name.split(" ")[0]},` : member ? `Namaste ${member.name.split(" ")[0]},` : "Namaste,";
  const steps = invitee
    ? `Sign in with ${input.email} and tap "Join the Mandal".`
    : `Create your MandalHisab account with this email (${input.email}) and set your own password — you'll join the Mandal straight away.`;
  const emailed = await sendEmail({
    to: input.email,
    subject: `${ctx.user.name} invited you to ${ctx.org.name} on MandalHisab`,
    text: `${greeting}\n\n${ctx.user.name} invited you to join ${ctx.org.name} on MandalHisab${member ? " to see your savings, hapta and upad" : ""}.\n\n${steps}\n\nOpen: ${link}\n\nThis invitation expires in 7 days.`,
    html: `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1f1d2e">
<p style="font-size:20px;font-weight:700;margin:0 0 16px;color:#4f46e5">MandalHisab</p>
<p>${esc(greeting)}</p>
<p><b>${esc(ctx.user.name)}</b> invited you to join <b>${esc(ctx.org.name)}</b>${member ? " to see your savings, hapta and upad" : ""}.</p>
<p>${esc(steps)}</p>
<p style="margin:24px 0"><a href="${esc(link)}" style="background:#4f46e5;color:#fff;text-decoration:none;padding:12px 20px;border-radius:12px;font-weight:600;display:inline-block">${invitee ? "Join the Mandal" : "Create account &amp; join"}</a></p>
<p style="font-size:13px;color:#6b6880">This invitation expires in 7 days. If the button doesn't work, open: ${esc(link)}</p>
</div>`,
  });
  await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "invitation.create", entityType: "invitation", entityId: invitationId, after: { email: input.email, role: input.role, memberId: member?._id ?? null } });
  return { ok: true, invitationId, inviteLink: link, existingUser: !!invitee, emailed, emailConfigured: emailConfigured() };
}

/** What an invitation is for — shown on the invite page before joining. */
export async function previewInvitation(auth: AuthContext, token: string) {
  const c = await cols();
  const inv = await c.invitations.findOne({ tokenHash: hashToken(token) });
  if (!inv || inv.status !== "pending" || inv.expiresAt <= new Date()) throw badRequest("This invitation is invalid, already used or has expired. Ask the Mandal admin for a new one.");
  const [org, inviter, member] = await Promise.all([
    c.organizations.findOne({ _id: inv.organizationId }, { projection: { name: 1, city: 1, status: 1 } }),
    c.users.findOne({ _id: inv.invitedBy }, { projection: { name: 1 } }),
    inv.memberId ? c.members.findOne({ _id: inv.memberId }, { projection: { name: 1, membershipNumber: 1 } }) : Promise.resolve(null),
  ]);
  return {
    organization: org ? { _id: org._id, name: org.name, city: org.city ?? null } : null,
    invitedByName: inviter?.name ?? null,
    role: inv.role,
    email: inv.email,
    member: member ? { name: member.name, membershipNumber: member.membershipNumber } : null,
    emailMatches: inv.email === auth.user.email,
    signedInAs: auth.user.email,
    expiresAt: inv.expiresAt,
  };
}

export async function acceptInvitation(auth: AuthContext, token: string) {
  const c = await cols();
  const inv = await c.invitations.findOne({ tokenHash: hashToken(token), status: "pending", expiresAt: { $gt: new Date() } });
  if (!inv) throw badRequest("This invitation is invalid or has expired");
  return acceptInvitationDoc(auth, inv);
}

/** Accept an invitation shown inside the app (matched by the signed-in user's email). */
export async function acceptInvitationById(auth: AuthContext, id: ObjectId) {
  const c = await cols();
  const inv = await c.invitations.findOne({ _id: id, email: auth.user.email, status: "pending", expiresAt: { $gt: new Date() } });
  if (!inv) throw badRequest("This invitation is invalid or has expired");
  return acceptInvitationDoc(auth, inv);
}

export async function declineInvitation(auth: AuthContext, id: ObjectId) {
  const c = await cols();
  const r = await c.invitations.updateOne({ _id: id, email: auth.user.email, status: "pending" }, { $set: { status: "revoked", updatedAt: new Date() } });
  if (r.modifiedCount !== 1) throw badRequest("This invitation is no longer pending");
  await audit({ actorId: auth.user._id, action: "invitation.decline", entityType: "invitation", entityId: id });
  return { ok: true };
}

/** Pending invitations addressed to the signed-in user's email. */
export async function myInvitations(auth: AuthContext) {
  const c = await cols();
  const invs = await c.invitations.find({ email: auth.user.email, status: "pending", expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).toArray();
  const orgs = await c.organizations.find({ _id: { $in: invs.map((i) => i.organizationId) } }, { projection: { name: 1, city: 1, status: 1 } }).toArray();
  const users = await c.users.find({ _id: { $in: invs.map((i) => i.invitedBy) } }, { projection: { name: 1 } }).toArray();
  return invs
    .filter((i) => orgs.some((o) => o._id.equals(i.organizationId) && o.status !== "suspended" && o.status !== "archived"))
    .map((i) => ({
      id: i._id,
      role: i.role,
      expiresAt: i.expiresAt,
      organization: orgs.find((o) => o._id.equals(i.organizationId)) ?? null,
      invitedByName: users.find((u) => u._id.equals(i.invitedBy))?.name ?? null,
    }));
}

async function acceptInvitationDoc(auth: AuthContext, inv: import("@/types/models").InvitationDoc) {
  const c = await cols();
  if (inv.email !== auth.user.email) throw forbidden("This invitation was sent to a different email address");
  const org = await c.organizations.findOne({ _id: inv.organizationId });
  if (!org || org.status === "suspended" || org.status === "archived") throw new AppError("ORG_INACTIVE", "Organization is not active");
  const now = new Date();
  const existing = await c.organizationMemberships.findOne({ organizationId: inv.organizationId, userId: auth.user._id });
  await withTransaction(async (session) => {
    const claimed = await c.invitations.updateOne({ _id: inv._id, status: "pending" }, { $set: { status: "accepted", updatedAt: now } }, { session });
    if (claimed.modifiedCount !== 1) throw conflict("Invitation already used");
    if (existing?.status === "active") {
      // Already a member: never change an existing role through an invitation — only link the member record if missing.
      if (inv.memberId && !existing.memberId) {
        await c.organizationMemberships.updateOne({ _id: existing._id }, { $set: { memberId: inv.memberId, updatedAt: now } }, { session });
        await c.members.updateOne({ _id: inv.memberId, organizationId: inv.organizationId, userId: null }, { $set: { userId: auth.user._id } }, { session });
      }
    } else {
      await c.organizationMemberships.updateOne(
        { organizationId: inv.organizationId, userId: auth.user._id },
        {
          $set: { role: inv.role, status: "active", approvedBy: inv.invitedBy, approvedAt: now, updatedAt: now, ...(inv.memberId ? { memberId: inv.memberId } : {}) },
          $setOnInsert: { _id: new ObjectId(), createdAt: now },
        },
        { upsert: true, session },
      );
      if (inv.memberId) {
        await c.members.updateOne({ _id: inv.memberId, organizationId: inv.organizationId, userId: null }, { $set: { userId: auth.user._id } }, { session });
      }
    }
    await audit({ organizationId: inv.organizationId, actorId: auth.user._id, action: "invitation.accept", entityType: "invitation", entityId: inv._id }, session);
  });
  if (existing?.status !== "active" && !inv.memberId && org.status === "active") {
    const ctx = await requireOrgAccess(auth, inv.organizationId.toHexString(), "org.view");
    if (ctx.org.settings.membership.autoCreateMember && !ctx.membership.memberId) await ensureMemberForUser(ctx, ctx.membership._id, auth.user._id);
  }
  return { organizationId: inv.organizationId };
}

export async function listInvitations(ctx: OrgContext) {
  const c = await cols();
  const invs = await c.invitations.find({ organizationId: ctx.orgId, status: "pending", expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).toArray();
  return invs.map(({ tokenHash: _t, ...i }) => i);
}

export async function revokeInvitation(ctx: OrgContext, id: ObjectId) {
  const c = await cols();
  const r = await c.invitations.updateOne({ _id: id, organizationId: ctx.orgId, status: "pending" }, { $set: { status: "revoked", updatedAt: new Date() } });
  if (r.modifiedCount !== 1) throw notFound("Invitation");
  await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "invitation.revoke", entityType: "invitation", entityId: id });
  return { ok: true };
}

/* ------------------------------------------------------------ platform admin */

export const PlatformOrgActionSchema = z.object({
  action: z.enum(["approve", "suspend", "reactivate", "archive"]),
  reason: reason.optional(),
});

export async function platformListOrganizations(status?: string, q?: string) {
  const c = await cols();
  const match: Record<string, unknown> = {};
  if (status) match.status = status;
  if (q) match.name = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
  return c.organizations
    .aggregate([
      { $match: match },
      { $sort: { createdAt: -1 } },
      { $limit: 200 },
      {
        $lookup: {
          from: "organizationMemberships",
          let: { o: "$_id" },
          pipeline: [{ $match: { $expr: { $and: [{ $eq: ["$organizationId", "$$o"] }, { $eq: ["$status", "active"] }] } } }, { $count: "n" }],
          as: "userCount",
        },
      },
      { $lookup: { from: "users", localField: "createdBy", foreignField: "_id", as: "creator" } },
      {
        // Only platform-level metadata: no financial data is exposed here.
        $project: {
          name: 1,
          code: 1,
          city: 1,
          state: 1,
          status: 1,
          statusReason: 1,
          createdAt: 1,
          registrationNumber: 1,
          contactEmail: 1,
          contactPhone: 1,
          users: { $ifNull: [{ $arrayElemAt: ["$userCount.n", 0] }, 0] },
          creator: { $arrayElemAt: [{ $map: { input: "$creator", in: { name: "$$this.name", email: "$$this.email" } } }, 0] },
        },
      },
    ])
    .toArray();
}

export async function platformUpdateOrganization(auth: AuthContext, orgId: ObjectId, input: z.infer<typeof PlatformOrgActionSchema>) {
  const c = await cols();
  const org = await c.organizations.findOne({ _id: orgId });
  if (!org) throw notFound("Organization");
  const transitions: Record<string, { from: string[]; to: OrganizationDoc["status"] }> = {
    approve: { from: ["pending"], to: "active" },
    suspend: { from: ["active", "pending"], to: "suspended" },
    reactivate: { from: ["suspended", "archived"], to: "active" },
    archive: { from: ["active", "suspended", "pending"], to: "archived" },
  };
  const t = transitions[input.action];
  if (!t.from.includes(org.status)) throw badRequest(`Cannot ${input.action} an organization that is ${org.status}`);
  if ((input.action === "suspend" || input.action === "archive") && !input.reason) throw badRequest("A reason is required");
  await c.organizations.updateOne({ _id: orgId }, { $set: { status: t.to, statusReason: input.reason, updatedAt: new Date() } });
  await audit({ organizationId: orgId, actorId: auth.user._id, action: `platform.organization.${input.action}`, entityType: "organization", entityId: orgId, before: { status: org.status }, after: { status: t.to }, reason: input.reason });
  const admins = await c.organizationMemberships.find({ organizationId: orgId, role: "admin", status: "active" }).toArray();
  for (const a of admins) {
    await notify({
      organizationId: orgId,
      userId: a.userId,
      type: `organization.${input.action}`,
      title: `Organization ${t.to}`,
      body: `${org.name} is now ${t.to}${input.reason ? `: ${input.reason}` : ""}.`,
      dedupeKey: `org-status:${orgId}:${t.to}:${Date.now()}`,
    });
  }
  return { ok: true, status: t.to };
}

export async function platformStats() {
  const c = await cols();
  const [orgs, users, byStatus, recent] = await Promise.all([
    c.organizations.countDocuments(),
    c.users.countDocuments({ status: "active" }),
    c.organizations.aggregate<{ _id: string; n: number }>([{ $group: { _id: "$status", n: { $sum: 1 } } }]).toArray(),
    c.auditLogs
      .find({ action: { $regex: "^(platform\\.|organization\\.create)" } })
      .sort({ createdAt: -1 })
      .limit(20)
      .project({ action: 1, organizationId: 1, actorId: 1, createdAt: 1, reason: 1 })
      .toArray(),
  ]);
  return {
    organizations: orgs,
    activeUsers: users,
    organizationsByStatus: Object.fromEntries(byStatus.map((b) => [b._id, b.n])),
    recentActivity: recent,
  };
}
