import { existsSync } from "node:fs";
import path from "node:path";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { authGuard } from "./auth.js";
import { authRoutes } from "./routes/auth.js";
import { hostRoutes } from "./routes/hosts.js";
import { nodeRoutes } from "./routes/nodes.js";

type BuildOptions = {
  /** Directory containing the built SPA (index.html). Defaults to ../web/dist or $SPA_DIR. */
  spaDir?: string;
  /** Set false in tests that aren't exercising auth. Defaults to true. */
  auth?: boolean;
};

export function buildServer(opts: BuildOptions = {}) {
  const app = Fastify({ logger: true });

  app.get("/health", async () => ({ status: "ok", service: "yet-another-home-lab-manager" }));

  app.register(fastifyCookie);

  if (opts.auth !== false) app.addHook("preHandler", authGuard);
  app.register(authRoutes);
  app.register(hostRoutes);
  app.register(nodeRoutes);
  const spaDir =
    opts.spaDir ?? process.env.SPA_DIR ?? path.resolve(import.meta.dirname, "../../web/dist");

  if (existsSync(path.join(spaDir, "index.html"))) {
    app.register(fastifyStatic, { root: spaDir });
    // SPA fallback: client-side routes get index.html; API misses get JSON 404.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api")) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "not found" });
    });
  }

  return app;
}
