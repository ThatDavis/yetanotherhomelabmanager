import { Link } from "react-router";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";

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
              className="chamfer mt-4 inline-block border border-accent/60 bg-accent/10 px-4 py-2 font-mono text-sm text-accent transition-colors duration-150 hover:bg-accent/20"
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
    </>
  );
}
