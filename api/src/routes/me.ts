import type { FastifyInstance } from "fastify";

export async function meRoute(app: FastifyInstance) {
  app.get("/api/me", {
    schema: { tags: ["Me"], description: "Current authenticated user." },
  }, async (request) => {
    return { id: request.user.id, email: request.user.email };
  });
}
