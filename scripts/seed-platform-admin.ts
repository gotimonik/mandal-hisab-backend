/**
 * Create (or promote) the initial platform super-admin from environment variables.
 * Credentials are never hard-coded:
 *   PLATFORM_ADMIN_EMAIL=you@example.com PLATFORM_ADMIN_PASSWORD='...' npm run seed:admin
 * If the user already exists, it is promoted to platform admin and the password is left unchanged.
 */
import "./load-env";
import { ObjectId } from "mongodb";
import { cols, ensureIndexes } from "../src/lib/collections";
import { closeDb } from "../src/lib/db";
import { hashPassword } from "../src/lib/crypto";
import { passwordSchema } from "../src/services/auth.service";
import { audit } from "../src/lib/audit";

async function main() {
  const email = (process.env.PLATFORM_ADMIN_EMAIL ?? "").trim().toLowerCase();
  const password = process.env.PLATFORM_ADMIN_PASSWORD ?? "";
  const name = process.env.PLATFORM_ADMIN_NAME ?? "Platform Admin";
  if (!email) throw new Error("Set PLATFORM_ADMIN_EMAIL");
  await ensureIndexes();
  const c = await cols();
  const existing = await c.users.findOne({ email });
  if (existing) {
    await c.users.updateOne({ _id: existing._id }, { $set: { isPlatformAdmin: true, status: "active", updatedAt: new Date() } });
    await audit({ actorId: null, action: "platform.admin_promoted", entityType: "user", entityId: existing._id, reason: "seed script" });
    console.info(`Promoted existing user ${email} to platform admin.`);
  } else {
    const parsed = passwordSchema.safeParse(password);
    if (!parsed.success) throw new Error(`PLATFORM_ADMIN_PASSWORD: ${parsed.error.issues[0].message}`);
    const now = new Date();
    const _id = new ObjectId();
    await c.users.insertOne({
      _id,
      name,
      email,
      passwordHash: await hashPassword(password),
      emailVerifiedAt: now,
      isPlatformAdmin: true,
      status: "active",
      sessionVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    await audit({ actorId: null, action: "platform.admin_created", entityType: "user", entityId: _id, reason: "seed script" });
    console.info(`Created platform admin ${email}. Remove PLATFORM_ADMIN_PASSWORD from your environment now.`);
  }
  await closeDb();
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  await closeDb();
  process.exit(1);
});
