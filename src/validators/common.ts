import { z } from "zod";
import { ObjectId } from "mongodb";
import { rupeesToPaise } from "@/lib/money";
import { parseDateOnly } from "@/lib/dates";

/** Rupee amount as string/number ("1250.50") → integer paise. Positive by default. */
export const money = (opts: { allowZero?: boolean } = {}) =>
  z
    .union([z.string(), z.number()])
    .transform((v, ctx) => {
      try {
        return rupeesToPaise(v);
      } catch {
        ctx.addIssue({ code: "custom", message: "Enter a valid amount (max 2 decimals)" });
        return z.NEVER;
      }
    })
    .refine((p) => (opts.allowZero ? p >= 0 : p > 0), {
      message: opts.allowZero ? "Amount cannot be negative" : "Amount must be greater than zero",
    });

export const dateOnly = z.string().transform((v, ctx) => {
  try {
    return parseDateOnly(v);
  } catch {
    ctx.addIssue({ code: "custom", message: "Enter a valid date (YYYY-MM-DD)" });
    return z.NEVER;
  }
});

export const objectId = z
  .string()
  .refine((v) => ObjectId.isValid(v) && String(new ObjectId(v)) === v.toLowerCase(), "Invalid id")
  .transform((v) => new ObjectId(v));

export const idempotencyKey = z
  .string()
  .min(8)
  .max(100)
  .regex(/^[A-Za-z0-9_.:-]+$/, "Invalid idempotency key");

export const trimmed = (max = 200) => z.string().trim().max(max);
export const reqText = (max = 200) => z.string().trim().min(1, "Required").max(max);
export const optText = (max = 500) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

export const reason = z.string().trim().min(3, "Please give a reason").max(500);

export const pagination = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

export const dateRange = z.object({
  from: dateOnly.optional(),
  to: dateOnly.optional(),
});

/** Annual/monthly interest rate as a decimal string with up to 4 decimals, 0–100. */
export const rateString = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => /^\d{1,3}(\.\d{1,4})?$/.test(v) && Number(v) <= 100, "Enter a rate between 0 and 100 with up to 4 decimals");

export const email = z.string().trim().toLowerCase().email("Enter a valid email").max(200);
export const phone = z
  .string()
  .trim()
  .regex(/^[+0-9 ()-]{7,20}$/, "Enter a valid phone number")
  .optional()
  .or(z.literal("").transform(() => undefined));
