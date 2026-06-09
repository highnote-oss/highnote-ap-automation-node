import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyRawBody from "fastify-raw-body";
import { createHmac, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { eq } from "drizzle-orm";
import { CollaborativeAuthorizationResponseCode } from "@highnote-oss/nodejs-sdk";

const SECRET = "test-secret-do-not-use";

const { getSigningKey } = vi.hoisted(() => ({
  getSigningKey: vi.fn<() => string | null>(() => SECRET),
}));

vi.mock("../services/collabAuthRegistration.js", () => ({
  getSigningKey,
}));

import { sqlite, db } from "../db/index.js";
import { users, invoices, collabAuthDecisions } from "../db/schema.js";
import { collaborativeAuthRoutes } from "./collaborativeAuth.js";
import type { InvoiceStatus } from "../types.js";

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
    CREATE TABLE IF NOT EXISTS collab_auth_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id TEXT,
      payment_card_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      requested_amount_cents INTEGER NOT NULL,
      merchant_category_code TEXT,
      decision TEXT NOT NULL,
      reason TEXT,
      raw_payload TEXT NOT NULL,
      received_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(fastifyRawBody, {
    field: "rawBody",
    encoding: "utf8",
    runFirst: true,
    global: false,
  });
  await app.register(collaborativeAuthRoutes);
  await app.ready();
  return app;
}

interface BuildRequestOpts {
  cardId?: string;
  requestedAmount?: number;
  merchantCategoryCode?: string;
  transactionId?: string;
  requestId?: string;
}

function buildCaRequestBody(opts: BuildRequestOpts = {}): Record<string, unknown> {
  const requestedAmount = opts.requestedAmount ?? 5_000;
  return {
    data: {
      collaborativeAuthorizationRequest: {
        id: opts.requestId ?? "req_" + randomUUID(),
        transaction: { id: opts.transactionId ?? "tx_1" },
        paymentCard: { id: opts.cardId ?? "pc_test" },
        transactionAmount: { value: requestedAmount, currencyCode: "USD" },
        settlementAmount: { value: requestedAmount, currencyCode: "USD" },
        requestedAmount: { value: requestedAmount, currencyCode: "USD" },
        merchantDetails: {
          merchantId: "m_1",
          merchantCategoryCode: opts.merchantCategoryCode ?? "5411",
          description: "Test Merchant",
          countryCodeAlpha3: "USA",
        },
        responseCode: "APPROVED",
      },
    },
    extensions: { signatureTimestamp: Date.now() },
  };
}

function signPayload(raw: string, secret: string = SECRET): string {
  return createHmac("sha256", secret).update(raw).digest("hex");
}

async function postSigned(
  app: FastifyInstance,
  opts: BuildRequestOpts = {},
): Promise<{ statusCode: number; body: any; raw: string }> {
  const body = buildCaRequestBody(opts);
  const raw = JSON.stringify(body);
  const signature = signPayload(raw);
  const res = await app.inject({
    method: "POST",
    url: "/collaborative-auth",
    headers: {
      "highnote-signature": signature,
      "content-type": "application/json",
    },
    payload: raw,
  });
  return { statusCode: res.statusCode, body: res.json(), raw };
}

async function waitForDecisionPersist(): Promise<void> {
  // queueMicrotask runs after the response is sent; flush by yielding to the
  // microtask queue before reading from the DB.
  await new Promise((resolve) => setImmediate(resolve));
}

let app: FastifyInstance;
let userId: number;

beforeAll(async () => {
  ensureTablesForTest();
  app = await buildTestApp();
});

beforeEach(() => {
  getSigningKey.mockReset();
  getSigningKey.mockReturnValue(SECRET);
  sqlite.exec("DELETE FROM collab_auth_decisions; DELETE FROM invoices; DELETE FROM users;");
  const [u] = db
    .insert(users)
    .values({ email: "ca@example.com", passwordHash: "x" })
    .returning()
    .all();
  userId = u.id;
});

