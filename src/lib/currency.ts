/**
 * Currencies a Mandal can keep its books in. Amounts are always stored as integer minor units
 * ("paise"), so only currencies with 2 decimal places are allowed. INR is the default.
 */
import { formatINR, paiseToRupeeString } from "./money";

export const CURRENCIES = [
  { code: "INR", name: "Indian rupee" },
  { code: "USD", name: "US dollar" },
  { code: "GBP", name: "British pound" },
  { code: "EUR", name: "Euro" },
  { code: "CAD", name: "Canadian dollar" },
  { code: "AUD", name: "Australian dollar" },
  { code: "NZD", name: "New Zealand dollar" },
  { code: "AED", name: "UAE dirham" },
  { code: "SAR", name: "Saudi riyal" },
  { code: "QAR", name: "Qatari riyal" },
  { code: "SGD", name: "Singapore dollar" },
  { code: "MYR", name: "Malaysian ringgit" },
  { code: "HKD", name: "Hong Kong dollar" },
  { code: "KES", name: "Kenyan shilling" },
  { code: "TZS", name: "Tanzanian shilling" },
  { code: "ZAR", name: "South African rand" },
  { code: "MUR", name: "Mauritian rupee" },
  { code: "NPR", name: "Nepalese rupee" },
  { code: "FJD", name: "Fijian dollar" },
  { code: "CHF", name: "Swiss franc" },
] as const;

export type CurrencyCode = (typeof CURRENCIES)[number]["code"];
export const CURRENCY_CODES = CURRENCIES.map((c) => c.code) as unknown as [CurrencyCode, ...CurrencyCode[]];
export const DEFAULT_CURRENCY: CurrencyCode = "INR";

export const isCurrency = (v: unknown): v is CurrencyCode => typeof v === "string" && (CURRENCY_CODES as readonly string[]).includes(v);

/** Indian grouping for INR (₹1,25,000.00); the usual 1,250,000.00 grouping for everything else. */
const localeFor = (code: string) => (code === "INR" || code === "NPR" ? "en-IN" : "en-US");

/** 12500050 → "₹1,25,000.50" / "$125,000.50" / "AED 125,000.50" */
export function formatMoney(paise: number, currency: string = DEFAULT_CURRENCY): string {
  if (!currency || currency === "INR") return formatINR(paise);
  return new Intl.NumberFormat(localeFor(currency), { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(paiseToRupeeString(paise)));
}

/** "₹", "$", "£", "AED" — used in CSV headers like "Amount (₹)". */
export function currencySymbol(currency: string = DEFAULT_CURRENCY): string {
  if (!currency || currency === "INR") return "₹";
  const part = new Intl.NumberFormat(localeFor(currency), { style: "currency", currency }).formatToParts(0).find((p) => p.type === "currency");
  return part?.value ?? currency;
}
