import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { del, get, list, put } from "@vercel/blob";
import { BSON, type Collection, type Document } from "mongodb";
import { cols, COLLECTION_NAMES, ensureIndexes, resetIndexCache, type Collections } from "@/lib/collections";
import { env } from "@/config/env";
import { audit } from "@/lib/audit";
import { BackupError, ORG_COLLECTIONS, restoreMandalData, type RestoreResult } from "./backup.service";

/**
 * Nightly server backup: the WHOLE database (every Mandal, every user) in one encrypted file,
 * kept for 30 days in Vercel Blob — a copy outside MongoDB Atlas, so even if the cluster is
 * lost, deleted or its own snapshots are gone, everything can be loaded back
 * (scripts/restore-server-backup.ts: one Mandal, or everything).
 *
 *  - Taken by the daily cron (routes: /cron/daily) and on demand from the platform panel.
 *  - Encrypted with AES-256-GCM using BACKUP_ENCRYPTION_KEY (scrypt-derived, fresh salt + IV per
 *    file). GCM also proves the file wasn't changed. Without the key a file is useless — and
 *    unrestorable, so the key must be kept safe outside Vercel too.
 *  - Unlike a Mandal admin's download, this keeps password hashes and push tokens, so after a
 *    full restore people simply sign in again. Sign-in sessions and one-time tokens are left out.
 *
 * File: "MHSB1" | salt(16) | iv(12) | tag(16) | AES-GCM( gzip( NDJSON ) ). The first line is
 * { format, version, createdAt, counts }; then one { c: collection, d: document } per line
 * (MongoDB Extended JSON, so ids, dates and amounts come back exactly).
 */

export const SERVER_BACKUP_FORMAT = "mandalhisab-server-backup";
const MAGIC = Buffer.from("MHSB1");
const KEEP_DAYS = 30;
const PREFIX = "server-backups/";
/** Not worth keeping: people sign in again; links in old emails expire anyway. */
export const NOT_IN_SERVER_BACKUP: (keyof Collections)[] = ["sessions", "authTokens", "rateLimits"];

/* ------------------------------------------------------------------ where the files are kept */

export interface BackupItem {
  name: string;
  sizeBytes: number;
  uploadedAt: Date;
}
export interface BackupStore {
  put(name: string, bytes: Uint8Array): Promise<void>;
  list(): Promise<BackupItem[]>;
  get(name: string): Promise<Uint8Array | null>;
  del(name: string): Promise<void>;
}

/** Vercel Blob, private where the store allows it (the files are encrypted either way). */
class BlobBackupStore implements BackupStore {
  constructor(private token: string) {}
  async put(name: string, bytes: Uint8Array) {
    const body = Buffer.from(bytes);
    const opts = { contentType: "application/octet-stream", token: this.token, addRandomSuffix: false, allowOverwrite: true } as const;
    try {
      await put(PREFIX + name, body, { ...opts, access: "private" });
    } catch {
      await put(PREFIX + name, body, { ...opts, access: "public", addRandomSuffix: true });
    }
  }
  async list() {
    const out: BackupItem[] = [];
    let cursor: string | undefined;
    do {
      const r = await list({ prefix: PREFIX, token: this.token, cursor, limit: 1000 });
      for (const b of r.blobs) out.push({ name: b.pathname.slice(PREFIX.length), sizeBytes: b.size, uploadedAt: new Date(b.uploadedAt) });
      cursor = r.hasMore ? r.cursor : undefined;
    } while (cursor);
    return out.sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime());
  }
  async get(name: string) {
    for (const access of ["private", "public"] as const) {
      try {
        const r = await get(PREFIX + name, { access, token: this.token, useCache: false });
        if (r?.stream) return new Uint8Array(await new Response(r.stream).arrayBuffer());
      } catch {
        // try the other access level
      }
    }
    return null;
  }
  async del(name: string) {
    await del(PREFIX + name, { token: this.token });
  }
}

/** Kept in memory (tests, local development without a Blob token). */
export class MemoryBackupStore implements BackupStore {
  files = new Map<string, { bytes: Uint8Array; at: Date }>();
  async put(name: string, bytes: Uint8Array) {
    this.files.set(name, { bytes, at: new Date() });
  }
  async list() {
    return [...this.files.entries()].map(([name, f]) => ({ name, sizeBytes: f.bytes.length, uploadedAt: f.at })).sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime());
  }
  async get(name: string) {
    return this.files.get(name)?.bytes ?? null;
  }
  async del(name: string) {
    this.files.delete(name);
  }
}

