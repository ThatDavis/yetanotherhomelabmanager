export function PageHeader({ label, title }: { label: string; title: string }) {
  return (
    <header className="mb-6 border-b border-surface0 pb-3">
      <div className="micro-label">{label}</div>
      <h1 className="mt-1 font-mono text-xl font-bold tracking-wide text-text">{title}</h1>
    </header>
  );
}
