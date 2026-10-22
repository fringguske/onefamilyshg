// All money is handled as whole cents (integers). Strings are parsed and
// formatted digit by digit, so no floating-point rounding can creep in.

export const MAX_CENTS = 100_000_000_000_00; // 100 billion — a sanity ceiling

const DECIMAL_RE = /^(\d+)(?:\.(\d{0,2}))?$/;

/** "12,500.5" -> 1250050. Empty -> 0. Invalid or negative -> null. */
export function parseMoney(input: string | null | undefined): number | null {
  if (input === null || input === undefined) return 0;
  const s = input.replace(/[\s,]/g, "").replace(/^(KES|KSH|SH)\.?/i, "");
  if (s === "") return 0;
  const m = DECIMAL_RE.exec(s);
  if (!m) return null;
  const whole = m[1].replace(/^0+(?=\d)/, "");
  if (whole.length > 13) return null;
  const frac = (m[2] ?? "").padEnd(2, "0");
  const cents = Number(whole) * 100 + Number(frac);
  return cents <= MAX_CENTS ? cents : null;
}

/** 1250050 -> "12,500.50" */
export function formatMoney(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "—";
  const negative = cents < 0;
  const digits = Math.abs(Math.trunc(cents)).toString().padStart(3, "0");
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${whole}.${digits.slice(-2)}`;
}

/** Value to put back into an input box: 1250050 -> "12500.50", 0 -> "". */
export function centsToInput(cents: number): string {
  if (!cents) return "";
  const digits = Math.abs(cents).toString().padStart(3, "0");
  const frac = digits.slice(-2);
  return `${digits.slice(0, -2)}${frac === "00" ? "" : "." + frac}`;
}

/** "10" -> 1000 basis points, "12.5" -> 1250. Max 100%. */
export function parsePercent(input: string): number | null {
  const s = input.trim().replace(/%$/, "");
  const m = DECIMAL_RE.exec(s);
  if (!m) return null;
  const bps = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return bps <= 10000 ? bps : null;
}

/** 1250 -> "12.5" */
export function formatPercent(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const frac = String(bps % 100).padStart(2, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

/** Server-side guard: value must be a non-negative safe integer number of cents. */
export function isCents(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= MAX_CENTS;
}
