import type { ReactNode } from "react";

export function Panel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="chamfer border border-surface1 bg-mantle">
      <div className="micro-label border-b border-surface0 px-4 py-2">▚ {label}</div>
      <div className="p-4">{children}</div>
    </section>
  );
}
