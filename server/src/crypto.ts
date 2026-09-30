import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM with env MASTER_KEY (64 hex chars = 32 bytes).
// MASTER_KEY loss = unrecoverable secrets. Backup documented in .env.example.

export type Encrypted = { ciphertext: string; iv: string; authTag: string };

function masterKey(): Buffer {
  const hex = process.env.MASTER_KEY;
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error("MASTER_KEY must be 64 hex chars (openssl rand -hex 32)");
  }
  return Buffer.from(hex, "hex");
}

export function encrypt(plaintext: string): Encrypted {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

export function decrypt({ ciphertext, iv, authTag }: Encrypted): string {
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
