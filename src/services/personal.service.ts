import { ObjectId, type Filter } from "mongodb";
import { z } from "zod";
import { cols } from "@/lib/collections";
import { badRequest, conflict, isDuplicateKeyError, notFound } from "@/lib/errors";
import { formatDateOnly, parseDateOnly, todayIn, utcAddDays, utcAddMonths } from "@/lib/dates";
import { paiseToRupeeString } from "@/lib/money";
import type { AuthContext } from "@/lib/auth";
import type { PersonalCategoryDoc, PersonalEntryDoc, PersonalWalletDoc } from "@/types/models";
import { dateOnly, idempotencyKey, money, objectId, optText } from "@/validators/common";
import { notify } from "./notification.service";
import { syncMandal } from "./personal-mandal.service";
import { copy } from "./notification-copy";

/**
 * Personal Hisab — a person's own money book (daily income, spending, wallets, budgets).
 *
 * Privacy: every record carries the owner's userId and EVERY query here filters by it. Nothing
 * has an organizationId, so no Mandal screen, Mandal backup or Mandal role can ever reach it.
 * Someone else's id is answered with 404, the same as an id that doesn't exist.
 */

const TZ = "Asia/Kolkata";

export const WALLET_KINDS = ["cash", "bank", "upi", "card", "other"] as const;
export const TONES = ["indigo", "orange", "amber", "rose", "emerald", "sky", "violet", "pink", "slate"] as const;

/** Starter wallets and categories, made on the first visit. `key` lets the app translate them. */
const STARTER_WALLETS: { key: string; name: string; kind: (typeof WALLET_KINDS)[number] }[] = [
  { key: "cash", name: "Cash", kind: "cash" },
  { key: "bank", name: "Bank / UPI", kind: "bank" },
];
const STARTER_CATEGORIES: { kind: "expense" | "income"; key: string; name: string; tone: (typeof TONES)[number]; icon: string }[] = [
  { kind: "expense", key: "food", name: "Food & dining", tone: "orange", icon: "utensils" },
  { kind: "expense", key: "groceries", name: "Groceries", tone: "emerald", icon: "shopping-cart" },
  { kind: "expense", key: "transport", name: "Travel & fuel", tone: "sky", icon: "fuel" },
  { kind: "expense", key: "bills", name: "Bills & recharge", tone: "violet", icon: "receipt" },
  { kind: "expense", key: "home", name: "Rent & home", tone: "indigo", icon: "house" },
  { kind: "expense", key: "shopping", name: "Shopping", tone: "pink", icon: "shopping-bag" },
  { kind: "expense", key: "health", name: "Health & medicine", tone: "rose", icon: "heart-pulse" },
  { kind: "expense", key: "education", name: "Education", tone: "sky", icon: "graduation-cap" },
  { kind: "expense", key: "family", name: "Family & gifts", tone: "amber", icon: "gift" },
  { kind: "expense", key: "festival", name: "Festivals & religious", tone: "orange", icon: "sparkles" },
  { kind: "expense", key: "savings", name: "Mandal hapta & savings", tone: "emerald", icon: "hand-coins" },
  { kind: "expense", key: "loan", name: "Loan & EMI", tone: "slate", icon: "landmark" },
  { kind: "expense", key: "other", name: "Other expense", tone: "slate", icon: "circle-ellipsis" },
  { kind: "income", key: "salary", name: "Salary", tone: "emerald", icon: "briefcase" },
  { kind: "income", key: "business", name: "Business", tone: "indigo", icon: "store" },
  { kind: "income", key: "interest", name: "Interest", tone: "violet", icon: "percent" },
  { kind: "income", key: "gift", name: "Gifts received", tone: "pink", icon: "gift" },
  { kind: "income", key: "refund", name: "Refund", tone: "sky", icon: "undo" },
  { kind: "income", key: "other_income", name: "Other income", tone: "slate", icon: "coins" },
];

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const own = (auth: AuthContext) => auth.user._id;

/* ------------------------------------------------------------------ first visit */

/** Make the starter wallets and categories once per person. Safe to call on every request. */
export async function ensureSetup(auth: AuthContext) {
  if (auth.user.personalSetupAt) return;
  const c = await cols();
  const userId = own(auth);
  const now = new Date();
  const ignoreDup = (e: unknown) => {
    if (!isDuplicateKeyError(e)) throw e;
  };
  // only if they have none yet (a second request racing this one is stopped by the unique indexes)
  if ((await c.personalWallets.countDocuments({ userId }, { limit: 1 })) === 0) {
    await c.personalWallets
      .insertMany(
        STARTER_WALLETS.map((w) => ({ _id: new ObjectId(), userId, ...w, openingBalancePaise: 0, isArchived: false, createdAt: now, updatedAt: now })),
        { ordered: false },
      )
      .catch(ignoreDup);
  }
  if ((await c.personalCategories.countDocuments({ userId }, { limit: 1 })) === 0) {
    await c.personalCategories
      .insertMany(
        STARTER_CATEGORIES.map((k) => ({ _id: new ObjectId(), userId, ...k, monthlyBudgetPaise: null, isArchived: false, createdAt: now, updatedAt: now })),
        { ordered: false },
      )
      .catch(ignoreDup);
  }
  await c.users.updateOne({ _id: userId, personalSetupAt: { $exists: false } }, { $set: { personalSetupAt: now } });
  auth.user.personalSetupAt = now;
}

