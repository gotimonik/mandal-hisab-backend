import { z } from "zod";
import type { Router } from "@/lib/http";
import { parseObjectId, requirePlatformAdmin } from "@/lib/auth";
import * as orgService from "@/services/organization.service";
import { cols } from "@/lib/collections";
import { deactivateUser, publicUser } from "@/services/auth.service";
import { reason } from "@/validators/common";
import { badRequest } from "@/lib/errors";

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
