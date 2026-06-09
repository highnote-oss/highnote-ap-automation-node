import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const { createForPaymentCard } = vi.hoisted(() => ({
  createForPaymentCard: vi.fn(),
}));

vi.mock("../services/highnote.js", () => ({
  highnote: {
    clientTokens: { createForPaymentCard },
  },
}));

import { sqlite, db } from "../db/index.js";
import { users, invoices } from "../db/schema.js";
import { registerAuthHook, JWT_SECRET } from "../middleware/auth.js";
import { payByLinkRoutes } from "./payByLink.js";
import {
  HighnoteUserError,
  HighnoteAccessDeniedError,
  Iso4217Alpha3SupportedCurrency,
} from "@highnote-oss/nodejs-sdk";
import type { InvoiceStatus } from "../types.js";

function buildTestApp(): FastifyInstance {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuthHook(app);
  app.register(payByLinkRoutes);
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

beforeAll(async () => {
  ensureTablesForTest();
  app = buildTestApp();
  await app.ready();
});

beforeEach(() => {
  createForPaymentCard.mockReset();
  createForPaymentCard.mockResolvedValue({
    value: "ct_fixture_value",
    expirationDate: "2099-12-31T00:00:00Z",
  });
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
      currencyCode: Iso4217Alpha3SupportedCurrency.USD,
      status: "CARD_ISSUED" satisfies InvoiceStatus,
      cardId: "pc_test",
      ...overrides,
    })
    .run();
  return id;
}

