/**
 * Load the database back from a nightly server backup (platform panel → Server backups → download).
 *
 *   npm run backup:restore-server -- mandalhisab-2026-11-03T00-30-00Z.mhsb --dry-run              # check only
 *   npm run backup:restore-server -- mandalhisab-2026-11-03T00-30-00Z.mhsb --mandal ABC123         # one Mandal
 *   npm run backup:restore-server -- mandalhisab-2026-11-03T00-30-00Z.mhsb                         # everything, into an empty database
 *
 * Options:
 *   --dry-run        open the file and show what's in it; change nothing
 *   --mandal CODE    restore only the Mandal with this join code (people keep their passwords)
 *   --replace        with --mandal: that Mandal is still in the database — replace it
 *   --replace-all    restore everything over a database that isn't empty (deletes what's there first!)
 *
 * Needs BACKUP_ENCRYPTION_KEY (the same as when the backup was made) and MONGODB_URI / MONGODB_DB
 * of the database to restore into, from .env.local or the environment.
 */
import "./load-env";
import { readFileSync } from "node:fs";
import { BackupError } from "../src/services/backup.service";
import { restoreServerBackup } from "../src/services/server-backup.service";
import { closeDb } from "../src/lib/db";

async function main() {
  const args = process.argv.slice(2);
  const path = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--mandal");
  if (!path) throw new BackupError("Give the backup file: npm run backup:restore-server -- <file.mhsb> [--dry-run] [--mandal CODE] [--replace] [--replace-all]");
  const key = process.env.BACKUP_ENCRYPTION_KEY;
  if (!key) throw new BackupError("Set BACKUP_ENCRYPTION_KEY (the key the backup was made with)");
  const m = args.indexOf("--mandal");
  const r = await restoreServerBackup(readFileSync(path), key, {
    dryRun: args.includes("--dry-run"),
    mandalCode: m >= 0 ? args[m + 1] : undefined,
    replace: args.includes("--replace"),
    replaceAll: args.includes("--replace-all"),
  });
  console.info(`${r.dryRun ? "Checked (nothing changed)" : "Restored"}: server backup of ${r.createdAt}${r.mandal ? ` — ${r.mandal.organization.name} (${r.mandal.organization.code})` : " — whole database"}`);
  for (const [name, n] of Object.entries(r.counts)) if (n) console.info(`  ${name.padEnd(26)} ${n}`);
}

main()
  .catch((e) => {
    console.error(e instanceof BackupError ? `✗ ${e.message}` : e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