function seedInvoice(overrides: Partial<typeof invoices.$inferInsert> = {}): string {
  const id = randomUUID();
  db.insert(invoices)
    .values({
      id,
      userId,
      vendorName: "Acme",
      vendorEmail: "acme@example.com",
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

describe("POST /collaborative-auth — decision tree", () => {
  it("declines with INVALID_TRANSACTION when no invoice matches the card", async () => {
    const { statusCode, body } = await postSigned(app, { cardId: "pc_unknown" });

    expect(statusCode).toBe(200);
    expect(body.responseCode).toBe(
      CollaborativeAuthorizationResponseCode.INVALID_TRANSACTION,
    );

    await waitForDecisionPersist();
    const rows = db.select().from(collabAuthDecisions).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].invoiceId).toBeNull();
    expect(rows[0].decision).toBe(
      CollaborativeAuthorizationResponseCode.INVALID_TRANSACTION,
    );
  });

  it("approves a matching CARD_ISSUED invoice within the limit and no MCC constraint", async () => {
    const invoiceId = seedInvoice({ amountCents: 10_000, expectedMcc: null });

    const { statusCode, body } = await postSigned(app, { requestedAmount: 5_000 });

    expect(statusCode).toBe(200);
    expect(body.responseCode).toBe(
      CollaborativeAuthorizationResponseCode.APPROVED,
    );

    await waitForDecisionPersist();
    const row = db.select().from(collabAuthDecisions).get();
    expect(row?.invoiceId).toBe(invoiceId);
  });

  it("declines with DUPLICATE_TRANSACTION when the single-use card was already consumed", async () => {
    seedInvoice({ status: "AUTHORIZED" satisfies InvoiceStatus });

    const { statusCode, body } = await postSigned(app, { requestedAmount: 5_000 });

    expect(statusCode).toBe(200);
    expect(body.responseCode).toBe(
      CollaborativeAuthorizationResponseCode.DUPLICATE_TRANSACTION,
    );
  });

  it("declines with INSUFFICIENT_FUNDS when requested amount exceeds invoice", async () => {
    seedInvoice({ amountCents: 10_000 });

    const { statusCode, body } = await postSigned(app, { requestedAmount: 20_000 });

    expect(statusCode).toBe(200);
    expect(body.responseCode).toBe(
      CollaborativeAuthorizationResponseCode.INSUFFICIENT_FUNDS,
    );
  });

  it("declines with INVALID_MERCHANT_CATEGORY_CODE when MCC mismatches", async () => {
    seedInvoice({ amountCents: 10_000, expectedMcc: "5411" });

    const { statusCode, body } = await postSigned(app, {
      requestedAmount: 5_000,
      merchantCategoryCode: "5732",
    });

    expect(statusCode).toBe(200);
    expect(body.responseCode).toBe(
      CollaborativeAuthorizationResponseCode.INVALID_MERCHANT_CATEGORY_CODE,
    );
  });
});

describe("POST /collaborative-auth — signature & registration", () => {
  it("rejects a tampered signature with 401", async () => {
    const body = buildCaRequestBody();
    const raw = JSON.stringify(body);
    const badSignature = signPayload(raw, "wrong-secret");

    const res = await app.inject({
      method: "POST",
      url: "/collaborative-auth",
      headers: {
        "highnote-signature": badSignature,
        "content-type": "application/json",
      },
      payload: raw,
    });

    expect(res.statusCode).toBe(401);
  });

  it("returns 503 when the signing key is not yet registered", async () => {
    getSigningKey.mockReturnValue(null);

    const body = buildCaRequestBody();
    const raw = JSON.stringify(body);
    const res = await app.inject({
      method: "POST",
      url: "/collaborative-auth",
      headers: {
        "highnote-signature": signPayload(raw),
        "content-type": "application/json",
      },
      payload: raw,
    });

    expect(res.statusCode).toBe(503);
  });
});

describe("POST /collaborative-auth — latency budget", () => {
  it("responds in under 200ms with the full decision tree exercised", async () => {
    seedInvoice({ amountCents: 10_000, expectedMcc: "5411" });

    const start = performance.now();
    const { statusCode } = await postSigned(app, {
      requestedAmount: 5_000,
      merchantCategoryCode: "5411",
    });
    const elapsedMs = performance.now() - start;

    expect(statusCode).toBe(200);
    expect(elapsedMs).toBeLessThan(200);
  });
});
