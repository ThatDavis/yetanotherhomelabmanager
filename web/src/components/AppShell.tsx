import { Outlet } from "react-router";
import { Sidebar } from "./Sidebar";
import { JobToastListener, ToastProvider } from "./Toasts";

export function AppShell() {
  return (
    <ToastProvider>
      <div className="flex h-screen overflow-hidden bg-base">
        <Sidebar />
        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
      <JobToastListener />
    </ToastProvider>
  );
}
