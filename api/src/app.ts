import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
} from "fastify-type-provider-zod";
import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import fastifyStatic from "@fastify/static";
import fastifyRawBody from "fastify-raw-body";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sqlite } from "./db/index.js";
import { registerAuthHook } from "./middleware/auth.js";
import { authRoutes } from "./routes/auth.js";
import { meRoute } from "./routes/me.js";
import { fundingAccountRoutes } from "./routes/fundingAccounts.js";
import { invoiceRoutes } from "./routes/invoices.js";
import { clientTokenRoutes } from "./routes/clientTokens.js";
import { collaborativeAuthRoutes } from "./routes/collaborativeAuth.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { payByLinkRoutes } from "./routes/payByLink.js";
import { environment } from "./services/highnote.js";

// Detect a Highnote/GraphQL rate-limit error. The SDK surfaces these as a raw
// graphql-request ClientError (no typed error class), so without this they would
// fall through to a generic HTTP 500.
function isRateLimitError(err: any): boolean {
  if (err?.response?.status === 429) return true;
  // Fallback for SDK errors that don't surface the HTTP status — match
  // Highnote's specific rate-limit phrasing, not the generic words "rate limit".
  const message = String(err?.message ?? "");
  return /usage limit exceeded|request complexity points/i.test(message);
}

function rateLimitRetryAfter(err: any): number {
  const raw = err?.response?.extensions?.rateLimit?.retryAfter;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.ceil(parsed) : 10;
}

