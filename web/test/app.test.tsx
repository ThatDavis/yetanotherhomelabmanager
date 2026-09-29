import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import { App } from "../src/App";

test("App renders the project title", () => {
  const html = renderToString(<App />);
  expect(html).toContain("Home Lab Manager");
});
