import type { Router } from "@/lib/http";
import { csvResponse } from "@/lib/http";
import { parseObjectId } from "@/lib/auth";
import { toCsv } from "@/lib/csv";
import * as p from "@/services/personal.service";
import * as rem from "@/services/personal-reminders.service";

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
  r.patch(`${base}/entries/:id`, async (req) => p.updateEntry(await req.auth(), parseObjectId(req.params.id, "Entry"), await req.body(p.EntryUpdateSchema)));
  r.delete(`${base}/entries/:id`, async (req) => p.deleteEntry(await req.auth(), parseObjectId(req.params.id, "Entry")));

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
  r.post(`${base}/reminders/:id/skip`, async (req) => rem.skipReminder(await req.auth(), parseObjectId(req.params.id, "Reminder")));

  r.patch(`${base}/settings`, async (req) => p.updateSettings(await req.auth(), await req.body(p.SettingsSchema)));
}