describe("POST /api/invoices/:id/pay-link", () => {
  it("returns a base64url slug and an ISO expiresAt for a valid issued invoice", async () => {
    const id = seedInvoice(userAId);

    const res = await app.inject({
      method: "POST",
      url: `/api/invoices/${id}/pay-link`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.slug).toBe("string");
    expect(body.slug.length).toBeGreaterThanOrEqual(32);
    expect(body.slug).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(() => new Date(body.expiresAt).toISOString()).not.toThrow();
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("persists slug, client token, and expiresAt on the invoice row", async () => {
    const id = seedInvoice(userAId);

    const res = await app.inject({
      method: "POST",
      url: `/api/invoices/${id}/pay-link`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    const body = res.json();

    const row = db.select().from(invoices).where(eq(invoices.id, id)).get();
    expect(row?.payBySlug).toBe(body.slug);
    expect(row?.payByClientToken).toBe("ct_fixture_value");
    expect(row?.payBySlugExpiresAt).toBe(body.expiresAt);
  });

  it("returns 404 when the invoice belongs to another user (no existence leak)", async () => {
    const id = seedInvoice(userBId);

    const res = await app.inject({
      method: "POST",
      url: `/api/invoices/${id}/pay-link`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(res.statusCode).toBe(404);
    expect(createForPaymentCard).not.toHaveBeenCalled();
  });

  it("returns 400 when the invoice has no issued card", async () => {
    const id = seedInvoice(userAId, {
      status: "DRAFT" satisfies InvoiceStatus,
      cardId: null,
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/invoices/${id}/pay-link`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/no issued card/i);
    expect(createForPaymentCard).not.toHaveBeenCalled();
  });

  it("generates a fresh slug on each call (regeneration overwrites the previous)", async () => {
    const id = seedInvoice(userAId);

    const first = await app.inject({
      method: "POST",
      url: `/api/invoices/${id}/pay-link`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/invoices/${id}/pay-link`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    const firstSlug = first.json().slug;
    const secondSlug = second.json().slug;
    expect(firstSlug).not.toBe(secondSlug);

    const row = db.select().from(invoices).where(eq(invoices.id, id)).get();
    expect(row?.payBySlug).toBe(secondSlug);

    // Each POST must mint a fresh client token; guards against the SDK being
    // short-circuited or memoized on the second call.
    expect(createForPaymentCard).toHaveBeenCalledTimes(2);

    // The previous slug must immediately stop resolving. Without this assertion,
    // a refactor to one-to-many slug storage (or any bug leaving the old slug
    // resolvable) would slip through.
    const stale = await app.inject({
      method: "GET",
      url: `/api/pay/${firstSlug}`,
    });
    expect(stale.statusCode).toBe(404);
  });

  it("returns 400 with fieldErrors when the SDK throws HighnoteUserError", async () => {
    createForPaymentCard.mockRejectedValueOnce(
      new HighnoteUserError([
        { code: "INVALID", description: "Card is closed" },
      ]),
    );
    const id = seedInvoice(userAId);

    const res = await app.inject({
      method: "POST",
      url: `/api/invoices/${id}/pay-link`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("Highnote validation error");
    expect(body.fieldErrors).toEqual([
      { code: "INVALID", description: "Card is closed" },
    ]);
  });

  it("returns 403 when the SDK throws HighnoteAccessDeniedError", async () => {
    createForPaymentCard.mockRejectedValueOnce(
      new HighnoteAccessDeniedError("nope"),
    );
    const id = seedInvoice(userAId);

    const res = await app.inject({
      method: "POST",
      url: `/api/invoices/${id}/pay-link`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("Access denied");
  });
});

describe("GET /api/pay/:slug (public)", () => {
  function seedWithLink(
    overrides: Partial<typeof invoices.$inferInsert> = {},
  ): { id: string; slug: string } {
    const slug = "slug_" + randomUUID().replace(/-/g, "");
    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
    const id = seedInvoice(userAId, {
      payBySlug: slug,
      payByClientToken: "ct_persisted_value",
      payBySlugExpiresAt: expiresAt,
      ...overrides,
    });
    return { id, slug };
  }

  it("returns vendor + amount + clientToken + cardId without requiring a JWT", async () => {
    const { slug } = seedWithLink({
      vendorName: "Vendor Co",
      amountCents: 25_000,
      currencyCode: Iso4217Alpha3SupportedCurrency.USD,
      invoiceNumber: "INV-PAY-1",
      cardId: "pc_vendor_facing",
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/pay/${slug}`,
      // Intentionally no Authorization header.
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      vendorName: "Vendor Co",
      amountCents: 25_000,
      currencyCode: Iso4217Alpha3SupportedCurrency.USD,
      invoiceNumber: "INV-PAY-1",
      clientToken: "ct_persisted_value",
      cardId: "pc_vendor_facing",
    });
  });

  // The Highnote Card Viewer SDK's `renderFields` requires `paymentCardId`
  // alongside the client token. We expose it deliberately: the client token
  // already grants read access to this specific card, so the cardId without
  // the matching token is useless. The slug remains the rotating secret.
  it("exposes cardId alongside the client token for SDK consumption", async () => {
    const { slug } = seedWithLink({ cardId: "pc_required_by_sdk" });

    const res = await app.inject({ method: "GET", url: `/api/pay/${slug}` });

    expect(res.statusCode).toBe(200);
    expect(res.json().cardId).toBe("pc_required_by_sdk");
  });

  it("returns 404 for an unknown slug", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/pay/unknown_slug_does_not_exist",
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 410 when the slug has expired", async () => {
    const { slug } = seedWithLink({
      payBySlugExpiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    const res = await app.inject({ method: "GET", url: `/api/pay/${slug}` });

    expect(res.statusCode).toBe(410);
    expect(res.json().error).toMatch(/expired/i);
  });

  it("returns 410 when the invoice is CANCELLED", async () => {
    const { slug } = seedWithLink({
      status: "CANCELLED" satisfies InvoiceStatus,
    });

    const res = await app.inject({ method: "GET", url: `/api/pay/${slug}` });

    expect(res.statusCode).toBe(410);
  });

  it("returns 410 when the invoice is CLEARED", async () => {
    const { slug } = seedWithLink({
      status: "CLEARED" satisfies InvoiceStatus,
    });

    const res = await app.inject({ method: "GET", url: `/api/pay/${slug}` });

    expect(res.statusCode).toBe(410);
  });

  it("returns 410 when the invoice is RECONCILED", async () => {
    const { slug } = seedWithLink({
      status: "RECONCILED" satisfies InvoiceStatus,
    });

    const res = await app.inject({ method: "GET", url: `/api/pay/${slug}` });

    expect(res.statusCode).toBe(410);
  });
});
