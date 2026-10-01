import { expect, test } from "vitest";
import { graphPoints } from "../src/components/PingGraph";

test("points span the width and scale latency to max", () => {
  const { line, maxMs } = graphPoints(
    [
      { ok: true, latencyMs: 0 },
      { ok: true, latencyMs: 50 },
      { ok: true, latencyMs: 100 },
    ],
    100,
    50,
  );
  expect(maxMs).toBe(100);
  const pts = line.split(" ");
  expect(pts[0]).toBe("0,48"); // 0ms → bottom
  expect(pts[2]).toBe("100,2"); // max → top
});

test("failures produce baseline ticks at their x position", () => {
  const { failures } = graphPoints(
    [
      { ok: true, latencyMs: 5 },
      { ok: false, latencyMs: null },
      { ok: true, latencyMs: 5 },
    ],
    100,
    50,
  );
  expect(failures).toEqual([{ x: 50 }]);
});

test("zero-latency window divides safely (maxMs floor of 1)", () => {
  const { maxMs, line } = graphPoints([{ ok: true, latencyMs: 0 }], 100, 50);
  expect(maxMs).toBe(1);
  expect(line).toBe("0,48");
});
