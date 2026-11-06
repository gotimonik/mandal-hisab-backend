import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, ok, registerAndLogin, uniq } from "../helpers/api";
import { setStorageForTests, type StorageProvider } from "@/services/upload.service";
import { BillReaderError, setBillReaderForTests, type BillReader } from "@/services/bill-reader.service";
import { cleanupOrphanBills } from "@/services/personal-bills.service";
import { cols } from "@/lib/collections";

/**
 * Personal Hisab bills: scan a bill (max 5 MB), get the total / date / shop / category read off
 * it, save it with an entry. 10 a month per person; only the owner can ever get the file.
 */

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

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
    const f = files.get(url);
    if (!f) throw new Error("gone");
    return f;
  },
};

const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const PDF = [0x25, 0x50, 0x44, 0x46];
function bill(size = 2000, magic = JPEG, type = "image/jpeg", name = "bill.jpg") {
  const bytes = new Uint8Array(size);
  bytes.set(magic);
  return new File([bytes], name, { type });
}
const form = (f: File) => {
  const fd = new FormData();
  fd.set("file", f);
  return fd;
};

let reading: Awaited<ReturnType<BillReader>> = { isBill: true, amount: 0, date: null, merchant: null, type: "expense", categoryId: null, walletKind: null };
let seenCategories: { id: string; kind: string; name: string }[] = [];
const reader: BillReader = async ({ categories }) => {
  seenCategories = categories;
  return reading;
};

