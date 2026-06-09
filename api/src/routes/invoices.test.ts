import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";

const { issueForApplicationWithOnDemandFunding } = vi.hoisted(() => ({
  issueForApplicationWithOnDemandFunding: vi.fn(),
}));

vi.mock("@highnote-oss/nodejs-sdk", async () => {
  const actual =
    await vi.importActual<typeof import("@highnote-oss/nodejs-sdk")>(
      "@highnote-oss/nodejs-sdk",
    );
  function MockHighnote() {
    return {
      cards: { issueForApplicationWithOnDemandFunding },
    };
  }
  return {
    ...actual,
    Highnote: MockHighnote,
  };
});

import { sqlite, db } from "../db/index.js";
import { users, invoices } from "../db/schema.js";
import { registerAuthHook, JWT_SECRET } from "../middleware/auth.js";
import { invoiceRoutes } from "./invoices.js";
import { applicationId } from "../services/highnote.js";
import { HighnoteUserError } from "@highnote-oss/nodejs-sdk";
import type { InvoiceStatus } from "../types.js";

function buildTestApp(): FastifyInstance {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuthHook(app);
  app.register(invoiceRoutes);
  return app;
}

function signToken(userId: number, email: string): string {
  return jwt.sign({ userId, email }, JWT_SECRET, {
    algorithm: "HS256",
    expiresIn: "1h",
  });
}

function ensureTablesForTest(): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      vendor_name TEXT NOT NULL,
      vendor_email TEXT NOT NULL,
      invoice_number TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      currency_code TEXT NOT NULL DEFAULT 'USD',
      due_date TEXT,
      expected_mcc TEXT,
      pdf_path TEXT,
      status TEXT NOT NULL DEFAULT 'DRAFT',
      source_funding_account_id TEXT,
      card_id TEXT,
      card_financial_account_id TEXT,
      pay_by_slug TEXT UNIQUE,
      pay_by_client_token TEXT,
      pay_by_slug_expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);
}

const validBody = {
  vendorName: "Acme Supplies",
  vendorEmail: "billing@acme.test",
  invoiceNumber: "INV-001",
  amountCents: 12_345,
  currencyCode: "USD",
};

let app: FastifyInstance;
let userAId: number;
let userBId: number;
let tokenA: string;
let tokenB: string;

beforeAll(async () => {
  ensureTablesForTest();
  app = buildTestApp();
  await app.ready();
});

beforeEach(() => {
  issueForApplicationWithOnDemandFunding.mockReset();
  sqlite.exec("DELETE FROM invoices; DELETE FROM users;");
  const [a] = db
    .insert(users)
    .values({ email: "a@example.com", passwordHash: "x" })
    .returning()
    .all();
  const [b] = db
    .insert(users)
    .values({ email: "b@example.com", passwordHash: "x" })
    .returning()
    .all();
  userAId = a.id;
  userBId = b.id;
  tokenA = signToken(userAId, a.email);
  tokenB = signToken(userBId, b.email);
});

