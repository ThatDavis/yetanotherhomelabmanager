import { Outlet } from "react-router";
import { Sidebar } from "./Sidebar";

export function AppShell() {
  return (
    <div className="flex h-screen overflow-hidden bg-base">
      <Sidebar />
      <main className="flex-1 overflow-y-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}
