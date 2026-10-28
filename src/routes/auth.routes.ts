import { z } from "zod";
import type { Router } from "@/lib/http";
import * as authService from "@/services/auth.service";
import * as orgService from "@/services/organization.service";
import * as pushService from "@/services/push.service";
import { listNotifications, markRead } from "@/services/notification.service";
import { email, pagination } from "@/validators/common";
import { parseObjectId } from "@/lib/auth";

export function registerAuthRoutes(r: Router) {
  r.get("/health", async () => ({ ok: true, time: new Date().toISOString() }));

  r.post("/auth/register", async (req) => authService.register(await req.body(authService.RegisterSchema), req.ip));
  r.post("/auth/login", async (req) =>
    authService.login(await req.body(authService.LoginSchema), { ip: req.ip, userAgent: req.userAgent }),
  );
  r.post("/auth/logout", async (req) => authService.logout(await req.auth()));
  r.post("/auth/logout-all", async (req) => authService.logoutAll(await req.auth()));
  r.get("/auth/me", async (req) => authService.me(await req.auth()));
  /* phone push notifications (iOS / Android app) */
  r.post("/me/push-devices", async (req) => pushService.registerDevice(await req.auth(), await req.body(pushService.PushDeviceSchema)));
  r.delete("/me/push-devices", async (req) => {
    const b = await req.body(z.object({ token: z.string().min(1).max(4096) }));
    return pushService.unregisterDevice(await req.auth(), b.token);
  });
  r.patch("/auth/me", async (req) => authService.updateProfile(await req.auth(), await req.body(authService.ProfileSchema)));
  r.post("/auth/change-password", async (req) => {
    const b = await req.body(z.object({ currentPassword: z.string().min(1), newPassword: authService.passwordSchema }));
    return authService.changePassword(await req.auth(), b.currentPassword, b.newPassword);
  });
  r.post("/auth/verify-email", async (req) => {
    const b = await req.body(z.object({ token: z.string().min(10).max(200) }));
    return authService.verifyEmail(b.token);
  });
  r.post("/auth/resend-verification", async (req) => authService.resendVerification(await req.auth()));
  /** Signed-out version, for people who registered but haven't verified yet (they can't sign in). */
  r.post("/auth/resend-verification-email", async (req) => {
    const b = await req.body(z.object({ email }));
    return authService.resendVerificationByEmail(b.email, req.ip);
  });
  r.post("/auth/forgot-password", async (req) => {
    const b = await req.body(z.object({ email }));
    return authService.forgotPassword(b.email, req.ip);
  });
  r.post("/auth/reset-password", async (req) => {
    const b = await req.body(z.object({ token: z.string().min(10).max(200), password: authService.passwordSchema }));
    return authService.resetPassword(b.token, b.password, req.ip);
  });

  // Organization onboarding (user-level)
  r.post("/organizations", async (req) =>
    orgService.createOrganization(await req.auth(), await req.body(orgService.CreateOrgSchema), req.ip),
  );
  r.get("/organizations/lookup", async (req) => {
    await req.auth();
    const { code } = req.queryAs(z.object({ code: z.string().trim().min(4).max(20) }));
    return orgService.lookupByCode(code);
  });
  r.post("/organizations/join", async (req) => orgService.requestToJoin(await req.auth(), await req.body(orgService.JoinSchema)));
  r.post("/invitations/accept", async (req) => {
    const b = await req.body(z.object({ token: z.string().min(10).max(200) }));
    return orgService.acceptInvitation(await req.auth(), b.token);
  });

  // Notifications (user-level, optionally filtered by org)
  r.get("/notifications", async (req) => {
    const q = req.queryAs(pagination.extend({ orgId: z.string().optional(), unread: z.enum(["true", "false"]).optional() }));
    return listNotifications(await req.auth(), {
      organizationId: q.orgId ? parseObjectId(q.orgId) : undefined,
      unreadOnly: q.unread === "true",
      page: q.page,
      pageSize: q.pageSize,
    });
  });
  r.post("/notifications/read", async (req) => {
    const b = await req.body(z.object({ ids: z.union([z.literal("all"), z.array(z.string()).max(500)]) }));
    return markRead(await req.auth(), b.ids === "all" ? "all" : b.ids.map((i) => parseObjectId(i)));
  });
}
