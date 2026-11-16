import { renderToString } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { expect, test } from "vitest";
import { routes } from "../src/App";

function renderAt(url: string) {
  const router = createMemoryRouter(routes, { initialEntries: [url] });
  return renderToString(<RouterProvider router={router} />);
}

test("sidebar renders all sections on every page", () => {
  const html = renderAt("/");
  for (const section of ["Dashboard", "Uptime", "Nodes", "Infra", "Jobs", "Audit", "Settings"]) {
    expect(html).toContain(section);
  }
});

test("dashboard lands at / with empty-state CTA", () => {
  const html = renderAt("/");
  expect(html).toContain("Dashboard");
  expect(html).toContain("ADD YOUR FIRST PVE NODE");
});

test("section routes render their pages", () => {
  expect(renderAt("/nodes")).toContain("No nodes registered yet");
  expect(renderAt("/audit")).toContain("Audit Log");
});
