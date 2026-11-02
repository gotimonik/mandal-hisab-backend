import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { BSON, ObjectId, type Collection, type Document } from "mongodb";
import { cols, ensureIndexes, type Collections } from "@/lib/collections";
import { env } from "@/config/env";
import { audit } from "@/lib/audit";
import { forbidden } from "@/lib/errors";
import { hashPassword } from "@/lib/crypto";
import type { OrgContext } from "@/lib/auth";

/**
 * A Mandal's own backup: everything about one Mandal in one file, so if the database is ever
 * lost or damaged, the admin can hand the file to MandalHisab and it is loaded back exactly
 * (scripts/restore-backup.ts).
 *
 * - Every record of the Mandal, with its real ids, dates and amounts (MongoDB Extended JSON).
 * - The app users who belong to it — name, email, phone, language — but never passwords,
 *   sign-in sessions or phone push tokens. After a restore, people set a new password with
 *   "Forgot password".
 * - Signed with the server's AUTH_SECRET: a file edited after download (balances changed …)
 *   is refused when restoring.
 */

export const BACKUP_FORMAT = "mandalhisab-backup";
export const BACKUP_VERSION = 1;

/** Collections whose records carry the Mandal's organizationId. */
export const ORG_COLLECTIONS = [
  "organizationMemberships",
  "invitations",
  "members",
  "haptaSchemes",
  "memberSchemeEnrollments",
  "installments",
  "payments",
  "donations",
  "expenses",
  "financialAccounts",
  "financialTransactions",
  "ledgerEntries",
  "receipts",
  "loans",
  "loanRepayments",
  "interestCalculations",
  "notifications",
  "auditLogs",
  "memberLedger",
  "interestRuns",
  "withdrawals",
  "fundLoans",
  "fundLoanDues",
  "fundLoanPayments",
  "upadRequests",
  "upadPaymentClaims",
  "meetings",
] as const satisfies readonly (keyof Collections)[];

/** Kept out on purpose (or saved another way): see the comment at the top. */
export const NOT_IN_BACKUP: (keyof Collections)[] = ["sessions", "authTokens", "rateLimits", "pushDevices"];
/** Saved separately: the Mandal itself, its numbering (receipt no. …) and its people. */
export const SPECIAL_IN_BACKUP: (keyof Collections)[] = ["organizations", "counters", "users"];

const USER_FIELDS = { _id: 1, name: 1, email: 1, phone: 1, emailVerifiedAt: 1, status: 1, sessionVersion: 1, language: 1, createdAt: 1, updatedAt: 1 } as const;

const signingKey = () => createHmac("sha256", env().AUTH_SECRET).update("mandalhisab-backup").digest();
const sign = (body: string) => createHmac("sha256", signingKey()).update(body).digest("hex");

const anyCol = (c: Collections, name: keyof Collections) => c[name] as unknown as Collection<Document>;

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: number;
  createdAt: string;
  organization: { id: string; name: string; code: string };
  counts: Record<string, number>;
  data: Record<string, unknown>;
  signature?: string;
}

/** The backup file for the admin's Mandal. */
export async function createBackup(ctx: OrgContext) {
  // a platform admin looking around may read screens, not take the Mandal's data away
  if (ctx.platformView) throw forbidden("Only the Mandal's own admins can download its backup");
  const c = await cols();
  const orgId = ctx.orgId;
  const data: Record<string, Document[]> = {};
  data.organizations = await c.organizations.find({ _id: orgId }).toArray();
  for (const name of ORG_COLLECTIONS) data[name] = await anyCol(c, name).find({ organizationId: orgId }).toArray();
  data.counters = await c.counters.find({ _id: { $regex: `^${orgId.toHexString()}:` } }).toArray();
  const userIds = new Map<string, ObjectId>();
  for (const m of data.organizationMemberships) userIds.set(String(m.userId), m.userId as ObjectId);
  userIds.set(String(ctx.org.createdBy), ctx.org.createdBy);
  data.users = await c.users.find({ _id: { $in: [...userIds.values()] } }, { projection: USER_FIELDS }).toArray();

  const now = new Date();
  const body: BackupFile = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: now.toISOString(),
    organization: { id: orgId.toHexString(), name: ctx.org.name, code: ctx.org.code },
    counts: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length])),
    data: BSON.EJSON.serialize(data, { relaxed: false }),
  };
  const unsigned = JSON.stringify(body);
  await audit({ organizationId: orgId, actorId: ctx.user._id, action: "organization.backup", entityType: "organization", entityId: orgId, after: { records: Object.values(body.counts).reduce((a, b) => a + b, 0) } });
  const date = now.toISOString().slice(0, 10);
  return {
    filename: `MandalHisab-backup-${ctx.org.code}-${date}.json`,
    json: `${unsigned.slice(0, -1)},"signature":${JSON.stringify(sign(unsigned))}}`,
  };
}

