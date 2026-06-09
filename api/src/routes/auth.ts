import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import { SignupBodySchema, LoginBodySchema } from "../types.js";
import { JWT_SECRET } from "../middleware/auth.js";

const BCRYPT_ROUNDS = 10;
const JWT_EXPIRY = "1h";

// A valid bcrypt hash of a random string. Used to run a real compare on the
// login path even when the email is unknown, so response timing does not
// reveal whether an account exists.
const DUMMY_PASSWORD_HASH = "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";

function signToken(userId: number, email: string): string {
  return jwt.sign(
    { userId, email },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY, algorithm: "HS256" },
  );
}

export async function authRoutes(app: FastifyInstance) {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.post("/api/auth/signup", {
    schema: {
      tags: ["Auth"],
      description: "Create a new user account",
      body: SignupBodySchema,
    },
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    const { email, password } = request.body;

    const [existing] = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (existing) {
      return reply.status(409).send({ error: "Email already registered" });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const [user] = await db
      .insert(users)
      .values({ email, passwordHash })
      .returning();

    const token = signToken(user.id, user.email);

    return reply.status(201).send({
      token,
      user: { id: user.id, email: user.email },
    });
  });

  typedApp.post("/api/auth/login", {
    schema: {
      tags: ["Auth"],
      description: "Log in with email and password",
      body: LoginBodySchema,
    },
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    const { email, password } = request.body;

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    // Always run a bcrypt compare — even for an unknown email — so login
    // response timing does not reveal whether an account exists.
    const valid = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!user || !valid) {
      return reply.status(401).send({ error: "Invalid email or password" });
    }

    const token = signToken(user.id, user.email);

    return reply.send({
      token,
      user: { id: user.id, email: user.email },
    });
  });
}
