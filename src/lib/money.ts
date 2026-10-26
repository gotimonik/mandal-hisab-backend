/**
 * Decimal-safe money helpers. All amounts are integer paise (1 ₹ = 100 paise).
 * Parsing/formatting is string based; no floating point is used for money.
 */

export const MAX_PAISE = 1_000_000_000_000_00; // ₹1 lakh crore — sanity ceiling

export function assertPaise(n: number, label = "amount"): number {
  if (!Number.isSafeInteger(n)) throw new Error(`${label} must be an integer number of paise`);
  if (Math.abs(n) > MAX_PAISE) throw new Error(`${label} is out of range`);
  return n;
}

/**
 * Parse a rupee amount ("1250", "1,250.5", "1250.50", 1250.5) into paise.
 * Rejects more than 2 decimal places and non-numeric input.
 */
export function rupeesToPaise(input: string | number): number {
  let s = typeof input === "number" ? numberToPlainString(input) : input.trim();
  s = s.replace(/[,₹\s]/g, "");
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new Error(`Invalid amount: ${String(input)}`);
  const sign = m[1] ? -1 : 1;
  const rupees = m[2].replace(/^0+(?=\d)/, "");
  const frac = (m[3] ?? "").padEnd(2, "0");
  const paise = BigInt(rupees) * 100n + BigInt(frac);
  const n = Number(paise) * sign;
  return assertPaise(n === 0 ? 0 : n);
}

function numberToPlainString(n: number): string {
  if (!Number.isFinite(n)) throw new Error("Invalid amount");
  // toFixed(2) would silently round; detect >2 decimals first
  const s = String(n);
  if (/e/i.test(s)) throw new Error("Invalid amount");
  return s;
}

export function paiseToRupeeString(paise: number): string {
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const r = Math.trunc(abs / 100);
  const p = abs % 100;
  return `${neg ? "-" : ""}${r}.${String(p).padStart(2, "0")}`;
}

/** Indian digit grouping: 125000.5 → ₹1,25,000.50 */
export function formatINR(paise: number, withSymbol = true): string {
  const neg = paise < 0;
  const [r, p] = paiseToRupeeString(Math.abs(paise)).split(".");
  let grouped = r;
  if (r.length > 3) {
    const last3 = r.slice(-3);
    const rest = r.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
    grouped = `${rest},${last3}`;
  }
  return `${neg ? "-" : ""}${withSymbol ? "₹" : ""}${grouped}.${p}`;
}

export function sumPaise(values: number[]): number {
  let t = 0;
  for (const v of values) t += v;
  return assertPaise(t, "sum");
}

/** Round half-up a BigInt rational num/den to an integer (works for negatives symmetrically). */
export function roundHalfUp(num: bigint, den: bigint): bigint {
  if (den === 0n) throw new Error("Division by zero");
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const neg = num < 0n;
  const a = neg ? -num : num;
  const q = a / den;
  const r = a % den;
  const res = r * 2n >= den ? q + 1n : q;
  return neg ? -res : res;
}

/**
 * Split `total` into `parts` integer amounts differing by at most 1 paise;
 * the remainder paise go to the earliest parts.
 */
export function splitEvenly(total: number, parts: number): number[] {
  if (parts <= 0) throw new Error("parts must be positive");
  const base = Math.trunc(total / parts);
  let rem = total - base * parts;
  return Array.from({ length: parts }, () => {
    if (rem > 0) {
      rem--;
      return base + 1;
    }
    return base;
  });
}

/** Percentage given in basis points (100 bps = 1%) of an amount, rounded half-up. */
export function bpsOf(amountPaise: number, bps: number): number {
  return Number(roundHalfUp(BigInt(amountPaise) * BigInt(bps), 10_000n));
}
