import { ObjectId, type AnyBulkWriteOperation } from "mongodb";
import { z } from "zod";
import { cols } from "@/lib/collections";
import { badRequest, notFound } from "@/lib/errors";
import { formatDateOnly, todayIn } from "@/lib/dates";
import type { AuthContext } from "@/lib/auth";
import type { PersonalEntryDoc } from "@/types/models";
import { dateOnly, objectId } from "@/validators/common";
import { FUND_LOANS, LOANS_RECEIVABLE, MEMBER_FUNDS, UPAD_ADVANCE } from "./ledger.service";

/**
 * Personal Hisab ⇄ the person's Mandals (opt-in). Every Mandal transaction tagged with the
 * person's own member record becomes an entry in their book:
 *
 *  - the cash effect for the person is the opposite of the Mandal's cash change
 *    (the Mandal's cash goes up ₹500 when they pay hapta → their wallet goes down ₹500);
 *  - what goes back into their OWN savings / upad / loan balance only moves money ("in" / "out");
 *    the rest of a payment is real spending (upad interest, late fees, hapta in a Mandal whose
 *    hapta is its income), recorded as "expense";
 *  - reversed transactions drop out, so the personal entry disappears with them.
 *
 * Pull-based: the book is brought up to date when the person opens Personal Hisab (throttled),
 * so no Mandal screen needs to know about it. Only Mandals in rupees are copied (the book is in ₹).
 */

const TZ = "Asia/Kolkata";
const THROTTLE_MS = 15_000;
const SPEND_CATEGORY: Record<string, string> = {
  hapta_collection: "savings",
  other_income: "savings",
  member_joining: "savings",
  fund_loan_payment: "loan",
  loan_repayment: "loan",
};

interface Want {
  transactionId: ObjectId;
  organizationId: ObjectId;
  kind: string;
  part: "main" | "spend";
  type: PersonalEntryDoc["type"];
  amountPaise: number;
  date: Date;
  categoryKey?: string;
}

/** What one Mandal transaction means for the member's own pocket. */
async function wantedFor(organizationId: ObjectId, memberId: ObjectId, fromDate: Date): Promise<Want[]> {
  const c = await cols();
  const txns = await c.financialTransactions.find({ organizationId, memberId, date: { $gte: fromDate }, type: { $ne: "reversal" }, reversedBy: null }, { projection: { _id: 1, type: 1, date: 1 } }).toArray();
  if (!txns.length) return [];
  const lines = await c.ledgerEntries.find({ organizationId, transactionId: { $in: txns.map((t) => t._id) } }, { projection: { transactionId: 1, accountKey: 1, debitPaise: 1, creditPaise: 1, memberId: 1 } }).toArray();
  const byTxn = new Map<string, typeof lines>();
  for (const l of lines) {
    const k = l.transactionId.toHexString();
    byTxn.set(k, [...(byTxn.get(k) ?? []), l]);
  }
  const mine = (id?: ObjectId | null) => !id || id.equals(memberId);
  const out: Want[] = [];
  for (const t of txns) {
    const ls = byTxn.get(t._id.toHexString()) ?? [];
    // the Mandal's cash / bank change
    const cash = ls.filter((l) => l.accountKey.startsWith("fa:")).reduce((a, l) => a + l.debitPaise - l.creditPaise, 0);
    if (cash === 0) continue; // interest credited to savings, opening balances … (no money changed hands)
    const base = { transactionId: t._id, organizationId, kind: t.type, date: t.date };
    if (cash < 0) {
      // the member received money: upad, a loan, their own savings back — never income
      out.push({ ...base, part: "main", type: "in", amountPaise: -cash });
      continue;
    }
    // the member paid: what went back into their own savings / upad / loan just moved
    const ownBack = ls
      .filter(
        (l) =>
          l.creditPaise > 0 &&
          ((l.accountKey === MEMBER_FUNDS && l.memberId?.equals(memberId)) || ((l.accountKey === FUND_LOANS || l.accountKey === UPAD_ADVANCE) && mine(l.memberId)) || l.accountKey === LOANS_RECEIVABLE),
      )
      .reduce((a, l) => a + l.creditPaise, 0);
    const moved = Math.min(cash, ownBack);
    const spent = cash - moved;
    if (moved > 0) out.push({ ...base, part: "main", type: "out", amountPaise: moved });
    if (spent > 0) out.push({ ...base, part: "spend", type: "expense", amountPaise: spent, categoryKey: SPEND_CATEGORY[t.type] ?? "other" });
  }
  return out;
}

/** The person's member records in rupee Mandals. */
async function linkedMembers(userId: ObjectId) {
  const c = await cols();
  const members = await c.members.find({ userId }, { projection: { _id: 1, organizationId: 1, name: 1 } }).toArray();
  const orgs = await c.organizations.find({ _id: { $in: members.map((m) => m.organizationId) } }, { projection: { name: 1, settings: 1, status: 1 } }).toArray();
  return members
    .map((m) => ({ member: m, org: orgs.find((o) => o._id.equals(m.organizationId)) }))
    .filter((x) => x.org)
    .map((x) => ({ memberId: x.member._id, memberName: x.member.name, organizationId: x.org!._id, orgName: x.org!.name, currency: x.org!.settings?.currency ?? "INR" }));
}

/**
 * Bring the person's book up to date with their Mandals. Cheap enough to run on every visit;
 * throttled so a page that loads several things syncs once.
 */
