import { NextRequest } from "next/server";
import { createApiHandler } from "@/lib/http";
import { buildRouter } from "@/routes";

const handler = createApiHandler(buildRouter(), "/api/v1");

export interface ApiResult<T = any> {
  status: number;
  data: T;
  error?: { code: string; message: string; details?: unknown };
}

let ipCounter = 0;

/** Call the real HTTP handler (routing, auth, validation, tenant guards). */
export async function api<T = any>(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; form?: FormData } = {},
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { "x-forwarded-for": `10.0.0.${(ipCounter++ % 250) + 1}` };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const req = new NextRequest(`http://localhost/api/v1${path}`, {
    method,
    headers,
    // multipart: the Request sets the content-type (with its boundary) itself
    body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  const res = await handler(req);
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("json")) return { status: res.status, data: (await res.text()) as T };
  const json = (await res.json()) as { data?: T; error?: ApiResult["error"] };
  return { status: res.status, data: json.data as T, error: json.error };
}

export async function ok<T = any>(p: Promise<ApiResult<T>>): Promise<T> {
  const r = await p;
  if (r.status >= 300) throw new Error(`Expected success, got ${r.status}: ${JSON.stringify(r.error)}`);
  return r.data;
}

let n = 0;
export const uniq = (p = "k") => `${p}-${Date.now().toString(36)}-${(n++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** Open the verification link from the last email sent to this address (new accounts must verify). */
export async function verifyEmailFromMail(email: string) {
  const { sentEmails } = await import("@/services/email.service");
  const mail = sentEmails.filter((m) => m.to === email && /verify-email\?token=/.test(m.text ?? "")).pop();
  if (!mail) throw new Error(`no verification email for ${email}`);
  const token = decodeURIComponent((mail.text ?? "").match(/verify-email\?token=([^\s]+)/)![1]);
  return ok<{ ok: true; email: string | null }>(api("POST", "/auth/verify-email", { body: { token } }));
}

export async function registerAndLogin(name = "User") {
  const email = `${uniq("u")}@example.com`.toLowerCase();
  const password = "secret123";
  const reg = await ok(api("POST", "/auth/register", { body: { name, email, password } }));
  await verifyEmailFromMail(email);
  const login = await ok<{ token: string }>(api("POST", "/auth/login", { body: { email, password } }));
  return { token: login.token, userId: reg.id as string, email, password };
}

export async function makePlatformAdmin(userId: string) {
  const { cols } = await import("@/lib/collections");
  const { ObjectId } = await import("mongodb");
  const c = await cols();
  await c.users.updateOne({ _id: new ObjectId(userId) }, { $set: { isPlatformAdmin: true } });
}

/** Create an org via the API and approve it as platform admin. Returns ids and tokens. */
export async function setupOrg(name = "Shree Ganesh Mandal") {
  const admin = await registerAndLogin("Org Admin");
  const org = await ok(api("POST", "/organizations", { token: admin.token, body: { name } }));
  const pa = await registerAndLogin("Platform Admin");
  await makePlatformAdmin(pa.userId);
  await ok(api("PATCH", `/platform/organizations/${org.id}`, { token: pa.token, body: { action: "approve" } }));
  const accounts = await ok<any[]>(api("GET", `/orgs/${org.id}/accounts`, { token: admin.token }));
  return { orgId: org.id as string, code: org.code as string, admin, platformAdmin: pa, cashAccountId: accounts[0]._id as string };
}

/** Add a user to an org with a role (join request + approval). */
export async function addUser(orgId: string, code: string, adminToken: string, role: "admin" | "manager" | "member", memberId?: string) {
  const u = await registerAndLogin(role);
  await ok(api("POST", "/organizations/join", { token: u.token, body: { code } }));
  const ms = await ok<any[]>(api("GET", `/orgs/${orgId}/memberships?status=pending`, { token: adminToken }));
  const m = ms.find((x) => x.user._id === u.userId);
  await ok(api("PATCH", `/orgs/${orgId}/memberships/${m._id}`, { token: adminToken, body: { action: "approve", role, memberId } }));
  return u;
}
