import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyRawBody from "fastify-raw-body";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import jwt from "jsonwebtoken";
import { createHmac, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  Iso4217Alpha3SupportedCurrency,
  NotificationEventName,
} from "@highnote-oss/nodejs-sdk";

const SECRET = "test-webhook-secret";

// Hoist mocks so they're in place before route imports pull the SDK / service.
const { getSecret, noteVerifiedEventReceived, cardsClose } = vi.hoisted(() => ({
  getSecret: vi.fn<() => string | null>(() => SECRET),
  noteVerifiedEventReceived: vi.fn<() => void>(),
  cardsClose: vi.fn<(args: { paymentCardId: string }) => Promise<unknown>>(
    async () => ({ id: "pc_closed" }),
  ),
}));

vi.mock("../services/webhookRegistration.js", () => ({
  getSecret,
  noteVerifiedEventReceived,
  // Unused in these tests but referenced via `import *`; stub for completeness.
  getStatus: vi.fn(async () => ({ targetId: null })),
  getStatusSync: vi.fn(() => ({ targetId: null })),
  getPublicWebhookUrl: vi.fn(() => null),
  init: vi.fn(async () => undefined),
}));

vi.mock("../services/highnote.js", () => ({
  highnote: {
    cards: { close: cardsClose },
    webhooks: {
      add: vi.fn(),
      list: vi.fn(),
      listEvents: vi.fn(),
      replay: vi.fn(),
    },
  },
}));

import { sqlite, db } from "../db/index.js";
import { users, invoices, webhookEvents } from "../db/schema.js";
import { registerAuthHook, JWT_SECRET } from "../middleware/auth.js";
import { webhookRoutes } from "./webhooks.js";
import type { InvoiceStatus } from "../types.js";

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
    CREATE TABLE IF NOT EXISTS webhook_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT UNIQUE,
      event_type TEXT NOT NULL,
      invoice_id TEXT,
      payload TEXT NOT NULL,
      received_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(fastifyRawBody, {
    field: "rawBody",
    encoding: "utf8",
    runFirst: true,
    global: false,
  });
  registerAuthHook(app);
  await app.register(webhookRoutes);
  await app.ready();
  return app;
}

interface BuildEventOpts {
  cardId?: string;
  eventName?: NotificationEventName;
  approvedValue?: number;
  approvedCurrency?: Iso4217Alpha3SupportedCurrency;
  eventId?: string;
}

// Mirrors the real Highnote delivery shape: a NotificationEvent nested under
// data.node, whose type is data.node.name and whose per-event detail (cardId,
// amounts) is data.node.node.
function buildEventPayload(opts: BuildEventOpts = {}): Record<string, unknown> {
  const currencyCode =
    opts.approvedCurrency ?? Iso4217Alpha3SupportedCurrency.USD;
  const name =
    opts.eventName ?? NotificationEventName.PAYMENT_CARD_AUTHORIZATION_APPROVED;
  return {
    data: {
      node: {
        __typename: "NotificationEvent",
        id: opts.eventId ?? "nee_" + randomUUID(),
        name,
        node: {
          __typename: "PaymentCardAuthorizationApprovedEvent",
          id: "te_" + randomUUID(),
          cardId: opts.cardId ?? "pc_test",
          approvedAmount: {
            value: opts.approvedValue ?? 5_000,
            currencyCode,
          },
          requestedAmount: {
            value: opts.approvedValue ?? 5_000,
            currencyCode,
          },
        },
      },
    },
    extensions: { signatureTimestamp: Date.now() },
  };
}

function sign(raw: string, secret: string = SECRET): string {
  return createHmac("sha256", secret).update(raw).digest("hex");
}

async function postSigned(
  app: FastifyInstance,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; body: unknown }> {
  const raw = JSON.stringify(payload);
  const res = await app.inject({
    method: "POST",
    url: "/api/webhooks",
    headers: {
      "highnote-signature": sign(raw),
      "content-type": "application/json",
    },
    payload: raw,
  });
  return { statusCode: res.statusCode, body: res.json() };
}

let app: FastifyInstance;
let userId: number;
let otherUserId: number;
let tokenA: string;
let tokenB: string;

beforeAll(async () => {
  ensureTablesForTest();
  app = await buildTestApp();
});

