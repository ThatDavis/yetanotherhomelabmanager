import type { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";

type AuditQuery = {
  action?: string;
  ok?: string;
  target?: string;
  before?: string;
  limit?: string;
};

export function auditRoutes(app: FastifyInstance) {
  // Filterable, cursor-paginated audit read. `before` is an ISO timestamp cursor.
  app.get("/api/audit", async (req) => {
    const q = req.query as AuditQuery;
    const take = Math.min(Number(q.limit) || 50, 200);

    const where: Prisma.AuditEntryWhereInput = {};
    if (q.action) where.action = { startsWith: q.action };
    if (q.ok === "true" || q.ok === "false") where.ok = q.ok === "true";
    if (q.target) where.target = { contains: q.target };
    if (q.before) where.at = { lt: new Date(q.before) };

    const rows = await prisma.auditEntry.findMany({
      where,
      orderBy: { at: "desc" },
      take: take + 1,
    });
    const hasMore = rows.length > take;
    const entries = hasMore ? rows.slice(0, take) : rows;
    return {
      entries,
      nextBefore: hasMore ? (entries[entries.length - 1]?.at.toISOString() ?? null) : null,
    };
  });
}
