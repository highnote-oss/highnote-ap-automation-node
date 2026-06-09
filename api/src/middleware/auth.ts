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
