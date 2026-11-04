import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { api, ok, registerAndLogin, uniq } from "../helpers/api";
import { cols } from "@/lib/collections";
import { runPersonalReminders } from "@/services/personal-reminders.service";
import { setStorageForTests, type StorageProvider } from "@/services/upload.service";
import { setBillReaderForTests } from "@/services/bill-reader.service";

/**
 * Personal Hisab books: one login, several separate hisabs ("Personal", "Office" …). Each book has
 * its own wallets, categories, entries, budgets, defaults and reminders; nothing ever mixes, and
 * someone else's book can never be opened.
 */

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
const ist = (s: string) => new Date(`${s}+05:30`);

const files = new Map<string, Uint8Array>();
const fake: StorageProvider = {
  async put(path, data) {
    const url = `https://blob.test/${path}`;
    files.set(url, data);
    return url;
  },
  async del(url) {
    files.delete(url);
  },
  async get(url) {
    return files.get(url)!;
  },
};

describe("Personal Hisab books", () => {
  let me: { token: string; userId: string };
  let other: { token: string; userId: string };
  let office: string;
  // a call made inside a book
  const inBook = (book: string | null, method: string, path: string, opts: { token?: string; body?: unknown; form?: FormData } = {}) =>
    api(method, path, { token: me.token, ...opts, headers: book ? { "x-personal-book": book } : {} });
  const wallets = async (book: string | null, token = me.token) => (await ok(api("GET", "/me/personal/wallets", { token, headers: book ? { "x-personal-book": book } : {} }))).wallets;
  const categories = async (book: string | null) => (await ok(inBook(book, "GET", "/me/personal/categories"))).categories;
  const addSpend = async (book: string | null, amount: string, note: string) => {
    const [w, k] = [(await wallets(book))[0], (await categories(book)).find((x: any) => x.kind === "expense")];
    return ok(inBook(book, "POST", "/me/personal/entries", { body: { type: "expense", amount, date: today(), walletId: w._id, categoryId: k._id, note, idempotencyKey: uniq("pe") } }));
  };

  beforeAll(async () => {
    setStorageForTests(fake);
    setBillReaderForTests(null);
    me = await registerAndLogin("Book Keeper");
    other = await registerAndLogin("Other Person");
    // main book used before books existed
    await addSpend(null, "250", "Vegetables");
  });
  afterAll(() => {
    setStorageForTests(undefined);
    setBillReaderForTests(undefined);
  });

  it("everyone starts with their main book, called Personal", async () => {
    const r = await ok(inBook(null, "GET", "/me/personal/books"));
    expect(r.books).toEqual([{ _id: me.userId, name: "Personal", isMain: true }]);
    expect(r.activeId).toBe(me.userId);
  });

  it("a new book has its own starter wallets and categories, and its own entries", async () => {
    const r = await ok(inBook(null, "POST", "/me/personal/books", { body: { name: "Office" } }));
    office = r.book._id;
    const [mainW, officeW] = [await wallets(null), await wallets(office)];
    expect(officeW.map((w: any) => w.key)).toEqual(["cash", "bank"]);
    expect(officeW.map((w: any) => w._id)).not.toContain(mainW[0]._id);
    // same wallet name in two books is fine
    await ok(inBook(office, "POST", "/me/personal/wallets", { body: { name: "Petty cash", kind: "cash" } }));
    await ok(inBook(null, "POST", "/me/personal/wallets", { body: { name: "Petty cash", kind: "cash" } }));

    await addSpend(office, "1200", "Client lunch");
    const mainList = await ok(inBook(null, "GET", "/me/personal/entries"));
    const officeList = await ok(inBook(office, "GET", "/me/personal/entries"));
    expect(mainList.items.map((e: any) => e.note)).toEqual(["Vegetables"]);
    expect(officeList.items.map((e: any) => e.note)).toEqual(["Client lunch"]);
    const o = await ok(inBook(office, "GET", "/me/personal/overview"));
    expect(o.monthTotals.expensePaise).toBe(120000);
    expect((await ok(inBook(office, "GET", "/me/personal/books"))).activeId).toBe(office);
  });

  it("a wallet or category of one book can't be used in another", async () => {
    const mainWallet = (await wallets(null))[0];
    const officeCat = (await categories(office)).find((x: any) => x.kind === "expense");
    const r = await inBook(office, "POST", "/me/personal/entries", { body: { type: "expense", amount: "1", date: today(), walletId: mainWallet._id, categoryId: officeCat._id, idempotencyKey: uniq("pe") } });
    expect(r.status).toBe(404);
  });

  it("someone else's book id never opens it — they just see their own main book", async () => {
    const theirs = await wallets(office, other.token);
    expect(theirs.map((w: any) => w._id)).not.toContain((await wallets(office))[0]._id);
    const list = await ok(api("GET", "/me/personal/entries", { token: other.token, headers: { "x-personal-book": office } }));
    expect(list.items).toHaveLength(0);
    expect((await ok(api("GET", "/me/personal/books", { token: other.token, headers: { "x-personal-book": office } }))).activeId).toBe(other.userId);
    expect((await api("PATCH", `/me/personal/books/${office}`, { token: other.token, body: { name: "Mine now" } })).status).toBe(404);
    expect((await api("DELETE", `/me/personal/books/${office}`, { token: other.token, body: { confirmName: "Office" } })).status).toBe(404);
  });

  it("budgets and defaults belong to each book", async () => {
    await ok(inBook(office, "PATCH", "/me/personal/settings", { body: { monthlyBudget: "5000" } }));
    expect((await ok(inBook(office, "GET", "/me/personal/categories"))).monthlyBudgetPaise).toBe(500000);
    expect((await ok(inBook(null, "GET", "/me/personal/categories"))).monthlyBudgetPaise).toBeNull();
    const w = (await wallets(office))[1];
    await ok(inBook(office, "PATCH", "/me/personal/settings", { body: { defaultWalletId: w._id } }));
    expect((await wallets(office)).find((x: any) => x.isDefault)?._id).toBe(w._id);
    expect((await wallets(null)).some((x: any) => x.isDefault)).toBe(false);
  });

  it("a budget alert from a book goes to the person and opens that book", async () => {
    await addSpend(office, "4500", "Printer"); // 1200 + 4500 of 5000 → over budget
    const c = await cols();
    const n = await c.notifications.findOne({ userId: new ObjectId(me.userId), type: "personal.budget.over" });
    expect(n?.link).toBe(`/personal/budgets?book=${office}`);
    expect(await c.notifications.countDocuments({ userId: new ObjectId(office) })).toBe(0);
  });

  it("a reminder in a book pushes to the person and opens that book", async () => {
    const cat = (await categories(office)).find((x: any) => x.kind === "expense");
    await ok(inBook(office, "POST", "/me/personal/reminders", { body: { title: "Office rent", amount: "15000", categoryId: cat._id, repeat: "monthly", dueDate: "2028-01-05", time: "10:00", remindBeforeMinutes: 60 } }));
    expect((await ok(inBook(null, "GET", "/me/personal/reminders"))).reminders).toHaveLength(0);
    await runPersonalReminders(ist("2028-01-05T09:05"));
    const n = await (await cols()).notifications.findOne({ userId: new ObjectId(me.userId), type: "personal.reminder" });
    expect(n).toMatchObject({ title: "Reminder: Office rent", link: `/personal/reminders?book=${office}` });
  });

  it("bills scanned in a book use that book's categories and count towards the person's 10", async () => {
    const before = (await ok(inBook(null, "GET", "/me/personal/bills/usage"))).used;
    const fd = new FormData();
    const bytes = new Uint8Array(2000);
    bytes.set([0xff, 0xd8, 0xff, 0xe0]);
    fd.set("file", new File([bytes], "bill.jpg", { type: "image/jpeg" }));
    const s = await ok(inBook(office, "POST", "/me/personal/bills", { form: fd }));
    expect(s.usage.used).toBe(before + 1);
    const [w, k] = [(await wallets(office))[0], (await categories(office)).find((x: any) => x.kind === "expense")];
    const e = await ok(inBook(office, "POST", "/me/personal/entries", { body: { type: "expense", amount: "99", date: today(), walletId: w._id, categoryId: k._id, billId: s.bill._id, idempotencyKey: uniq("pe") } }));
    expect(e.entry.bill._id).toBe(s.bill._id);
    expect((await ok(inBook(null, "GET", "/me/personal/bills/usage"))).used).toBe(before + 1);
  });

  it("copying Mandal money in is for the main book only", async () => {
    expect((await ok(inBook(office, "GET", "/me/personal/mandal-sync"))).available).toBe(false);
    expect((await ok(inBook(null, "GET", "/me/personal/mandal-sync"))).available).toBe(true);
    expect((await inBook(office, "PATCH", "/me/personal/mandal-sync", { body: { enabled: true } })).status).toBe(400);
  });

  it("books can be renamed; names stay unique", async () => {
    await ok(inBook(null, "PATCH", `/me/personal/books/${me.userId}`, { body: { name: "Home" } }));
    expect((await inBook(null, "POST", "/me/personal/books", { body: { name: "home" } })).status).toBe(400);
    expect((await inBook(null, "PATCH", `/me/personal/books/${office}`, { body: { name: "HOME" } })).status).toBe(400);
    await ok(inBook(null, "PATCH", `/me/personal/books/${office}`, { body: { name: "Office 2026" } }));
    expect((await ok(inBook(null, "GET", "/me/personal/books"))).books.map((b: any) => b.name)).toEqual(["Home", "Office 2026"]);
  });

  it("deleting a book needs its name, removes everything in it (bills too), and never touches the main book", async () => {
    expect((await inBook(null, "DELETE", `/me/personal/books/${me.userId}`, { body: { confirmName: "Home" } })).status).toBe(400);
    expect((await inBook(null, "DELETE", `/me/personal/books/${office}`, { body: { confirmName: "Office" } })).status).toBe(400);
    const billFiles = files.size;
    const r = await ok(inBook(null, "DELETE", `/me/personal/books/${office}`, { body: { confirmName: "office 2026" } }));
    expect(r.removed.entries).toBe(3);
    expect(files.size).toBe(billFiles - 1);
    const c = await cols();
    expect(await c.personalEntries.countDocuments({ userId: new ObjectId(office) })).toBe(0);
    expect(await c.personalReminders.countDocuments({ userId: new ObjectId(office) })).toBe(0);
    // the main book is as it was; a stale choice of the deleted book just shows the main book
    expect((await ok(inBook(office, "GET", "/me/personal/entries"))).items.map((e: any) => e.note)).toEqual(["Vegetables"]);
  });

  it("up to 10 books", async () => {
    for (let i = 1; i <= 9; i++) await ok(inBook(null, "POST", "/me/personal/books", { body: { name: `Book ${i}` } }));
    expect((await inBook(null, "POST", "/me/personal/books", { body: { name: "One too many" } })).status).toBe(400);
  });
});
