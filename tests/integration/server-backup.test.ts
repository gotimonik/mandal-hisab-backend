import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { api, ok, setupOrg, uniq } from "../helpers/api";
import { COLLECTION_NAMES, cols } from "@/lib/collections";
import { resetEnvCache } from "@/config/env";
import { NOT_IN_SERVER_BACKUP, MemoryBackupStore, listServerBackups, readServerBackup, restoreServerBackup, runServerBackup, setBackupStoreForTests } from "@/services/server-backup.service";

/**
 * The nightly server backup: the whole database, encrypted, kept 30 days outside Atlas.
 * Restoring gives back one Mandal, or everything — and people sign in with their own passwords.
 */

const KEY = "a-long-random-backup-key-only-the-owner-knows-123";
const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const store = new MemoryBackupStore();

async function mandalWithData(name: string) {
  const o = await setupOrg(name);
  const t = o.admin.token;
  const member = (await ok(api("POST", `/orgs/${o.orgId}/members`, { token: t, body: { name: `${name} Member` } })))._id;
  await ok(api("POST", `/orgs/${o.orgId}/cashbook/entries`, { token: t, body: { direction: "in", amount: "5000", date: today(), description: "Opening cash", idempotencyKey: uniq("ce") } }));
  await ok(api("POST", `/orgs/${o.orgId}/fund-loans`, { token: t, body: { memberId: member, amount: "1000", date: today(), monthlyRate: "2", idempotencyKey: uniq("fl") } }));
  return o;
}
const login = (email: string, password = "secret123") => api("POST", "/auth/login", { body: { email, password } });

describe("nightly server backup", () => {
  beforeAll(() => {
    process.env.BACKUP_ENCRYPTION_KEY = KEY;
    resetEnvCache();
    setBackupStoreForTests(store);
  });
  afterAll(() => {
    delete process.env.BACKUP_ENCRYPTION_KEY;
    resetEnvCache();
    setBackupStoreForTests(undefined);
  });

  it("isn't taken until it's set up", async () => {
    delete process.env.BACKUP_ENCRYPTION_KEY;
    resetEnvCache();
    expect(await runServerBackup()).toMatchObject({ skipped: true, reason: expect.stringMatching(/BACKUP_ENCRYPTION_KEY/) });
    process.env.BACKUP_ENCRYPTION_KEY = KEY;
    resetEnvCache();
  });

  it("the daily cron writes an encrypted copy of everything; old copies are deleted after 30 days", async () => {
    const a = await mandalWithData("Server A");
    await mandalWithData("Server B");
    process.env.CRON_SECRET = "cron-secret-for-tests";
    resetEnvCache();
    const cron = await ok(api("GET", "/cron/daily", { token: "cron-secret-for-tests" }));
    expect(cron.serverBackup).toMatchObject({ skipped: false, name: expect.stringMatching(/^mandalhisab-.*\.mhsb$/) });
    const list = await listServerBackups();
    expect(list).toMatchObject({ configured: true, keepDays: 30, stale: false });
    expect(list.items).toHaveLength(1);

    const bytes = (await store.get(list.items[0].name))!;
    // encrypted: no names or emails readable in the file
    expect(Buffer.from(bytes).includes(Buffer.from("Server A"))).toBe(false);
    expect(Buffer.from(bytes).includes(Buffer.from(a.admin.email))).toBe(false);
    const { head, data } = readServerBackup(bytes, KEY);
    expect(head.counts.organizations).toBeGreaterThanOrEqual(2);
    expect(data.users.find((u) => u.email === a.admin.email)?.passwordHash).toMatch(/^\$2/); // kept, so people can sign in
    for (const n of NOT_IN_SERVER_BACKUP) expect(head.counts[n]).toBeUndefined();
    expect(Object.keys(head.counts).sort()).toEqual(COLLECTION_NAMES.filter((n) => !NOT_IN_SERVER_BACKUP.includes(n)).sort());

    // wrong key or a changed byte: refused
    expect(() => readServerBackup(bytes, "some-other-key-that-is-long-enough-123")).toThrow(/wrong BACKUP_ENCRYPTION_KEY/);
    const bad = Uint8Array.from(bytes);
    bad[bad.length - 5] ^= 0xff;
    expect(() => readServerBackup(bad, KEY)).toThrow(/changed or damaged/);

    // a copy from 31 days ago is cleaned up by the next run; the platform admin can also take one now
    await store.put("mandalhisab-old.mhsb", new Uint8Array([1]));
    store.files.get("mandalhisab-old.mhsb")!.at = new Date(Date.now() - 31 * 86_400_000);
    const pa = a.platformAdmin.token;
    const now = await ok(api("POST", "/platform/server-backups", { token: pa }));
    expect(now.deletedOld).toBe(1);
    expect((await ok(api("GET", "/platform/server-backups", { token: pa }))).items.map((i: any) => i.name)).not.toContain("mandalhisab-old.mhsb");
    expect((await api("GET", "/platform/server-backups", { token: a.admin.token })).status).toBe(403);
  });

  it("restores one Mandal from it — people sign in with their own password", async () => {
    const a = await mandalWithData("Lost Mandal");
    const r = await runServerBackup();
    const bytes = (await store.get((r as { name: string }).name))!;
    const before = await ok(api("GET", `/orgs/${a.orgId}/members`, { token: a.admin.token }));

    // the Mandal and its admin's account are lost
    const c = await cols();
    const id = new ObjectId(a.orgId);
    for (const n of COLLECTION_NAMES) if (n !== "users" && n !== "organizations" && n !== "counters") await (c[n] as any).deleteMany({ organizationId: id });
    await c.organizations.deleteOne({ _id: id });
    await c.users.deleteOne({ _id: new ObjectId(a.admin.userId) });
    expect((await login(a.admin.email)).status).toBe(401);

    const code = (await readServerBackup(bytes, KEY)).data.organizations.find((o) => String(o._id) === a.orgId)!.code as string;
    expect((await restoreServerBackup(bytes, KEY, { mandalCode: code, dryRun: true })).mandal).toMatchObject({ dryRun: true, usersCreated: 1 });
    await restoreServerBackup(bytes, KEY, { mandalCode: code });
    const back = await ok<{ token: string }>(login(a.admin.email));
    expect((await ok(api("GET", `/orgs/${a.orgId}/members`, { token: back.token }))).items).toEqual(before.items);
  });

  it("restores the whole database after it is lost completely", async () => {
    const a = await mandalWithData("Whole DB Mandal");
    const before = await ok(api("GET", `/orgs/${a.orgId}/fund-loans`, { token: a.admin.token }));
    const r = await runServerBackup();
    const bytes = (await store.get((r as { name: string }).name))!;

    // not over a database that still has Mandals
    await expect(restoreServerBackup(bytes, KEY)).rejects.toThrow(/already has/);

    // everything is gone
    const c = await cols();
    for (const n of COLLECTION_NAMES) await (c[n] as any).deleteMany({});
    expect((await login(a.admin.email)).status).toBe(401);

    const res = await restoreServerBackup(bytes, KEY);
    expect(res.dryRun).toBe(false);
    const back = await ok<{ token: string }>(login(a.admin.email));
    const after = await ok(api("GET", `/orgs/${a.orgId}/fund-loans`, { token: back.token }));
    expect(after.items.map((l: any) => [l._id, l.number, l.outstandingPaise])).toEqual(before.items.map((l: any) => [l._id, l.number, l.outstandingPaise]));
  });
});
