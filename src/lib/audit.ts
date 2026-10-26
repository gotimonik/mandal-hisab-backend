import { ObjectId, type ClientSession } from "mongodb";
import { cols } from "./collections";
import type { AuditLogDoc } from "@/types/models";

export interface AuditInput {
  organizationId?: ObjectId | null;
  actorId?: ObjectId | null;
  action: string;
  entityType: string;
  entityId?: ObjectId | string | null;
  before?: unknown;
  after?: unknown;
  reason?: string;
  ip?: string;
}

/** Append-only audit log. Pass `session` to make the entry part of a transaction. */
export async function audit(input: AuditInput, session?: ClientSession): Promise<void> {
  const c = await cols();
  const doc: AuditLogDoc = {
    _id: new ObjectId(),
    organizationId: input.organizationId ?? null,
    actorId: input.actorId ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    before: sanitize(input.before),
    after: sanitize(input.after),
    reason: input.reason,
    ip: input.ip,
    createdAt: new Date(),
  };
  await c.auditLogs.insertOne(doc, { session });
}

const SECRET_KEYS = new Set(["passwordHash", "password", "tokenHash", "token"]);

function sanitize(v: unknown): unknown {
  if (v === undefined || v === null) return v;
  if (Array.isArray(v)) return v.map(sanitize);
  if (v instanceof Date || v instanceof ObjectId) return v;
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (SECRET_KEYS.has(k)) continue;
      out[k] = sanitize(val);
    }
    return out;
  }
  return v;
}
