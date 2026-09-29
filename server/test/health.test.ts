import { expect, test } from "vitest";
import { buildServer } from "../src/app.js";

test("GET /health returns ok", async () => {
  const app = buildServer();
  const res = await app.inject({ method: "GET", url: "/health" });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ status: "ok", service: "home-lab-manager" });
  await app.close();
});