/* ------------------------------------------------------------------ shared lookups */

async function loadBook(userId: ObjectId) {
  const c = await cols();
  const [wallets, categories, orgIds] = await Promise.all([
    c.personalWallets.find({ userId }).sort({ isArchived: 1, createdAt: 1, _id: 1 }).toArray(),
    c.personalCategories.find({ userId }).sort({ kind: 1, isArchived: 1, createdAt: 1, _id: 1 }).toArray(),
    c.personalEntries.distinct("source.organizationId", { userId, "source.organizationId": { $exists: true } }),
  ]);
  const orgs = orgIds.length ? await c.organizations.find({ _id: { $in: orgIds as ObjectId[] } }, { projection: { name: 1 } }).toArray() : [];
  return {
    wallets,
    categories,
    walletById: new Map(wallets.map((w) => [w._id.toHexString(), w])),
    categoryById: new Map(categories.map((k) => [k._id.toHexString(), k])),
    orgName: new Map(orgs.map((o) => [o._id.toHexString(), o.name])),
  };
}
type Book = Awaited<ReturnType<typeof loadBook>>;

const walletOut = (w: PersonalWalletDoc) => ({ _id: w._id, name: w.name, key: w.key ?? null, kind: w.kind, isArchived: w.isArchived });
const categoryOut = (k: PersonalCategoryDoc) => ({ _id: k._id, kind: k.kind, name: k.name, key: k.key ?? null, tone: k.tone, icon: k.icon ?? null, monthlyBudgetPaise: k.monthlyBudgetPaise ?? null, isArchived: k.isArchived });

function entryOut(e: PersonalEntryDoc, book: Book) {
  const w = book.walletById.get(e.walletId.toHexString());
  const tw = e.toWalletId ? book.walletById.get(e.toWalletId.toHexString()) : undefined;
  const k = e.categoryId ? book.categoryById.get(e.categoryId.toHexString()) : undefined;
  return {
    _id: e._id,
    type: e.type,
    amountPaise: e.amountPaise,
    date: formatDateOnly(e.date),
    note: e.note ?? null,
    wallet: w ? walletOut(w) : null,
    toWallet: tw ? walletOut(tw) : null,
    category: k ? categoryOut(k) : null,
    /** copied from a Mandal (read-only except wallet and note) */
    mandal: e.source ? { organizationId: e.source.organizationId, name: book.orgName.get(e.source.organizationId.toHexString()) ?? null, kind: e.source.kind, part: e.source.part } : null,
    createdAt: e.createdAt,
  };
}

/** Balance of every wallet: opening + income − spending − sent + received. */
async function walletBalances(userId: ObjectId, wallets: PersonalWalletDoc[]) {
  const c = await cols();
  const [outs, ins] = await Promise.all([
    c.personalEntries
      .aggregate<{ _id: ObjectId; net: number; n: number }>([
        { $match: { userId } },
        { $group: { _id: "$walletId", net: { $sum: { $cond: [{ $in: ["$type", ["income", "in"]] }, "$amountPaise", { $multiply: ["$amountPaise", -1] }] } }, n: { $sum: 1 } } },
      ])
      .toArray(),
    c.personalEntries
      .aggregate<{ _id: ObjectId; net: number; n: number }>([
        { $match: { userId, type: "transfer", toWalletId: { $type: "objectId" } } },
        { $group: { _id: "$toWalletId", net: { $sum: "$amountPaise" }, n: { $sum: 1 } } },
      ])
      .toArray(),
  ]);
  const net = new Map<string, number>();
  const count = new Map<string, number>();
  for (const r of [...outs, ...ins]) {
    const id = r._id.toHexString();
    net.set(id, (net.get(id) ?? 0) + r.net);
    count.set(id, (count.get(id) ?? 0) + r.n);
  }
  return wallets.map((w) => ({
    ...walletOut(w),
    openingBalancePaise: w.openingBalancePaise,
    balancePaise: w.openingBalancePaise + (net.get(w._id.toHexString()) ?? 0),
    entryCount: count.get(w._id.toHexString()) ?? 0,
  }));
}

/* ------------------------------------------------------------------ budget alerts */

/**
 * After spending is saved: push once when this month's spending reaches 80 % of a budget, and
 * once when it goes over (per category and overall, per month). Only for the current month;
 * the person can turn these off on the Budgets page.
 */