beforeEach(() => {
  getSecret.mockReset();
  getSecret.mockReturnValue(SECRET);
  noteVerifiedEventReceived.mockReset();
  cardsClose.mockReset();
  cardsClose.mockResolvedValue({ id: "pc_closed" });
  sqlite.exec(
    "DELETE FROM webhook_events; DELETE FROM invoices; DELETE FROM users;",
  );
  const [u] = db
    .insert(users)
    .values({ email: "wh@example.com", passwordHash: "x" })
    .returning()
    .all();
  userId = u.id;
  const [other] = db
    .insert(users)
    .values({ email: "wh-other@example.com", passwordHash: "x" })
    .returning()
    .all();
  otherUserId = other.id;
  tokenA = signToken(userId, u.email);
  tokenB = signToken(otherUserId, other.email);
});

function seedInvoice(
  overrides: Partial<typeof invoices.$inferInsert> = {},
): string {
  const id = randomUUID();
  db.insert(invoices)
    .values({
      id,
      userId,
      vendorName: "Acme",
      vendorEmail: "acme@example.com",
      invoiceNumber: "INV-1",
      amountCents: 10_000,
      currencyCode: Iso4217Alpha3SupportedCurrency.USD,
      status: "CARD_ISSUED" satisfies InvoiceStatus,
      cardId: "pc_test",
      ...overrides,
    })
    .run();
  return id;
}