export async function syncMandal(auth: AuthContext, opts: { force?: boolean } = {}) {
  const s = auth.user.personalMandalSync;
  if (!s?.enabled) return { synced: false as const };
  const c = await cols();
  const userId = auth.user._id;
  const now = new Date();
  if (!opts.force) {
    // claim this run (another request may be syncing right now)
    const claim = await c.users.updateOne({ _id: userId, $or: [{ personalMandalSyncedAt: null }, { personalMandalSyncedAt: { $exists: false } }, { personalMandalSyncedAt: { $lt: new Date(now.getTime() - THROTTLE_MS) } }] }, { $set: { personalMandalSyncedAt: now } });
    if (!claim.modifiedCount) return { synced: false as const };
  } else {
    await c.users.updateOne({ _id: userId }, { $set: { personalMandalSyncedAt: now } });
  }
  const [linked, wallets, categories] = await Promise.all([
    linkedMembers(userId),
    c.personalWallets.find({ userId }).sort({ isArchived: 1, createdAt: 1, _id: 1 }).toArray(),
    c.personalCategories.find({ userId, kind: "expense" }).toArray(),
  ]);
  const wallet = wallets.find((w) => s.walletId && w._id.equals(s.walletId) && !w.isArchived) ?? wallets.find((w) => !w.isArchived);
  if (!wallet) return { synced: false as const };
  const catByKey = new Map(categories.filter((k) => k.key && !k.isArchived).map((k) => [k.key!, k._id]));
  let added = 0;
  let removed = 0;
  for (const l of linked.filter((x) => x.currency === "INR")) {
    const want = await wantedFor(l.organizationId, l.memberId, s.fromDate);
    const ops: AnyBulkWriteOperation<PersonalEntryDoc>[] = want.map((w) => ({
      updateOne: {
        filter: { userId, "source.transactionId": w.transactionId, "source.part": w.part },
        update: {
          // the wallet and note are the person's to change; the rest follows the Mandal
          $set: { type: w.type, amountPaise: w.amountPaise, date: w.date, categoryId: w.categoryKey ? (catByKey.get(w.categoryKey) ?? null) : null, toWalletId: null, source: { organizationId: w.organizationId, transactionId: w.transactionId, kind: w.kind, part: w.part }, updatedAt: now },
          $setOnInsert: { _id: new ObjectId(), userId, walletId: wallet._id, idempotencyKey: `mandal-${w.transactionId.toHexString()}-${w.part}`, createdAt: now },
        },
        upsert: true,
      },
    }));
    if (ops.length) added += (await c.personalEntries.bulkWrite(ops, { ordered: false })).upsertedCount;
    // reversed in the Mandal, or before the start date now: gone from the book too
    const keep = want.map((w) => ({ "source.transactionId": w.transactionId, "source.part": w.part }));
    removed += (await c.personalEntries.deleteMany({ userId, "source.organizationId": l.organizationId, ...(keep.length ? { $nor: keep } : {}) })).deletedCount;
  }
  return { synced: true as const, added, removed };
}

/* ------------------------------------------------------------------ settings */

export async function getMandalSync(auth: AuthContext) {
  const s = auth.user.personalMandalSync;
  const c = await cols();
  const linked = await linkedMembers(auth.user._id);
  const counts = await c.personalEntries
    .aggregate<{ _id: ObjectId; n: number }>([{ $match: { userId: auth.user._id, "source.organizationId": { $exists: true } } }, { $group: { _id: "$source.organizationId", n: { $sum: 1 } } }])
    .toArray();
  return {
    enabled: !!s?.enabled,
    walletId: s?.walletId ?? null,
    fromDate: s?.fromDate ? formatDateOnly(s.fromDate) : null,
    mandals: linked.map((l) => ({ organizationId: l.organizationId, name: l.orgName, memberName: l.memberName, supported: l.currency === "INR", entries: counts.find((x) => x._id.equals(l.organizationId))?.n ?? 0 })),
  };
}

export const MandalSyncSchema = z.object({
  enabled: z.boolean(),
  walletId: objectId.optional().nullable(),
  fromDate: dateOnly.optional(),
});

/** Turn the sync on / off and choose the wallet and the start date. Turning it on syncs straight away. */
export async function updateMandalSync(auth: AuthContext, input: z.infer<typeof MandalSyncSchema>) {
  const c = await cols();
  const userId = auth.user._id;
  if (input.walletId && !(await c.personalWallets.findOne({ _id: input.walletId, userId, isArchived: false }))) throw notFound("Wallet");
  const today = todayIn(TZ);
  const fromDate = input.fromDate ?? auth.user.personalMandalSync?.fromDate ?? new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  if (fromDate.getTime() > today.getTime()) throw badRequest("The start date can't be in the future");
  const next = { enabled: input.enabled, walletId: input.walletId ?? auth.user.personalMandalSync?.walletId ?? null, fromDate };
  // a new wallet applies to entries copied from now on; move existing ones too
  if (input.walletId && auth.user.personalMandalSync?.walletId && !auth.user.personalMandalSync.walletId.equals(input.walletId)) {
    await c.personalEntries.updateMany({ userId, "source.transactionId": { $exists: true }, walletId: auth.user.personalMandalSync.walletId }, { $set: { walletId: input.walletId, updatedAt: new Date() } });
  }
  await c.users.updateOne({ _id: userId }, { $set: { personalMandalSync: next } });
  auth.user.personalMandalSync = next;
  const result = next.enabled ? await syncMandal(auth, { force: true }) : { synced: false as const };
  return { ...(await getMandalSync(auth)), result };
}
