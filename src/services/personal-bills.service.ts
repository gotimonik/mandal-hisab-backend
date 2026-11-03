import { ObjectId, type ClientSession } from "mongodb";
import { cols } from "@/lib/collections";
import { env } from "@/config/env";
import { AppError, badRequest, notFound } from "@/lib/errors";
import { formatDateOnly, parseDateOnly, todayIn, utcAddDays } from "@/lib/dates";
import { paiseToRupeeString } from "@/lib/money";
import type { AuthContext } from "@/lib/auth";
import type { PersonalBillDoc, PersonalBillReading, PersonalBillRef } from "@/types/models";
import { readStoredFile, storage, storePersonalBill } from "./upload.service";
import { BillReaderError, billReader, MAX_READ_IMAGE_BYTES, type RawBillReading } from "./bill-reader.service";
import { ensureSetup } from "./personal.service";

/**
 * Personal Hisab bills: the person scans a bill, we keep the file and read the total, date and
 * shop off it, and the app fills in the "Add spending" form for them to check and save. A few a
 * month per person (PERSONAL_BILLS_PER_MONTH), 5 MB each. Like the rest of Personal Hisab, every
 * query filters by the owner's userId — a bill can only ever be seen by the person who scanned it.
 */

const TZ = "Asia/Kolkata";
const own = (auth: AuthContext) => auth.user._id;
const thisMonth = () => formatDateOnly(todayIn(TZ)).slice(0, 7);

/** Scanned but never saved with an entry for this long → removed by the daily job. */
const ORPHAN_AFTER_MS = 24 * 60 * 60 * 1000;

export const billRefOut = (b: PersonalBillRef | null | undefined) => (b ? { _id: b.billId, name: b.name, contentType: b.contentType, size: b.size } : null);

/** How many bills this person has scanned this month, and how many they may. */
export async function billUsage(auth: AuthContext) {
  const c = await cols();
  const month = thisMonth();
  const used = await c.personalBills.countDocuments({ userId: own(auth), month, notCounted: { $ne: true } });
  const limit = env().PERSONAL_BILLS_PER_MONTH;
  return { month, used, limit, left: Math.max(0, limit - used), reads: billReader() !== null };
}

/** Turn what the reader saw into safe values: real dates, sensible amounts, this person's categories. */
function clean(raw: RawBillReading, categoryKinds: Map<string, "expense" | "income">): PersonalBillReading {
  const today = todayIn(TZ);
  let date: string | null = null;
  if (raw.date && /^\d{4}-\d{2}-\d{2}$/.test(raw.date)) {
    try {
      const d = parseDateOnly(raw.date);
      // a bill from the future, or years ago, is a misread
      if (d.getTime() <= utcAddDays(today, 1).getTime() && d.getTime() >= utcAddDays(today, -730).getTime()) date = formatDateOnly(d);
    } catch {
      /* not a real date */
    }
  }
  const paise = raw.amount !== null && Number.isFinite(raw.amount) ? Math.round(raw.amount * 100) : null;
  const amountPaise = paise !== null && paise > 0 && paise <= 1_000_000_000 ? paise : null;
  const kind = raw.categoryId ? categoryKinds.get(raw.categoryId) : undefined;
  const categoryId = kind === raw.type && raw.categoryId ? new ObjectId(raw.categoryId) : null;
  const merchant = raw.merchant?.replace(/\s+/g, " ").trim().slice(0, 80) || null;
  return { isBill: raw.isBill, amountPaise: raw.isBill ? amountPaise : null, date: raw.isBill ? date : null, merchant: raw.isBill ? merchant : null, type: raw.type, categoryId: raw.isBill ? categoryId : null, walletKind: raw.isBill ? raw.walletKind : null };
}

export const readingOut = (r: PersonalBillReading | null) =>
  r ? { isBill: r.isBill, amount: r.amountPaise !== null ? paiseToRupeeString(r.amountPaise) : null, amountPaise: r.amountPaise, date: r.date, merchant: r.merchant, type: r.type, categoryId: r.categoryId, walletKind: r.walletKind } : null;

