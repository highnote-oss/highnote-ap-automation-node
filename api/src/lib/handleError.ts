import type { FastifyReply } from "fastify";
import {
  HighnoteUserError,
  HighnoteAccessDeniedError,
} from "@highnote-oss/nodejs-sdk";

/**
 * Shared error handler for route handlers that call the Highnote SDK. Maps
 * known SDK error classes to HTTP responses; anything else is re-thrown so
 * Fastify's default error handler (and any upstream observability) can see it.
 */
export function handleError(
  err: unknown,
  reply: FastifyReply,
): FastifyReply | void {
  if (err instanceof HighnoteUserError) {
    return reply.status(400).send({
      error: "Highnote validation error",
      fieldErrors: err.fieldErrors,
    });
  }
  if (err instanceof HighnoteAccessDeniedError) {
    return reply
      .status(403)
      .send({ error: "Access denied", message: err.message });
  }
  throw err;
}