describe("POST /api/invoices", () => {
  it("creates a draft invoice for the authenticated user", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/invoices",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: validBody,
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe("DRAFT");
    expect(body.userId).toBe(userAId);
    expect(body.vendorName).toBe(validBody.vendorName);
    expect(body.amountCents).toBe(validBody.amountCents);
    expect(typeof body.id).toBe("string");
  });

  it("rejects a body missing required fields with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/invoices",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { vendorName: "Acme" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("requires authentication", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/invoices",
      payload: validBody,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/invoices", () => {
  it("returns only the authenticated user's invoices", async () => {
    await app.inject({
      method: "POST",
      url: "/api/invoices",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: validBody,
    });

    const resA = await app.inject({
      method: "GET",
      url: "/api/invoices",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(resA.statusCode).toBe(200);
    expect(resA.json().invoices).toHaveLength(1);

    const resB = await app.inject({
      method: "GET",
      url: "/api/invoices",
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(resB.statusCode).toBe(200);
    expect(resB.json().invoices).toHaveLength(0);
  });
});

describe("GET /api/invoices/:id", () => {
  it("returns 404 when another user requests the invoice (no existence leak)", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/invoices",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: validBody,
    });
    const id = createRes.json().id;

    const res = await app.inject({
      method: "GET",
      url: `/api/invoices/${id}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/invoices/:id/cancel", () => {
  it("transitions DRAFT to CANCELLED", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/invoices",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: validBody,
    });
    const id = createRes.json().id;

    const res = await app.inject({
      method: "POST",
      url: `/api/invoices/${id}/cancel`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id, status: "CANCELLED" });
  });

  it("returns 400 on a second cancel attempt", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/invoices",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: validBody,
    });
    const id = createRes.json().id;

    await app.inject({
      method: "POST",
      url: `/api/invoices/${id}/cancel`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/invoices/${id}/cancel`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(second.statusCode).toBe(400);
    expect(second.json().error).toMatch(/already CANCELLED/);
  });
});

describe("POST /api/invoices/:id/approve", () => {
  const sourceFundingAccountId = "fa_funding_src";

  function paymentCardFixture(
    overrides: Partial<{
      id: string;
      financialAccounts: Array<{ id: string; __typename: "FinancialAccount" }>;
    }> = {},
  ) {
    return {
      __typename: "PaymentCard" as const,
      id: overrides.id ?? "pc_1",
      bin: "411111",
      last4: "1234",
      network: "VISA",
      status: "ACTIVE",
      formFactor: "VIRTUAL",
      expirationDate: "2028-12-31T00:00:00Z",
      expirationMonth: "12",
      expirationYear: "2028",
      externalId: null,
      financialAccounts: overrides.financialAccounts ?? [
        { id: "fa_1", __typename: "FinancialAccount" as const },
      ],
    };
  }

  async function createDraftInvoice(): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/invoices",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: validBody,
    });
    return res.json().id;
  }

  it("transitions DRAFT to CARD_ISSUED and persists cardId + financialAccountId", async () => {
    issueForApplicationWithOnDemandFunding.mockResolvedValueOnce(paymentCardFixture());
    const id = await createDraftInvoice();

    const res = await app.inject({
      method: "POST",
      url: `/api/invoices/${id}/approve`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { sourceFundingAccountId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id,
      status: "CARD_ISSUED" satisfies InvoiceStatus,
      cardId: "pc_1",
      cardFinancialAccountId: "fa_1",
    });

    const row = db.select().from(invoices).where(eq(invoices.id, id)).get();
    expect(row?.status).toBe("CARD_ISSUED");
    expect(row?.cardId).toBe("pc_1");
    expect(row?.cardFinancialAccountId).toBe("fa_1");
    expect(row?.sourceFundingAccountId).toBe(sourceFundingAccountId);
  });

  it("invokes the SDK with applicationId, sourceFinancialAccountId, and idempotencyKey === invoice.id", async () => {
    issueForApplicationWithOnDemandFunding.mockResolvedValueOnce(paymentCardFixture());
    const id = await createDraftInvoice();

    await app.inject({
      method: "POST",
      url: `/api/invoices/${id}/approve`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { sourceFundingAccountId },
    });

    expect(issueForApplicationWithOnDemandFunding).toHaveBeenCalledTimes(1);
    expect(issueForApplicationWithOnDemandFunding).toHaveBeenCalledWith(
      expect.objectContaining({
        applicationId,
        sourceFinancialAccountId: sourceFundingAccountId,
        idempotencyKey: id,
      }),
    );
  });

  it("returns 400 when the invoice is not in DRAFT status", async () => {
    const id = await createDraftInvoice();
    db.update(invoices)
      .set({ status: "CARD_ISSUED" satisfies InvoiceStatus })
      .where(eq(invoices.id, id))
      .run();

    const res = await app.inject({
      method: "POST",
      url: `/api/invoices/${id}/approve`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { sourceFundingAccountId },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Cannot approve invoice in CARD_ISSUED/);
    expect(issueForApplicationWithOnDemandFunding).not.toHaveBeenCalled();
  });

  it("returns 404 when another user attempts to approve the invoice", async () => {
    const id = await createDraftInvoice();

    const res = await app.inject({
      method: "POST",
      url: `/api/invoices/${id}/approve`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { sourceFundingAccountId },
    });

    expect(res.statusCode).toBe(404);
    expect(issueForApplicationWithOnDemandFunding).not.toHaveBeenCalled();
  });

  it("returns 400 with fieldErrors when the SDK throws HighnoteUserError", async () => {
    issueForApplicationWithOnDemandFunding.mockRejectedValueOnce(
      new HighnoteUserError([
        { code: "INVALID", description: "Funding account is closed" },
      ]),
    );
    const id = await createDraftInvoice();

    const res = await app.inject({
      method: "POST",
      url: `/api/invoices/${id}/approve`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { sourceFundingAccountId },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("Highnote validation error");
    expect(body.fieldErrors).toEqual([
      { code: "INVALID", description: "Funding account is closed" },
    ]);

    const row = db.select().from(invoices).where(eq(invoices.id, id)).get();
    expect(row?.status).toBe("DRAFT");
  });

  it("returns 500 when the SDK returns a card with no financial accounts", async () => {
    issueForApplicationWithOnDemandFunding.mockResolvedValueOnce(
      paymentCardFixture({ financialAccounts: [] }),
    );
    const id = await createDraftInvoice();

    const res = await app.inject({
      method: "POST",
      url: `/api/invoices/${id}/approve`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { sourceFundingAccountId },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: "Card issued but no FA returned",
      cardId: "pc_1",
    });

    const row = db.select().from(invoices).where(eq(invoices.id, id)).get();
    expect(row?.status).toBe("DRAFT");
  });
});