/** When the Mandal's backup was last downloaded, and by whom (Settings shows it). */
export async function backupStatus(ctx: OrgContext) {
  const c = await cols();
  const last = await c.auditLogs.findOne({ organizationId: ctx.orgId, action: "organization.backup" }, { sort: { createdAt: -1 } });
  const by = last?.actorId ? await c.users.findOne({ _id: last.actorId }, { projection: { name: 1 } }) : null;
  // money recorded since then (hapta, upad, cash book …): the backup no longer has the latest
  const changed = await c.financialTransactions.findOne({ organizationId: ctx.orgId, ...(last ? { createdAt: { $gt: last.createdAt } } : {}) }, { projection: { _id: 1 } });
  const daysSince = last ? Math.floor((Date.now() - last.createdAt.getTime()) / 86_400_000) : null;
  // remind the admin when there's none, or it's more than a month old
  const due = daysSince === null || daysSince > 30;
  return { lastBackupAt: last?.createdAt ?? null, lastBackupBy: by?.name ?? null, due, daysSince, changedSinceBackup: !!changed };
}

/* ------------------------------------------------------------------ restore (platform operator) */

export interface RestoreOptions {
  /** Check the file and report what would be restored, without changing the database. */
  dryRun?: boolean;
  /** The Mandal still exists in the database: delete what's there and load the backup instead. */
  replace?: boolean;
  /** Load a file whose signature doesn't match (edited, or made with another AUTH_SECRET). */
  trustUnsigned?: boolean;
  /** Who restored it (platform admin), for the audit log. */
  actorId?: ObjectId | null;
}

export interface RestoreResult {
  organization: { id: string; name: string; code: string };
  backupCreatedAt: string;
  signatureValid: boolean;
  replacedExisting: boolean;
  /** The Mandal is still in the database (a restore needs "replace"). */
  existsInDatabase: boolean;
  usersCreated: number;
  usersMatchedByEmail: number;
  counts: Record<string, number>;
  dryRun: boolean;
}

export class BackupError extends Error {}

/** Swap user ids everywhere in a record (people who signed up again after the loss). */
function remapIds<T>(v: T, map: Map<string, ObjectId>): T {
  if (map.size === 0 || v === null || typeof v !== "object") return v;
  if (v instanceof ObjectId) return (map.get(v.toHexString()) ?? v) as T;
  if (v instanceof Date) return v;
  if (Array.isArray(v)) return v.map((x) => remapIds(x, map)) as T;
  if (Object.getPrototypeOf(v) !== Object.prototype) return v; // other BSON values
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, remapIds(x, map)])) as T;
}

/** Check a backup file: its format and that nobody changed it since it was downloaded. */
export function readBackup(text: string): { file: BackupFile; signatureValid: boolean; data: Record<string, Document[]> } {
  let file: BackupFile;
  try {
    file = JSON.parse(text);
  } catch {
    throw new BackupError("This isn't a MandalHisab backup file (not valid JSON)");
  }
  if (file?.format !== BACKUP_FORMAT) throw new BackupError("This isn't a MandalHisab backup file");
  if (file.version !== BACKUP_VERSION) throw new BackupError(`Backup version ${file.version} isn't supported by this version of MandalHisab`);
  const { signature, ...rest } = file;
  const expected = Buffer.from(sign(JSON.stringify(rest)), "hex");
  const given = typeof signature === "string" && /^[0-9a-f]{64}$/.test(signature) ? Buffer.from(signature, "hex") : Buffer.alloc(0);
  const signatureValid = given.length === expected.length && timingSafeEqual(given, expected);
  const data = BSON.EJSON.deserialize(file.data as Document, { relaxed: false }) as Record<string, Document[]>;
  return { file, signatureValid, data };
}