async function budgetAlerts(auth: AuthContext, date: Date, categoryId: ObjectId | null | undefined) {
  if (auth.user.personalBudgetAlerts === false) return;
  const today = todayIn(TZ);
  const month = formatDateOnly(today).slice(0, 7);
  if (formatDateOnly(date).slice(0, 7) !== month) return;
  const c = await cols();
  const userId = own(auth);
  const { start, end } = monthRange(month);
  const spentWhere = async (extra: Filter<PersonalEntryDoc>) =>
    (await c.personalEntries.aggregate<{ t: number }>([{ $match: { userId, type: "expense", date: { $gte: start, $lte: end }, ...extra } }, { $group: { _id: null, t: { $sum: "$amountPaise" } } }]).toArray())[0]?.t ?? 0;
  const checks: { id: string; budget: number; spent: number; params: Record<string, string | number | null> }[] = [];
  const overall = (await c.users.findOne({ _id: userId }, { projection: { personalMonthlyBudgetPaise: 1 } }))?.personalMonthlyBudgetPaise;
  if (overall) checks.push({ id: "all", budget: overall, spent: await spentWhere({}), params: { overall: 1 } });
  if (categoryId) {
    const k = await c.personalCategories.findOne({ _id: categoryId, userId });
    if (k?.monthlyBudgetPaise) checks.push({ id: k._id.toHexString(), budget: k.monthlyBudgetPaise, spent: await spentWhere({ categoryId }), params: { name: k.name, catKey: k.key ?? null } });
  }
  for (const ch of checks) {
    const over = ch.spent > ch.budget;
    const near = !over && ch.spent * 100 >= ch.budget * 80;
    if (!over && !near) continue;
    const level = over ? "over" : "near";
    await notify({
      organizationId: null,
      userId,
      type: `personal.budget.${level}`,
      copy: copy(`personal.budget.${level}`, { ...ch.params, spentPaise: ch.spent, budgetPaise: ch.budget, overPaise: Math.max(0, ch.spent - ch.budget), month }, "INR"),
      link: ch.id === "all" ? "/personal/budgets" : `/personal/categories/${ch.id}`,
      dedupeKey: `ph-budget:${ch.id}:${month}:${level}`,
    });
  }
}

/* ------------------------------------------------------------------ entries */

export const EntrySchema = z.object({
  type: z.enum(["expense", "income", "transfer"]),
  amount: money(),
  date: dateOnly,
  walletId: objectId,
  toWalletId: objectId.optional().nullable(),
  categoryId: objectId.optional().nullable(),
  note: optText(300),
  idempotencyKey,
});
export const EntryUpdateSchema = EntrySchema.omit({ idempotencyKey: true });

type EntryInput = z.infer<typeof EntryUpdateSchema>;

/** Check the wallets / category belong to this person and fit the kind of entry. */
async function checkEntry(userId: ObjectId, v: EntryInput, existing?: PersonalEntryDoc) {
  const c = await cols();
  const [wallet, toWallet, category] = await Promise.all([
    c.personalWallets.findOne({ _id: v.walletId, userId }),
    v.type === "transfer" && v.toWalletId ? c.personalWallets.findOne({ _id: v.toWalletId, userId }) : null,
    v.type !== "transfer" && v.categoryId ? c.personalCategories.findOne({ _id: v.categoryId, userId }) : null,
  ]);
  if (!wallet) throw notFound("Wallet");
  // a hidden wallet / category can stay on an entry that already used it, but not be picked anew
  const same = (a?: ObjectId | null, b?: ObjectId | null) => !!a && !!b && a.equals(b);
  if (wallet.isArchived && !same(existing?.walletId, wallet._id) && !same(existing?.toWalletId, wallet._id)) throw badRequest(`"${wallet.name}" is hidden. Show it again in Wallets to use it`);
  if (v.date.getTime() > utcAddDays(todayIn(TZ), 366).getTime()) throw badRequest("The date is too far in the future");
  if (v.type === "transfer") {
    if (!v.toWalletId) throw badRequest("Choose the wallet the money goes to");
    if (!toWallet) throw notFound("Wallet");
    if (toWallet._id.equals(wallet._id)) throw badRequest("Choose two different wallets");
    if (toWallet.isArchived && !same(existing?.toWalletId, toWallet._id) && !same(existing?.walletId, toWallet._id)) throw badRequest(`"${toWallet.name}" is hidden. Show it again in Wallets to use it`);
    return { walletId: wallet._id, toWalletId: toWallet._id, categoryId: null };
  }
  if (!v.categoryId) throw badRequest("Choose a category");
  if (!category) throw notFound("Category");
  if (category.kind !== v.type) throw badRequest(v.type === "expense" ? "Choose a spending category" : "Choose an income category");
  if (category.isArchived && !same(existing?.categoryId, category._id)) throw badRequest(`"${category.name}" is hidden. Show it again in Categories to use it`);
  return { walletId: wallet._id, toWalletId: null, categoryId: category._id };
}

