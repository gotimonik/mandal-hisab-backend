import { afterAll, inject } from "vitest";

process.env.MONGODB_URI = inject("mongoUri");

process.env.MONGODB_DB = `mh_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
process.env.ORG_REGISTRATION_POLICY = "approval";
process.env.DISABLE_RATE_LIMIT = "true";
process.env.CORS_ALLOWED_ORIGINS = "http://localhost:3000";

afterAll(async () => {
  const { getDb, closeDb } = await import("@/lib/db");
  const db = await getDb();
  await db.dropDatabase();
  await closeDb();
});
