import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { and, desc, eq } from "drizzle-orm";
import {
  verifyCollaborativeAuthSignature,
  CollaborativeAuthorizationResponseCode,
  type CollaborativeAuthResponse,
} from "@highnote-oss/nodejs-sdk";
import { db } from "../db/index.js";
import { invoices, collabAuthDecisions } from "../db/schema.js";
import { getSigningKey } from "../services/collabAuthRegistration.js";
import { IdParamsSchema } from "../types.js";

/**
 * Highnote calls this endpoint with each authorization. The decision must
 * return within 2 seconds or Highnote falls back to product-level stand-in.
 *
 * Decision tree (matches the design spec). The SDK's
 * `CollaborativeAuthorizationResponseCode` enum has no `DO_NOT_HONOR`; the
 * closest valid codes are used below:
 *   1. No matching invoice for this card → INVALID_TRANSACTION
 *   2. Invoice already consumed (AUTHORIZED/CLEARED/RECONCILED) → DUPLICATE_TRANSACTION
 *   3. Invoice cancelled → INVALID_TRANSACTION
 *   4. requestedAmount > invoice amount → INSUFFICIENT_FUNDS
 *   5. Invoice has expectedMcc AND merchant MCC mismatches → INVALID_MERCHANT_CATEGORY_CODE
 *   6. Otherwise → APPROVED
 *
 * The decision row is persisted fire-and-forget so the response doesn't
 * block on the write — every millisecond counts under the 2s budget.
 */
export async function collaborativeAuthRoutes(app: FastifyInstance) {
  // Public (no JWT) — Highnote authenticates via the HMAC signature header.
  // `rawBody: true` opts in to the fastify-raw-body capture needed for the
  // exact-bytes signature check; the plugin is registered with global:false.
  app.post(
    "/collaborative-auth",
    { config: { public: true, rawBody: true } },
    async (request, reply) => {
      const signingKey = getSigningKey();
      if (!signingKey) {
        request.log.warn("CA endpoint hit before registration completed");
        return reply.status(503).send({ error: "Endpoint not yet registered" });
      }

      const signature = request.headers["highnote-signature"];
      if (typeof signature !== "string") {
        return reply
          .status(401)
          .send({ error: "Missing highnote-signature header" });
      }

      const payload = (request as unknown as { rawBody: string }).rawBody;
      const verification = verifyCollaborativeAuthSignature({
        payload,
        signature,
        signingKey,
      });
      if (!verification.valid || !verification.request) {
        return reply.status(401).send({ error: "Invalid signature" });
      }

      const caRequest = verification.request.data.collaborativeAuthorizationRequest;
      const cardId = caRequest.paymentCard.id;
      const requestedAmount = caRequest.requestedAmount;
      const merchantCategoryCode = caRequest.merchantDetails.merchantCategoryCode;

      const invoice = db
        .select()
        .from(invoices)
        .where(eq(invoices.cardId, cardId))
        .get();

      const decide = (): {
        code: CollaborativeAuthorizationResponseCode;
        reason: string;
      } => {
        if (!invoice) {
          return {
            code: CollaborativeAuthorizationResponseCode.INVALID_TRANSACTION,
            reason: "no matching invoice",
          };
        }
        // Status comes from a TEXT column typed as the InvoiceStatus union —
        // string literals here compare against that union, not the CA enum.
        const consumed: string[] = ["AUTHORIZED", "CLEARED", "RECONCILED"];
        if (consumed.includes(invoice.status)) {
          return {
            code: CollaborativeAuthorizationResponseCode.DUPLICATE_TRANSACTION,
            reason: "single-use card already consumed",
          };
        }
        if (invoice.status === "CANCELLED") {
          return {
            code: CollaborativeAuthorizationResponseCode.INVALID_TRANSACTION,
            reason: "invoice cancelled",
          };
        }
        if (requestedAmount.value > invoice.amountCents) {
          return {
            code: CollaborativeAuthorizationResponseCode.INSUFFICIENT_FUNDS,
            reason: `amount ${requestedAmount.value} exceeds invoice ${invoice.amountCents}`,
          };
        }
        if (invoice.expectedMcc && invoice.expectedMcc !== merchantCategoryCode) {
          return {
            code: CollaborativeAuthorizationResponseCode.INVALID_MERCHANT_CATEGORY_CODE,
            reason: `MCC mismatch (expected ${invoice.expectedMcc}, got ${merchantCategoryCode})`,
          };
        }
        return {
          code: CollaborativeAuthorizationResponseCode.APPROVED,
          reason: "approved",
        };
      };

      const decision = decide();

      // Fire-and-forget persistence — don't let the DB write delay the reply.
      // better-sqlite3 is synchronous; queueMicrotask defers it until after
      // the response is queued for send.
      queueMicrotask(() => {
        try {
          db.insert(collabAuthDecisions)
            .values({
              invoiceId: invoice?.id ?? null,
              paymentCardId: cardId,
              requestId: caRequest.id,
              requestedAmountCents: requestedAmount.value,
              merchantCategoryCode,
              decision: decision.code,
              reason: decision.reason,
              rawPayload: payload,
            })
            .run();
        } catch (err) {
          request.log.error({ err }, "Failed to persist CA decision");
        }
      });

      const response: CollaborativeAuthResponse = {
        transaction: { id: caRequest.transaction.id },
        responseCode: decision.code,
      };
      return reply.send(response);
    },
  );

  // List CA decisions for one of the operator's own invoices. Auth-required
  // and ownership-guarded — selecting a decision row leaks no metadata about
  // someone else's invoice (cross-user requests return 404 indistinguishably
  // from unknown ids).
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  typedApp.get(
    "/api/invoices/:id/collab-decisions",
    {
      schema: {
        tags: ["Collaborative Auth"],
        description:
          "List collaborative-auth decision rows for the given invoice (own invoices only).",
        params: IdParamsSchema,
      },
    },
    async (request, reply) => {
      const invoice = db
        .select()
        .from(invoices)
        .where(
          and(
            eq(invoices.id, request.params.id),
            eq(invoices.userId, request.user.id),
          ),
        )
        .get();
      if (!invoice) {
        return reply.status(404).send({ error: "Invoice not found" });
      }

      const rows = db
        .select()
        .from(collabAuthDecisions)
        .where(eq(collabAuthDecisions.invoiceId, request.params.id))
        .orderBy(desc(collabAuthDecisions.receivedAt))
        .all();
      return { decisions: rows };
    },
  );
}
