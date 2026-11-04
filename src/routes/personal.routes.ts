import type { Router } from "@/lib/http";
import { csvResponse } from "@/lib/http";
import { parseObjectId } from "@/lib/auth";
import { toCsv } from "@/lib/csv";
import * as p from "@/services/personal.service";
import * as rem from "@/services/personal-reminders.service";
import * as ms from "@/services/personal-mandal.service";
import * as bills from "@/services/personal-bills.service";
import * as books from "@/services/personal-books.service";
import type { ApiRequest } from "@/lib/http";
import { BILL_MAX_BYTES, BILL_TOO_BIG, formFile } from "@/services/upload.service";
import { z } from "zod";

/**
 * Personal Hisab: the signed-in person's own money book. User-level (req.auth()), never inside a
 * Mandal — the service filters every read and write by the caller's own user id.
 */
/** The signed-in person, scoped to the book this request is about (X-Personal-Book; main book by default). */
const pauth = async (req: ApiRequest) => books.withBook(await req.auth(), req.raw.headers.get("x-personal-book"));

export function registerPersonalRoutes(r: Router) {
  const base = "/me/personal";

  // books: separate hisabs under one login ("Personal", "Office" …)
  r.get(`${base}/books`, async (req) => books.listBooks(await pauth(req)));
  r.post(`${base}/books`, async (req) => books.createBook(await pauth(req), await req.body(books.BookSchema)));
  r.patch(`${base}/books/:id`, async (req) => books.renameBook(await pauth(req), parseObjectId(req.params.id, "Book"), await req.body(books.BookSchema)));
  r.delete(`${base}/books/:id`, async (req) => books.deleteBook(await pauth(req), parseObjectId(req.params.id, "Book"), await req.body(books.BookDeleteSchema)));

  r.get(`${base}/overview`, async (req) => p.overview(await pauth(req), req.queryAs(p.OverviewQuery)));
  r.get(`${base}/summary`, async (req) => p.summary(await pauth(req), req.queryAs(p.SummaryQuery)));
  r.get(`${base}/passbook`, async (req) => p.passbook(await pauth(req), req.queryAs(p.PassbookQuery)));

  r.get(`${base}/entries`, async (req) => {
    const auth = await pauth(req);
    const q = req.queryAs(p.EntryListQuery);
    if (q.format === "csv") {
      const t = await p.entriesCsv(auth, q);
      return csvResponse(`personal-hisab-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(t.headers, t.rows));
    }
    return p.listEntries(auth, q);
  });
  r.post(`${base}/entries`, async (req) => p.createEntry(await pauth(req), await req.body(p.EntrySchema)));
  r.patch(`${base}/entries/:id`, async (req) => p.updateEntry(await pauth(req), parseObjectId(req.params.id, "Entry"), await req.body(z.unknown())));
  r.delete(`${base}/entries/:id`, async (req) => p.deleteEntry(await pauth(req), parseObjectId(req.params.id, "Entry")));

  // bills: scan (upload + read), the monthly count, the file itself, and removing an unsaved one
  r.post(`${base}/bills`, async (req) => bills.scanBill(await pauth(req), await formFile(req, BILL_MAX_BYTES, BILL_TOO_BIG)));
  r.get(`${base}/bills/usage`, async (req) => bills.billUsage(await pauth(req)));
  r.get(`${base}/bills/:id/file`, async (req) => bills.billFile(await pauth(req), parseObjectId(req.params.id, "Bill")));
  r.delete(`${base}/bills/:id`, async (req) => bills.deleteBill(await pauth(req), parseObjectId(req.params.id, "Bill")));

  r.get(`${base}/wallets`, async (req) => p.listWallets(await pauth(req)));
  r.post(`${base}/wallets`, async (req) => p.createWallet(await pauth(req), await req.body(p.WalletSchema)));
  r.patch(`${base}/wallets/:id`, async (req) => p.updateWallet(await pauth(req), parseObjectId(req.params.id, "Wallet"), await req.body(p.WalletUpdateSchema)));
  r.delete(`${base}/wallets/:id`, async (req) => p.deleteWallet(await pauth(req), parseObjectId(req.params.id, "Wallet")));

  r.get(`${base}/categories`, async (req) => p.listCategories(await pauth(req)));
  r.post(`${base}/categories`, async (req) => p.createCategory(await pauth(req), await req.body(p.CategorySchema)));
  r.patch(`${base}/categories/:id`, async (req) => p.updateCategory(await pauth(req), parseObjectId(req.params.id, "Category"), await req.body(p.CategoryUpdateSchema)));
  r.delete(`${base}/categories/:id`, async (req) => p.deleteCategory(await pauth(req), parseObjectId(req.params.id, "Category")));

  r.get(`${base}/reminders`, async (req) => rem.listReminders(await pauth(req), { markRead: req.query.get("markRead") === "1" }));
  r.post(`${base}/reminders`, async (req) => rem.createReminder(await pauth(req), await req.body(rem.ReminderSchema)));
  r.patch(`${base}/reminders/:id`, async (req) => rem.updateReminder(await pauth(req), parseObjectId(req.params.id, "Reminder"), await req.body(rem.ReminderUpdateSchema)));
  r.delete(`${base}/reminders/:id`, async (req) => rem.deleteReminder(await pauth(req), parseObjectId(req.params.id, "Reminder")));
  r.post(`${base}/reminders/:id/paid`, async (req) => rem.markPaid(await pauth(req), parseObjectId(req.params.id, "Reminder"), await req.body(rem.PaidSchema)));
  r.post(`${base}/reminders/:id/later`, async (req) => rem.remindLater(await pauth(req), parseObjectId(req.params.id, "Reminder"), await req.body(rem.LaterSchema)));
  r.post(`${base}/reminders/:id/skip`, async (req) => rem.skipReminder(await pauth(req), parseObjectId(req.params.id, "Reminder")));

  r.get(`${base}/mandal-sync`, async (req) => ms.getMandalSync(await pauth(req)));
  r.patch(`${base}/mandal-sync`, async (req) => ms.updateMandalSync(await pauth(req), await req.body(ms.MandalSyncSchema)));

  r.patch(`${base}/settings`, async (req) => p.updateSettings(await pauth(req), await req.body(p.SettingsSchema)));
}
