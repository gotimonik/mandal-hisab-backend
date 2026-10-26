import { put } from "@vercel/blob";
import { randomBytes } from "node:crypto";
import { env } from "@/config/env";
import { AppError, badRequest } from "@/lib/errors";
import type { OrgContext } from "@/lib/auth";
import type { AttachmentRef } from "@/types/models";

const ALLOWED: Record<string, { ext: string; magic: (b: Uint8Array) => boolean }> = {
  "application/pdf": { ext: "pdf", magic: (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 },
  "image/png": { ext: "png", magic: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  "image/jpeg": { ext: "jpg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  "image/webp": { ext: "webp", magic: (b) => b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
};

export interface StorageProvider {
  put(path: string, data: Uint8Array, contentType: string): Promise<string>;
}

class VercelBlobStorage implements StorageProvider {
  constructor(private token: string) {}
  async put(path: string, data: Uint8Array, contentType: string) {
    const res = await put(path, Buffer.from(data), { access: "public", contentType, token: this.token, addRandomSuffix: false });
    return res.url;
  }
}

export function storage(): StorageProvider | null {
  const t = env().BLOB_READ_WRITE_TOKEN;
  return t ? new VercelBlobStorage(t) : null;
}

/**
 * Validate and store a receipt / invoice attachment. Files are validated by size,
 * declared type AND magic bytes, then stored under an unguessable per-org path.
 * No filesystem persistence (Vercel functions are ephemeral).
 */
export async function uploadAttachment(ctx: OrgContext, file: File): Promise<AttachmentRef> {
  const s = storage();
  if (!s) throw new AppError("BAD_REQUEST", "File uploads are not configured on this server (set BLOB_READ_WRITE_TOKEN)");
  const max = env().MAX_UPLOAD_BYTES;
  if (file.size === 0) throw badRequest("The file is empty");
  if (file.size > max) throw badRequest(`Files must be smaller than ${Math.round(max / 1024 / 1024)} MB`);
  const spec = ALLOWED[file.type];
  if (!spec) throw badRequest("Only PDF, PNG, JPEG or WEBP files are allowed");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!spec.magic(bytes)) throw badRequest("The file content does not match its type");
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || `file.${spec.ext}`;
  const path = `orgs/${ctx.orgId.toHexString()}/${new Date().toISOString().slice(0, 7)}/${randomBytes(16).toString("hex")}.${spec.ext}`;
  const url = await s.put(path, bytes, file.type);
  return { url, name: safeName, contentType: file.type, size: file.size };
}
