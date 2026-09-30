import { expect, test } from "vitest";
import { buildServer } from "../src/app.js";

test("GET /health returns ok", async () => {
  const app = buildServer({ auth: false });
  const res = await app.inject({ method: "GET", url: "/health" });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ status: "ok", service: "yet-another-home-lab-manager" });
  await app.close();
});
