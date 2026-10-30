/**
 * Prepare Mandal search. Safe to run repeatedly.
 *   npm run db:search-index
 * 1. Fills in `nameLatin` (English spelling of Gujarati/Hindi names) where it is missing or stale.
 * 2. Creates or updates the Atlas Search index. It builds in the background; search falls back
 *    to a regex until it is ready.
 */
import "./load-env";
import { cols } from "../src/lib/collections";
import { closeDb } from "../src/lib/db";
import { ORG_SEARCH_DEFINITION, ORG_SEARCH_INDEX } from "../src/lib/search-index";
import { latinName } from "../src/lib/transliterate";

async function main() {
  const c = await cols();

  let changed = 0;
  for await (const o of c.organizations.find({}, { projection: { name: 1, nameLatin: 1 } })) {
    const next = latinName(o.name);
    if ((o.nameLatin ?? null) === next) continue;
    await c.organizations.updateOne({ _id: o._id }, { $set: { nameLatin: next } });
    console.info(`  ${o.name} → ${next ?? "(English name, none needed)"}`);
    changed++;
  }
  console.info(`English spellings updated for ${changed} Mandal(s).`);

  const existing = await c.organizations.listSearchIndexes(ORG_SEARCH_INDEX).toArray();
  if (existing.length) {
    await c.organizations.updateSearchIndex(ORG_SEARCH_INDEX, ORG_SEARCH_DEFINITION);
    console.info(`Updated search index "${ORG_SEARCH_INDEX}" on organizations (rebuilding in the background).`);
  } else {
    await c.organizations.createSearchIndex({ name: ORG_SEARCH_INDEX, definition: ORG_SEARCH_DEFINITION });
    console.info(`Created search index "${ORG_SEARCH_INDEX}" on organizations (building in the background).`);
  }
  await closeDb();
}

main().catch(async (e) => {
  console.error("Could not prepare search. Atlas Search needs an Atlas cluster (or the mongodb-atlas-local image).");
  console.error(e);
  await closeDb();
  process.exit(1);
});
