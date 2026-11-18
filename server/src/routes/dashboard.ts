import type { FastifyInstance } from "fastify";
import { cachedAdvisoriesForVersion, repoForImage } from "../changelogs.js";
import { prisma } from "../db.js";
import { versionKey } from "../stacks.js";

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
        select: { osUpdatesPending: true },
      }),
    ]);

    const guests = { running: 0, stopped: 0, other: 0 };
    for (const row of guestCounts) {
      if (row.status === "running") guests.running = row._count._all;
      else if (row.status === "stopped") guests.stopped = row._count._all;
      else guests.other = row._count._all;
    }

    // M3.6 services strip: cached scan data, never blocks on SSH.
    // M3.7: breaking = local semver major-bump compare; CVE counts are
    // cache-only (cold = not counted; the stacks list warms the cache).
    const stacksTotal = stacks.length;
    let stacksUpdatable = 0;
    let stacksDrift = 0;
    let stacksBreaking = 0;
    let stacksWithCves = 0;
    for (const s of stacks) {
      let services: {
        updatable?: boolean | null;
        image?: string;
        tag?: string;
        version?: string;
        source?: string;
        latest?: string | null;
      }[] = [];
      try {
        const parsed: unknown = JSON.parse(s.services);
        if (Array.isArray(parsed)) services = parsed;
      } catch {
        // ignore malformed rows
      }
      if (services.some((x) => x.updatable === true)) stacksUpdatable += 1;
      if (s.drift) stacksDrift += 1;
      if (
        services.some((x) => {
          const cur = versionKey(x.version || x.tag || "");
          const lat = x.latest ? versionKey(x.latest) : null;
          return cur?.[0] !== undefined && lat?.[0] !== undefined && lat[0] > cur[0];
        })
      )
        stacksBreaking += 1;
      if (
        services.some((x) => {
          const repo = repoForImage(x.image ?? "", x.source ?? "");
          return repo
            ? (cachedAdvisoriesForVersion(repo, x.version || x.tag || "") ?? []).length > 0
            : false;
        })
      )
        stacksWithCves += 1;
    }
    const hostsNeedingUpdates = hosts.filter((h) => h.osUpdatesPending > 0);

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
        stacksTotal,
        stacksUpdatable,
        stacksDrift,
        stacksBreaking,
        stacksWithCves,
        hostsNeedingUpdates: hostsNeedingUpdates.length,
      },
    };
  });
}
