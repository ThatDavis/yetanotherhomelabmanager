import { buildServer } from "./app.js";
import { startScheduler } from "./scheduler.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

if (!process.env.MASTER_KEY && process.env.NODE_ENV === "production") {
  // Fail loud: without MASTER_KEY the secrets store would be unrecoverable or unencrypted.
  console.error("MASTER_KEY is required in production. See .env.example.");
  process.exit(1);
}

await startScheduler();

const app = buildServer();

app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
