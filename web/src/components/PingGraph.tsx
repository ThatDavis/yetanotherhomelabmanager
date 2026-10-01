// Thin latency line graph (SVG, no chart lib). x = check index (oldest → newest),
// y = latency scaled to the window max. Failures render as red ticks on the baseline.

export type PingPoint = { ok: boolean; latencyMs: number | null };

export function graphPoints(
  results: PingPoint[],
  width: number,
  height: number,
): { line: string; failures: { x: number }[]; maxMs: number } {
  const latencies = results.map((r) => r.latencyMs ?? 0);
  const maxMs = Math.max(1, ...latencies);
  const step = results.length > 1 ? width / (results.length - 1) : 0;
  const line = results
    .map((r, i) => {
      const x = Math.round(i * step * 10) / 10;
      const y = Math.round((height - ((r.latencyMs ?? 0) / maxMs) * (height - 4) - 2) * 10) / 10;
      return `${x},${y}`;
    })
    .join(" ");
  const failures = results
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => !r.ok)
    .map(({ i }) => ({ x: Math.round(i * step * 10) / 10 }));
  return { line, failures, maxMs };
}

export function PingGraph({
  results,
  width = 680,
  height = 72,
}: {
  results: PingPoint[];
  width?: number;
  height?: number;
}) {
  const { line, failures, maxMs } = graphPoints(results, width, height);
  return (
    <div>
      <div className="micro-label mb-1">
        ▚ LATENCY (last {results.length} checks, max {maxMs}ms)
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full border border-surface0 bg-crust"
        role="img"
        aria-label="latency graph"
      >
        <line
          x1="0"
          y1={height - 1}
          x2={width}
          y2={height - 1}
          stroke="var(--color-surface0)"
          strokeWidth="1"
        />
        <polyline
          points={line}
          fill="none"
          stroke="var(--color-sapphire)"
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {failures.map((f, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: ticks are positional, never reordered
          <line
            key={i}
            x1={f.x}
            y1={height - 6}
            x2={f.x}
            y2={height - 1}
            stroke="var(--color-status-error)"
            strokeWidth="2"
          />
        ))}
      </svg>
    </div>
  );
}
