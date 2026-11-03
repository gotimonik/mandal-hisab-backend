import type { Router } from "@/lib/http";
import { csvResponse } from "@/lib/http";
import { parseObjectId } from "@/lib/auth";
import { toCsv } from "@/lib/csv";
import * as p from "@/services/personal.service";
import * as rem from "@/services/personal-reminders.service";
import * as ms from "@/services/personal-mandal.service";
import * as bills from "@/services/personal-bills.service";
import { BILL_MAX_BYTES, BILL_TOO_BIG, formFile } from "@/services/upload.service";
import { z } from "zod";

/**
 * Personal Hisab: the signed-in person's own money book. User-level (req.auth()), never inside a
 * Mandal — the service filters every read and write by the caller's own user id.
 */
export function registerPersonalRoutes(r: Router) {
  const base = "/me/personal";

  r.get(`${base}/overview`, async (req) => p.overview(await req.auth(), req.queryAs(p.OverviewQuery)));
  r.get(`${base}/summary`, async (req) => p.summary(await req.auth(), req.queryAs(p.SummaryQuery)));

  r.get(`${base}/entries`, async (req) => {
    const auth = await req.auth();
    const q = req.queryAs(p.EntryListQuery);
    if (q.format === "csv") {
      const t = await p.entriesCsv(auth, q);
      return csvResponse(`personal-hisab-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(t.headers, t.rows));
    }
    return p.listEntries(auth, q);
  });
  r.post(`${base}/entries`, async (req) => p.createEntry(await req.auth(), await req.body(p.EntrySchema)));
  r.patch(`${base}/entries/:id`, async (req) => p.updateEntry(await req.auth(), parseObjectId(req.params.id, "Entry"), await req.body(z.unknown())));
  r.delete(`${base}/entries/:id`, async (req) => p.deleteEntry(await req.auth(), parseObjectId(req.params.id, "Entry")));

  // bills: scan (upload + read), the monthly count, the file itself, and removing an unsaved one
  r.post(`${base}/bills`, async (req) => bills.scanBill(await req.auth(), await formFile(req, BILL_MAX_BYTES, BILL_TOO_BIG)));
  r.get(`${base}/bills/usage`, async (req) => bills.billUsage(await req.auth()));
  r.get(`${base}/bills/:id/file`, async (req) => bills.billFile(await req.auth(), parseObjectId(req.params.id, "Bill")));
  r.delete(`${base}/bills/:id`, async (req) => bills.deleteBill(await req.auth(), parseObjectId(req.params.id, "Bill")));

  r.get(`${base}/wallets`, async (req) => p.listWallets(await req.auth()));
  r.post(`${base}/wallets`, async (req) => p.createWallet(await req.auth(), await req.body(p.WalletSchema)));
  r.patch(`${base}/wallets/:id`, async (req) => p.updateWallet(await req.auth(), parseObjectId(req.params.id, "Wallet"), await req.body(p.WalletUpdateSchema)));
  r.delete(`${base}/wallets/:id`, async (req) => p.deleteWallet(await req.auth(), parseObjectId(req.params.id, "Wallet")));

  r.get(`${base}/categories`, async (req) => p.listCategories(await req.auth()));
  r.post(`${base}/categories`, async (req) => p.createCategory(await req.auth(), await req.body(p.CategorySchema)));
  r.patch(`${base}/categories/:id`, async (req) => p.updateCategory(await req.auth(), parseObjectId(req.params.id, "Category"), await req.body(p.CategoryUpdateSchema)));
  r.delete(`${base}/categories/:id`, async (req) => p.deleteCategory(await req.auth(), parseObjectId(req.params.id, "Category")));

  r.get(`${base}/reminders`, async (req) => rem.listReminders(await req.auth(), { markRead: req.query.get("markRead") === "1" }));
  r.post(`${base}/reminders`, async (req) => rem.createReminder(await req.auth(), await req.body(rem.ReminderSchema)));
  r.patch(`${base}/reminders/:id`, async (req) => rem.updateReminder(await req.auth(), parseObjectId(req.params.id, "Reminder"), await req.body(rem.ReminderUpdateSchema)));
  r.delete(`${base}/reminders/:id`, async (req) => rem.deleteReminder(await req.auth(), parseObjectId(req.params.id, "Reminder")));
  r.post(`${base}/reminders/:id/paid`, async (req) => rem.markPaid(await req.auth(), parseObjectId(req.params.id, "Reminder"), await req.body(rem.PaidSchema)));
  r.post(`${base}/reminders/:id/later`, async (req) => rem.remindLater(await req.auth(), parseObjectId(req.params.id, "Reminder"), await req.body(rem.LaterSchema)));
  r.post(`${base}/reminders/:id/skip`, async (req) => rem.skipReminder(await req.auth(), parseObjectId(req.params.id, "Reminder")));

  r.get(`${base}/mandal-sync`, async (req) => ms.getMandalSync(await req.auth()));
  r.patch(`${base}/mandal-sync`, async (req) => ms.updateMandalSync(await req.auth(), await req.body(ms.MandalSyncSchema)));

  r.patch(`${base}/settings`, async (req) => p.updateSettings(await req.auth(), await req.body(p.SettingsSchema)));
}
