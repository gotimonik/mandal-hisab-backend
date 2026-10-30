import { del, put } from "@vercel/blob";
import { randomBytes } from "node:crypto";
import { env } from "@/config/env";
import { AppError, badRequest } from "@/lib/errors";
import { audit } from "@/lib/audit";
import { cols } from "@/lib/collections";
import type { OrgContext } from "@/lib/auth";
import type { ApiRequest } from "@/lib/http";
import type { AttachmentRef } from "@/types/models";

const ALLOWED: Record<string, { ext: string; magic: (b: Uint8Array) => boolean }> = {
  "application/pdf": { ext: "pdf", magic: (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 },
  "image/png": { ext: "png", magic: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  "image/jpeg": { ext: "jpg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  "image/webp": { ext: "webp", magic: (b) => b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
};

export interface StorageProvider {
  put(path: string, data: Uint8Array, contentType: string): Promise<string>;
  del(url: string): Promise<void>;
}

class VercelBlobStorage implements StorageProvider {
  constructor(private token: string) {}
  async put(path: string, data: Uint8Array, contentType: string) {
    const res = await put(path, Buffer.from(data), { access: "public", contentType, token: this.token, addRandomSuffix: false });
    return res.url;
  }
  async del(url: string) {
    await del(url, { token: this.token });
  }
}

let testStorage: StorageProvider | null | undefined;
/** Tests only: swap the storage backend (undefined = back to Vercel Blob). */
export function setStorageForTests(s: StorageProvider | null | undefined) {
  testStorage = s;
}

export function storage(): StorageProvider | null {
  if (testStorage !== undefined) return testStorage;
  const t = env().BLOB_READ_WRITE_TOKEN;
  return t ? new VercelBlobStorage(t) : null;
}

function requireStorage(): StorageProvider {
  const s = storage();
  if (!s) throw new AppError("BAD_REQUEST", "File uploads are not configured on this server (set BLOB_READ_WRITE_TOKEN)");
  return s;
}

/** The `file` field of a multipart request, rejected early (by Content-Length) when too big. */
export async function formFile(req: ApiRequest, maxBytes: number, tooBig: string): Promise<File> {
  const ct = req.raw.headers.get("content-type") ?? "";
  if (!ct.includes("multipart/form-data")) throw badRequest("Use multipart/form-data with a 'file' field");
  const len = Number(req.raw.headers.get("content-length") ?? 0);
  if (len > maxBytes + 10_000) throw badRequest(tooBig);
  const form = await req.raw.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw badRequest("Missing file");
  return file;
}

/** Size, declared type AND magic bytes must all agree. */
async function readChecked(file: File, opts: { max: number; tooBig: string; types: string[]; wrongType: string }) {
  if (file.size === 0) throw badRequest("The file is empty");
  if (file.size > opts.max) throw badRequest(opts.tooBig);
  const spec = opts.types.includes(file.type) ? ALLOWED[file.type] : undefined;
  if (!spec) throw badRequest(opts.wrongType);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!spec.magic(bytes)) throw badRequest("The file content does not match its type");
  return { bytes, ext: spec.ext };
}

/**
 * Validate and store a receipt / invoice attachment. Files are validated by size,
 * declared type AND magic bytes, then stored under an unguessable per-org path.
 * No filesystem persistence (Vercel functions are ephemeral).
 */
export async function uploadAttachment(ctx: OrgContext, file: File): Promise<AttachmentRef> {
  const s = requireStorage();
  const max = env().MAX_UPLOAD_BYTES;
  const { bytes, ext } = await readChecked(file, {
    max,
    tooBig: `Files must be smaller than ${Math.round(max / 1024 / 1024)} MB`,
    types: Object.keys(ALLOWED),
    wrongType: "Only PDF, PNG, JPEG or WEBP files are allowed",
  });
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || `file.${ext}`;
  const path = `orgs/${ctx.orgId.toHexString()}/${new Date().toISOString().slice(0, 7)}/${randomBytes(16).toString("hex")}.${ext}`;
  const url = await s.put(path, bytes, file.type);
  return { url, name: safeName, contentType: file.type, size: file.size };
}

/* ------------------------------------------------------------------ Mandal logo */

export const LOGO_MAX_BYTES = 1024 * 1024;
export const LOGO_TOO_BIG = "The logo must be 1 MB or smaller";

const logoFolder = (ctx: OrgContext) => `/orgs/${ctx.orgId.toHexString()}/logo/`;

/** Delete the previous logo, but only if we stored it (not a URL someone typed in). Best effort. */
async function deleteStoredLogo(s: StorageProvider, ctx: OrgContext, url: string | null | undefined) {
  if (!url || !url.includes(logoFolder(ctx))) return;
  await s.del(url).catch((e) => console.warn("Could not delete the old logo", url, e));
}

/** Store a PNG / JPEG / WEBP logo (max 1 MB) in Vercel Blob and make it the Mandal's logo. */
export async function uploadOrgLogo(ctx: OrgContext, file: File) {
  const s = requireStorage();
  const { bytes, ext } = await readChecked(file, {
    max: LOGO_MAX_BYTES,
    tooBig: LOGO_TOO_BIG,
    types: ["image/png", "image/jpeg", "image/webp"],
    wrongType: "The logo must be a PNG, JPEG or WEBP image",
  });
  // a new name each time, so browsers and the receipt PDF never show a cached old logo
  const url = await s.put(`${logoFolder(ctx).slice(1)}${randomBytes(16).toString("hex")}.${ext}`, bytes, file.type);
  const c = await cols();
  await c.organizations.updateOne({ _id: ctx.orgId }, { $set: { logoUrl: url, updatedAt: new Date() } });
  await deleteStoredLogo(s, ctx, ctx.org.logoUrl);
  await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "organization.logo.update", entityType: "organization", entityId: ctx.orgId, before: { logoUrl: ctx.org.logoUrl ?? null }, after: { logoUrl: url } });
  return { logoUrl: url };
}

export async function removeOrgLogo(ctx: OrgContext) {
  const c = await cols();
  await c.organizations.updateOne({ _id: ctx.orgId }, { $unset: { logoUrl: "" }, $set: { updatedAt: new Date() } });
  const s = storage();
  if (s) await deleteStoredLogo(s, ctx, ctx.org.logoUrl);
  await audit({ organizationId: ctx.orgId, actorId: ctx.user._id, action: "organization.logo.remove", entityType: "organization", entityId: ctx.orgId, before: { logoUrl: ctx.org.logoUrl ?? null }, after: { logoUrl: null } });
  return { logoUrl: null };
}
