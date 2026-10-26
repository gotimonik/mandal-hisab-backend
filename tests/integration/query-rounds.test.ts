import { expect, it } from "vitest";
import { MongoClient } from "mongodb";
import { api, makePlatformAdmin, ok, registerAndLogin, uniq } from "../helpers/api";

/**
 * Performance guard: in production every sequential database round trip costs a full
 * API ↔ Atlas network round trip, so screens must not issue queries one-by-one or per
 * upad per month. We count "rounds" — a query that starts while no other query is in flight.
 */
it("screens use a small, fixed number of sequential database rounds", async () => {
  const uri = process.env.MONGODB_URI!;
  const client = new MongoClient(uri, { monitorCommands: true });
  await client.connect();
  const cache = ((globalThis as Record<string, unknown>).__mandalMongo ??= {}) as { client?: MongoClient; uri?: string; promise?: Promise<MongoClient> };
  const previous = cache.client;
  Object.assign(cache, { client, uri, promise: Promise.resolve(client) });
  let inflight = 0;
  let rounds = 0;
  const done = () => {
    inflight = Math.max(0, inflight - 1);
  };
  client.on("commandStarted", () => {
    if (inflight === 0) rounds++;
    inflight++;
  });
  client.on("commandSucceeded", done);
  client.on("commandFailed", done);

  try {
    const admin = await registerAndLogin("Rounds Admin");
    const org = await ok(api("POST", "/organizations", { token: admin.token, body: { name: "Rounds Mandal", monthlyHaptaAmount: "500", haptaStartMonth: "2026-04" } }));
    const pa = await registerAndLogin("PA");
    await makePlatformAdmin(pa.userId);
    await ok(api("PATCH", `/platform/organizations/${org.id}`, { token: pa.token, body: { action: "approve" } }));
    const o = org.id as string;
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await ok(api("POST", `/orgs/${o}/members`, { token: admin.token, body: { name: `M${i}`, joiningDate: "2026-04-01" } })))._id);
    for (const m of ["2026-04", "2026-05"]) {
      const v = await ok(api("GET", `/orgs/${o}/monthly?month=${m}`, { token: admin.token }));
      for (const r of v.rows) await ok(api("POST", `/orgs/${o}/monthly/collect`, { token: admin.token, body: { installmentId: r.installmentId, amount: "500", date: `${m}-05`, idempotencyKey: uniq("c") } }));
    }
    // several upad, months old — the work must not grow with upad × months
    for (let i = 0; i < 4; i++) await ok(api("POST", `/orgs/${o}/fund-loans`, { token: admin.token, body: { memberId: ids[i], amount: "500", date: "2026-05-10", monthlyRate: "2", idempotencyKey: uniq("f") } }));

    const roundsFor = async (path: string) => {
      await ok(api("GET", path, { token: admin.token })); // first call may create interest dues
      rounds = 0;
      await ok(api("GET", path, { token: admin.token }));
      return rounds;
    };
    expect(await roundsFor("/auth/me")).toBeLessThanOrEqual(2);
    expect(await roundsFor(`/orgs/${o}`)).toBeLessThanOrEqual(2);
    expect(await roundsFor(`/orgs/${o}/dashboard`)).toBeLessThanOrEqual(7);
    expect(await roundsFor(`/orgs/${o}/monthly`)).toBeLessThanOrEqual(7);
    expect(await roundsFor(`/orgs/${o}/fund-loans`)).toBeLessThanOrEqual(6);
    expect(await roundsFor(`/orgs/${o}/fund-loans/month`)).toBeLessThanOrEqual(8);
  } finally {
    Object.assign(cache, { client: previous, promise: previous ? Promise.resolve(previous) : undefined });
    await client.close();
  }
}, 120000);