/** Load a Mandal back from its backup file (scripts/restore-backup.ts). */
export async function restoreBackup(text: string, opts: RestoreOptions = {}): Promise<RestoreResult> {
  const { file, signatureValid, data } = readBackup(text);
  if (!signatureValid && !opts.trustUnsigned) {
    throw new BackupError("The backup file was changed after it was downloaded (or was made with a different AUTH_SECRET). Not restored. Use --trust-unsigned only if you are sure the file is genuine.");
  }
  const org = data.organizations?.[0];
  if (!org?._id) throw new BackupError("The backup has no Mandal in it");
  await ensureIndexes();
  const c = await cols();
  const existing = await c.organizations.findOne({ _id: org._id }, { projection: { name: 1 } });
  if (existing && !opts.replace && !opts.dryRun) throw new BackupError(`"${existing.name}" is still in the database. Run again with --replace to overwrite it with this backup.`);
  const clash = await c.organizations.findOne({ code: org.code, _id: { $ne: org._id } }, { projection: { name: 1 } });
  if (clash) throw new BackupError(`Another Mandal ("${clash.name}") now uses the join code ${org.code}. Change one of the codes first.`);

  // People: someone who signed up again since keeps their new account; everyone else comes back
  // with their old id and no password (they use "Forgot password").
  const map = new Map<string, ObjectId>();
  const newUsers: Document[] = [];
  let matched = 0;
  for (const u of data.users ?? []) {
    const byEmail = await c.users.findOne({ email: u.email }, { projection: { _id: 1 } });
    if (byEmail) {
      matched++;
      if (!byEmail._id.equals(u._id)) map.set((u._id as ObjectId).toHexString(), byEmail._id);
      continue;
    }
    const idTaken = await c.users.findOne({ _id: u._id }, { projection: { _id: 1 } });
    const _id = idTaken ? new ObjectId() : (u._id as ObjectId);
    if (idTaken) map.set((u._id as ObjectId).toHexString(), _id);
    newUsers.push({ ...u, _id });
  }

  const counts = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length]));
  const result: RestoreResult = {
    organization: file.organization,
    backupCreatedAt: file.createdAt,
    signatureValid,
    replacedExisting: !!existing && !opts.dryRun,
    existsInDatabase: !!existing,
    usersCreated: newUsers.length,
    usersMatchedByEmail: matched,
    counts,
    dryRun: !!opts.dryRun,
  };
  if (opts.dryRun) return result;

  if (existing) await deleteMandalData(org._id as ObjectId);
  if (newUsers.length) {
    // nobody knows this password: "Forgot password" sets a real one
    const passwordHash = await hashPassword(randomBytes(32).toString("hex"));
    await c.users.insertMany(newUsers.map((u) => ({ ...u, passwordHash, isPlatformAdmin: false, sessionVersion: (u.sessionVersion as number) ?? 1 })) as never);
  }
  await c.organizations.insertOne(remapIds(org, map) as never);
  if (data.counters?.length) await c.counters.insertMany(data.counters as never);
  for (const name of ORG_COLLECTIONS) {
    const docs = data[name] ?? [];
    if (docs.length) await anyCol(c, name).insertMany(docs.map((d) => remapIds(d, map)));
  }
  await audit({ organizationId: org._id as ObjectId, actorId: opts.actorId ?? null, action: "organization.restore", entityType: "organization", entityId: org._id as ObjectId, reason: `Restored from the backup of ${file.createdAt}` });
  return result;
}

/** The text of an uploaded backup: as downloaded, or gzip-compressed (the platform panel compresses it). */
export function backupText(bytes: Uint8Array): string {
  const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? (() => {
    try {
      return gunzipSync(bytes, { maxOutputLength: 200 * 1024 * 1024 });
    } catch {
      throw new BackupError("The compressed backup file is damaged");
    }
  })() : bytes;
  return new TextDecoder("utf-8").decode(raw);
}

/** Everything of one Mandal (not its people's accounts): used before loading a backup over it. */
async function deleteMandalData(orgId: ObjectId) {
  const c = await cols();
  for (const name of ORG_COLLECTIONS) await anyCol(c, name).deleteMany({ organizationId: orgId });
  await c.counters.deleteMany({ _id: { $regex: `^${orgId.toHexString()}:` } });
  await c.organizations.deleteOne({ _id: orgId });
}
