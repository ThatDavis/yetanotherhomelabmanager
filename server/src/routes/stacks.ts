import type { FastifyInstance } from "fastify";
import { audit } from "../audit.js";
import {
  advisoriesForVersion,
  cachedAdvisoriesForVersion,
  releaseNotesInRange,
  repoForImage,
  warmAdvisoryCache,
} from "../changelogs.js";
import { prisma } from "../db.js";
import { enqueueStackJob } from "../jobs.js";
import { type StackService, versionKey } from "../stacks.js";

// Compose stack inventory API (M3.6). Rows are cached by stacks.scan;
// the update endpoint turns one stack into an ad-hoc job.
// M3.7 annotates each service: repo mapping + major-bump flag (both local),
// CVE count (cache-only; cold cache = null + background warm — list views
// never block on GitHub).
export function stackRoutes(app: FastifyInstance) {
  app.get("/api/stacks", async () => {
    const stacks = await prisma.composeStack.findMany({
      include: { host: { select: { id: true, alias: true } } },
      orderBy: [{ host: { alias: "asc" } }, { project: "asc" }],
    });
    const reposToWarm = new Set<string>();
    const annotated = stacks.map((s) => {
      const services = (JSON.parse(s.services) as StackService[]).map((svc) => {
        const repo = repoForImage(svc.image, svc.source ?? "");
        const current = versionKey(svc.version || svc.tag);
        const latest = svc.latest ? versionKey(svc.latest) : null;
        const breaking =
          current?.[0] !== undefined && latest?.[0] !== undefined ? latest[0] > current[0] : null;
        const running = svc.version || svc.tag;
        const cves = repo ? (cachedAdvisoriesForVersion(repo, running)?.length ?? null) : null;
        if (repo && cves === null) reposToWarm.add(repo);
        return { ...svc, repo, breaking, cves };
      });
      return { ...s, services };
    });
    warmAdvisoryCache([...reposToWarm]);
    return annotated;
  });

  // M3.7: inline changelog + advisory detail for one service (operator
  // clicked — blocking on GitHub is fine here, failures degrade to null).
  app.get("/api/stacks/:id/changelog", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { service } = req.query as { service?: string };
    const stack = await prisma.composeStack.findUnique({ where: { id } });
    if (!stack) return reply.code(404).send({ error: "stack not found" });
    const services = JSON.parse(stack.services) as StackService[];
    const svc = services.find((s) => s.name === service);
    if (!svc) return reply.code(404).send({ error: "service not found" });
    const repo = repoForImage(svc.image, svc.source ?? "");
    if (!repo) return { repo: null };
    const running = svc.version || svc.tag;
    const latest = svc.latest ?? "";
    const [notes, advisories] = await Promise.all([
      latest ? releaseNotesInRange(repo, running, latest) : Promise.resolve([]),
      advisoriesForVersion(repo, running),
    ]);
    return {
      repo,
      repoUrl: `https://github.com/${repo}`,
      current: running,
      latest: latest || null,
      notes,
      advisories,
    };
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
