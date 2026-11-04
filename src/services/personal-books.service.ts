import { ObjectId, type UpdateFilter } from "mongodb";
import { z } from "zod";
import { cols } from "@/lib/collections";
import { badRequest, notFound } from "@/lib/errors";
import type { AuthContext } from "@/lib/auth";
import type { PersonalBookDoc, UserDoc } from "@/types/models";
import { storage } from "./upload.service";

/**
 * Personal Hisab books: one login can keep several separate hisabs ("Personal", "Office" …).
 *
 * The main book is the person's own: its records carry their user id, exactly as before books
 * existed, so nothing had to move. An extra book's records carry the book's _id as `userId`.
 * Each request names its book (X-Personal-Book header, set by the app from the person's choice
 * on that device); `withBook` checks the book is theirs and gives the Personal Hisab services an
 * AuthContext whose `user._id` is that book's key and whose settings are that book's — so every
 * existing query is scoped to the one book without being rewritten, and books can never mix.
 */

export const MAX_BOOKS = 10;
export const MAIN_BOOK_NAME = "Personal";
const SETTINGS = ["personalSetupAt", "personalMonthlyBudgetPaise", "personalBudgetAlerts", "personalDefaults"] as const;

const bookName = z.string().trim().min(1, "Enter a name").max(40, "Keep the name under 40 characters");
export const BookSchema = z.object({ name: bookName });
export const BookDeleteSchema = z.object({ confirmName: z.string().trim() });

const mainName = (u: UserDoc) => u.personalBookName?.trim() || MAIN_BOOK_NAME;

/** The person behind a request, whichever book it is about. */
export const realUserId = (auth: AuthContext) => auth.personal?.realUserId ?? auth.user._id;

/**
 * This request's book. No / unknown / someone else's book id → the person's main book (never an
 * error: a stale choice on a phone just shows the main book).
 */
export async function withBook(auth: AuthContext, requested: string | null | undefined): Promise<AuthContext> {
  const main: AuthContext = { ...auth, personal: { realUserId: auth.user._id, bookId: auth.user._id, isMain: true, bookName: mainName(auth.user) } };
  if (!requested || !ObjectId.isValid(requested) || requested === auth.user._id.toHexString()) return main;
  const c = await cols();
  const book = await c.personalBooks.findOne({ _id: new ObjectId(requested), userId: auth.user._id });
  if (!book) return main;
  const user: UserDoc = {
    ...auth.user,
    _id: book._id,
    personalSetupAt: book.personalSetupAt,
    personalMonthlyBudgetPaise: book.personalMonthlyBudgetPaise ?? null,
    personalBudgetAlerts: book.personalBudgetAlerts,
    personalDefaults: book.personalDefaults ?? null,
    // copying Mandal money in is for the main book only
    personalMandalSync: null,
    personalMandalSyncedAt: null,
  };
  return { ...auth, user, personal: { realUserId: auth.user._id, bookId: book._id, isMain: false, bookName: book.name } };
}

/* ------------------------------------------------------------------ a book's settings */

/** A book's settings: on the person for the main book, on the book itself for the others. */
export async function readBookSettings(ownerId: ObjectId) {
  const c = await cols();
  const projection = Object.fromEntries(SETTINGS.map((k) => [k, 1]));
  return (await c.users.findOne({ _id: ownerId }, { projection })) ?? (await c.personalBooks.findOne({ _id: ownerId }, { projection }));
}

/** Update a book's settings wherever they live (`filter` adds conditions, e.g. "not set yet"). */
export async function writeBookSettings(ownerId: ObjectId, update: UpdateFilter<UserDoc> & UpdateFilter<PersonalBookDoc>, filter: Record<string, unknown> = {}) {
  const c = await cols();
  const onUser = await c.users.countDocuments({ _id: ownerId }, { limit: 1 });
  if (onUser) return c.users.updateOne({ _id: ownerId, ...filter }, update as UpdateFilter<UserDoc>);
  return c.personalBooks.updateOne({ _id: ownerId, ...filter }, update as UpdateFilter<PersonalBookDoc>);
}

/** Who gets a book's notifications: the person, also for their extra books. */
export async function ownerOfBook(ownerId: ObjectId): Promise<ObjectId> {
  const c = await cols();
  const book = await c.personalBooks.findOne({ _id: ownerId }, { projection: { userId: 1 } });
  return book?.userId ?? ownerId;
}

/** "/personal/reminders" → "/personal/reminders?book=…" for an extra book, so a tapped notification opens the right book. */
export const bookLink = (path: string, ownerId: ObjectId, realId: ObjectId) => (ownerId.equals(realId) ? path : `${path}${path.includes("?") ? "&" : "?"}book=${ownerId.toHexString()}`);

