import { describe, it, expect, beforeAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { registerAuthHook, JWT_SECRET } from "./auth.js";

function buildTestApp(): FastifyInstance {
  const app = Fastify();
  registerAuthHook(app);

  app.get("/api/me", async (request) => ({
    id: request.user.id,
    email: request.user.email,
  }));

  app.get(
    "/api/pay/abc12345",
    { config: { public: true } },
    async () => ({ ok: true }),
  );

  return app;
}

function signToken(userId: number, email: string): string {
  return jwt.sign({ userId, email }, JWT_SECRET, {
    algorithm: "HS256",
    expiresIn: "1h",
  });
}

let app: FastifyInstance;

beforeAll(async () => {
  app = buildTestApp();
  await app.ready();
});

describe("JWT auth middleware", () => {
  it("returns 401 with no Authorization header", async () => {
    const res = await app.inject({ method: "GET", url: "/api/me" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 for an invalid token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: "Bearer not-a-real-jwt" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects tokens signed with alg: 'none'", async () => {
    const header = Buffer.from(
      JSON.stringify({ alg: "none", typ: "JWT" }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ userId: 1, email: "a@b.c" }),
    ).toString("base64url");
    const noneToken = `${header}.${payload}.`;

    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${noneToken}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects tokens signed with the wrong algorithm (RS256 vs expected HS256)", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const wrongAlgToken = jwt.sign(
      { userId: 1, email: "a@b.c" },
      privateKey.export({ type: "pkcs1", format: "pem" }),
      { algorithm: "RS256" },
    );

    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${wrongAlgToken}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts a valid HS256 token and sets request.user", async () => {
    const token = signToken(42, "alice@example.com");

    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: 42, email: "alice@example.com" });
  });

  it("skips auth for routes with config.public === true", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/pay/abc12345",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
