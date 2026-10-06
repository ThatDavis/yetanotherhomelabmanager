import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";

export function dashboardRoutes(app: FastifyInstance) {
  // Everything the live dashboard needs in one round-trip.
  app.get("/api/dashboard", async () => {
    const [targets, nodes, guestCounts, recentAudit, stacks, hosts] = await Promise.all([
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
      prisma.composeStack.findMany({ select: { services: true, drift: true } }),
      prisma.host.findMany({
        select: { id: true, alias: true, osUpdatesPending: true, osCheckedAt: true },
      }),
    ]);

    const guests = { running: 0, stopped: 0, other: 0 };
    for (const row of guestCounts) {
      if (row.status === "running") guests.running = row._count._all;
      else if (row.status === "stopped") guests.stopped = row._count._all;
      else guests.other = row._count._all;
    }

    // M3.6 services strip: cached scan data, never blocks on SSH.
    let stacksTotal = stacks.length;
    let stacksUpdatable = 0;
    let stacksDrift = 0;
    for (const s of stacks) {
      let services: { updatable?: boolean | null }[] = [];
      try {
        const parsed: unknown = JSON.parse(s.services);
        if (Array.isArray(parsed)) services = parsed;
      } catch {
        // ignore malformed rows
      }
      if (services.some((x) => x.updatable === true)) stacksUpdatable += 1;
      if (s.drift) stacksDrift += 1;
    }
    const hostsNeedingUpdates = hosts.filter((h) => h.osUpdatesPending > 0);

    return {
      targets,
      nodes,
      guests,
      recentAudit,
      hosts,
      stacks: { total: stacksTotal, updatable: stacksUpdatable, drift: stacksDrift },
      summary: {
        targetsUp: targets.filter((t) => t.status === "up").length,
        targetsDown: targets.filter((t) => t.status === "down").length,
        targetsTotal: targets.length,
        nodesUp: nodes.filter((n) => n.status === "up").length,
        nodesTotal: nodes.length,
        stacksTotal,
        stacksUpdatable,
        stacksDrift,
        hostsNeedingUpdates: hostsNeedingUpdates.length,
      },
    };
  });
}
