/**
 * Create all MongoDB indexes. Safe to run repeatedly.
 *   npm run db:init
 */
import "./load-env";
import { ensureIndexes } from "../src/lib/collections";
import { closeDb } from "../src/lib/db";

async function main() {
  await ensureIndexes();
  console.info("Indexes are in place.");
  await closeDb();
}

main().catch(async (e) => {
  console.error(e);
  await closeDb();
  process.exit(1);
});