export async function createEntry(auth: AuthContext, input: z.infer<typeof EntrySchema>) {
  await ensureSetup(auth);
  const c = await cols();
  const userId = own(auth);
  const dup = await c.personalEntries.findOne({ userId, idempotencyKey: input.idempotencyKey });
  if (dup) return { entry: entryOut(dup, await loadBook(userId)), duplicate: true };
  const refs = await checkEntry(userId, input);
  const now = new Date();
  const doc: PersonalEntryDoc = { _id: new ObjectId(), userId, type: input.type, amountPaise: input.amount, date: input.date, ...refs, note: input.note, idempotencyKey: input.idempotencyKey, createdAt: now, updatedAt: now };
  try {
    await c.personalEntries.insertOne(doc);
  } catch (e) {
    if (!isDuplicateKeyError(e)) throw e;
    const again = await c.personalEntries.findOne({ userId, idempotencyKey: input.idempotencyKey });
    if (!again) throw e;
    return { entry: entryOut(again, await loadBook(userId)), duplicate: true };
  }
  if (doc.type === "expense") await budgetAlerts(auth, doc.date, doc.categoryId).catch((e) => console.error("[budget-alerts]", e));
  return { entry: entryOut(doc, await loadBook(userId)), duplicate: false };
}

/** An entry copied from a Mandal: only the wallet and the note are the person's to change. */
export const MandalEntryUpdateSchema = z.object({ walletId: objectId, note: optText(300) });

export async function updateEntry(auth: AuthContext, id: ObjectId, body: unknown) {
  const c = await cols();
  const userId = own(auth);
  const existing = await c.personalEntries.findOne({ _id: id, userId });
  if (!existing) throw notFound("Entry");
  if (existing.source) {
    const v = MandalEntryUpdateSchema.parse(body);
    const w = await c.personalWallets.findOne({ _id: v.walletId, userId });
    if (!w) throw notFound("Wallet");
    if (w.isArchived && !w._id.equals(existing.walletId)) throw badRequest(`"${w.name}" is hidden. Show it again in Wallets to use it`);
    await c.personalEntries.updateOne({ _id: id, userId }, v.note ? { $set: { walletId: w._id, note: v.note, updatedAt: new Date() } } : { $set: { walletId: w._id, updatedAt: new Date() }, $unset: { note: "" } });
    return { entry: entryOut((await c.personalEntries.findOne({ _id: id, userId }))!, await loadBook(userId)) };
  }
  const input: EntryInput = EntryUpdateSchema.parse(body);
  const refs = await checkEntry(userId, input, existing);
  const set = { type: input.type, amountPaise: input.amount, date: input.date, ...refs, updatedAt: new Date() };
  await c.personalEntries.updateOne({ _id: id, userId }, input.note ? { $set: { ...set, note: input.note } } : { $set: set, $unset: { note: "" } });
  const doc = await c.personalEntries.findOne({ _id: id, userId });
  if (doc!.type === "expense") await budgetAlerts(auth, doc!.date, doc!.categoryId).catch((e) => console.error("[budget-alerts]", e));
  return { entry: entryOut(doc!, await loadBook(userId)) };
}

export async function deleteEntry(auth: AuthContext, id: ObjectId) {
  const c = await cols();
  const e = await c.personalEntries.findOne({ _id: id, userId: own(auth) }, { projection: { source: 1 } });
  if (!e) throw notFound("Entry");
  if (e.source) throw badRequest("This comes from your Mandal. It goes away by itself if the Mandal reverses it");
  const r = await c.personalEntries.deleteOne({ _id: id, userId: own(auth) });
  if (!r.deletedCount) throw notFound("Entry");
  return { ok: true };
}

export const EntryListQuery = z.object({
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  type: z.enum(["expense", "income", "transfer", "in", "out"]).optional().or(z.literal("").transform(() => undefined)),
  /** only entries copied from Mandals ("1") */
  mandal: z.enum(["1"]).optional().or(z.literal("").transform(() => undefined)),
  walletId: objectId.optional().or(z.literal("").transform(() => undefined)),
  categoryId: objectId.optional().or(z.literal("").transform(() => undefined)),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  format: z.string().optional(),
});

function entryFilter(userId: ObjectId, q: z.infer<typeof EntryListQuery>): Filter<PersonalEntryDoc> {
  const f: Filter<PersonalEntryDoc> = { userId };
  if (q.from || q.to) f.date = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  if (q.type) f.type = q.type;
  if (q.walletId) f.$or = [{ walletId: q.walletId }, { toWalletId: q.walletId }];
  if (q.categoryId) f.categoryId = q.categoryId;
  if (q.q) f.note = { $regex: escapeRegex(q.q), $options: "i" };
  if (q.mandal) f["source.transactionId"] = { $exists: true };
  return f;
}

