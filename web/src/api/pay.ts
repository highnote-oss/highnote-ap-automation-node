import type { SupportedCurrencyCode } from "./client";

/**
 * Vendor-facing payload returned by `GET /api/pay/:slug`. The endpoint is
 * public (no JWT) — see `api/src/routes/payByLink.ts`.
 *
 * `cardId` is exposed alongside `clientToken` because the Highnote
 * `@highnoteplatform/card-viewer` SDK requires `paymentCardId` to render
 * the iframe. The client token already grants narrowly-scoped read access
 * to this card, so the cardId is not independently sensitive here; the slug
 * remains the rotating secret.
 */
export interface PayDetails {
  vendorName: string;
  amountCents: number;
  currencyCode: SupportedCurrencyCode;
  invoiceNumber: string;
  clientToken: string;
  cardId: string;
}

/** Thrown when the backend returns 410 — the link is no longer payable. */
export class PayLinkExpiredError extends Error {
  constructor() {
    super("Pay link expired or no longer active");
    this.name = "PayLinkExpiredError";
  }
}

/** Thrown when the backend returns 404 — unknown slug. */
export class PayLinkNotFoundError extends Error {
  constructor() {
    super("Pay link not found");
    this.name = "PayLinkNotFoundError";
  }
}

/**
 * Public fetch helper for the vendor-facing pay-by-link page. Does NOT use
 * the authed `request()` helper in `client.ts` — no `Authorization` header,
 * no `localStorage` read. The route opts out of auth via `config: public: true`
 * on the Fastify side.
 *
 * Distinguishes 410 (expired/closed) from 404 (unknown) via typed errors so
 * the page can keep a single friendly message for either while leaving room
 * for the operator to disambiguate in logs.
 */
export async function fetchPayDetails(slug: string): Promise<PayDetails> {
  const res = await fetch(`/api/pay/${slug}`);
  if (res.status === 410) throw new PayLinkExpiredError();
  if (res.status === 404) throw new PayLinkNotFoundError();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
