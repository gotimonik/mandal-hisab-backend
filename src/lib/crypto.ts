import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import { env } from "@/config/env";

/**
 * bcryptjs is pure JS, so each extra round doubles the time on a small server CPU.
 * 10 rounds is the bcrypt default and still strong; 12 was taking seconds per login.
 * Older cost-12 hashes keep working and are upgraded on the next successful login.
 */
export const BCRYPT_ROUNDS = process.env.NODE_ENV === "test" ? 4 : 10;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/** True when a stored hash was made with a different cost than we use now. */
export function needsRehash(hash: string): boolean {
  try {
    return bcrypt.getRounds(hash) !== BCRYPT_ROUNDS;
  } catch {
    return false;
  }
}

/** 256-bit URL-safe random token. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Keyed hash for storing tokens; a DB leak does not reveal usable tokens. */
export function hashToken(token: string): string {
  return createHmac("sha256", env().AUTH_SECRET).update(token).digest("hex");
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Human-friendly join code without ambiguous characters. */
export function joinCode(len = 8): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(len);
  let s = "";
  for (let i = 0; i < len; i++) s += alphabet[bytes[i] % alphabet.length];
  return s;
}
