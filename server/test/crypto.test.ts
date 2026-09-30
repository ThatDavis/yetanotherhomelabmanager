import "./env.js";
import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import { decrypt, encrypt } from "../src/crypto.js";

// Note: never mutate process.env.MASTER_KEY in tests — vitest worker threads
// share process.env with other test files running concurrently.

const otherKey = randomBytes(32).toString("hex");

test("encrypt/decrypt roundtrip", () => {
  const secret = "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----";
  expect(decrypt(encrypt(secret))).toBe(secret);
});

test("roundtrip with an explicit key", () => {
  expect(decrypt(encrypt("value", otherKey), otherKey)).toBe("value");
});

test("different encryptions of the same value differ (random IV)", () => {
  expect(encrypt("same").ciphertext).not.toBe(encrypt("same").ciphertext);
});

test("tampered ciphertext fails GCM auth", () => {
  const enc = encrypt("sensitive");
  const tampered = { ...enc, ciphertext: `${enc.ciphertext.slice(0, -4)}AAAA` };
  expect(() => decrypt(tampered)).toThrow();
});

test("decrypt with wrong key fails", () => {
  const enc = encrypt("sensitive");
  expect(() => decrypt(enc, otherKey)).toThrow();
});

test("malformed key throws a clear error", () => {
  expect(() => encrypt("x", "short")).toThrow(/64 hex chars/);
});
