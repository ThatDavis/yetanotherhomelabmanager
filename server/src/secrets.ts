import { decrypt, encrypt } from "./crypto.js";
import { prisma } from "./db.js";

// Minimal encrypted secrets store (M1 feature "encrypted secrets store" generalizes this).
// Secrets are rows in the Secret table; values are AES-GCM ciphertext.

export async function storeSecret(id: string, plaintext: string): Promise<void> {
  await prisma.secret.upsert({
    where: { id },
    update: encrypt(plaintext),
    create: { id, ...encrypt(plaintext) },
  });
}

export async function loadSecret(id: string): Promise<string | null> {
  const row = await prisma.secret.findUnique({ where: { id } });
  return row ? decrypt(row) : null;
}
