import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { expect, test } from "vitest";
import { Guests } from "../src/pages/Guests";

test("Infra page renders header and empty state before data loads", () => {
  const html = renderToString(
    <MemoryRouter>
      <Guests />
    </MemoryRouter>,
  );
  expect(html).toContain("Infra");
  expect(html).toContain("No hosts registered yet");
  expect(html).toContain("ADD HOST");
});
