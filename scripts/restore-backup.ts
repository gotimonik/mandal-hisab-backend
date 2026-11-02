/**
 * Load a Mandal back from the backup file its admin downloaded (Settings → Backup).
 *
 *   npm run backup:restore -- MandalHisab-backup-ABC123-2026-11-02.json --dry-run   # check only
 *   npm run backup:restore -- MandalHisab-backup-ABC123-2026-11-02.json             # restore
 *
 * Options:
 *   --dry-run         check the file and show what would be restored; change nothing
 *   --replace         the Mandal still exists: delete it and load the backup instead
 *   --trust-unsigned  load a file whose signature doesn't match (edited, or another AUTH_SECRET)
 *
 * Uses MONGODB_URI / MONGODB_DB / AUTH_SECRET from .env.local (the same values as production).
 * People who had no account any more get one back without a password: they use "Forgot password".
 */
import "./load-env";
import { readFileSync } from "node:fs";
import { BackupError, backupText, restoreBackup } from "../src/services/backup.service";
import { closeDb } from "../src/lib/db";

async function main() {
  const args = process.argv.slice(2);
  const path = args.find((a) => !a.startsWith("--"));
  if (!path) throw new BackupError("Give the backup file: npm run backup:restore -- <file.json> [--dry-run] [--replace]");
  const r = await restoreBackup(backupText(readFileSync(path)), {
    dryRun: args.includes("--dry-run"),
    replace: args.includes("--replace"),
    trustUnsigned: args.includes("--trust-unsigned"),
  });
  console.info(`${r.dryRun ? "Checked (nothing changed)" : "Restored"}: ${r.organization.name} (${r.organization.code}) — backup of ${r.backupCreatedAt}`);
  console.info(`Signature: ${r.signatureValid ? "valid" : "NOT valid"}${r.replacedExisting ? " · replaced the Mandal that was in the database" : r.existsInDatabase ? " · the Mandal is still in the database (restore needs --replace)" : ""}`);
  console.info(`People: ${r.usersMatchedByEmail} already have an account, ${r.usersCreated} ${r.dryRun ? "would get" : "got"} theirs back (they set a password with "Forgot password")`);
  for (const [name, n] of Object.entries(r.counts)) if (n) console.info(`  ${name.padEnd(26)} ${n}`);
}

main()
  .catch((e) => {
    console.error(e instanceof BackupError ? `✗ ${e.message}` : e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
