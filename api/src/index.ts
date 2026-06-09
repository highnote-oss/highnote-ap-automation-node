import "dotenv/config";
import { buildApp, ensureTables } from "./app.js";
import * as collabAuthRegistration from "./services/collabAuthRegistration.js";

const port = parseInt(process.env.PORT ?? "3000", 10);

const app = await buildApp();

try {
  ensureTables();
  await app.listen({ port, host: "0.0.0.0" });
  app.log.info(`AP automation API running on http://localhost:${port}`);
  void collabAuthRegistration.init();
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