describe("POST /api/webhooks — signature & basic shape", () => {
  it("returns 503 when no signing secret is in memory", async () => {
    getSecret.mockReturnValue(null);
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks",
      payload: JSON.stringify({ id: "evt_1", name: "TEST_EVENT" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(503);
  });

  it("returns 400 for an empty body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks",
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 401 when the signature is invalid", async () => {
    const payload = buildEventPayload();
    const raw = JSON.stringify(payload);
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks",
      headers: {
        "highnote-signature": sign(raw, "wrong-secret"),
        "content-type": "application/json",
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /api/webhooks — invoice state transitions", () => {
  it("transitions CARD_ISSUED → AUTHORIZED on PAYMENT_CARD_AUTHORIZATION_APPROVED for a matching card", async () => {
    const invoiceId = seedInvoice();

    const { statusCode } = await postSigned(
      app,
      buildEventPayload({
        cardId: "pc_test",
        eventName: NotificationEventName.PAYMENT_CARD_AUTHORIZATION_APPROVED,
      }),
    );
    expect(statusCode).toBe(200);

    const row = db.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
    expect(row?.status).toBe("AUTHORIZED" satisfies InvoiceStatus);
  });

  it("settles CARD_ISSUED → RECONCILED on a single-step auth+clear (AP pay path) and fires cards.close", async () => {
    const invoiceId = seedInvoice({
      status: "CARD_ISSUED" satisfies InvoiceStatus,
      amountCents: 10_000,
      currencyCode: Iso4217Alpha3SupportedCurrency.USD,
    });

    const { statusCode } = await postSigned(
      app,
      buildEventPayload({
        cardId: "pc_test",
        eventName:
          NotificationEventName.PAYMENT_CARD_AUTHORIZATION_AND_CLEAR_APPROVED,
        approvedValue: 10_000,
        approvedCurrency: "USD",
      }),
    );
    expect(statusCode).toBe(200);

    const row = db.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
    expect(row?.status).toBe("RECONCILED" satisfies InvoiceStatus);
    expect(cardsClose).toHaveBeenCalledWith({ paymentCardId: "pc_test" });
  });

  it("transitions to RECONCILED on PAYMENT_CARD_CLEARED when amount matches exactly, and fires cards.close", async () => {
    const invoiceId = seedInvoice({
      status: "AUTHORIZED" satisfies InvoiceStatus,
      amountCents: 10_000,
      currencyCode: Iso4217Alpha3SupportedCurrency.USD,
    });

    const { statusCode } = await postSigned(
      app,
      buildEventPayload({
        cardId: "pc_test",
        eventName: NotificationEventName.PAYMENT_CARD_CLEARED,
        approvedValue: 10_000,
        approvedCurrency: "USD",
      }),
    );
    expect(statusCode).toBe(200);

    const row = db.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
    expect(row?.status).toBe("RECONCILED" satisfies InvoiceStatus);
    expect(cardsClose).toHaveBeenCalledWith({ paymentCardId: "pc_test" });
  });

  it("transitions to CLEARED (not RECONCILED) on PAYMENT_CARD_CLEARED with amount variance, and still fires cards.close", async () => {
    const invoiceId = seedInvoice({
      status: "AUTHORIZED" satisfies InvoiceStatus,
      amountCents: 10_000,
      currencyCode: Iso4217Alpha3SupportedCurrency.USD,
    });

    const { statusCode } = await postSigned(
      app,
      buildEventPayload({
        cardId: "pc_test",
        eventName: NotificationEventName.PAYMENT_CARD_CLEARED,
        approvedValue: 9_950, // Variance — does not match invoice exactly.
        approvedCurrency: "USD",
      }),
    );
    expect(statusCode).toBe(200);

    const row = db.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
    expect(row?.status).toBe("CLEARED" satisfies InvoiceStatus);
    expect(cardsClose).toHaveBeenCalledWith({ paymentCardId: "pc_test" });
  });

  it("logs the event but does not mutate any invoice when no card matches", async () => {
    const invoiceId = seedInvoice({ cardId: "pc_other" });

    const { statusCode } = await postSigned(
      app,
      buildEventPayload({
        cardId: "pc_unknown",
        eventName: NotificationEventName.PAYMENT_CARD_AUTHORIZATION_APPROVED,
      }),
    );
    expect(statusCode).toBe(200);

    const row = db.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
    expect(row?.status).toBe("CARD_ISSUED" satisfies InvoiceStatus);

    const eventRows = db.select().from(webhookEvents).all();
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0].eventType).toBe(
      NotificationEventName.PAYMENT_CARD_AUTHORIZATION_APPROVED,
    );

    expect(cardsClose).not.toHaveBeenCalled();
  });

  it("guards the AUTHORIZED transition — duplicate-delivered auth event after CLEARED does NOT regress status", async () => {
    const invoiceId = seedInvoice({
      status: "CLEARED" satisfies InvoiceStatus,
    });

    const { statusCode } = await postSigned(
      app,
      buildEventPayload({
        cardId: "pc_test",
        eventName: NotificationEventName.PAYMENT_CARD_AUTHORIZATION_APPROVED,
      }),
    );
    expect(statusCode).toBe(200);

    const row = db.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
    expect(row?.status).toBe("CLEARED" satisfies InvoiceStatus);
  });

  it("persists the raw event to webhook_events AND writes the invoice status BEFORE cards.close fails", async () => {
    const invoiceId = seedInvoice({
      status: "AUTHORIZED" satisfies InvoiceStatus,
      amountCents: 10_000,
      currencyCode: Iso4217Alpha3SupportedCurrency.USD,
    });

    // Force cards.close to throw — dispatch must have already logged the event
    // AND written the invoice row to its terminal status before the failure.
    cardsClose.mockRejectedValueOnce(new Error("upstream close failed"));

    const payload = buildEventPayload({
      cardId: "pc_test",
      eventName: NotificationEventName.PAYMENT_CARD_CLEARED,
      approvedValue: 10_000,
      approvedCurrency: "USD",
      eventId: "nee_persist_test",
    });

    const { statusCode } = await postSigned(app, payload);
    expect(statusCode).toBe(200);

    const eventRows = db.select().from(webhookEvents).all();
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0].eventType).toBe(
      NotificationEventName.PAYMENT_CARD_CLEARED,
    );
    // eventId is read from the nested data.node.id.
    expect(eventRows[0].eventId).toBe("nee_persist_test");

    // Status write happens before the close attempt — so even though close
    // throws, the invoice has already advanced to its terminal status.
    const row = db.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
    expect(row?.status).toBe("RECONCILED" satisfies InvoiceStatus);
  });

  it("guards the CLEARED transition — duplicate-delivered cleared event does NOT re-fire cards.close", async () => {
    // Invoice is already in a terminal cleared status. A second delivery of
    // the cleared event must not call cards.close again.
    seedInvoice({
      status: "RECONCILED" satisfies InvoiceStatus,
      amountCents: 10_000,
      currencyCode: Iso4217Alpha3SupportedCurrency.USD,
    });

    const { statusCode } = await postSigned(
      app,
      buildEventPayload({
        cardId: "pc_test",
        eventName: NotificationEventName.PAYMENT_CARD_CLEARED,
        approvedValue: 10_000,
        approvedCurrency: "USD",
      }),
    );
    expect(statusCode).toBe(200);

    expect(cardsClose).not.toHaveBeenCalled();
  });

  it("returns 200 with the event persisted but no DB invoice update when event has no cardId", async () => {
    const invoiceId = seedInvoice();

    const payload = {
      id: "evt_" + randomUUID(),
      name: NotificationEventName.PAYMENT_CARD_AUTHORIZATION_APPROVED,
      data: {
        __typename: "PaymentCardAuthorizationApprovedEvent",
        // cardId intentionally omitted.
        approvedAmount: {
          value: 5_000,
          currencyCode: Iso4217Alpha3SupportedCurrency.USD,
        },
      },
      // The SDK signature verifier requires a recent signatureTimestamp; it
      // is unrelated to the cardId branch we're exercising here.
      extensions: { signatureTimestamp: Date.now() },
    };

    const { statusCode } = await postSigned(app, payload);
    expect(statusCode).toBe(200);

    const eventRows = db.select().from(webhookEvents).all();
    expect(eventRows).toHaveLength(1);

    const row = db.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
    expect(row?.status).toBe("CARD_ISSUED" satisfies InvoiceStatus);
    expect(cardsClose).not.toHaveBeenCalled();
  });

  it("deduplicates by eventId — a duplicate delivery of the same event leaves only one webhook_events row", async () => {
    seedInvoice();

    const eventId = "evt_dup_" + randomUUID();
    const payload = buildEventPayload({
      cardId: "pc_test",
      eventName: NotificationEventName.PAYMENT_CARD_AUTHORIZATION_APPROVED,
      eventId,
    });

    const first = await postSigned(app, payload);
    expect(first.statusCode).toBe(200);

    const second = await postSigned(app, payload);
    expect(second.statusCode).toBe(200);

    const eventRows = db.select().from(webhookEvents).all();
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0].eventId).toBe(eventId);
  });

  // Notable: malformed JSON is rejected by Fastify's built-in JSON body
  // parser BEFORE the route handler runs, so signature verification and
  // the route's own JSON.parse catch are both bypassed. The observable
  // result is 400 with no webhook_events row written. We pin this so a
  // future signature-handling refactor can't accidentally let a malformed
  // payload through to dispatch.
  it("rejects with 400 a body with a valid HMAC but malformed JSON, and writes no webhook_events row", async () => {
    seedInvoice();

    const raw = "{not valid json";
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks",
      headers: {
        "highnote-signature": sign(raw),
        "content-type": "application/json",
      },
      payload: raw,
    });

    expect(res.statusCode).toBe(400);

    const eventRows = db.select().from(webhookEvents).all();
    expect(eventRows).toHaveLength(0);
    expect(cardsClose).not.toHaveBeenCalled();
  });
});

