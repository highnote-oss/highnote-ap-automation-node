import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { randomUUID } from "node:crypto";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../db/index.js";
import { invoices } from "../db/schema.js";
import { CreateInvoiceBodySchema, IdParamsSchema } from "../types.js";
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
}
