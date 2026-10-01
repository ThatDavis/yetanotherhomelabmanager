// Status strip computation (M2.2): the last N check results rendered as
// colored blocks. Replay oldest→newest: a failure is "warn" while its
// consecutive run is below alertAfter, "down" once the run crosses it.

export type StripBlock = "ok" | "warn" | "down";

export function stripBlocks(
  results: { ok: boolean }[],
  alertAfter: number,
  size = 10,
): StripBlock[] {
  const window = results.slice(0, size).reverse(); // newest-first in → oldest-first replay
  let fails = 0;
  return window.map((r) => {
    if (r.ok) {
      fails = 0;
      return "ok";
    }
    fails += 1;
    return fails >= alertAfter ? "down" : "warn";
  });
}

export const STRIP_COLORS: Record<StripBlock, string> = {
  ok: "bg-status-ok",
  warn: "bg-status-warn",
  down: "bg-status-error",
};

export function StatusStrip({ blocks, total }: { blocks: StripBlock[]; total: number }) {
  const empty = Math.max(0, total - blocks.length);
  return (
    <div className="flex gap-0.5" title="last checks (oldest → newest)">
      {Array.from({ length: empty }, (_, i) => (
        <span key={`e${i}`} className="h-3 w-2 bg-surface1" />
      ))}
      {blocks.map((b, i) => (
        <span key={i} className={`h-3 w-2 ${STRIP_COLORS[b]}`} />
      ))}
    </div>
  );
}
