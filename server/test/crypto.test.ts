import "./env.js";
import { expect, test } from "vitest";
import { decrypt, encrypt } from "../src/crypto.js";

test("encrypt/decrypt roundtrip", () => {
  const secret = "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----";
  expect(decrypt(encrypt(secret))).toBe(secret);
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
  const original = process.env.MASTER_KEY;
  process.env.MASTER_KEY = "0".repeat(64);
  expect(() => decrypt(enc)).toThrow();
  process.env.MASTER_KEY = original;
});

test("missing/malformed MASTER_KEY throws a clear error", () => {
  const original = process.env.MASTER_KEY;
  process.env.MASTER_KEY = "short";
  expect(() => encrypt("x")).toThrow(/MASTER_KEY must be 64 hex chars/);
  process.env.MASTER_KEY = original;
});
