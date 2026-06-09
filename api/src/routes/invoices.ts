import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { randomUUID } from "node:crypto";
import { eq, and, desc } from "drizzle-orm";
import {
  HighnoteUserError,
  HighnoteAccessDeniedError,
} from "@highnote-oss/nodejs-sdk";
import { db } from "../db/index.js";
import { invoices } from "../db/schema.js";
import { highnote, applicationId } from "../services/highnote.js";
import {
  ApproveInvoiceBodySchema,
  CreateInvoiceBodySchema,
  IdParamsSchema,
} from "../types.js";
import type { InvoiceStatus } from "../types.js";

export async function invoiceRoutes(app: FastifyInstance) {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.post("/api/invoices", {
    schema: {
      tags: ["Invoices"],
      description: "Create a draft invoice.",
      body: CreateInvoiceBodySchema,
    },
  }, async (request, reply) => {
    const userId = request.user.id;
    const id = randomUUID();
    const now = new Date().toISOString();

    db.insert(invoices).values({
      id,
      userId,
      vendorName: request.body.vendorName,
      vendorEmail: request.body.vendorEmail,
      invoiceNumber: request.body.invoiceNumber,
      amountCents: request.body.amountCents,
      currencyCode: request.body.currencyCode,
      dueDate: request.body.dueDate ?? null,
      expectedMcc: request.body.expectedMcc ?? null,
      status: "DRAFT" satisfies InvoiceStatus,
      createdAt: now,
      updatedAt: now,
    }).run();

    const created = db.select().from(invoices).where(eq(invoices.id, id)).get();
    return reply.status(201).send(created);
  });

  typedApp.get("/api/invoices", {
    schema: { tags: ["Invoices"], description: "List invoices for the authenticated user." },
  }, async (request) => {
    const rows = db
      .select()
      .from(invoices)
      .where(eq(invoices.userId, request.user.id))
      .orderBy(desc(invoices.createdAt))
      .all();
    return { invoices: rows };
  });

  typedApp.get("/api/invoices/:id", {
    schema: { tags: ["Invoices"], description: "Get one invoice.", params: IdParamsSchema },
  }, async (request, reply) => {
    const row = db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, request.params.id), eq(invoices.userId, request.user.id)))
      .get();
    if (!row) return reply.status(404).send({ error: "Invoice not found" });
    return row;
  });

  typedApp.post("/api/invoices/:id/cancel", {
    schema: {
      tags: ["Invoices"],
      description: "Cancel a draft or issued invoice.",
      params: IdParamsSchema,
    },
  }, async (request, reply) => {
    const row = db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, request.params.id), eq(invoices.userId, request.user.id)))
      .get();
    if (!row) return reply.status(404).send({ error: "Invoice not found" });

    const terminal: InvoiceStatus[] = ["RECONCILED", "CANCELLED"];
    if (terminal.includes(row.status as InvoiceStatus)) {
      return reply.status(400).send({ error: `Invoice is already ${row.status}` });
    }

    // Card closure on cancel is deferred to Task 8/12 (where we have the cards.close
    // wiring in place). For now we transition the invoice and rely on the operator
    // to manually close any open card via the dashboard if needed.
    const now = new Date().toISOString();
    db.update(invoices)
      .set({ status: "CANCELLED" satisfies InvoiceStatus, updatedAt: now })
      .where(eq(invoices.id, row.id))
      .run();
    return { id: row.id, status: "CANCELLED" satisfies InvoiceStatus };
  });

  typedApp.post("/api/invoices/:id/approve", {
    schema: {
      tags: ["Invoices"],
      description: "Approve a draft invoice and issue the single-use virtual card.",
      params: IdParamsSchema,
      body: ApproveInvoiceBodySchema,
    },
  }, async (request, reply) => {
    const row = db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, request.params.id), eq(invoices.userId, request.user.id)))
      .get();
    if (!row) return reply.status(404).send({ error: "Invoice not found" });
    if (row.status !== ("DRAFT" satisfies InvoiceStatus)) {
      return reply.status(400).send({ error: `Cannot approve invoice in ${row.status}` });
    }

    try {
      const card = await highnote.cards.issueForApplicationWithOnDemandFunding({
        applicationId,
        sourceFinancialAccountId: request.body.sourceFundingAccountId,
        options: {
          activateOnCreate: true,
          expirationDate: defaultExpirationDate(),
        },
        idempotencyKey: row.id,
      });

      const newFinancialAccountId = card.financialAccounts?.[0]?.id;
      if (!newFinancialAccountId) {
        return reply.status(500).send({
          error: "Card issued but no FA returned",
          cardId: card.id,
        });
      }

      const now = new Date().toISOString();
      db.update(invoices).set({
        status: "CARD_ISSUED" satisfies InvoiceStatus,
        sourceFundingAccountId: request.body.sourceFundingAccountId,
        cardId: card.id,
        cardFinancialAccountId: newFinancialAccountId,
        updatedAt: now,
      }).where(eq(invoices.id, row.id)).run();

      return {
        id: row.id,
        status: "CARD_ISSUED" satisfies InvoiceStatus,
        cardId: card.id,
        cardFinancialAccountId: newFinancialAccountId,
      };
    } catch (err) {
      return handleError(err, reply);
    }
  });
}

function defaultExpirationDate(): string {
  // Default: ~2 years from now, end of month.
  const d = new Date();
  d.setFullYear(d.getFullYear() + 2);
  d.setMonth(d.getMonth() + 1, 0);
  d.setHours(23, 59, 59, 0);
  return d.toISOString();
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