let testStore: BackupStore | null | undefined;
export function setBackupStoreForTests(s: BackupStore | null | undefined) {
  testStore = s;
}
function store(): BackupStore | null {
  if (testStore !== undefined) return testStore;
  const t = env().BLOB_READ_WRITE_TOKEN;
  return t ? new BlobBackupStore(t) : null;
}
const keyText = () => env().BACKUP_ENCRYPTION_KEY ?? null;

/** Is the nightly backup set up (a key, and somewhere to keep the files)? */
export function serverBackupConfigured() {
  return !!keyText() && !!store();
}

/* ------------------------------------------------------------------ encrypt / decrypt */

function encrypt(plain: Buffer, key: string) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const k = scryptSync(key, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", k, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]);
}

function decrypt(file: Uint8Array, key: string) {
  const b = Buffer.from(file);
  if (b.length < MAGIC.length + 44 || !b.subarray(0, MAGIC.length).equals(MAGIC)) throw new BackupError("This isn't a MandalHisab server backup file");
  let at = MAGIC.length;
  const salt = b.subarray(at, (at += 16));
  const iv = b.subarray(at, (at += 12));
  const tag = b.subarray(at, (at += 16));
  const decipher = createDecipheriv("aes-256-gcm", scryptSync(key, salt, 32), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(b.subarray(at)), decipher.final()]);
  } catch {
    throw new BackupError("Can't open this backup: wrong BACKUP_ENCRYPTION_KEY, or the file was changed or damaged");
  }
}

/* ------------------------------------------------------------------ take a backup */

const anyCol = (c: Collections, name: keyof Collections) => c[name] as unknown as Collection<Document>;
const included = () => COLLECTION_NAMES.filter((n) => !NOT_IN_SERVER_BACKUP.includes(n));

/** The whole database as one encrypted file (not stored). */
export async function buildServerBackup(key: string, now = new Date()) {
  const c = await cols();
  const lines: string[] = [];
  const counts: Record<string, number> = {};
  for (const name of included()) {
    let n = 0;
    for await (const d of anyCol(c, name).find({})) {
      lines.push(JSON.stringify({ c: name, d: BSON.EJSON.serialize(d, { relaxed: false }) }));
      n++;
    }
    counts[name] = n;
  }
  const head = JSON.stringify({ format: SERVER_BACKUP_FORMAT, version: 1, createdAt: now.toISOString(), counts });
  const bytes = encrypt(gzipSync(Buffer.from([head, ...lines].join("\n"), "utf8")), key);
  return { bytes, counts, name: `mandalhisab-${now.toISOString().slice(0, 19).replace(/:/g, "-")}Z.mhsb` };
}

/** Take tonight's backup and delete the ones older than 30 days. */
export async function runServerBackup(now = new Date(), actorId: import("mongodb").ObjectId | null = null) {
  const key = keyText();
  const s = store();
  if (!key || !s) return { skipped: true as const, reason: !key ? "BACKUP_ENCRYPTION_KEY is not set" : "No file storage (BLOB_READ_WRITE_TOKEN) is set" };
  const b = await buildServerBackup(key, now);
  await s.put(b.name, b.bytes);
  const cutoff = now.getTime() - KEEP_DAYS * 86_400_000;
  let deleted = 0;
  for (const f of await s.list()) {
    if (f.uploadedAt.getTime() < cutoff && f.name !== b.name) {
      await s.del(f.name);
      deleted++;
    }
  }
  await audit({ organizationId: null, actorId, action: "platform.server_backup", entityType: "database", entityId: b.name, after: { sizeBytes: b.bytes.length, records: Object.values(b.counts).reduce((x, y) => x + y, 0), deletedOld: deleted } });
  return { skipped: false as const, name: b.name, sizeBytes: b.bytes.length, counts: b.counts, deletedOld: deleted };
}

export async function listServerBackups() {
  const s = store();
  const items = s && keyText() ? await s.list() : [];
  // the nightly job missed a night (or none taken yet)
  const stale = !items[0] || Date.now() - items[0].uploadedAt.getTime() > 36 * 3600_000;
  return { configured: serverBackupConfigured(), keepDays: KEEP_DAYS, stale, items };
}

