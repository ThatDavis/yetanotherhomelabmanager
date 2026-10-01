import { Link } from "react-router";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { TargetsPanel } from "../components/TargetsPanel";

export function Dashboard() {
  return (
    <>
      <PageHeader label="SYS.STATUS // OVERVIEW" title="Dashboard" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel label="NODE HEALTH">
          <div className="py-6 text-center">
            <p className="font-mono text-sm text-subtext0">No nodes registered yet.</p>
            <Link
              to="/nodes"
              className="chamfer chamfer-accent mt-4 inline-block px-4 py-2 font-mono text-sm text-accent [--chamfer-bg:color-mix(in_oklab,var(--color-accent)_10%,var(--color-mantle))] hover:[--chamfer-bg:color-mix(in_oklab,var(--color-accent)_20%,var(--color-mantle))]"
            >
              + ADD YOUR FIRST PVE NODE
            </Link>
          </div>
        </Panel>
        <Panel label="RECENT ACTIVITY">
          <div className="py-6 text-center">
            <p className="font-mono text-sm text-subtext0">
              Jobs and audit events will appear here.
            </p>
          </div>
        </Panel>
      </div>
      <div className="mt-4">
        <TargetsPanel />
      </div>
    </>
  );
}
