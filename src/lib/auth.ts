import { ObjectId } from "mongodb";
import { cols } from "./collections";
import { hashToken } from "./crypto";
import { AppError, forbidden, notFound, unauthorized } from "./errors";
import { permissionsFor, type Permission } from "./permissions";
import { withSettingsDefaults } from "./org-defaults";
import type { OrganizationDoc, OrganizationMembershipDoc, OrgRole, SessionDoc, UserDoc } from "@/types/models";

export interface AuthContext {
  user: UserDoc;
  session: SessionDoc;
}

export interface OrgContext extends AuthContext {
  org: OrganizationDoc;
  orgId: ObjectId;
  membership: OrganizationMembershipDoc;
  role: OrgRole;
  permissions: Set<Permission>;
  can(p: Permission): boolean;
  require(p: Permission): void;
}

const SESSION_TOUCH_MS = 5 * 60 * 1000;

/** Resolve a bearer token into an authenticated user, or throw 401. */
export async function authenticate(token: string | null | undefined): Promise<AuthContext> {
  if (!token || token.length < 20 || token.length > 200) throw unauthorized();
  const c = await cols();
  // Session and its user in ONE round trip (this runs on every request).
  const [row] = await c.sessions
    .aggregate<SessionDoc & { _user: UserDoc[] }>([
      { $match: { tokenHash: hashToken(token) } },
      { $limit: 1 },
      { $lookup: { from: "users", localField: "userId", foreignField: "_id", as: "_user" } },
    ])
    .toArray();
  if (!row || row.expiresAt.getTime() <= Date.now()) throw unauthorized("Session expired");
  const { _user, ...session } = row;
  const user = _user[0];
  if (!user || user.status !== "active" || user.sessionVersion !== session.sessionVersion) {
    throw unauthorized("Session is no longer valid");
  }
  if (Date.now() - session.lastUsedAt.getTime() > SESSION_TOUCH_MS) {
    // bookkeeping only — don't make the request wait for it
    void c.sessions.updateOne({ _id: session._id }, { $set: { lastUsedAt: new Date() } }).catch(() => {});
  }
  return { user, session };
}

export function parseObjectId(v: string | undefined | null, what = "Resource"): ObjectId {
  if (!v || !ObjectId.isValid(v) || String(new ObjectId(v)) !== v.toLowerCase()) throw notFound(what);
  return new ObjectId(v);
}

export interface OrgAccessOptions {
  /** Operation writes data; requires the organization to be active (or pending if allowPending). */
  write?: boolean;
  allowPending?: boolean;
}

/**
 * Tenant guard. Loads the org and the caller's ACTIVE membership in it and checks
 * the permission. Platform super-admins get NO implicit access to organization data.
 */
export async function requireOrgAccess(
  auth: AuthContext,
  orgIdRaw: string,
  permission: Permission,
  opts: OrgAccessOptions = {},
): Promise<OrgContext> {
  const orgId = parseObjectId(orgIdRaw, "Organization");
  const c = await cols();
  const [org, membership] = await Promise.all([
    c.organizations.findOne({ _id: orgId }),
    c.organizationMemberships.findOne({ organizationId: orgId, userId: auth.user._id, status: "active" }),
  ]);
  // Same error for "doesn't exist" and "not a member" so org ids can't be probed.
  if (!org || !membership) throw notFound("Organization");
  withSettingsDefaults(org);
  if (org.status === "suspended") throw new AppError("ORG_INACTIVE", "This organization is suspended");
  if (opts.write) {
    const ok = org.status === "active" || (opts.allowPending && org.status === "pending");
    if (!ok) {
      throw new AppError(
        "ORG_INACTIVE",
        org.status === "pending"
          ? "This organization is awaiting platform approval"
          : "This organization is archived (read-only)",
      );
    }
  }
  const permissions = permissionsFor(membership.role, org.settings.managerPermissions);
  if (!permissions.has(permission)) throw forbidden();
  return {
    ...auth,
    org,
    orgId,
    membership,
    role: membership.role,
    permissions,
    can: (p) => permissions.has(p),
    require: (p) => {
      if (!permissions.has(p)) throw forbidden();
    },
  };
}

export function requirePlatformAdmin(auth: AuthContext) {
  if (!auth.user.isPlatformAdmin) throw forbidden();
}
