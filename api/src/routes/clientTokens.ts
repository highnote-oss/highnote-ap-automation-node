import type { FastifyInstance } from "fastify";
import type { FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { eq, and } from "drizzle-orm";
import {
  HighnoteUserError,
  HighnoteAccessDeniedError,
  PaymentCardClientTokenPermission,
} from "@highnote-oss/nodejs-sdk";
import { db } from "../db/index.js";
import { invoices } from "../db/schema.js";
import { highnote } from "../services/highnote.js";
import { IdParamsSchema } from "../types.js";

export async function clientTokenRoutes(app: FastifyInstance) {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.post("/api/invoices/:id/card-viewer-token", {
    schema: {
      tags: ["Client Tokens"],
      description: "Generate a scoped client token for the Card Viewer SDK.",
      params: IdParamsSchema,
    },
  }, async (request, reply) => {
    const row = db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, request.params.id), eq(invoices.userId, request.user.id)))
      .get();
    if (!row) return reply.status(404).send({ error: "Invoice not found" });
    if (!row.cardId) return reply.status(400).send({ error: "Invoice has no issued card" });

    try {
      const token = await highnote.clientTokens.createForPaymentCard({
        paymentCardId: row.cardId,
        permissions: [PaymentCardClientTokenPermission.READ_RESTRICTED_DETAILS],
      });
      return token;
    } catch (err) {
      return handleError(err, reply);
    }
  });
}

function handleError(err: unknown, reply: FastifyReply) {
  if (err instanceof HighnoteUserError) {
    return reply.status(400).send({ error: "Highnote validation error", fieldErrors: err.fieldErrors });
  }
  if (err instanceof HighnoteAccessDeniedError) {
    return reply.status(403).send({ error: "Access denied", message: err.message });
  }
  throw err;
}
