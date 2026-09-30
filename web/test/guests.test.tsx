import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import { Guests } from "../src/pages/Guests";

test("Guests page renders header and empty state before data loads", () => {
  const html = renderToString(<Guests />);
  expect(html).toContain("Guests");
  expect(html).toContain("No hosts registered yet");
  expect(html).toContain("ADD HOST");
});
