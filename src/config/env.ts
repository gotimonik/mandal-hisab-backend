import { z } from "zod";

const boolish = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((v) => v === "true" || v === "1");

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),
  MONGODB_DB: z.string().min(1).default("mandalhisab"),
  AUTH_SECRET: z.string().min(16, "AUTH_SECRET must be at least 16 characters"),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  REQUIRE_EMAIL_VERIFICATION: boolish,
  APP_URL: z.string().url().default("http://localhost:4000"),
  FRONTEND_URL: z.string().url().default("http://localhost:3000"),
  CORS_ALLOWED_ORIGINS: z.string().default("http://localhost:3000"),
  ORG_REGISTRATION_POLICY: z.enum(["open", "approval", "disabled"]).default("approval"),
  CRON_SECRET: z.string().optional(),
  EMAIL_FROM: z.string().default("MandalHisab <no-reply@example.com>"),
  RESEND_API_KEY: z.string().optional(),
  BLOB_READ_WRITE_TOKEN: z.string().optional(),
  /**
   * Firebase service account (the JSON key file, as-is or base64-encoded) used to send phone
   * push notifications through Firebase Cloud Messaging. Unset = no pushes (in-app only).
   */
  FCM_SERVICE_ACCOUNT: z.string().optional(),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

/** Lazily validated server environment. Never import this from client code. */
export function env(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid server environment: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test helper: forget the cached env so tests can change process.env. */
export function resetEnvCache() {
  cached = null;
}
