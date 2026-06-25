import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  verifyCollaborativeAuthSignature,
  CollaborativeAuthorizationResponseCode,
  type CollaborativeAuthResponse,
} from "@highnote-oss/nodejs-sdk";
import { db } from "../db/index.js";
import { invoices, collabAuthDecisions } from "../db/schema.js";
import * as collabAuthRegistration from "../services/collabAuthRegistration.js";
import { getSigningKey } from "../services/collabAuthRegistration.js";
import { IdParamsSchema } from "../types.js";
import { requireAdmin } from "../middleware/auth.js";

const CollabAuthDecisionsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).default(100),
});

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
 *   6. Odd-cent amount → DECLINED  (demo rule: even cents approve, odd decline)
 *   7. Otherwise (even-cent amount) → APPROVED
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
      if (!verification.valid) {
        return reply.status(401).send({ error: "Invalid signature" });
      }

      // `verifyCollaborativeAuthSignature` returns the entire parsed payload as
      // `request`. A real authorization carries a
      // `data.collaborativeAuthorizationRequest` with a `paymentCard`.
      const caRequest =
        verification.request?.data?.collaborativeAuthorizationRequest;

      // Activation handshake. Highnote verifies a newly-registered endpoint by
      // POSTing a signed request whose `collaborativeAuthorizationRequest` is a
      // `CollaborativeAuthorizationEndpointActivationRequest` ({ ping: "pong" })
      // — present, but with NO `paymentCard`. Acknowledge it with any 2XX so the
      // endpoint transitions to ACTIVE. Dereferencing the absent paymentCard is
      // what threw a 500 here and left the endpoint stuck in ACTIVATION_FAILED.
      // The activation ping has no paymentCard; a real authorization always
      // carries paymentCard + requestedAmount + merchantDetails. Anything
      // missing a field the decision needs is not a decidable authorization —
      // acknowledge with 200 rather than dereferencing it and throwing a 500
      // (which would push Highnote to stand-in on the 2-second budget path).
      if (
        !caRequest ||
        !caRequest.paymentCard ||
        !caRequest.requestedAmount ||
        !caRequest.merchantDetails
      ) {
        request.log.info("CA endpoint ping / non-authorization payload acknowledged");
        return reply.status(200).send({ received: true });
      }
      const cardId = caRequest.paymentCard.id;
      const requestedAmount = caRequest.requestedAmount;
      const merchantCategoryCode = caRequest.merchantDetails.categoryCode;

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
        // Demo decision rule: approve even-cent amounts, decline odd-cent
        // amounts. The amount is in cents, so `value % 2` tests the trailing
        // cent digit ($10.04 -> approve, $10.05 -> decline). This is a
        // deterministic hook for exercising the approve/decline paths in the
        // Test environment — change the amount's last cent to flip the outcome.
        if (requestedAmount.value % 2 !== 0) {
          return {
            code: CollaborativeAuthorizationResponseCode.DECLINED,
            reason: "odd-cent amount (demo rule: even cents approve, odd decline)",
          };
        }
        return {
          code: CollaborativeAuthorizationResponseCode.APPROVED,
          reason: "even-cent amount (demo rule: even cents approve, odd decline)",
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

  // Public registration status (JWT-protected). Mirrors the webhook-status
  // endpoint shape. Never exposes the signing-key secret; only a boolean.
  typedApp.get(
    "/api/collab-auth/status",
    {
      schema: {
        tags: ["Collaborative Auth"],
        description:
          "Get the current collaborative-authorization endpoint registration status.",
      },
    },
    async () => {
      // Live-refresh from Highnote so the badge reflects the true status.
      return collabAuthRegistration.getStatus();
    },
  );

  // POST /api/collab-auth/register -- Re-run auto-registration (JWT-protected).
  // Useful when the activation probe failed during a cold-start or the
  // previously-stored signing key is no longer valid.  The operator hits the
  // Re-register button on the Collab Auth page and lands here.
  typedApp.post(
    "/api/collab-auth/register",
    {
      // Re-registration tears down every bay19-auto-* endpoint and mints a fresh
      // one with a new signing key — churning the money-movement authorization
      // plane. Gate it to admins (when configured) and cap it to a slow cooldown
      // so it can't be looped into a stand-in/decline DoS.
      preHandler: requireAdmin,
      config: { rateLimit: { max: 3, timeWindow: "5 minutes" } },
      schema: {
        tags: ["Collaborative Auth"],
        description:
          "Re-run collaborative-authorization endpoint auto-registration. Removes prior bay19-auto-* endpoints and registers a fresh one. Returns the new public status.",
      },
    },
    async () => {
      await collabAuthRegistration.register();
      return collabAuthRegistration.getPublicStatus();
    },
  );

  // Operator-wide decision log (JWT-protected). Returns every persisted
  // decision row across all invoices owned by anyone — this is a single-user
  // demo, so there is no per-user partitioning at the table level. Use the
  // per-invoice variant above when scoping matters.
  typedApp.get(
    "/api/collab-auth/decisions",
    {
      schema: {
        tags: ["Collaborative Auth"],
        description:
          "List recent collaborative-authorization decisions across all invoices (operator view).",
        querystring: CollabAuthDecisionsQuerySchema,
      },
    },
    async (request) => {
      const rows = db
        .select()
        .from(collabAuthDecisions)
        .orderBy(desc(collabAuthDecisions.receivedAt))
        .limit(request.query.limit)
        .all();
      return { decisions: rows };
    },
  );
}
