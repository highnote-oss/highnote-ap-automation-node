import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyRawBody from "fastify-raw-body";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { createHmac, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { NotificationEventName } from "@highnote-oss/nodejs-sdk";

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
import { webhookRoutes } from "./webhooks.js";
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
  await app.register(webhookRoutes);
  await app.ready();
  return app;
}

interface BuildEventOpts {
  cardId?: string;
  eventName?: NotificationEventName;
  approvedValue?: number;
  approvedCurrency?: string;
  eventId?: string;
}

function buildEventPayload(opts: BuildEventOpts = {}): Record<string, unknown> {
  return {
    id: opts.eventId ?? "evt_" + randomUUID(),
    name: opts.eventName ?? NotificationEventName.CARD_PAYMENT_AUTHORIZED_EVENT,
    data: {
      __typename:
        opts.eventName === NotificationEventName.CARD_PAYMENT_CLEARED_EVENT
          ? "PaymentCardClearedEvent"
          : "PaymentCardAuthorizationApprovedEvent",
      id: "ev_node_" + randomUUID(),
      cardId: opts.cardId ?? "pc_test",
      approvedAmount: {
        value: opts.approvedValue ?? 5_000,
        currencyCode: opts.approvedCurrency ?? "USD",
      },
      requestedAmount: {
        value: opts.approvedValue ?? 5_000,
        currencyCode: opts.approvedCurrency ?? "USD",
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
      currencyCode: "USD",
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
  it("transitions CARD_ISSUED → AUTHORIZED on CARD_PAYMENT_AUTHORIZED_EVENT for a matching card", async () => {
    const invoiceId = seedInvoice();

    const { statusCode } = await postSigned(
      app,
      buildEventPayload({
        cardId: "pc_test",
        eventName: NotificationEventName.CARD_PAYMENT_AUTHORIZED_EVENT,
      }),
    );
    expect(statusCode).toBe(200);

    const row = db.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
    expect(row?.status).toBe("AUTHORIZED" satisfies InvoiceStatus);
  });

  it("transitions to RECONCILED on CARD_PAYMENT_CLEARED_EVENT when amount matches exactly, and fires cards.close", async () => {
    const invoiceId = seedInvoice({
      status: "AUTHORIZED" satisfies InvoiceStatus,
      amountCents: 10_000,
      currencyCode: "USD",
    });

    const { statusCode } = await postSigned(
      app,
      buildEventPayload({
        cardId: "pc_test",
        eventName: NotificationEventName.CARD_PAYMENT_CLEARED_EVENT,
        approvedValue: 10_000,
        approvedCurrency: "USD",
      }),
    );
    expect(statusCode).toBe(200);

    const row = db.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
    expect(row?.status).toBe("RECONCILED" satisfies InvoiceStatus);
    expect(cardsClose).toHaveBeenCalledWith({ paymentCardId: "pc_test" });
  });

  it("transitions to CLEARED (not RECONCILED) on CARD_PAYMENT_CLEARED_EVENT with amount variance, and still fires cards.close", async () => {
    const invoiceId = seedInvoice({
      status: "AUTHORIZED" satisfies InvoiceStatus,
      amountCents: 10_000,
      currencyCode: "USD",
    });

    const { statusCode } = await postSigned(
      app,
      buildEventPayload({
        cardId: "pc_test",
        eventName: NotificationEventName.CARD_PAYMENT_CLEARED_EVENT,
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
        eventName: NotificationEventName.CARD_PAYMENT_AUTHORIZED_EVENT,
      }),
    );
    expect(statusCode).toBe(200);

    const row = db.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
    expect(row?.status).toBe("CARD_ISSUED" satisfies InvoiceStatus);

    const eventRows = db.select().from(webhookEvents).all();
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0].eventType).toBe(
      NotificationEventName.CARD_PAYMENT_AUTHORIZED_EVENT,
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
        eventName: NotificationEventName.CARD_PAYMENT_AUTHORIZED_EVENT,
      }),
    );
    expect(statusCode).toBe(200);

    const row = db.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
    expect(row?.status).toBe("CLEARED" satisfies InvoiceStatus);
  });

  it("persists the raw event to webhook_events BEFORE dispatching transitions", async () => {
    seedInvoice();

    // Force cards.close to throw — dispatch must have already logged the event.
    cardsClose.mockRejectedValueOnce(new Error("upstream close failed"));

    const payload = buildEventPayload({
      cardId: "pc_test",
      eventName: NotificationEventName.CARD_PAYMENT_CLEARED_EVENT,
    });

    const { statusCode } = await postSigned(app, payload);
    expect(statusCode).toBe(200);

    const eventRows = db.select().from(webhookEvents).all();
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0].eventType).toBe(
      NotificationEventName.CARD_PAYMENT_CLEARED_EVENT,
    );
    expect(eventRows[0].eventId).toBe(payload.id);
  });
});