export async function listEntries(auth: AuthContext, q: z.infer<typeof EntryListQuery>) {
  await ensureSetup(auth);
  await syncMandal(auth).catch((e) => console.error("[mandal-sync]", e));
  const c = await cols();
  const userId = own(auth);
  const filter = entryFilter(userId, q);
  const [items, total, sums, book] = await Promise.all([
    c.personalEntries.find(filter).sort({ date: -1, _id: -1 }).skip((q.page - 1) * q.pageSize).limit(q.pageSize).toArray(),
    c.personalEntries.countDocuments(filter),
    c.personalEntries.aggregate<{ _id: string; t: number }>([{ $match: filter }, { $group: { _id: "$type", t: { $sum: "$amountPaise" } } }]).toArray(),
    loadBook(userId),
  ]);
  const sum = (t: string) => sums.find((s) => s._id === t)?.t ?? 0;
  return {
    items: items.map((e) => entryOut(e, book)),
    total,
    page: q.page,
    pageSize: q.pageSize,
    totals: { incomePaise: sum("income"), expensePaise: sum("expense"), transferPaise: sum("transfer"), inPaise: sum("in"), outPaise: sum("out"), netPaise: sum("income") - sum("expense") },
  };
}

/** Every matching entry (no paging) as a CSV table. */
export async function entriesCsv(auth: AuthContext, q: z.infer<typeof EntryListQuery>) {
  const c = await cols();
  const userId = own(auth);
  const [items, book] = await Promise.all([c.personalEntries.find(entryFilter(userId, q)).sort({ date: 1, _id: 1 }).limit(50_000).toArray(), loadBook(userId)]);
  const headers = ["Date", "Type", "Category", "Wallet", "To wallet", "Note", "Money in", "Money out"];
  const rows = items.map((e) => {
    const o = entryOut(e, book);
    const amt = paiseToRupeeString(e.amountPaise);
    const isIn = e.type === "income" || e.type === "in";
    const isOut = e.type === "expense" || e.type === "out";
    const what = o.mandal ? `${o.mandal.name ?? "Mandal"}: ${o.mandal.kind.replace(/_/g, " ")}${e.type === "in" || e.type === "out" ? " (not income/spending)" : ""}` : (o.category?.name ?? "");
    return [o.date, e.type, what, o.wallet?.name ?? "", o.toWallet?.name ?? "", o.note ?? "", isIn ? amt : "", isOut ? amt : ""];
  });
  return { headers, rows };
}

/* ------------------------------------------------------------------ overview & reports */

function monthRange(month: string) {
  const start = parseDateOnly(`${month}-01`);
  return { start, end: utcAddDays(utcAddMonths(start, 1), -1) };
}

async function totalsByCategory(userId: ObjectId, from: Date, to: Date, only: Filter<PersonalEntryDoc> = {}) {
  const c = await cols();
  return c.personalEntries
    .aggregate<{ _id: { type: string; categoryId: ObjectId | null }; t: number; n: number }>([
      { $match: { userId, type: { $in: ["expense", "income"] }, date: { $gte: from, $lte: to }, ...only } },
      { $group: { _id: { type: "$type", categoryId: "$categoryId" }, t: { $sum: "$amountPaise" }, n: { $sum: 1 } } },
      { $sort: { t: -1 } },
    ])
    .toArray();
}

function categoryRows(rows: Awaited<ReturnType<typeof totalsByCategory>>, book: Book, kind: "expense" | "income") {
  return rows
    .filter((r) => r._id.type === kind)
    .map((r) => {
      const k = r._id.categoryId ? book.categoryById.get(r._id.categoryId.toHexString()) : undefined;
      return { category: k ? categoryOut(k) : null, totalPaise: r.t, count: r.n };
    });
}

export const OverviewQuery = z.object({ month: z.string().regex(MONTH, "Month must be YYYY-MM").optional() });

