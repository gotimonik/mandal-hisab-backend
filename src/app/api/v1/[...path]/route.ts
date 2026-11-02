import { createApiHandler } from "@/lib/http";
import { buildRouter } from "@/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// the daily cron also writes the nightly database backup
export const maxDuration = 300;

const handler = createApiHandler(buildRouter(), "/api/v1");

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const PUT = handler;
export const DELETE = handler;
export const OPTIONS = handler;
