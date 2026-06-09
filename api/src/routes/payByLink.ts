import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { randomBytes } from "node:crypto";
import { eq, and } from "drizzle-orm";
import {
  HighnoteUserError,
  HighnoteAccessDeniedError,
  PaymentCardClientTokenPermission,
} from "@highnote-oss/nodejs-sdk";
import { db } from "../db/index.js";
import { invoices } from "../db/schema.js";
import { highnote } from "../services/highnote.js";
import {
  IdParamsSchema,
  SlugParamsSchema,
  type InvoiceStatus,
} from "../types.js";

const PAY_BY_LINK_TTL_HOURS = 24;
const SLUG_BYTES = 32;

/**
 * Statuses for which the pay-by-link is no longer payable. CANCELLED means the
 * operator withdrew the invoice; CLEARED and RECONCILED mean the underlying
 * card has already been used (and in those cases the webhook handler also
 * closes the card upstream). We return 410 so the vendor-facing page can show
 * a "no longer active" message distinct from a 404 (unknown link).
 */
const TERMINAL_PAY_STATUSES = [
  "CANCELLED",
  "CLEARED",
  "RECONCILED",
] satisfies InvoiceStatus[];

export async function payByLinkRoutes(app: FastifyInstance) {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  // Operator generates a pay-by-link for an issued invoice. Each call mints a
  // fresh client token from Highnote and rotates the slug — the previous slug
  // is overwritten and immediately stops resolving.
  typedApp.post(
    "/api/invoices/:id/pay-link",
    {
      schema: {
        tags: ["Pay By Link"],
        description:
          "Generate a public pay-by-link slug for an invoice that already has an issued card.",
        params: IdParamsSchema,
      },
    },
    async (request, reply) => {
      const row = db
        .select()
        .from(invoices)
        .where(
          and(
            eq(invoices.id, request.params.id),
            eq(invoices.userId, request.user.id),
          ),
        )
        .get();
      if (!row) return reply.status(404).send({ error: "Invoice not found" });
      if (!row.cardId) {
        return reply
          .status(400)
          .send({ error: "Invoice has no issued card" });
      }

      try {
        const token = await highnote.clientTokens.createForPaymentCard({
          paymentCardId: row.cardId,
          permissions: [
            PaymentCardClientTokenPermission.READ_RESTRICTED_DETAILS,
          ],
        });

        const slug = randomBytes(SLUG_BYTES).toString("base64url");
        const expiresAt = new Date(
          Date.now() + PAY_BY_LINK_TTL_HOURS * 3600 * 1000,
        ).toISOString();

        db.update(invoices)
          .set({
            payBySlug: slug,
            payByClientToken: token.value,
            payBySlugExpiresAt: expiresAt,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(invoices.id, row.id))
          .run();

        return { slug, expiresAt };
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // Public — vendor consumes via slug. Opts out of auth via `public: true`.
  // The slug itself is the rotating secret; the client token returned here is
  // narrowly scoped to READ_RESTRICTED_DETAILS on the single-use card. We
  // never expose the cardId in the public payload.
  typedApp.get(
    "/api/pay/:slug",
    {
      config: { public: true },
      schema: {
        tags: ["Pay By Link"],
        description:
          "Public endpoint that resolves a pay-by-link slug to the vendor-facing payload.",
        params: SlugParamsSchema,
      },
    },
    async (request, reply) => {
      const row = db
        .select()
        .from(invoices)
        .where(eq(invoices.payBySlug, request.params.slug))
        .get();
      if (!row || !row.cardId || !row.payByClientToken) {
        return reply
          .status(404)
          .send({ error: "Link not found or expired" });
      }
      if (
        row.payBySlugExpiresAt &&
        new Date(row.payBySlugExpiresAt) < new Date()
      ) {
        return reply.status(410).send({ error: "Link expired" });
      }
      if (
        (TERMINAL_PAY_STATUSES as readonly InvoiceStatus[]).includes(
          row.status as InvoiceStatus,
        )
      ) {
        return reply.status(410).send({ error: "Card no longer active" });
      }
      return {
        vendorName: row.vendorName,
        amountCents: row.amountCents,
        currencyCode: row.currencyCode,
        invoiceNumber: row.invoiceNumber,
        clientToken: row.payByClientToken,
      };
    },
  );
}

function handleError(err: unknown, reply: FastifyReply) {
  if (err instanceof HighnoteUserError) {
    return reply.status(400).send({
      error: "Highnote validation error",
      fieldErrors: err.fieldErrors,
    });
  }
  if (err instanceof HighnoteAccessDeniedError) {
    return reply
      .status(403)
      .send({ error: "Access denied", message: err.message });
  }
  throw err;
}