/** The home screen: balances, this month in/out, today, budgets, spending by category, recent entries. */
export async function overview(auth: AuthContext, q: z.infer<typeof OverviewQuery>) {
  await ensureSetup(auth);
  await syncMandal(auth).catch((e) => console.error("[mandal-sync]", e));
  const c = await cols();
  const userId = own(auth);
  const today = todayIn(TZ);
  const month = q.month ?? formatDateOnly(today).slice(0, 7);
  const { start, end } = monthRange(month);
  const prev = monthRange(formatDateOnly(utcAddMonths(start, -1)).slice(0, 7));
  const book = await loadBook(userId);
  const [wallets, byCat, prevSpend, todayRows, daily, recent] = await Promise.all([
    walletBalances(userId, book.wallets),
    totalsByCategory(userId, start, end),
    c.personalEntries.aggregate<{ t: number }>([{ $match: { userId, type: "expense", date: { $gte: prev.start, $lte: prev.end } } }, { $group: { _id: null, t: { $sum: "$amountPaise" } } }]).toArray(),
    c.personalEntries.aggregate<{ _id: string; t: number }>([{ $match: { userId, date: today, type: { $in: ["expense", "income"] } } }, { $group: { _id: "$type", t: { $sum: "$amountPaise" } } }]).toArray(),
    c.personalEntries
      .aggregate<{ _id: { d: Date; type: string }; t: number }>([
        { $match: { userId, type: { $in: ["expense", "income"] }, date: { $gte: start, $lte: end } } },
        { $group: { _id: { d: "$date", type: "$type" }, t: { $sum: "$amountPaise" } } },
      ])
      .toArray(),
    c.personalEntries.find({ userId }).sort({ date: -1, _id: -1 }).limit(8).toArray(),
  ]);
  const spending = categoryRows(byCat, book, "expense");
  const income = categoryRows(byCat, book, "income");
  const incomePaise = income.reduce((a, r) => a + r.totalPaise, 0);
  const expensePaise = spending.reduce((a, r) => a + r.totalPaise, 0);

  // every expense category with a budget shows, even before anything is spent in it
  const spentBy = new Map(spending.filter((r) => r.category).map((r) => [String(r.category!._id), r.totalPaise]));
  const budgets = book.categories
    .filter((k) => k.kind === "expense" && !k.isArchived && (k.monthlyBudgetPaise ?? 0) > 0)
    .map((k) => ({ category: categoryOut(k), budgetPaise: k.monthlyBudgetPaise!, spentPaise: spentBy.get(k._id.toHexString()) ?? 0 }));

  const days: { date: string; incomePaise: number; expensePaise: number }[] = [];
  for (let d = start; d.getTime() <= end.getTime(); d = utcAddDays(d, 1)) days.push({ date: formatDateOnly(d), incomePaise: 0, expensePaise: 0 });
  for (const r of daily) {
    const row = days.find((x) => x.date === formatDateOnly(r._id.d));
    if (row) row[r._id.type === "income" ? "incomePaise" : "expensePaise"] += r.t;
  }
  const t = (type: string) => todayRows.find((r) => r._id === type)?.t ?? 0;

  return {
    month,
    today: formatDateOnly(today),
    totalBalancePaise: wallets.reduce((a, w) => a + w.balancePaise, 0),
    wallets: wallets.filter((w) => !w.isArchived || w.balancePaise !== 0),
    monthTotals: { incomePaise, expensePaise, netPaise: incomePaise - expensePaise, previousExpensePaise: prevSpend[0]?.t ?? 0 },
    todayTotals: { incomePaise: t("income"), expensePaise: t("expense") },
    overallBudget: auth.user.personalMonthlyBudgetPaise ? { budgetPaise: auth.user.personalMonthlyBudgetPaise, spentPaise: expensePaise } : null,
    budgets,
    spending,
    income,
    days,
    recent: recent.map((e) => entryOut(e, book)),
    categories: book.categories.filter((k) => !k.isArchived).map(categoryOut),
  };
}

export const SummaryQuery = z.object({
  from: dateOnly,
  to: dateOnly,
  categoryId: objectId.optional().or(z.literal("").transform(() => undefined)),
  walletId: objectId.optional().or(z.literal("").transform(() => undefined)),
});

/** Any date range: totals, spending and income by category, and month by month. */
export async function summary(auth: AuthContext, q: z.infer<typeof SummaryQuery>) {
  await ensureSetup(auth);
  await syncMandal(auth).catch((e) => console.error("[mandal-sync]", e));
  if (q.from.getTime() > q.to.getTime()) throw badRequest("'From' must be before 'To'");
  const c = await cols();
  const userId = own(auth);
  // one category / one wallet (spending and income only — money moved between wallets isn't either)
  const only: Filter<PersonalEntryDoc> = { ...(q.categoryId ? { categoryId: q.categoryId } : {}), ...(q.walletId ? { walletId: q.walletId } : {}) };
  const [book, byCat, monthly] = await Promise.all([
    loadBook(userId),
    totalsByCategory(userId, q.from, q.to, only),
    c.personalEntries
      .aggregate<{ _id: { m: string; type: string }; t: number }>([
        { $match: { userId, type: { $in: ["expense", "income"] }, date: { $gte: q.from, $lte: q.to }, ...only } },
        { $group: { _id: { m: { $dateToString: { format: "%Y-%m", date: "$date" } }, type: "$type" }, t: { $sum: "$amountPaise" } } },
        { $sort: { "_id.m": 1 } },
      ])
      .toArray(),
  ]);
  const spending = categoryRows(byCat, book, "expense");
  const income = categoryRows(byCat, book, "income");
  const months = new Map<string, { month: string; incomePaise: number; expensePaise: number }>();
  for (const r of monthly) {
    const row = months.get(r._id.m) ?? { month: r._id.m, incomePaise: 0, expensePaise: 0 };
    row[r._id.type === "income" ? "incomePaise" : "expensePaise"] += r.t;
    months.set(r._id.m, row);
  }
  const incomePaise = income.reduce((a, r) => a + r.totalPaise, 0);
  const expensePaise = spending.reduce((a, r) => a + r.totalPaise, 0);
  return {
    from: formatDateOnly(q.from),
    to: formatDateOnly(q.to),
    totals: { incomePaise, expensePaise, netPaise: incomePaise - expensePaise },
    spending,
    income,
    months: [...months.values()].map((m) => ({ ...m, netPaise: m.incomePaise - m.expensePaise })),
  };
}

