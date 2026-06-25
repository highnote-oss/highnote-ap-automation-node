import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET ?? (() => {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "JWT_SECRET is required when NODE_ENV=production (any hosted instance " +
        "of this demo). On Render it is auto-generated; set it explicitly on " +
        "other hosts. See SECURITY.md for what \"production\" means here.",
    );
  }
  // Local dev: per-process random secret. Tokens invalidate on restart.
  return randomBytes(32).toString("hex");
})();

export interface AuthUser {
  id: number;
  email: string;
}

/**
 * Comma-separated allowlist of operator emails permitted to manage
 * money-movement registrations (collab-auth / webhook endpoints). When unset,
 * any authenticated user may manage them (single-user demo default). Set this
 * on shared or hosted instances to lock registration churn to known operators.
 */
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS ?? "")
  .split(",")
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

/** Whether an operator allowlist is configured for the registration routes. */
export function isAdminAllowlistConfigured(): boolean {
  return ADMIN_EMAILS.length > 0;
}

/**
 * Route guard for sensitive registration management. Use as a `preHandler` on
 * routes that tear down and re-mint money-movement endpoints. When ADMIN_EMAILS
 * is configured, only those operators pass; otherwise it is a no-op so the
 * single-user demo keeps working, and the per-route rate limit is the backstop.
 */
export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (ADMIN_EMAILS.length === 0) {
    return;
  }
  const email = request.user?.email?.toLowerCase();
  if (!email || !ADMIN_EMAILS.includes(email)) {
    return reply.status(403).send({ error: "Admin access required" });
  }
}

declare module "fastify" {
  interface FastifyRequest {
    user: AuthUser;
  }
  interface FastifyContextConfig {
    public?: boolean;
  }
}

/** Verify the JWT and attach `request.user` from claims (no DB lookup). */
async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return reply.status(401).send({ error: "Missing or invalid Authorization header" });
  }

  const token = authHeader.slice(7);

  let payload: { userId: number; email: string };
  try {
    payload = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] }) as typeof payload;
  } catch {
    return reply.status(401).send({ error: "Invalid or expired token" });
  }

  request.user = {
    id: payload.userId,
    email: payload.email,
  };
}

/**
 * Register the auth hook globally on the Fastify instance.
 * Skips public paths and routes marked `config: { public: true }`;
 * all others require a valid JWT.
 */
export function registerAuthHook(app: FastifyInstance): void {
  app.addHook("onRequest", async (request, reply) => {
    // Routes that opt out explicitly (e.g. /api/pay/:slug).
    if (request.routeOptions.config?.public === true) {
      return;
    }

    const url = request.url;

    // Non-API routes: static files, SPA fallback, etc.
    if (!url.startsWith("/api/")) {
      return;
    }

    // Built-in public API surface.
    if (
      url.startsWith("/api/auth") ||
      url === "/api/config" ||
      url === "/api/health" ||
      (url === "/api/webhooks" && request.method === "POST") ||
      (url === "/api/collaborative-auth" && request.method === "POST")
    ) {
      return;
    }

    await authenticate(request, reply);
  });
}

export { JWT_SECRET };
