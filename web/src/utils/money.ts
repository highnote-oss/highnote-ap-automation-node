import type { SupportedCurrencyCode } from "../api/client";

/**
 * Format an integer cent amount as a human-readable currency string.
 *
 * @param cents - integer amount in the smallest unit of the currency
 * @param currencyCode - ISO 4217 alpha-3 currency code, defaults to USD
 */
export function formatCents(
  cents: number,
  currencyCode: SupportedCurrencyCode | string = "USD"
): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: currencyCode,
  });
}

/**
 * Parse a dollar-string (e.g. "1234.56") into an integer cent amount.
 * Returns null when the input is not a valid positive number.
 */
export function dollarsToCents(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100);
}