/** The encrypted file, for the platform admin to download and keep elsewhere too. */
export async function downloadServerBackup(name: string) {
  const s = store();
  if (!s || !/^[\w.-]+\.mhsb$/.test(name)) return null;
  return s.get(name);
}

/* ------------------------------------------------------------------ restore */

/** Open a server backup with the key: its header and every collection's documents. */
export function readServerBackup(file: Uint8Array, key: string) {
  const text = gunzipSync(decrypt(file, key)).toString("utf8");
  const [headLine, ...rest] = text.split("\n");
  const head = JSON.parse(headLine) as { format: string; version: number; createdAt: string; counts: Record<string, number> };
  if (head.format !== SERVER_BACKUP_FORMAT) throw new BackupError("This isn't a MandalHisab server backup file");
  if (head.version !== 1) throw new BackupError(`Server backup version ${head.version} isn't supported`);
  const data: Record<string, Document[]> = {};
  for (const line of rest) {
    if (!line) continue;
    const { c, d } = JSON.parse(line) as { c: string; d: Document };
    (data[c] ??= []).push(BSON.EJSON.deserialize(d, { relaxed: false }) as Document);
  }
  return { head, data };
}

export interface ServerRestoreOptions {
  /** check the file and report, change nothing */
  dryRun?: boolean;
  /** restore only this Mandal (its join code) */
  mandalCode?: string;
  /** that Mandal is still in the database: replace it */
  replace?: boolean;
  /** restore EVERYTHING over a database that isn't empty (deletes what's there first) */
  replaceAll?: boolean;
}

/** Load a server backup back: one Mandal (`mandalCode`), or the whole database into an empty one. */
export async function restoreServerBackup(file: Uint8Array, key: string, opts: ServerRestoreOptions = {}): Promise<{ createdAt: string; counts: Record<string, number>; dryRun: boolean; mandal?: RestoreResult }> {
  const { head, data } = readServerBackup(file, key);
  if (opts.mandalCode) {
    const org = (data.organizations ?? []).find((o) => String(o.code).toUpperCase() === opts.mandalCode!.toUpperCase());
    if (!org) throw new BackupError(`No Mandal with join code ${opts.mandalCode} in this backup`);
    const id = String(org._id);
    const mine: Record<string, Document[]> = { organizations: [org] };
    for (const n of ORG_COLLECTIONS) mine[n] = (data[n] ?? []).filter((d) => String(d.organizationId) === id);
    mine.counters = (data.counters ?? []).filter((d) => String(d._id).startsWith(`${id}:`));
    const userIds = new Set([String(org.createdBy), ...mine.organizationMemberships.map((m) => String(m.userId))]);
    mine.users = (data.users ?? []).filter((u) => userIds.has(String(u._id)));
    const r = await restoreMandalData({ organization: { id, name: String(org.name), code: String(org.code) }, createdAt: head.createdAt, signatureValid: true }, mine, { dryRun: opts.dryRun, replace: opts.replace, keepPasswords: true });
    return { createdAt: head.createdAt, counts: r.counts, dryRun: !!opts.dryRun, mandal: r };
  }
  // everything (a brand-new database may have no indexes yet: make sure they exist)
  resetIndexCache();
  await ensureIndexes();
  const c = await cols();
  const existing = await c.organizations.countDocuments();
  if (existing > 0 && !opts.replaceAll) throw new BackupError(`The database already has ${existing} Mandal(s). Restore one with --mandal <join code>, or everything with --replace-all (deletes what's there first).`);
  if (opts.dryRun) return { createdAt: head.createdAt, counts: head.counts, dryRun: true };
  for (const name of included()) {
    const col = anyCol(c, name);
    if (opts.replaceAll) await col.deleteMany({});
    const docs = data[name] ?? [];
    for (let i = 0; i < docs.length; i += 1000) await col.insertMany(docs.slice(i, i + 1000), { ordered: false });
  }
  await audit({ organizationId: null, actorId: null, action: "platform.server_restore", entityType: "database", reason: `Restored the whole database from the server backup of ${head.createdAt}` });
  return { createdAt: head.createdAt, counts: head.counts, dryRun: false };
}
