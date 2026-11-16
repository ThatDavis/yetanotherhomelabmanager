import type { FastifyInstance } from "fastify";
import { audit } from "../audit.js";
import { prisma } from "../db.js";
import { enqueueStackJob } from "../jobs.js";

// Compose stack inventory API (M3.6). Rows are cached by stacks.scan;
// the update endpoint turns one stack into an ad-hoc job.
export function stackRoutes(app: FastifyInstance) {
  app.get("/api/stacks", async () => {
    const stacks = await prisma.composeStack.findMany({
      include: { host: { select: { id: true, alias: true } } },
      orderBy: [{ host: { alias: "asc" } }, { project: "asc" }],
    });
    return stacks.map((s) => ({ ...s, services: JSON.parse(s.services) }));
  });

  app.post("/api/stacks/:id/update", async (req, reply) => {
    const { id } = req.params as { id: string };
    const stack = await prisma.composeStack.findUnique({
      where: { id },
      include: { host: true },
    });
    if (!stack) return reply.code(404).send({ error: "stack not found" });
    const jobId = await enqueueStackJob(id);
    if (!jobId) return reply.code(404).send({ error: "stack not found" });
    await audit({
      action: "stack.update",
      target: `${stack.host.alias}/${stack.project}`,
      ok: true,
    });
    return reply.code(202).send({ jobId });
  });
}
