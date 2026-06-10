import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  HighnoteUserError,
  HighnoteAccessDeniedError,
  ElectronicFundTransferSource,
  Iso4217Alpha3SupportedCurrency,
} from "@highnote-oss/nodejs-sdk";
import { highnote, cardProductId } from "../services/highnote.js";
import { IdParamsSchema } from "../types.js";

/**
 * Names of features that mark an account as a *source* of funds for ODF-issued
 * cards. Each card product's PFA carries `ProductFundingFinancialAccountFeature`;
 * the demo lists these so the operator can pick one as `sourceFinancialAccountId`
 * when approving an invoice.
 *
 * NOTE: keep these as `__typename` strings; the SDK exposes the discriminator
 * via `feature.__typename`, not via a separate enum.
 */
const FUNDING_SOURCE_FEATURE_TYPENAMES = new Set([
  "ProductFundingFinancialAccountFeature",
]);

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
      description:
        "List Product Funding Accounts (PFAs) for the configured AP card product. Each PFA is a candidate `sourceFinancialAccountId` for ODF-backed card issuance.",
    },
  }, async (_request, reply) => {
    try {
      // PFAs live at the card-product / org level, not at the applicant's
      // account holder. Querying accountHolders.listFinancialAccounts with
      // the subscriber's accountHolderId returns nothing here -- the PFA
      // belongs to the issuer organization, not to the subscriber.
      const all = [];
      for await (const fa of highnote.cardProducts.listFinancialAccounts(cardProductId)) {
        all.push(fa);
      }
      const accounts = all.filter((fa) =>
        (fa.features ?? []).some(
          (f) => f.__typename && FUNDING_SOURCE_FEATURE_TYPENAMES.has(f.__typename),
        ),
      );
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
