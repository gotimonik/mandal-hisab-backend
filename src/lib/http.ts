import { NextResponse, type NextRequest } from "next/server";
import { ZodError, type z } from "zod";
import { env } from "@/config/env";
import { AppError, badRequest } from "./errors";
import { authenticate, requireOrgAccess, type AuthContext, type OrgAccessOptions, type OrgContext } from "./auth";
import type { Permission } from "./permissions";
import { ensureIndexes } from "./collections";

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface ApiRequest {
  raw: NextRequest;
  method: Method;
  params: Record<string, string>;
  query: URLSearchParams;
  ip: string;
  userAgent: string;
  body<S extends z.ZodType>(schema: S): Promise<z.infer<S>>;
  queryAs<S extends z.ZodType>(schema: S): z.infer<S>;
  auth(): Promise<AuthContext>;
  org(permission: Permission, opts?: OrgAccessOptions): Promise<OrgContext>;
}

export type Handler = (req: ApiRequest) => Promise<unknown>;

interface Route {
  method: Method;
  parts: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];
  add(method: Method, path: string, handler: Handler) {
    this.routes.push({ method, parts: path.split("/").filter(Boolean), handler });
    return this;
  }
  get = (p: string, h: Handler) => this.add("GET", p, h);
  post = (p: string, h: Handler) => this.add("POST", p, h);
  patch = (p: string, h: Handler) => this.add("PATCH", p, h);
  delete = (p: string, h: Handler) => this.add("DELETE", p, h);

  match(method: string, segments: string[]): { route?: Route; params: Record<string, string>; pathMatched: boolean } {
    let pathMatched = false;
    for (const r of this.routes) {
      if (r.parts.length !== segments.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < r.parts.length; i++) {
        const p = r.parts[i];
        if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(segments[i]);
        else if (p !== segments[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      pathMatched = true;
      if (r.method === method) return { route: r, params, pathMatched };
    }
    return { params: {}, pathMatched };
  }
}

const MAX_JSON_BYTES = 1_000_000;

function corsHeaders(req: NextRequest): Record<string, string> {
  const origin = req.headers.get("origin");
  const allowed = env()
    .CORS_ALLOWED_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const h: Record<string, string> = { Vary: "Origin" };
  if (origin && allowed.includes(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "GET,POST,PATCH,PUT,DELETE,OPTIONS";
    h["Access-Control-Allow-Headers"] = "Authorization,Content-Type,Idempotency-Key";
    h["Access-Control-Max-Age"] = "600";
  }
  return h;
}

export function errorResponse(e: unknown): { status: number; body: unknown } {
  if (e instanceof AppError) {
    return { status: e.status, body: { error: { code: e.code, message: e.message, details: e.details } } };
  }
  if (e instanceof ZodError) {
    return {
      status: 422,
      body: {
        error: {
          code: "VALIDATION_ERROR",
          message: "Please check the highlighted fields",
          details: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      },
    };
  }
  console.error("Unhandled API error", e);
  return { status: 500, body: { error: { code: "INTERNAL", message: "Something went wrong. Please try again." } } };
}

export function createApiHandler(router: Router, basePath: string) {
  const handle = async (req: NextRequest): Promise<Response> => {
    const cors = corsHeaders(req);
    if (req.method === "OPTIONS") return new NextResponse(null, { status: 204, headers: cors });
    try {
      const url = new URL(req.url);
      const rest = url.pathname.startsWith(basePath) ? url.pathname.slice(basePath.length) : url.pathname;
      const segments = rest.split("/").filter(Boolean);
      const { route, params, pathMatched } = router.match(req.method, segments);
      if (!route) {
        const status = pathMatched ? 405 : 404;
        return NextResponse.json(
          { error: { code: status === 405 ? "BAD_REQUEST" : "NOT_FOUND", message: status === 405 ? "Method not allowed" : "Not found" } },
          { status, headers: cors },
        );
      }
      await ensureIndexes();
      const apiReq = buildRequest(req, route.method, params, url.searchParams);
      const result = await route.handler(apiReq);
      if (result instanceof Response) {
        for (const [k, v] of Object.entries(cors)) result.headers.set(k, v);
        return result;
      }
      return NextResponse.json({ data: result ?? null }, { status: req.method === "POST" ? 200 : 200, headers: cors });
    } catch (e) {
      const { status, body } = errorResponse(e);
      return NextResponse.json(body, { status, headers: cors });
    }
  };
  return handle;
}

function buildRequest(raw: NextRequest, method: Method, params: Record<string, string>, query: URLSearchParams): ApiRequest {
  let authCache: Promise<AuthContext> | null = null;
  const ip = (raw.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || raw.headers.get("x-real-ip") || "unknown";
  const req: ApiRequest = {
    raw,
    method,
    params,
    query,
    ip,
    userAgent: (raw.headers.get("user-agent") ?? "").slice(0, 300),
    async body(schema) {
      const ct = raw.headers.get("content-type") ?? "";
      if (!ct.includes("application/json")) throw badRequest("Expected application/json body");
      const text = await raw.text();
      if (text.length > MAX_JSON_BYTES) throw badRequest("Request body too large");
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        throw badRequest("Malformed JSON");
      }
      return schema.parse(json);
    },
    queryAs(schema) {
      return schema.parse(Object.fromEntries(query.entries()));
    },
    auth() {
      if (!authCache) {
        const h = raw.headers.get("authorization") ?? "";
        const token = h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : null;
        authCache = authenticate(token);
      }
      return authCache;
    },
    async org(permission, opts) {
      const a = await req.auth();
      return requireOrgAccess(a, params.orgId, permission, opts);
    },
  };
  return req;
}

export function csvResponse(filename: string, csv: string): Response {
  return new Response("﻿" + csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}"`,
      "Cache-Control": "no-store",
    },
  });
}
