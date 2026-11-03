import { env } from "@/config/env";

/**
 * Reads a bill (photo or PDF) with Claude's vision through the Anthropic Messages API and returns
 * what it found — total, date, shop, a likely category and how it was paid. The result is only a
 * suggestion: the app fills in the "Add spending" form and the person checks it before saving.
 *
 * Nothing is kept by us beyond the reading itself; the bill goes to Anthropic only to be read.
 */

export interface BillCategoryOption {
  id: string;
  kind: "expense" | "income";
  name: string;
}

export interface RawBillReading {
  isBill: boolean;
  /** rupees, as read (null = not found / not in rupees) */
  amount: number | null;
  date: string | null;
  merchant: string | null;
  type: "expense" | "income";
  categoryId: string | null;
  walletKind: "cash" | "upi" | "card" | "bank" | null;
}

export type BillReader = (input: { bytes: Uint8Array; contentType: string; categories: BillCategoryOption[]; today: string }) => Promise<RawBillReading>;

/** Problems on our side or the provider's (not the bill's fault). */
export class BillReaderError extends Error {}

let testReader: BillReader | null | undefined;
/** Tests only: swap the reader (null = "not configured", undefined = the real one). */
export function setBillReaderForTests(r: BillReader | null | undefined) {
  testReader = r;
}

/** The reader in use, or null when no API key is set (bills are then kept but not read). */
export function billReader(): BillReader | null {
  if (testReader !== undefined) return testReader;
  return env().ANTHROPIC_API_KEY ? readWithClaude : null;
}

/** Claude's per-image limit is 5 MB of base64, so very large photos aren't sent. */
export const MAX_READ_IMAGE_BYTES = Math.floor((5 * 1024 * 1024 * 3) / 4) - 1024;

const TOOL = {
  name: "record_bill",
  description: "Record what this bill, receipt, invoice or payment screenshot says.",
  input_schema: {
    type: "object",
    properties: {
      is_bill: { type: "boolean", description: "true if this is a bill, receipt, invoice or a payment / UPI screenshot; false for anything else" },
      total_amount: { type: ["number", "null"], description: "The final amount actually paid (grand total / net payable / amount paid), in the bill's currency. Not a subtotal, tax, discount, 'you saved' or change returned. null if not readable." },
      currency: { type: ["string", "null"], description: "ISO currency code, e.g. INR. INR if the bill shows ₹, Rs or Rs., or is clearly Indian without another currency." },
      date: { type: ["string", "null"], description: "The bill or payment date as YYYY-MM-DD. Indian bills write dates day first (03/11/26 = 2026-11-03). null if not shown." },
      merchant: { type: ["string", "null"], description: "Shop, company or person name, short (e.g. 'DMart', 'HP Petrol Pump', 'Ramesh Patel'). null if not shown." },
      direction: { type: "string", enum: ["expense", "income"], description: "expense if the person paid; income if they received money (e.g. a UPI 'received from' screenshot)." },
      category_id: { type: ["string", "null"], description: "The id of the best matching category from the list for this direction, or null if none fits." },
      payment_method: { type: ["string", "null"], enum: ["cash", "upi", "card", "bank", null], description: "How it was paid, if the bill shows it." },
    },
    required: ["is_bill", "total_amount", "currency", "date", "merchant", "direction", "category_id", "payment_method"],
  },
} as const;

async function readWithClaude({ bytes, contentType, categories, today }: Parameters<BillReader>[0]): Promise<RawBillReading> {
  const key = env().ANTHROPIC_API_KEY;
  if (!key) throw new BillReaderError("Bill reading is not configured");
  const data = Buffer.from(bytes).toString("base64");
  const file =
    contentType === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
      : { type: "image", source: { type: "base64", media_type: contentType, data } };
  const list = (kind: "expense" | "income") =>
    categories
      .filter((c) => c.kind === kind)
      .map((c) => `- ${c.id}: ${c.name}`)
      .join("\n") || "(none)";
  const prompt = [
    `Read this bill for a personal expense tracker in India. Today is ${today}.`,
    "Call record_bill with what it shows. Only report what is actually on the bill; use null when unsure.",
    "Spending categories:",
    list("expense"),
    "Income categories:",
    list("income"),
  ].join("\n");

  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: env().BILL_READER_MODEL,
        max_tokens: 400,
        tools: [TOOL],
        tool_choice: { type: "tool", name: TOOL.name },
        messages: [{ role: "user", content: [file, { type: "text", text: prompt }] }],
      }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (e) {
    throw new BillReaderError(`Bill reader unreachable: ${(e as Error).message}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // a bill the model can't open (corrupt image, password-protected PDF) is the bill's problem
    if (res.status === 400 && /image|pdf|document|media/i.test(text)) return { isBill: false, amount: null, date: null, merchant: null, type: "expense", categoryId: null, walletKind: null };
    throw new BillReaderError(`Bill reader failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as { content?: { type: string; name?: string; input?: Record<string, unknown> }[] };
  const call = json.content?.find((b) => b.type === "tool_use" && b.name === TOOL.name);
  if (!call?.input) throw new BillReaderError("Bill reader gave no answer");
  const v = call.input;
  const currency = typeof v.currency === "string" ? v.currency.toUpperCase() : null;
  const amount = typeof v.total_amount === "number" && (currency === null || currency === "INR") ? v.total_amount : null;
  const method = v.payment_method;
  return {
    isBill: v.is_bill === true,
    amount,
    date: typeof v.date === "string" ? v.date : null,
    merchant: typeof v.merchant === "string" ? v.merchant : null,
    type: v.direction === "income" ? "income" : "expense",
    categoryId: typeof v.category_id === "string" ? v.category_id : null,
    walletKind: method === "cash" || method === "upi" || method === "card" || method === "bank" ? method : null,
  };
}
