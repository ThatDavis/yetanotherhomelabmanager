import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../audit.js";
import { deleteSecret, listSecrets, rotateMasterKey } from "../secrets.js";

const rotateSchema = z.object({
  newMasterKey: z.string().regex(/^[0-9a-f]{64}$/i, "must be 64 hex chars"),
});

export function secretRoutes(app: FastifyInstance) {
  // Metadata only — secret values are never returned by the API.
  app.get("/api/secrets", async () => listSecrets());

  app.post("/api/secrets/rotate-key", async (req, reply) => {
    const parsed = rotateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid key", details: parsed.error.issues });
    }
    const start = Date.now();
    try {
      const count = await rotateMasterKey(parsed.data.newMasterKey);
      await audit({
        action: "secrets.rotate-key",
        params: { secretsRotated: count },
        ok: true,
        durationMs: Date.now() - start,
      });
      return {
        rotated: count,
        warning:
          "Update MASTER_KEY in the environment and restart the app. Until then, secret operations will fail (the running process still has the old key).",
      };
    } catch (err) {
      await audit({
        action: "secrets.rotate-key",
        ok: false,
        output: (err as Error).message,
        durationMs: Date.now() - start,
      });
      return reply.code(500).send({ error: `rotation failed: ${(err as Error).message}` });
    }
  });

  app.delete("/api/secrets/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const error = await deleteSecret(id);
    if (error) {
      await audit({ action: "secrets.delete", target: id, ok: false, output: error });
      return reply.code(409).send({ error });
    }
    await audit({ action: "secrets.delete", target: id, ok: true });
    return { deleted: id };
  });
}