describe("Personal Hisab bills", () => {
  let me: { token: string; userId: string };
  let other: { token: string; userId: string };
  let groceries: any, cash: any;
  const scan = (f: File, token = me.token) => api("POST", "/me/personal/bills", { token, form: form(f) });

  beforeAll(async () => {
    setStorageForTests(fake);
    setBillReaderForTests(reader);
    me = await registerAndLogin("Bill Scanner");
    other = await registerAndLogin("Nosy Neighbour");
    const cats = await ok(api("GET", "/me/personal/categories", { token: me.token }));
    groceries = cats.categories.find((k: any) => k.key === "groceries");
    cash = (await ok(api("GET", "/me/personal/wallets", { token: me.token }))).wallets.find((w: any) => w.key === "cash");
  });
  afterAll(() => {
    setStorageForTests(undefined);
    setBillReaderForTests(undefined);
  });

  it("reads the total, date, shop and category off a bill", async () => {
    reading = { isBill: true, amount: 1234.5, date: today(), merchant: "  DMart   Adajan ", type: "expense", categoryId: groceries._id, walletKind: "upi" };
    const r = await ok(scan(bill()));
    expect(r.reading).toMatchObject({ isBill: true, amount: "1234.50", amountPaise: 123450, date: today(), merchant: "DMart Adajan", type: "expense", categoryId: groceries._id, walletKind: "upi" });
    expect(r.usage).toMatchObject({ used: 1, limit: 10, left: 9 });
    expect(r.bill.contentType).toBe("image/jpeg");
    // the reader was given this person's own categories
    expect(seenCategories.some((k) => k.id === groceries._id)).toBe(true);
  });

  it("says which UPI app a payment screenshot is from", async () => {
    const upiUser = await registerAndLogin("UPI Payer"); // own monthly scan count
    reading = { isBill: true, amount: 250, date: today(), merchant: "Ramesh Patel", type: "expense", categoryId: null, walletKind: "upi", upiApp: "phonepe" };
    const r = await ok(scan(bill(), upiUser.token));
    expect(r.reading).toMatchObject({ walletKind: "upi", upiApp: "phonepe" });
    // older readers that don't say → null, not missing
    reading = { isBill: true, amount: 99, date: today(), merchant: "Tea stall", type: "expense", categoryId: null, walletKind: "cash" };
    expect((await ok(scan(bill(), upiUser.token))).reading.upiApp).toBeNull();
  });

  it("throws away readings that don't make sense", async () => {
    reading = { isBill: true, amount: -5, date: "2099-01-01", merchant: "Shop", type: "expense", categoryId: "65f000000000000000000000", walletKind: null };
    const r = await ok(scan(bill()));
    expect(r.reading).toMatchObject({ amount: null, date: null, categoryId: null, merchant: "Shop" });
    reading = { isBill: false, amount: 50, date: today(), merchant: "Cat photo", type: "expense", categoryId: null, walletKind: null };
    const r2 = await ok(scan(bill()));
    expect(r2.reading).toMatchObject({ isBill: false, amount: null, merchant: null });
  });

  it("saves the bill with an entry; only the owner can open it", async () => {
    reading = { isBill: true, amount: 300, date: today(), merchant: "Milk", type: "expense", categoryId: groceries._id, walletKind: null };
    const s = await ok(scan(bill(3000, PDF, "application/pdf", "milk.pdf")));
    const e = await ok(api("POST", "/me/personal/entries", { token: me.token, body: { type: "expense", amount: "300", date: today(), walletId: cash._id, categoryId: groceries._id, billId: s.bill._id, idempotencyKey: uniq("pe") } }));
    expect(e.entry.bill).toMatchObject({ _id: s.bill._id, name: "milk.pdf", contentType: "application/pdf" });

    const file = await api("GET", `/me/personal/bills/${s.bill._id}/file`, { token: me.token });
    expect(file.status).toBe(200);
    expect(String(file.data).startsWith("%PDF")).toBe(true);
    expect((await api("GET", `/me/personal/bills/${s.bill._id}/file`, { token: other.token })).status).toBe(404);
    // someone else can't put it on their entry either
    const otherCash = (await ok(api("GET", "/me/personal/wallets", { token: other.token }))).wallets[0];
    const otherCats = (await ok(api("GET", "/me/personal/categories", { token: other.token }))).categories.find((k: any) => k.kind === "expense");
    const steal = await api("POST", "/me/personal/entries", { token: other.token, body: { type: "expense", amount: "1", date: today(), walletId: otherCash._id, categoryId: otherCats._id, billId: s.bill._id, idempotencyKey: uniq("pe") } });
    expect(steal.status).toBe(404);
    // and it can't go on a second entry of mine
    const twice = await api("POST", "/me/personal/entries", { token: me.token, body: { type: "expense", amount: "1", date: today(), walletId: cash._id, categoryId: groceries._id, billId: s.bill._id, idempotencyKey: uniq("pe") } });
    expect(twice.status).toBe(400);

    // removing it from the entry deletes the file
    const url = (await (await cols()).personalBills.findOne({}, { sort: { createdAt: -1 } }))!.url!;
    await ok(api("PATCH", `/me/personal/entries/${e.entry._id}`, { token: me.token, body: { type: "expense", amount: "300", date: today(), walletId: cash._id, categoryId: groceries._id, billId: null } }));
    expect(files.has(url)).toBe(false);
    expect((await api("GET", `/me/personal/bills/${s.bill._id}/file`, { token: me.token })).status).toBe(404);
  });

  it("deleting an entry deletes its bill", async () => {
    const s = await ok(scan(bill()));
    const e = await ok(api("POST", "/me/personal/entries", { token: me.token, body: { type: "expense", amount: "10", date: today(), walletId: cash._id, categoryId: groceries._id, billId: s.bill._id, idempotencyKey: uniq("pe") } }));
    const doc = await (await cols()).personalBills.findOne({ entryId: { $ne: null }, deletedAt: null, url: { $type: "string" } }, { sort: { createdAt: -1 } });
    await ok(api("DELETE", `/me/personal/entries/${e.entry._id}`, { token: me.token }));
    expect(files.has(doc!.url!)).toBe(false);
  });

  it("rejects files over 5 MB and non-bills", async () => {
    const big = await scan(bill(5 * 1024 * 1024 + 1));
    expect(big.status).toBe(400);
    const txt = await scan(new File(["hello"], "a.txt", { type: "text/plain" }));
    expect(txt.status).toBe(400);
  });

  it("allows 10 scans a month; a reader failure on our side doesn't use one up", async () => {
    const u = await ok(api("GET", "/me/personal/bills/usage", { token: me.token }));
    setBillReaderForTests(async () => {
      throw new BillReaderError("down");
    });
    const failed = await ok(scan(bill()));
    expect(failed.readError).toBe("unavailable");
    expect(failed.usage.used).toBe(u.used);
    setBillReaderForTests(reader);
    for (let i = u.used; i < 10; i++) await ok(scan(bill()));
    const over = await scan(bill());
    expect(over.status).toBe(429);
    expect((over.error?.details as { code?: string })?.code).toBe("BILL_LIMIT");
    // removing a bill doesn't give the scan back
    const free = await (await cols()).personalBills.findOne({ entryId: null, deletedAt: null });
    await ok(api("DELETE", `/me/personal/bills/${free!._id.toHexString()}`, { token: me.token }));
    expect((await ok(api("GET", "/me/personal/bills/usage", { token: me.token }))).left).toBe(0);
    // another person has their own 10
    expect((await ok(api("GET", "/me/personal/bills/usage", { token: other.token }))).left).toBe(10);
  });

  it("keeps the bill when no reader is set up", async () => {
    setBillReaderForTests(null);
    const r = await ok(scan(bill(), other.token));
    expect(r.reading).toBeNull();
    expect(r.readError).toBe("off");
    setBillReaderForTests(reader);
  });

  it("the daily job removes bills never saved with an entry", async () => {
    const c = await cols();
    const loose = await c.personalBills.countDocuments({ entryId: null, deletedAt: null });
    expect(loose).toBeGreaterThan(0);
    const r = await cleanupOrphanBills(new Date(Date.now() + 25 * 60 * 60 * 1000));
    expect(r.billsRemoved).toBe(loose);
    expect(await c.personalBills.countDocuments({ entryId: null, deletedAt: null })).toBe(0);
  });
});
