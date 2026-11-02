import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { gzipSync } from "node:zlib";
import { createApiHandler } from "@/lib/http";
import { buildRouter } from "@/routes";
import { COLLECTION_NAMES, cols } from "@/lib/collections";
import { BackupError, NOT_IN_BACKUP, ORG_COLLECTIONS, SPECIAL_IN_BACKUP, readBackup, restoreBackup } from "@/services/backup.service";
import { addUser, api, ok, registerAndLogin, setupOrg, uniq, verifyEmailFromMail } from "../helpers/api";

/**
 * The admin downloads a backup of their Mandal; after the database is lost, the backup is loaded
 * back with scripts/restore-backup.ts and the Mandal is exactly as it was.
 */

const handler = createApiHandler(buildRouter(), "/api/v1");
/** The backup file exactly as the browser gets it. */
async function download(orgId: string, token: string) {
  const res = await handler(new NextRequest(`http://localhost/api/v1/orgs/${orgId}/backup`, { headers: { authorization: `Bearer ${token}` } }));
  return { status: res.status, disposition: res.headers.get("content-disposition") ?? "", text: await res.text() };
}

/** Lose the Mandal: every record of it, and (some of) its people's accounts. */
async function disaster(orgId: string, userIds: string[]) {
  const c = await cols();
  const id = new ObjectId(orgId);
  for (const name of ORG_COLLECTIONS) await (c[name] as any).deleteMany({ organizationId: id });
  await c.counters.deleteMany({ _id: { $regex: `^${orgId}:` } });
  await c.organizations.deleteOne({ _id: id });
  await c.users.deleteMany({ _id: { $in: userIds.map((u) => new ObjectId(u)) } });
}

const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

