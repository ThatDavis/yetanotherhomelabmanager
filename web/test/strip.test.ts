import { expect, test } from "vitest";
import { stripBlocks } from "../src/components/StatusStrip";

const ok = { ok: true };
const fail = { ok: false };

test("all successes are green", () => {
  expect(stripBlocks([ok, ok, ok], 3)).toEqual(["ok", "ok", "ok"]);
});

test("failures below threshold are warn, at/above are down", () => {
  // newest-first input, alertAfter=2: replay → fail(1/2)=warn, fail(2/2)=down
  expect(stripBlocks([fail, fail], 2)).toEqual(["warn", "down"]);
});

test("a success resets the failure run", () => {
  // replay: fail(1/3)=warn, ok, fail(1/3)=warn, fail(2/3)=warn
  expect(stripBlocks([fail, fail, ok, fail], 3)).toEqual(["warn", "ok", "warn", "warn"]);
});

test("recovery after down returns to green", () => {
  expect(stripBlocks([ok, ok, fail, fail], 2)).toEqual(["warn", "down", "ok", "ok"]);
});

test("window is capped at size, newest kept", () => {
  const results = Array.from({ length: 15 }, (_, i) => (i === 0 ? fail : ok));
  const blocks = stripBlocks(results, 3, 10);
  expect(blocks).toHaveLength(10);
  expect(blocks[9]).toBe("warn"); // newest is the failure, 1/3
});
