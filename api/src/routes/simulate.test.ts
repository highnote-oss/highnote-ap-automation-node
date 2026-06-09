import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";

const { authorize } = vi.hoisted(() => ({
  authorize: vi.fn(),
}));

vi.mock("../services/highnote.js", () => ({
  highnote: {
    test: {
      transactions: { authorize },
    },
  },
}));

import { sqlite, db } from "../db/index.js";
import { users, invoices } from "../db/schema.js";
import { registerAuthHook, JWT_SECRET } from "../middleware/auth.js";
import { simulateRoutes } from "./simulate.js";
import {
  HighnoteUserError,
  HighnoteAccessDeniedError,
  Iso3166Alpha3Country,
  Iso4217Alpha3SupportedCurrency,
  MerchantCategory,
} from "@highnote-oss/nodejs-sdk";
import type { InvoiceStatus } from "../types.js";

function buildTestApp(): FastifyInstance {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuthHook(app);
  app.register(simulateRoutes);
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

let app: FastifyInstance;
let userAId: number;
let userBId: number;
let tokenA: string;

const FIXTURE_EVENT = {
  __typename: "AuthorizationEvent",
  id: "ae_fixture",
  authorizedAmount: { value: 5_000, currencyCode: "USD" },
};

beforeAll(async () => {
  ensureTablesForTest();
  app = buildTestApp();
  await app.ready();
});

beforeEach(() => {
  authorize.mockReset();
  authorize.mockResolvedValue(FIXTURE_EVENT);
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
});

function seedInvoice(
  ownerId: number,
  overrides: Partial<typeof invoices.$inferInsert> = {},
): string {
  const id = randomUUID();
  db.insert(invoices)
    .values({
      id,
      userId: ownerId,
      vendorName: "Acme",
      vendorEmail: "billing@acme.test",
      invoiceNumber: "INV-1",
      amountCents: 10_000,
      currencyCode: "USD",
      status: "CARD_ISSUED" satisfies InvoiceStatus,
      cardId: "pc_test",
      ...overrides,
    })
    .run();
  return id;
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    amountCents: 5_000,
    category: MerchantCategory.GROCERY_STORES_SUPERMARKETS,
    merchantName: "Acme Mart",
    ...overrides,
  };
}

describe("POST /api/simulate/authorize", () => {
  it("returns the SDK AuthorizationEvent for a valid issued invoice", async () => {
    const id = seedInvoice(userAId);

    const res = await app.inject({
      method: "POST",
      url: "/api/simulate/authorize",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: validBody({ invoiceId: id }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(FIXTURE_EVENT);
  });

  it("calls the SDK with the invoice's cardId, typed enums, and Iso3166Alpha3Country.USA", async () => {
    const id = seedInvoice(userAId, { cardId: "pc_specific_card" });

    await app.inject({
      method: "POST",
      url: "/api/simulate/authorize",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: validBody({ invoiceId: id }),
    });

    expect(authorize).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledWith({
      cardId: "pc_specific_card",
      amount: {
        value: 5_000,
        currencyCode: Iso4217Alpha3SupportedCurrency.USD,
      },
      merchantDetails: {
        merchantId: "sim-merchant",
        category: MerchantCategory.GROCERY_STORES_SUPERMARKETS,
        name: "Acme Mart",
        countryCodeAlpha3: Iso3166Alpha3Country.USA,
      },
    });
  });

  it("forces currencyCode from the invoice row, ignoring any body value", async () => {
    const id = seedInvoice(userAId, { currencyCode: "USD" });

    await app.inject({
      method: "POST",
      url: "/api/simulate/authorize",
      headers: { authorization: `Bearer ${tokenA}` },
      // Even if a future caller sneaks a currencyCode into the body, the
      // route must source it from the invoice, not the request. (Zod will
      // strip unknown keys, but this asserts the contract end-to-end.)
      payload: { ...validBody({ invoiceId: id }), currencyCode: "EUR" },
    });

    expect(authorize.mock.calls[0][0].amount.currencyCode).toBe(
      Iso4217Alpha3SupportedCurrency.USD,
    );
  });

  it("returns 400 when the invoice belongs to another user (no SDK call)", async () => {
    const id = seedInvoice(userBId);

    const res = await app.inject({
      method: "POST",
      url: "/api/simulate/authorize",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: validBody({ invoiceId: id }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/no issued card/i);
    expect(authorize).not.toHaveBeenCalled();
  });

  it("returns 400 when the invoice has no issued card", async () => {
    const id = seedInvoice(userAId, {
      status: "DRAFT" satisfies InvoiceStatus,
      cardId: null,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/simulate/authorize",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: validBody({ invoiceId: id }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/no issued card/i);
    expect(authorize).not.toHaveBeenCalled();
  });

  it("returns 400 from Zod when category is not a valid MerchantCategory member", async () => {
    const id = seedInvoice(userAId);

    const res = await app.inject({
      method: "POST",
      url: "/api/simulate/authorize",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { ...validBody({ invoiceId: id }), category: "NOT_A_REAL_CATEGORY" },
    });

    expect(res.statusCode).toBe(400);
    expect(authorize).not.toHaveBeenCalled();
  });

  it("returns 400 from Zod when amountCents is not a positive integer", async () => {
    const id = seedInvoice(userAId);

    const res = await app.inject({
      method: "POST",
      url: "/api/simulate/authorize",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { ...validBody({ invoiceId: id }), amountCents: -1 },
    });

    expect(res.statusCode).toBe(400);
    expect(authorize).not.toHaveBeenCalled();
  });

  it("returns 400 from Zod when merchantName exceeds the SDK's 25-char cap", async () => {
    const id = seedInvoice(userAId);

    const res = await app.inject({
      method: "POST",
      url: "/api/simulate/authorize",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { ...validBody({ invoiceId: id }), merchantName: "x".repeat(26) },
    });

    expect(res.statusCode).toBe(400);
    expect(authorize).not.toHaveBeenCalled();
  });

  it("returns 400 with fieldErrors when the SDK throws HighnoteUserError", async () => {
    authorize.mockRejectedValueOnce(
      new HighnoteUserError([
        { code: "INVALID", description: "Card is closed" },
      ]),
    );
    const id = seedInvoice(userAId);

    const res = await app.inject({
      method: "POST",
      url: "/api/simulate/authorize",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: validBody({ invoiceId: id }),
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("Highnote validation error");
    expect(body.fieldErrors).toEqual([
      { code: "INVALID", description: "Card is closed" },
    ]);
  });

  it("returns 403 when the SDK throws HighnoteAccessDeniedError", async () => {
    authorize.mockRejectedValueOnce(new HighnoteAccessDeniedError("nope"));
    const id = seedInvoice(userAId);

    const res = await app.inject({
      method: "POST",
      url: "/api/simulate/authorize",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: validBody({ invoiceId: id }),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("Access denied");
  });
});