/** Upload → keep → read. Counts towards this month's limit once the file is stored. */
export async function scanBill(auth: AuthContext, file: File) {
  await ensureSetup(auth);
  const usage = await billUsage(auth);
  if (usage.left <= 0) {
    throw new AppError("RATE_LIMITED", `You've used all ${usage.limit} bill scans for this month. You can scan more from the 1st of next month.`, { code: "BILL_LIMIT", limit: usage.limit });
  }
  const c = await cols();
  const userId = own(auth);
  const stored = await storePersonalBill(userId, usage.month, file);
  const now = new Date();
  const doc: PersonalBillDoc = { _id: new ObjectId(), userId, month: usage.month, url: stored.url, name: stored.name, contentType: stored.contentType, size: stored.size, entryId: null, reading: null, createdAt: now, updatedAt: now };
  await c.personalBills.insertOne(doc);

  let readError: string | null = null;
  const reader = billReader();
  if (reader && !(stored.contentType !== "application/pdf" && stored.bytes.length > MAX_READ_IMAGE_BYTES)) {
    try {
      const cats = await c.personalCategories.find({ userId, isArchived: false }, { projection: { kind: 1, name: 1 } }).toArray();
      const raw = await reader({ bytes: stored.bytes, contentType: stored.contentType, categories: cats.map((k) => ({ id: k._id.toHexString(), kind: k.kind, name: k.name })), today: formatDateOnly(todayIn(TZ)) });
      doc.reading = clean(raw, new Map(cats.map((k) => [k._id.toHexString(), k.kind])));
      await c.personalBills.updateOne({ _id: doc._id }, { $set: { reading: doc.reading, updatedAt: new Date() } });
    } catch (e) {
      if (!(e instanceof BillReaderError)) throw e;
      console.error("[bill-reader]", e.message);
      readError = "unavailable";
      // our problem, not theirs: this one doesn't use up a scan
      await c.personalBills.updateOne({ _id: doc._id }, { $set: { notCounted: true, updatedAt: new Date() } });
    }
  } else if (reader) readError = "too_big";
  else readError = "off";

  return {
    bill: { _id: doc._id, name: doc.name, contentType: doc.contentType, size: doc.size },
    reading: readingOut(doc.reading),
    readError,
    usage: await billUsage(auth),
  };
}

/** The bill file itself, for the owner only. */
export async function billFile(auth: AuthContext, id: ObjectId): Promise<Response> {
  const c = await cols();
  const b = await c.personalBills.findOne({ _id: id, userId: own(auth), url: { $type: "string" } });
  if (!b?.url) throw notFound("Bill");
  const bytes = await readStoredFile(b.url);
  return new Response(Buffer.from(bytes), {
    status: 200,
    headers: {
      "Content-Type": b.contentType,
      "Content-Disposition": `inline; filename="${b.name.replace(/[^a-zA-Z0-9._-]/g, "_")}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** Delete the file and keep a slim record (so it still counts towards the month). */
async function discard(b: Pick<PersonalBillDoc, "_id" | "url">) {
  const c = await cols();
  await c.personalBills.updateOne({ _id: b._id }, { $set: { url: null, entryId: null, deletedAt: new Date(), updatedAt: new Date() } });
  const s = storage();
  if (b.url && s) await s.del(b.url).catch((e) => console.warn("[bills] could not delete", b._id.toHexString(), e));
}

/** Remove a scanned bill that isn't on any entry (the person cancelled or removed it). */
export async function deleteBill(auth: AuthContext, id: ObjectId) {
  const c = await cols();
  const b = await c.personalBills.findOne({ _id: id, userId: own(auth), deletedAt: null });
  if (!b) throw notFound("Bill");
  if (b.entryId) throw badRequest("This bill is on an entry. Open the entry to remove it");
  await discard(b);
  return { ok: true };
}

/** For an entry being saved: check the bill is this person's and free (or already on this entry). */
export async function claimBill(userId: ObjectId, billId: ObjectId, entryId: ObjectId, session?: ClientSession): Promise<PersonalBillRef> {
  const c = await cols();
  const b = await c.personalBills.findOne({ _id: billId, userId, url: { $type: "string" } }, { session });
  if (!b) throw notFound("Bill");
  if (b.entryId && !b.entryId.equals(entryId)) throw badRequest("This bill is already on another entry");
  await c.personalBills.updateOne({ _id: b._id }, { $set: { entryId, updatedAt: new Date() } }, { session });
  return { billId: b._id, name: b.name, contentType: b.contentType, size: b.size };
}

/** The entry no longer has this bill (removed from it, replaced, or the entry was deleted). */
export async function releaseBill(userId: ObjectId, billId: ObjectId) {
  const c = await cols();
  const b = await c.personalBills.findOne({ _id: billId, userId });
  if (b && !b.deletedAt) await discard(b);
}

/** Daily: bills scanned but never saved with an entry. */
export async function cleanupOrphanBills(now = new Date()) {
  const c = await cols();
  const old = await c.personalBills
    .find({ entryId: null, deletedAt: null, createdAt: { $lt: new Date(now.getTime() - ORPHAN_AFTER_MS) } }, { projection: { url: 1 } })
    .limit(500)
    .toArray();
  for (const b of old) await discard(b);
  return { billsRemoved: old.length };
}