/* ------------------------------------------------------------------ wallets */

export async function listWallets(auth: AuthContext) {
  await ensureSetup(auth);
  await syncMandal(auth).catch((e) => console.error("[mandal-sync]", e));
  const userId = own(auth);
  const book = await loadBook(userId);
  return { wallets: await walletBalances(userId, book.wallets) };
}

const walletName = z.string().trim().min(1, "Enter a name").max(60);
export const WalletSchema = z.object({ name: walletName, kind: z.enum(WALLET_KINDS).default("cash"), openingBalance: money({ allowZero: true }).default(0) });
export const WalletUpdateSchema = z.object({ name: walletName.optional(), kind: z.enum(WALLET_KINDS).optional(), openingBalance: money({ allowZero: true }).optional(), isArchived: z.boolean().optional() });

const nameTaken = (what: string) => conflict(`You already have a ${what} with this name`);

export async function createWallet(auth: AuthContext, input: z.infer<typeof WalletSchema>) {
  await ensureSetup(auth);
  const c = await cols();
  const now = new Date();
  const doc: PersonalWalletDoc = { _id: new ObjectId(), userId: own(auth), name: input.name, kind: input.kind, openingBalancePaise: input.openingBalance, isArchived: false, createdAt: now, updatedAt: now };
  try {
    await c.personalWallets.insertOne(doc);
  } catch (e) {
    if (isDuplicateKeyError(e)) throw nameTaken("wallet");
    throw e;
  }
  return { wallet: walletOut(doc) };
}

async function activeWalletCount(userId: ObjectId) {
  return (await cols()).personalWallets.countDocuments({ userId, isArchived: false });
}

export async function updateWallet(auth: AuthContext, id: ObjectId, input: z.infer<typeof WalletUpdateSchema>) {
  const c = await cols();
  const userId = own(auth);
  const w = await c.personalWallets.findOne({ _id: id, userId });
  if (!w) throw notFound("Wallet");
  if (input.isArchived === true && !w.isArchived && (await activeWalletCount(userId)) <= 1) throw badRequest("Keep at least one wallet");
  const set: Partial<PersonalWalletDoc> = { updatedAt: new Date() };
  const unset: Record<string, ""> = {};
  if (input.name !== undefined && input.name !== w.name) {
    set.name = input.name;
    unset.key = ""; // renamed: show the person's own name in every language
  }
  if (input.kind !== undefined) set.kind = input.kind;
  if (input.openingBalance !== undefined) set.openingBalancePaise = input.openingBalance;
  if (input.isArchived !== undefined) set.isArchived = input.isArchived;
  try {
    await c.personalWallets.updateOne({ _id: id, userId }, Object.keys(unset).length ? { $set: set, $unset: unset } : { $set: set });
  } catch (e) {
    if (isDuplicateKeyError(e)) throw nameTaken("wallet");
    throw e;
  }
  return { wallet: walletOut((await c.personalWallets.findOne({ _id: id, userId }))!) };
}

/** Delete an unused wallet; one with entries is hidden instead so past entries keep their wallet. */
export async function deleteWallet(auth: AuthContext, id: ObjectId) {
  const c = await cols();
  const userId = own(auth);
  const w = await c.personalWallets.findOne({ _id: id, userId });
  if (!w) throw notFound("Wallet");
  if (!w.isArchived && (await activeWalletCount(userId)) <= 1) throw badRequest("Keep at least one wallet");
  const used = await c.personalEntries.countDocuments({ userId, $or: [{ walletId: id }, { toWalletId: id }] }, { limit: 1 });
  if (used) {
    await c.personalWallets.updateOne({ _id: id, userId }, { $set: { isArchived: true, updatedAt: new Date() } });
    return { deleted: false, archived: true };
  }
  await c.personalWallets.deleteOne({ _id: id, userId });
  return { deleted: true, archived: false };
}

/* ------------------------------------------------------------------ categories & budgets */

