import { PageHeader } from "../components/PageHeader";

export function PlaceholderPage({
  label,
  title,
  note,
}: {
  label: string;
  title: string;
  note: string;
}) {
  return (
    <>
      <PageHeader label={label} title={title} />
      <p className="font-mono text-sm text-subtext0">{note}</p>
    </>
  );
}
