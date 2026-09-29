import path from "node:path";
import { expect, test } from "vitest";
import { buildServer } from "../src/app.js";

const spaDir = path.resolve(import.meta.dirname, "fixtures/spa");

test("serves SPA index.html at / and on client-side routes", async () => {
  const app = buildServer({ spaDir });

  const root = await app.inject({ method: "GET", url: "/" });
  expect(root.statusCode).toBe(200);
  expect(root.body).toContain("fixture-spa");

  const deep = await app.inject({ method: "GET", url: "/nodes/42/settings" });
  expect(deep.statusCode).toBe(200);
  expect(deep.body).toContain("fixture-spa");

  await app.close();
});

test("API misses return JSON 404, not the SPA", async () => {
  const app = buildServer({ spaDir });
  const res = await app.inject({ method: "GET", url: "/api/nope" });
  expect(res.statusCode).toBe(404);
  expect(res.json()).toEqual({ error: "not found" });
  await app.close();
});

test("without a built SPA, / is 404 and /health still works", async () => {
  const app = buildServer({ spaDir: path.resolve(import.meta.dirname, "fixtures/no-spa") });
  expect((await app.inject({ method: "GET", url: "/" })).statusCode).toBe(404);
  expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  await app.close();
});
