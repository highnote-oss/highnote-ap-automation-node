import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import {
  Iso3166Alpha3Country,
  Iso4217Alpha3SupportedCurrency,
  MerchantCategory,
} from "@highnote-oss/nodejs-sdk";
import { db } from "../db/index.js";
import { invoices } from "../db/schema.js";
import { highnote } from "../services/highnote.js";
import { handleError } from "../lib/handleError.js";

// Highnote caps `MerchantDetailsInput.name` at 25 characters — see the
// generated SDK type. We mirror that cap here so Zod rejects oversized input
// before it ever reaches the upstream SDK.
const MERCHANT_NAME_MAX = 25;

const SimulateAuthorizeBodySchema = z.object({
  invoiceId: z.string(),
  amountCents: z.number().int().positive(),
  category: z.nativeEnum(MerchantCategory),
  merchantName: z.string().min(1).max(MERCHANT_NAME_MAX),
});

/**
 * Test-environment simulate-authorize endpoint. Triggers a Highnote
 * `simulateAuthorization` against the card already issued for the invoice.
 * The route is operator-authenticated (JWT) and scoped to invoices owned by
 * the calling user — we never expose someone else's cardId or let a user
 * drive simulations against a card they don't own.
 *
 * The currency comes from the invoice row, not the request body: simulating
 * a different currency than the card was issued in would be a misleading
 * demo for the operator UI.
 */
export async function simulateRoutes(app: FastifyInstance) {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.post(
    "/api/simulate/authorize",
    {
      schema: {
        tags: ["Simulation"],
        description:
          "Trigger a test-environment authorization against an invoice's issued card.",
        body: SimulateAuthorizeBodySchema,
      },
    },
    async (request, reply) => {
      const row = db
        .select()
        .from(invoices)
        .where(
          and(
            eq(invoices.id, request.body.invoiceId),
            eq(invoices.userId, request.user.id),
          ),
        )
        .get();
      if (!row || !row.cardId) {
        return reply
          .status(400)
          .send({ error: "Invoice has no issued card" });
      }

      try {
        // The invoice's currencyCode column is `text` in SQLite, so Drizzle
        // types it as `string` on read. The write side is locked down:
        // `CreateInvoiceBodySchema` validates the field as
        // `z.nativeEnum(Iso4217Alpha3SupportedCurrency)`, so any value that
        // reaches this row is already a valid enum member. The cast bridges
        // the Drizzle string type back to the SDK enum without re-parsing.
        const event = await highnote.test.transactions.authorize({
          cardId: row.cardId,
          amount: {
            value: request.body.amountCents,
            currencyCode: row.currencyCode as Iso4217Alpha3SupportedCurrency,
          },
          merchantDetails: {
            merchantId: "sim-merchant",
            category: request.body.category,
            name: request.body.merchantName,
            countryCodeAlpha3: Iso3166Alpha3Country.USA,
          },
        });
        return event;
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );
}