describe("GET /api/invoices/:id/webhook-events", () => {
  it("returns the invoice's events ordered by receivedAt DESC for the owner", async () => {
    const invoiceId = seedInvoice();
    db.insert(webhookEvents)
      .values({
        eventId: "evt_old",
        eventType: NotificationEventName.PAYMENT_CARD_AUTHORIZATION_APPROVED,
        invoiceId,
        payload: "{}",
        receivedAt: "2024-01-01T00:00:00.000Z",
      })
      .run();
    db.insert(webhookEvents)
      .values({
        eventId: "evt_new",
        eventType: NotificationEventName.PAYMENT_CARD_CLEARED,
        invoiceId,
        payload: "{}",
        receivedAt: "2024-02-01T00:00:00.000Z",
      })
      .run();

    const res = await app.inject({
      method: "GET",
      url: `/api/invoices/${invoiceId}/webhook-events`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.events).toHaveLength(2);
    expect(body.events[0].eventId).toBe("evt_new");
    expect(body.events[1].eventId).toBe("evt_old");
  });

  it("returns 404 when the invoice belongs to another user (no existence leak)", async () => {
    const invoiceId = seedInvoice();
    db.insert(webhookEvents)
      .values({
        eventId: "evt_leak",
        eventType: NotificationEventName.PAYMENT_CARD_AUTHORIZATION_APPROVED,
        invoiceId,
        payload: "{}",
      })
      .run();

    const res = await app.inject({
      method: "GET",
      url: `/api/invoices/${invoiceId}/webhook-events`,
      headers: { authorization: `Bearer ${tokenB}` },
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns an empty array when the invoice has no events", async () => {
    const invoiceId = seedInvoice();

    const res = await app.inject({
      method: "GET",
      url: `/api/invoices/${invoiceId}/webhook-events`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ events: [] });
  });
});
