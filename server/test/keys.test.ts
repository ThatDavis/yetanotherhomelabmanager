import { expect, test } from "vitest";
import { bootstrapScript } from "../src/keys.js";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTesting yahlm-master";

test("bootstrap script embeds the public key and is sh-compatible", () => {
  const script = bootstrapScript(KEY);
  expect(script).toContain(KEY);
  expect(script.startsWith("#!/bin/sh")).toBe(true);
  expect(script).toContain("authorized_keys");
  // No bashisms
  expect(script).not.toContain("[[");
  expect(script).not.toContain("function ");
});

test("bootstrap script is idempotent (checks before appending)", () => {
  expect(bootstrapScript(KEY)).toContain("grep -qF");
});