export function ensureTables(): void {
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

/**
 * Build the Fastify app with all routes, plugins, and hooks registered.
 * Does NOT call `app.listen()` or kick off webhook registration — both are
 * the caller's responsibility (see `index.ts`). Tests use `app.inject()` to
 * drive the app in-process without binding a socket.
 */
export async function buildApp(): Promise<FastifyInstance> {
  // In deployed-demo mode the app sits behind Render's proxy, so the socket
  // peer is the proxy, not the client. Trust `X-Forwarded-For` there so
  // `request.ip` — and therefore the rate-limit bucket key — reflects the real
  // client. Only enabled in production: locally there is no trusted proxy in
  // front, so we must NOT honor a client-supplied X-Forwarded-For (it would let
  // anyone spoof their IP to dodge the limiter).
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    trustProxy: process.env.NODE_ENV === "production",
  });

  // CORS — the frontend dev server runs cross-origin in development. In
  // production the SPA is served same-origin by this server, so CORS stays
  // disabled unless a cross-origin frontend is explicitly configured.
  const corsOrigin =
    process.env.NODE_ENV === "production"
      ? (process.env.CORS_ORIGIN ?? false)
      : (process.env.CORS_ORIGIN ?? "http://localhost:5173");
  await app.register(fastifyCors, { origin: corsOrigin });

  // Security headers. The CSP allow-list is the minimum needed by the embedded
  // Highnote SDKs (card-viewer / secure-inputs all source iframes from
  // cdn.highnote.com and XHR to api.us[.test].highnote.com) and Google Fonts.
  //
  // `*.highnote.com` is broader than the exact origins observed in the SDK
  // (cdn., api.us., api.us.test.) but tolerates the SDK adding new
  // subdomains in future minor releases without breaking the page.
  //
  // Set `CSP_REPORT_ONLY=true` to soak-test changes before enforcing — the
  // browser logs violations to the console instead of blocking them. In dev
  // (`NODE_ENV !== "production"`) the SPA is served by Vite, not this server,
  // so the policy only matters in deployed environments.
  const cspReportOnly = process.env.CSP_REPORT_ONLY === "true";
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      useDefaults: true,
      reportOnly: cspReportOnly,
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'"],
        // Tailwind v4 injects utility classes as inline <style> blocks at
        // runtime; without 'unsafe-inline' the page renders unstyled.
        "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        "img-src": ["'self'", "data:"],
        "font-src": ["'self'", "data:", "https://fonts.gstatic.com"],
        // Highnote SDK iframes (card-viewer / secure-inputs).
        "frame-src": ["'self'", "https://*.highnote.com"],
        // SPA → same-origin /api; Highnote SDKs → api.us[.test].highnote.com.
        "connect-src": ["'self'", "https://*.highnote.com"],
        "object-src": ["'none'"],
        "base-uri": ["'self'"],
        "form-action": ["'self'"],
      },
    },
  });

  // Rate limiting. A generous global default (per client IP) covers every
  // route — including the authenticated `/api/*` routes guarded by the auth
  // hook, which would otherwise be unthrottled (CodeQL js/missing-rate-limiting
  // on the authorization hook). 300/min/IP is far above what a single user's
  // SPA bursts on page load, but well below brute-force / credential-stuffing
  // volume. Routes opt out (`config.rateLimit: false`) or tighten the window
  // (login/signup at 5/min) via their own per-route config, which overrides
  // this default.
  await app.register(fastifyRateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
  });

  // Raw body access for webhook signature verification
  await app.register(fastifyRawBody, { field: "rawBody", encoding: "utf8", runFirst: true, global: false });

  // Zod validation & serialization
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Global error handler — translates upstream rate limits into a real 429 with a
  // Retry-After header instead of leaking them to the client as a 500.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (isRateLimitError(error)) {
      const retryAfter = rateLimitRetryAfter(error);
      return reply
        .status(429)
        .header("Retry-After", String(retryAfter))
        .send({
          error: "Rate limited",
          message: "The Highnote API rate limit was reached. Please retry shortly.",
          retryAfter,
        });
    }
    const statusCode = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    // Server faults are error-level; client faults (validation, etc.) are warn-level noise.
    if (statusCode >= 500) request.log.error(error);
    else request.log.warn(error);
    return reply.status(statusCode).send({
      error: error.name || "Error",
      message: error.message,
      ...(error.validation ? { fieldErrors: error.validation } : {}),
    });
  });

  // OpenAPI spec generation
  await app.register(fastifySwagger, {
    transform: jsonSchemaTransform,
    openapi: {
      info: {
        title: "AP Automation API",
        description: "Accounts-payable automation demo powered by the Highnote SDK",
        version: "0.1.0",
      },
      servers: [{ url: "http://localhost:3000" }],
      tags: [
        { name: "Auth", description: "User authentication" },
        { name: "Me", description: "Current authenticated user" },
        { name: "Invoices", description: "Invoice intake, approval, and lifecycle" },
        { name: "Funding Accounts", description: "Subscriber funding accounts" },
        { name: "Collaborative Auth", description: "Real-time authorization decisioning" },
        { name: "Webhooks", description: "Webhook receiver and event viewer" },
        { name: "Pay By Link", description: "Public pay-by-link endpoints" },
        { name: "Simulation", description: "Test environment simulation tools (test env only)" },
      ],
    },
  });

  await app.register(fastifySwaggerUi, {
    routePrefix: "/docs",
  });

  // Health check
  app.get("/health", async () => ({ status: "ok" }));

  // Environment config (public)
  app.get("/api/config", async () => ({ environment }));

  // Public routes (no auth required) — register BEFORE the auth plugin
  await app.register(authRoutes);

  // Auth middleware — global hook, skips public paths
  registerAuthHook(app);

  // Protected route modules
  await app.register(meRoute);
  await app.register(fundingAccountRoutes);
  await app.register(invoiceRoutes);
  await app.register(clientTokenRoutes);

  // Public collaborative-authorization receiver. Authenticated by the
  // highnote-signature HMAC header, not JWT; the auth hook skips it because
  // the route is registered under "/" (not "/api/") and also opts out via
  // config.public === true.
  await app.register(collaborativeAuthRoutes);

  // Public webhook receiver. Authenticated by the highnote-signature HMAC
  // header (not JWT); the route opts out of auth via config.public === true
  // and opts in to raw-body capture via config.rawBody === true.
  await app.register(webhookRoutes);

  // Pay-by-link — the POST is operator-authenticated (JWT) and rotates a slug
  // for an already-issued card; the GET is public (vendor visits the link in a
  // browser) and opts out of auth via config.public === true.
  await app.register(payByLinkRoutes);

  // Serve frontend static files in production, or in dev once the SPA has been
  // built locally. The path `../web/dist` resolves relative to the compiled
  // file location (`api/dist/app.js` → `api/dist/../web/dist`); in dev under
  // tsx it resolves from `api/src/app.ts` → `api/src/../web/dist`. Both work
  // when the SPA is built at the monorepo root's `web/dist`.
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const spaRoot = join(__dirname, "..", "..", "web", "dist");
  const shouldServeSpa =
    process.env.NODE_ENV === "production" || existsSync(join(spaRoot, "index.html"));

  if (shouldServeSpa) {
    await app.register(fastifyStatic, {
      root: spaRoot,
      prefix: "/",
      wildcard: false,
    });

    // SPA fallback — serve index.html for non-API routes
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.status(404).send({ error: "Not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
}
