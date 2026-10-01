import { useState } from "react";
import { createBrowserRouter, RouterProvider } from "react-router";
import { AppShell } from "./components/AppShell";
import { Alerts } from "./pages/Alerts";
import { Audit } from "./pages/Audit";
import { Dashboard } from "./pages/Dashboard";
import { Guests } from "./pages/Guests";
import { Jobs } from "./pages/Jobs";
import { Login } from "./pages/Login";
import { Nodes } from "./pages/Nodes";
import { Settings } from "./pages/Settings";
import { Uptime } from "./pages/Uptime";

export const routes = [
  {
    path: "/",
    Component: AppShell,
    children: [
      { index: true, Component: Dashboard },
      { path: "uptime", Component: Uptime },
      { path: "alerts", Component: Alerts },
      { path: "nodes", Component: Nodes },
      { path: "guests", Component: Guests },
      { path: "jobs", Component: Jobs },
      { path: "audit", Component: Audit },
      { path: "settings", Component: Settings },
    ],
  },
  {
    path: "/login",
    Component: Login,
  },
];

export function App() {
  // Created lazily so importing `routes` never touches `document` (SSR/tests).
  const [router] = useState(() => createBrowserRouter(routes));
  return <RouterProvider router={router} />;
}
