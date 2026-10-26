import { ObjectId, type ClientSession } from "mongodb";
import { cols } from "@/lib/collections";
import { notFound } from "@/lib/errors";
import type { OrgContext } from "@/lib/auth";
import type { OrganizationDoc, ReceiptDoc } from "@/types/models";
import { fyNumber } from "./ledger.service";

export interface ReceiptInput {
  sourceType: ReceiptDoc["sourceType"];
  sourceId: ObjectId;
  memberId?: ObjectId | null;
  payerName: string;
  amountPaise: number;
  date: Date;
  method: string;
  reference?: string;
  lines: { description: string; amountPaise: number }[];
  issuedBy: ObjectId;
}

/**
 * Issue a receipt with a gap-free, per-financial-year number (e.g. RCPT/2026-27/000042).
 * One receipt per source document (unique index), so retries cannot duplicate.
 */
export async function issueReceipt(
  org: Pick<OrganizationDoc, "_id" | "settings">,
  input: ReceiptInput,
  session: ClientSession,
): Promise<ReceiptDoc> {
  const c = await cols();
  const existing = await c.receipts.findOne({ organizationId: org._id, sourceType: input.sourceType, sourceId: input.sourceId }, { session });
  if (existing) return existing;
  const doc: ReceiptDoc = {
    _id: new ObjectId(),
    organizationId: org._id,
    receiptNumber: await fyNumber(org, org.settings.receiptPrefix || "RCPT", input.date, session),
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    memberId: input.memberId ?? null,
    payerName: input.payerName,
    amountPaise: input.amountPaise,
    date: input.date,
    method: input.method,
    reference: input.reference,
    lines: input.lines,
    issuedBy: input.issuedBy,
    issuedAt: new Date(),
    status: "valid",
  };
  await c.receipts.insertOne(doc, { session });
  return doc;
}

export async function cancelReceiptFor(orgId: ObjectId, sourceType: ReceiptDoc["sourceType"], sourceId: ObjectId, session: ClientSession) {
  const c = await cols();
  await c.receipts.updateOne({ organizationId: orgId, sourceType, sourceId }, { $set: { status: "cancelled" } }, { session });
}

/** Receipt with organization letterhead details, for printing / PDF. */
export async function getReceipt(ctx: OrgContext, id: ObjectId, restrictMemberId?: ObjectId | null) {
  const c = await cols();
  const r = await c.receipts.findOne({ _id: id, organizationId: ctx.orgId });
  if (!r) throw notFound("Receipt");
  if (restrictMemberId !== undefined && (!restrictMemberId || !r.memberId?.equals(restrictMemberId))) throw notFound("Receipt");
  const issuer = await c.users.findOne({ _id: r.issuedBy }, { projection: { name: 1 } });
  const member = r.memberId ? await c.members.findOne({ _id: r.memberId }, { projection: { name: 1, membershipNumber: 1 } }) : null;
  return {
    receipt: r,
    issuedByName: issuer?.name ?? null,
    member,
    organization: {
      name: ctx.org.name,
      address: [ctx.org.address, ctx.org.city, ctx.org.state, ctx.org.pincode].filter(Boolean).join(", "),
      contactPhone: ctx.org.contactPhone ?? null,
      contactEmail: ctx.org.contactEmail ?? null,
      registrationNumber: ctx.org.registrationNumber ?? null,
      logoUrl: ctx.org.logoUrl ?? null,
    },
  };
}

export async function listReceipts(ctx: OrgContext, memberId?: ObjectId, limit = 100) {
  const c = await cols();
  const q: Record<string, unknown> = { organizationId: ctx.orgId };
  if (memberId) q.memberId = memberId;
  return c.receipts.find(q).sort({ date: -1, _id: -1 }).limit(limit).toArray();
}