export async function listCategories(auth: AuthContext) {
  await ensureSetup(auth);
  const book = await loadBook(own(auth));
  return { categories: book.categories.map(categoryOut), monthlyBudgetPaise: auth.user.personalMonthlyBudgetPaise ?? null, budgetAlerts: auth.user.personalBudgetAlerts !== false };
}

const catName = z.string().trim().min(1, "Enter a name").max(60);
/** 0 / empty removes the budget */
const budget = z.union([money({ allowZero: true }), z.literal("").transform(() => 0), z.null().transform(() => 0)]);
/** an icon name from the app's icon set; the app shows a default for names it doesn't know */
const icon = z.string().regex(/^[a-z0-9-]{1,30}$/, "Choose an icon");
export const CategorySchema = z.object({ kind: z.enum(["expense", "income"]), name: catName, tone: z.enum(TONES).default("slate"), icon: icon.optional(), monthlyBudget: budget.optional() });
export const CategoryUpdateSchema = z.object({ name: catName.optional(), tone: z.enum(TONES).optional(), icon: icon.optional(), monthlyBudget: budget.optional(), isArchived: z.boolean().optional() });

export async function createCategory(auth: AuthContext, input: z.infer<typeof CategorySchema>) {
  await ensureSetup(auth);
  const c = await cols();
  const now = new Date();
  const doc: PersonalCategoryDoc = {
    _id: new ObjectId(),
    userId: own(auth),
    kind: input.kind,
    name: input.name,
    tone: input.tone,
    ...(input.icon ? { icon: input.icon } : {}),
    monthlyBudgetPaise: input.kind === "expense" && input.monthlyBudget ? input.monthlyBudget : null,
    isArchived: false,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await c.personalCategories.insertOne(doc);
  } catch (e) {
    if (isDuplicateKeyError(e)) throw nameTaken("category");
    throw e;
  }
  return { category: categoryOut(doc) };
}

export async function updateCategory(auth: AuthContext, id: ObjectId, input: z.infer<typeof CategoryUpdateSchema>) {
  const c = await cols();
  const userId = own(auth);
  const k = await c.personalCategories.findOne({ _id: id, userId });
  if (!k) throw notFound("Category");
  const set: Partial<PersonalCategoryDoc> = { updatedAt: new Date() };
  const unset: Record<string, ""> = {};
  if (input.name !== undefined && input.name !== k.name) {
    set.name = input.name;
    unset.key = "";
  }
  if (input.tone !== undefined) set.tone = input.tone;
  if (input.icon !== undefined) set.icon = input.icon;
  if (input.monthlyBudget !== undefined) {
    if (k.kind !== "expense" && input.monthlyBudget) throw badRequest("Budgets are for spending categories");
    set.monthlyBudgetPaise = input.monthlyBudget || null;
  }
  if (input.isArchived !== undefined) set.isArchived = input.isArchived;
  try {
    await c.personalCategories.updateOne({ _id: id, userId }, Object.keys(unset).length ? { $set: set, $unset: unset } : { $set: set });
  } catch (e) {
    if (isDuplicateKeyError(e)) throw nameTaken("category");
    throw e;
  }
  return { category: categoryOut((await c.personalCategories.findOne({ _id: id, userId }))!) };
}

/** Delete an unused category; one with entries is hidden instead so past entries keep it. */
export async function deleteCategory(auth: AuthContext, id: ObjectId) {
  const c = await cols();
  const userId = own(auth);
  const k = await c.personalCategories.findOne({ _id: id, userId });
  if (!k) throw notFound("Category");
  const used = await c.personalEntries.countDocuments({ userId, categoryId: id }, { limit: 1 });
  if (used) {
    await c.personalCategories.updateOne({ _id: id, userId }, { $set: { isArchived: true, updatedAt: new Date() } });
    return { deleted: false, archived: true };
  }
  await c.personalCategories.deleteOne({ _id: id, userId });
  return { deleted: true, archived: false };
}

export const SettingsSchema = z.object({ monthlyBudget: budget.optional(), budgetAlerts: z.boolean().optional() });

/** The overall monthly spending limit (0 removes it) and whether budget alerts are pushed. */
export async function updateSettings(auth: AuthContext, input: z.infer<typeof SettingsSchema>) {
  const c = await cols();
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (input.monthlyBudget !== undefined) set.personalMonthlyBudgetPaise = input.monthlyBudget || null;
  if (input.budgetAlerts !== undefined) set.personalBudgetAlerts = input.budgetAlerts;
  await c.users.updateOne({ _id: own(auth) }, { $set: set });
  const u = await c.users.findOne({ _id: own(auth) }, { projection: { personalMonthlyBudgetPaise: 1, personalBudgetAlerts: 1 } });
  return { monthlyBudgetPaise: u?.personalMonthlyBudgetPaise ?? null, budgetAlerts: u?.personalBudgetAlerts !== false };
}
