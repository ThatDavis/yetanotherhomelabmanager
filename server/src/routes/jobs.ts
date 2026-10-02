import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { subscribeAllJobs, subscribeJob } from "../jobs.js";

const jobInclude = {
  schedule: { select: { id: true, name: true } },
  steps: {
    include: { host: { select: { id: true, alias: true, self: true } } },
    orderBy: { startedAt: "asc" as const },
  },
};

export function jobRoutes(app: FastifyInstance) {
  // Job center: latest jobs newest-first (history view; live updates via SSE).
  app.get("/api/jobs", async () => {
    return prisma.job.findMany({
      include: jobInclude,
      orderBy: { startedAt: "desc" },
      take: 50,
    });
  });

  app.get("/api/jobs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = await prisma.job.findUnique({ where: { id }, include: jobInclude });
    if (!job) return reply.code(404).send({ error: "job not found" });
    return job;
  });

  // Live job status (UI.md §5: SSE with poll fallback on the client).
  app.get("/api/jobs/events", async (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    reply.raw.write(`event: status\ndata: ${JSON.stringify({ status: "subscribed" })}\n\n`);
    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const unsubscribe = subscribeAllJobs(send);
    req.raw.on("close", () => {
      unsubscribe();
      reply.raw.end();
    });
  });

  app.get("/api/jobs/:id/events", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = await prisma.job.findUnique({ where: { id }, select: { id: true } });
    if (!job) return reply.code(404).send({ error: "job not found" });

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    reply.raw.write(`event: status\ndata: ${JSON.stringify({ status: "subscribed" })}\n\n`);

    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const unsubscribe = subscribeJob(id, send);
    req.raw.on("close", () => {
      unsubscribe();
      reply.raw.end();
    });
  });
}
