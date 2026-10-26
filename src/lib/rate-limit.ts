import { cols } from "./collections";
import { AppError } from "./errors";
import { sha256 } from "./crypto";

/**
 * Fixed-window rate limiter backed by MongoDB (works across serverless instances).
 * Throws 429 when `limit` is exceeded within `windowSeconds` for `key`.
 */
export async function rateLimit(key: string, limit: number, windowSeconds: number): Promise<void> {
  if (process.env.DISABLE_RATE_LIMIT === "true") return;
  const c = await cols();
  const now = Date.now();
  const windowStart = Math.floor(now / (windowSeconds * 1000)) * windowSeconds * 1000;
  const id = `${sha256(key).slice(0, 40)}:${windowStart}`;
  const res = await c.rateLimits.findOneAndUpdate(
    { _id: id },
    { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(windowStart + windowSeconds * 1000) } },
    { upsert: true, returnDocument: "after" },
  );
  if ((res?.count ?? 0) > limit) {
    throw new AppError("RATE_LIMITED", "Too many attempts. Please wait a few minutes and try again.");
  }
}