describe("Mandal backup", () => {
  it("covers every collection: each one is in the backup or left out on purpose", () => {
    expect([...ORG_COLLECTIONS, ...NOT_IN_BACKUP, ...SPECIAL_IN_BACKUP].sort()).toEqual([...COLLECTION_NAMES].sort());
  });

  it("backup → database lost → restore gives back the same Mandal", async () => {
    const o = await setupOrg("Backup Mandal");
    const members = [];
    for (const n of ["Asha Saver", "કિરણ પટેલ"]) members.push((await ok(api("POST", `/orgs/${o.orgId}/members`, { token: o.admin.token, body: { name: n } })))._id as string);
    const kiran = await addUser(o.orgId, o.code, o.admin.token, "member", members[1]);
    await ok(api("POST", `/orgs/${o.orgId}/cashbook/entries`, { token: o.admin.token, body: { direction: "in", amount: "5000", date: today(), description: "Opening cash", idempotencyKey: uniq("ce") } }));
    const loan = (await ok(api("POST", `/orgs/${o.orgId}/fund-loans`, { token: o.admin.token, body: { memberId: members[1], amount: "1500", date: today(), monthlyRate: "2", idempotencyKey: uniq("fl") } }))).loan;
    await ok(api("PATCH", `/orgs/${o.orgId}`, { token: o.admin.token, body: { address: "Pramukh Chhaya" } }));
    await ok(api("POST", `/orgs/${o.orgId}/meetings`, { token: o.admin.token, body: { date: future(3), time: "18:30", idempotencyKey: uniq("mt") } }));

    // what the admin sees before
    const before = {
      org: await ok(api("GET", `/orgs/${o.orgId}`, { token: o.admin.token })),
      members: (await ok(api("GET", `/orgs/${o.orgId}/members`, { token: o.admin.token }))).items.map((m: any) => [m._id, m.name, m.membershipNumber]),
      accounts: (await ok<any[]>(api("GET", `/orgs/${o.orgId}/accounts`, { token: o.admin.token }))).map((a) => [a._id, a.name, a.balancePaise]),
      loan: (await ok(api("GET", `/orgs/${o.orgId}/fund-loans/${loan._id}`, { token: o.admin.token }))).loan,
      meetings: (await ok(api("GET", `/orgs/${o.orgId}/meetings`, { token: o.admin.token }))).upcoming.length,
    };

    // only the Mandal's own admins can download it
    expect((await download(o.orgId, kiran.token)).status).toBe(403);
    expect((await download(o.orgId, o.platformAdmin.token)).status).toBe(403);
    const file = await download(o.orgId, o.admin.token);
    expect(file.status).toBe(200);
    expect(file.disposition).toMatch(new RegExp(`attachment; filename="MandalHisab-backup-${before.org.code}-\\d{4}-\\d{2}-\\d{2}\\.json"`));
    // no secrets in it
    expect(file.text).not.toMatch(/passwordHash|tokenHash.*session|\$2[aby]\$/);
    const { file: parsed, signatureValid, data } = readBackup(file.text);
    expect(signatureValid).toBe(true);
    expect(parsed.organization).toMatchObject({ id: o.orgId, name: "Backup Mandal" });
    expect(data.members.map((m) => m.name)).toEqual(expect.arrayContaining(["Asha Saver", "કિરણ પટેલ"]));
    expect(data.users.map((u) => u.email)).toEqual(expect.arrayContaining([kiran.email, o.admin.email]));
    expect(data.fundLoans[0]._id).toBeInstanceOf(ObjectId);
    expect(await ok(api("GET", `/orgs/${o.orgId}/backup/status`, { token: o.admin.token }))).toMatchObject({ lastBackupBy: "Org Admin", due: false });

    // the database loses the Mandal and both people's accounts; the admin signs up again (new id)
    await disaster(o.orgId, [o.admin.userId, kiran.userId]);
    expect((await api("GET", `/orgs/${o.orgId}`, { token: o.admin.token })).status).toBe(401); // account gone
    const reg = await ok(api("POST", "/auth/register", { body: { name: "Admin Again", email: o.admin.email, password: "newpass123" } }));
    await verifyEmailFromMail(o.admin.email);
    const admin2 = await ok<{ token: string }>(api("POST", "/auth/login", { body: { email: o.admin.email, password: "newpass123" } }));

    // check first (changes nothing), then restore
    const dry = await restoreBackup(file.text, { dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, signatureValid: true, usersMatchedByEmail: 1, usersCreated: 1 });
    expect((await api("GET", `/orgs/${o.orgId}`, { token: admin2.token })).status).toBe(404);
    const r = await restoreBackup(file.text);
    expect(r).toMatchObject({ dryRun: false, replacedExisting: false, usersMatchedByEmail: 1, usersCreated: 1 });

    // the re-registered admin is admin of the same Mandal again, with the same data
    const after = {
      org: await ok(api("GET", `/orgs/${o.orgId}`, { token: admin2.token })),
      members: (await ok(api("GET", `/orgs/${o.orgId}/members`, { token: admin2.token }))).items.map((m: any) => [m._id, m.name, m.membershipNumber]),
      accounts: (await ok<any[]>(api("GET", `/orgs/${o.orgId}/accounts`, { token: admin2.token }))).map((a) => [a._id, a.name, a.balancePaise]),
      loan: (await ok(api("GET", `/orgs/${o.orgId}/fund-loans/${loan._id}`, { token: admin2.token }))).loan,
      meetings: (await ok(api("GET", `/orgs/${o.orgId}/meetings`, { token: admin2.token }))).upcoming.length,
    };
    expect(after.org.myRole).toBe("admin");
    expect({ ...after.org, myMemberId: null }).toEqual({ ...before.org, myMemberId: null });
    expect(after.members).toEqual(before.members);
    expect(after.accounts).toEqual(before.accounts);
    // same upad; "given by" now points to the admin's new account
    expect({ ...after.loan, createdBy: null }).toEqual({ ...before.loan, createdBy: null });
    expect(before.loan.createdBy).toBe(o.admin.userId);
    expect(after.loan.createdBy).toBe(reg.id);
    expect(after.meetings).toBe(1);
    // numbering carries on: the next upad gets the next number, not 0001 again
    const next = (await ok(api("POST", `/orgs/${o.orgId}/fund-loans`, { token: admin2.token, body: { memberId: members[0], amount: "100", date: today(), monthlyRate: "2", idempotencyKey: uniq("fl") } }))).loan;
    expect(next.number).not.toBe(loan.number);

    // Kiran's account is back without a password: the old one doesn't work, "Forgot password" does
    expect((await api("POST", "/auth/login", { body: { email: kiran.email, password: "secret123" } })).status).toBe(401);
    const c = await cols();
    const k = await c.users.findOne({ email: kiran.email });
    expect(k?._id.toHexString()).toBe(kiran.userId);
    expect(k?.isPlatformAdmin).toBe(false);

    // the restore is in the Mandal's audit log
    const audit = await ok(api("GET", `/orgs/${o.orgId}/audit-logs`, { token: admin2.token }));
    expect((audit.items ?? audit).some((a: any) => a.action === "organization.restore")).toBe(true);
  });

  it("refuses an edited file, and won't overwrite a Mandal that still exists unless asked", async () => {
    const o = await setupOrg("Careful Mandal");
    await ok(api("POST", `/orgs/${o.orgId}/members`, { token: o.admin.token, body: { name: "Ramesh" } }));
    const file = (await download(o.orgId, o.admin.token)).text;

    // someone changes a name (or a balance) in the file
    const edited = file.replace("Ramesh", "Rajesh");
    expect(edited).not.toBe(file);
    expect(readBackup(edited).signatureValid).toBe(false);
    await expect(restoreBackup(edited, { replace: true })).rejects.toThrow(/changed after it was downloaded/);
    await expect(restoreBackup("not json")).rejects.toThrow(BackupError);
    await expect(restoreBackup(JSON.stringify({ format: "something-else" }))).rejects.toThrow(/isn't a MandalHisab backup/);

    // still in the database → needs --replace
    await expect(restoreBackup(file)).rejects.toThrow(/--replace/);
    await ok(api("POST", `/orgs/${o.orgId}/members`, { token: o.admin.token, body: { name: "Added after the backup" } }));
    const r = await restoreBackup(file, { replace: true });
    expect(r.replacedExisting).toBe(true);
    const names = (await ok(api("GET", `/orgs/${o.orgId}/members`, { token: o.admin.token }))).items.map((m: any) => m.name);
    expect(names).toContain("Ramesh");
    expect(names).not.toContain("Added after the backup");

    // --trust-unsigned loads an edited file deliberately
    const t = await restoreBackup(edited, { replace: true, trustUnsigned: true });
    expect(t.signatureValid).toBe(false);
  });

  it("only admins can see when the last backup was taken", async () => {
    const o = await setupOrg("Status Mandal");
    expect(await ok(api("GET", `/orgs/${o.orgId}/backup/status`, { token: o.admin.token }))).toEqual({ lastBackupAt: null, lastBackupBy: null, due: true });
    const m = await registerAndLogin("Plain member");
    expect((await api("GET", `/orgs/${o.orgId}/backup/status`, { token: m.token })).status).toBe(404);
  });

  it("platform admins restore from the admin panel: check first, then restore (compressed upload works)", async () => {
    const o = await setupOrg("Panel Mandal");
    await ok(api("POST", `/orgs/${o.orgId}/members`, { token: o.admin.token, body: { name: "Bhavna" } }));
    const text = (await download(o.orgId, o.admin.token)).text;
    const upload = (body: string | Uint8Array, q = "", token = o.platformAdmin.token) => {
      const form = new FormData();
      form.set("file", new File([body as BlobPart], "backup.json.gz", { type: "application/gzip" }));
      return api("POST", `/platform/backups/restore${q}`, { token, form });
    };
    // only platform admins
    expect((await upload(text, "?dryRun=1", o.admin.token)).status).toBe(403);

    // check: the Mandal is still there → reported, nothing changed
    const check = await ok(upload(gzipSync(text), "?dryRun=1"));
    expect(check).toMatchObject({ dryRun: true, signatureValid: true, existsInDatabase: true, organization: { name: "Panel Mandal" } });
    expect(check.counts.members).toBe(2); // the admin (also a member) and Bhavna

    // the Mandal is lost; restore it from the panel
    await disaster(o.orgId, []);
    expect(await ok(upload(gzipSync(text), "?dryRun=1"))).toMatchObject({ existsInDatabase: false });
    const r = await ok(upload(gzipSync(text)));
    expect(r).toMatchObject({ dryRun: false, replacedExisting: false });
    expect((await ok(api("GET", `/orgs/${o.orgId}/members`, { token: o.admin.token }))).items.map((m: any) => m.name)).toContain("Bhavna");
    // still there now → restoring again needs replace
    expect((await upload(text)).error?.message).toMatch(/--replace|still in the database/);
    expect(await ok(upload(text, "?replace=1"))).toMatchObject({ replacedExisting: true });
    // an edited file is refused unless trusted on purpose
    expect((await upload(text.replace("Bhavna", "Bhavana"), "?replace=1")).status).toBe(400);
    expect(await ok(upload(text.replace("Bhavna", "Bhavana"), "?replace=1&trustUnsigned=1"))).toMatchObject({ signatureValid: false });
    expect((await upload("garbage", "?dryRun=1")).status).toBe(400);
    // the restore is logged with the platform admin who did it
    const c = await cols();
    const log = await c.auditLogs.findOne({ organizationId: new ObjectId(o.orgId), action: "organization.restore" }, { sort: { createdAt: -1 } });
    expect(log?.actorId?.toHexString()).toBe(o.platformAdmin.userId);
  });
});
