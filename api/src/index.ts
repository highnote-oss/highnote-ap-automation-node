import "dotenv/config";
import { buildApp, ensureTables } from "./app.js";
import { isAdminAllowlistConfigured } from "./middleware/auth.js";
import * as collabAuthRegistration from "./services/collabAuthRegistration.js";
import * as webhookRegistration from "./services/webhookRegistration.js";

const port = parseInt(process.env.PORT ?? "3000", 10);

const app = await buildApp();

try {
  ensureTables();
  await app.listen({ port, host: "0.0.0.0" });
  app.log.info(`AP automation API running on http://localhost:${port}`);
  if (process.env.NODE_ENV === "production" && !isAdminAllowlistConfigured()) {
    app.log.warn(
      "ADMIN_EMAILS is unset: any authenticated user may re-register the " +
        "collaborative-auth / webhook endpoints (only the per-route cooldown " +
        "limits this). Set ADMIN_EMAILS to restrict registration management.",
    );
  }
  void collabAuthRegistration.init();
  void webhookRegistration.init();
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
