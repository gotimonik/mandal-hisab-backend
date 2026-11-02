import { z } from "zod";
import type { Router } from "@/lib/http";
import { parseObjectId, requirePlatformAdmin } from "@/lib/auth";
import * as orgService from "@/services/organization.service";
import { cols } from "@/lib/collections";
import { deactivateUser, publicUser } from "@/services/auth.service";
import { reason } from "@/validators/common";
import { badRequest } from "@/lib/errors";
import { formFile } from "@/services/upload.service";
import { BackupError, backupText, restoreBackup } from "@/services/backup.service";
import { downloadServerBackup, listServerBackups, runServerBackup } from "@/services/server-backup.service";

export function registerPlatformRoutes(r: Router) {
  r.get("/platform/stats", async (req) => {
    requirePlatformAdmin(await req.auth());
    return orgService.platformStats();
  });
  r.get("/platform/organizations", async (req) => {
    requirePlatformAdmin(await req.auth());
    const q = req.queryAs(z.object({ status: z.enum(["pending", "active", "suspended", "archived"]).optional(), q: z.string().max(100).optional() }));
    return orgService.platformListOrganizations(q.status, q.q);
  });
  r.patch("/platform/organizations/:id", async (req) => {
    const auth = await req.auth();
    requirePlatformAdmin(auth);
    return orgService.platformUpdateOrganization(auth, parseObjectId(req.params.id), await req.body(orgService.PlatformOrgActionSchema));
  });
  /* A Mandal admin's backup file → back into the database. ?dryRun=1 checks it and changes nothing. */
  r.post("/platform/backups/restore", async (req) => {
    const auth = await req.auth();
    requirePlatformAdmin(auth);
    const flag = (k: string) => req.query.get(k) === "1";
    const file = await formFile(req, 5 * 1024 * 1024, "The backup file is too big to upload (max 5 MB). Restore it with npm run backup:restore instead.");
    try {
      return await restoreBackup(backupText(new Uint8Array(await file.arrayBuffer())), { dryRun: flag("dryRun"), replace: flag("replace"), trustUnsigned: flag("trustUnsigned"), actorId: auth.user._id });
    } catch (e) {
      if (e instanceof BackupError) throw badRequest(e.message);
      throw e;
    }
  });
  /* nightly encrypted copies of the whole database (server-backup.service) */
  r.get("/platform/server-backups", async (req) => {
    requirePlatformAdmin(await req.auth());
    return listServerBackups();
  });
  r.post("/platform/server-backups", async (req) => {
    const auth = await req.auth();
    requirePlatformAdmin(auth);
    const r = await runServerBackup(new Date(), auth.user._id);
    if (r.skipped) throw badRequest(`Server backups aren't set up: ${r.reason}`);
    return r;
  });
  r.get("/platform/server-backups/download", async (req) => {
    requirePlatformAdmin(await req.auth());
    const name = req.query.get("name") ?? "";
    const bytes = await downloadServerBackup(name);
    if (!bytes) throw badRequest("Backup not found");
    return new Response(Buffer.from(bytes), { status: 200, headers: { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" } });
  });
  r.get("/platform/users", async (req) => {
    requirePlatformAdmin(await req.auth());
    const q = req.queryAs(z.object({ q: z.string().max(100).optional() }));
    const c = await cols();
    const filter = q.q ? { email: { $regex: q.q.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&") } } : {};
    const users = await c.users.find(filter).sort({ createdAt: -1 }).limit(100).toArray();
    return users.map(publicUser);
  });
  r.post("/platform/users/:id/deactivate", async (req) => {
    const auth = await req.auth();
    requirePlatformAdmin(auth);
    const b = await req.body(z.object({ reason }));
    const id = parseObjectId(req.params.id);
    if (id.equals(auth.user._id)) throw badRequest("You cannot deactivate yourself");
    await deactivateUser(auth, id, b.reason);
    return { ok: true };
  });
}
