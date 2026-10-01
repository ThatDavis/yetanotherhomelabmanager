import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";

export function dashboardRoutes(app: FastifyInstance) {
  // Everything the live dashboard needs in one round-trip.
  app.get("/api/dashboard", async () => {
    const [targets, nodes, guestCounts, recentAudit] = await Promise.all([
      prisma.pingTarget.findMany({
        include: { results: { orderBy: { at: "desc" }, take: 10 }, webhooks: true },
        orderBy: { name: "asc" },
      }),
      prisma.node.findMany({
        select: { id: true, name: true, type: true, status: true, lastCheckedAt: true },
        orderBy: { name: "asc" },
      }),
      prisma.guest.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.auditEntry.findMany({ orderBy: { at: "desc" }, take: 10 }),
    ]);

    const guests = { running: 0, stopped: 0, other: 0 };
    for (const row of guestCounts) {
      if (row.status === "running") guests.running = row._count._all;
      else if (row.status === "stopped") guests.stopped = row._count._all;
      else guests.other = row._count._all;
    }

    return {
      targets,
      nodes,
      guests,
      recentAudit,
      summary: {
        targetsUp: targets.filter((t) => t.status === "up").length,
        targetsDown: targets.filter((t) => t.status === "down").length,
        targetsTotal: targets.length,
        nodesUp: nodes.filter((n) => n.status === "up").length,
        nodesTotal: nodes.length,
      },
    };
  });
}
