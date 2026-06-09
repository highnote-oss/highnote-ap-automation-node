import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  HighnoteUserError,
  HighnoteAccessDeniedError,
  ElectronicFundTransferSource,
  FinancialAccountFeatureType,
  Iso4217Alpha3SupportedCurrency,
} from "@highnote-oss/nodejs-sdk";
import { highnote, cardProductId, getSubscriberAccountHolderId } from "../services/highnote.js";
import { IdParamsSchema } from "../types.js";

const TopUpBodySchema = z.object({
  amountCents: z.number().int().positive(),
  currencyCode: z
    .nativeEnum(Iso4217Alpha3SupportedCurrency)
    .default(Iso4217Alpha3SupportedCurrency.USD),
});

export async function fundingAccountRoutes(app: FastifyInstance) {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.get("/api/funding-accounts", {
    schema: {
      tags: ["Funding Accounts"],
      description: "List funding accounts available for issuing virtual cards from the AP card product.",
    },
  }, async (_request, reply) => {
    try {
      const accountHolderId = await getSubscriberAccountHolderId();
      const accounts = [];
      for await (const fa of highnote.accountHolders.listFinancialAccounts(accountHolderId, {
        filterBy: {
          features: { includes: [FinancialAccountFeatureType.CARD_FUNDING_ACCOUNT] },
          cardProductId: { equals: cardProductId },
        },
      })) {
        accounts.push(fa);
      }
      return { accounts };
    } catch (err) {
      return handleError(err, reply);
    }
  });

  typedApp.post("/api/admin/funding/:id/topup", {
    schema: {
      tags: ["Funding Accounts"],
      description: "Top up a funding account via simulated wire (test environment only).",
      params: IdParamsSchema,
      body: TopUpBodySchema,
    },
  }, async (request, reply) => {
    try {
      const deposit = await highnote.test.deposits.create({
        toFinancialAccountId: request.params.id,
        amount: {
          value: request.body.amountCents,
          currencyCode: request.body.currencyCode,
        },
        source: ElectronicFundTransferSource.WIRE,
      });
      return deposit;
    } catch (err) {
      return handleError(err, reply);
    }
  });
}

function handleError(err: unknown, reply: any) {
  if (err instanceof HighnoteUserError) {
    return reply.status(400).send({ error: "Highnote validation error", fieldErrors: err.fieldErrors });
  }
  if (err instanceof HighnoteAccessDeniedError) {
    return reply.status(403).send({ error: "Access denied", message: err.message });
  }
  throw err;
}