/* ------------------------------------------------------------------ list / create / rename / delete */

export async function listBooks(auth: AuthContext) {
  const c = await cols();
  const me = auth.personal?.realUserId ?? auth.user._id;
  const user = await c.users.findOne({ _id: me }, { projection: { personalBookName: 1 } });
  const extra = await c.personalBooks.find({ userId: me }).sort({ createdAt: 1, _id: 1 }).toArray();
  return {
    activeId: auth.personal?.bookId ?? me,
    max: MAX_BOOKS,
    books: [{ _id: me, name: user?.personalBookName?.trim() || MAIN_BOOK_NAME, isMain: true }, ...extra.map((b) => ({ _id: b._id, name: b.name, isMain: false }))],
  };
}

async function nameFree(me: ObjectId, name: string, except?: ObjectId) {
  const c = await cols();
  const user = await c.users.findOne({ _id: me }, { projection: { personalBookName: 1 } });
  const same = (n: string) => n.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase();
  if (!except?.equals(me) && same(user?.personalBookName?.trim() || MAIN_BOOK_NAME)) return false;
  const books = await c.personalBooks.find({ userId: me }, { projection: { name: 1 } }).toArray();
  return !books.some((b) => !b._id.equals(except ?? new ObjectId()) && same(b.name));
}

export async function createBook(auth: AuthContext, input: z.infer<typeof BookSchema>) {
  const c = await cols();
  const me = realUserId(auth);
  if ((await c.personalBooks.countDocuments({ userId: me })) >= MAX_BOOKS - 1) throw badRequest(`You can keep up to ${MAX_BOOKS} books`);
  if (!(await nameFree(me, input.name))) throw badRequest("You already have a book with this name");
  const now = new Date();
  const doc: PersonalBookDoc = { _id: new ObjectId(), userId: me, name: input.name, createdAt: now, updatedAt: now };
  await c.personalBooks.insertOne(doc);
  return { book: { _id: doc._id, name: doc.name, isMain: false } };
}

export async function renameBook(auth: AuthContext, id: ObjectId, input: z.infer<typeof BookSchema>) {
  const c = await cols();
  const me = realUserId(auth);
  if (!(await nameFree(me, input.name, id))) throw badRequest("You already have a book with this name");
  if (id.equals(me)) {
    await c.users.updateOne({ _id: me }, { $set: { personalBookName: input.name, updatedAt: new Date() } });
    return { book: { _id: me, name: input.name, isMain: true } };
  }
  const r = await c.personalBooks.updateOne({ _id: id, userId: me }, { $set: { name: input.name, updatedAt: new Date() } });
  if (!r.matchedCount) throw notFound("Book");
  return { book: { _id: id, name: input.name, isMain: false } };
}

/** Delete an extra book and everything in it (its bills' files too). The main book can't be deleted. */
export async function deleteBook(auth: AuthContext, id: ObjectId, input: z.infer<typeof BookDeleteSchema>) {
  const c = await cols();
  const me = realUserId(auth);
  if (id.equals(me)) throw badRequest("Your main book can't be deleted");
  const book = await c.personalBooks.findOne({ _id: id, userId: me });
  if (!book) throw notFound("Book");
  if (input.confirmName.toLocaleLowerCase() !== book.name.trim().toLocaleLowerCase()) throw badRequest("Type the book's name to delete it");
  // bills kept with this book's entries: remove their files
  const withBills = await c.personalEntries.find({ userId: id, "bill.billId": { $exists: true } }, { projection: { bill: 1 } }).toArray();
  const billIds = withBills.map((e) => e.bill!.billId);
  if (billIds.length) {
    const bills = await c.personalBills.find({ _id: { $in: billIds }, userId: me }, { projection: { url: 1 } }).toArray();
    const s = storage();
    for (const b of bills) if (b.url && s) await s.del(b.url).catch((e) => console.warn("[books] could not delete bill", b._id.toHexString(), e));
    await c.personalBills.updateMany({ _id: { $in: billIds }, userId: me }, { $set: { url: null, entryId: null, deletedAt: new Date(), updatedAt: new Date() } });
  }
  const [entries, wallets, categories, reminders] = await Promise.all([
    c.personalEntries.deleteMany({ userId: id }),
    c.personalWallets.deleteMany({ userId: id }),
    c.personalCategories.deleteMany({ userId: id }),
    c.personalReminders.deleteMany({ userId: id }),
  ]);
  await c.personalBooks.deleteOne({ _id: id, userId: me });
  return { deleted: true, removed: { entries: entries.deletedCount, wallets: wallets.deletedCount, categories: categories.deletedCount, reminders: reminders.deletedCount } };
}
