/**
 * Create the two example Mandals for an existing app user (who becomes their admin):
 *   - Parivar Mandal          — ₹500 per member per month
 *   - College Friends Mandal  — ₹1,000 per member per month
 *
 *   SEED_ADMIN_EMAIL=you@example.com [SEED_START_MONTH=2026-04] npm run seed:example
 *
 * Only configuration is created (Mandal, cash account, monthly hapta, the admin as a member).
 * No sample members or transactions — add real members/invite people from the app.
 * Safe to run again: a Mandal the user already administers with the same name is skipped.
 */
import "./load-env";
import type { AuthContext } from "../src/lib/auth";
import { cols, ensureIndexes } from "../src/lib/collections";
import { closeDb } from "../src/lib/db";
import { CreateOrgSchema, createOrganization } from "../src/services/organization.service";

const EXAMPLES = [
  { name: "Parivar Mandal", description: "Family savings Mandal — ₹500 per member every month.", monthlyHaptaAmount: "500" },
  { name: "College Friends Mandal", description: "College friends' savings Mandal — ₹1,000 per member every month.", monthlyHaptaAmount: "1000" },
];

async function main() {
  const email = (process.env.SEED_ADMIN_EMAIL ?? "").trim().toLowerCase();
  if (!email) throw new Error("Set SEED_ADMIN_EMAIL to the email of a registered user");
  const startMonth = process.env.SEED_START_MONTH;
  await ensureIndexes();
  const c = await cols();
  const user = await c.users.findOne({ email });
  if (!user) throw new Error(`No user with email ${email}. Register in the app first.`);
  const auth = { user, session: { _id: null } } as unknown as AuthContext;

  for (const ex of EXAMPLES) {
    const mine = await c.organizationMemberships.find({ userId: user._id, role: "admin", status: "active" }, { projection: { organizationId: 1 } }).toArray();
    const exists = await c.organizations.findOne({ _id: { $in: mine.map((m) => m.organizationId) }, name: ex.name });
    if (exists) {
      console.info(`• ${ex.name} already exists (code ${exists.code}) — skipped`);
      continue;
    }
    const input = CreateOrgSchema.parse({ ...ex, haptaStartMonth: startMonth, haptaDueDay: 10, creatorIsMember: true });
    const org = await createOrganization(auth, input, "seed-script");
    console.info(`• Created ${ex.name} — join code ${org.code}, status ${org.status}${org.status === "pending" ? " (a platform admin must approve it)" : ""}`);
  }
  await closeDb();
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  await closeDb();
  process.exit(1);
});
