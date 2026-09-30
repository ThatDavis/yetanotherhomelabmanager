import { decrypt, encrypt } from "./crypto.js";
import { prisma } from "./db.js";

// Encrypted secrets store. Secrets are rows in the Secret table;
// values are AES-GCM ciphertext under MASTER_KEY.

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

/** Names + metadata only — never decrypted values. */
export async function listSecrets() {
  return prisma.secret.findMany({
    select: { id: true, createdAt: true, updatedAt: true },
    orderBy: { id: "asc" },
  });
}

/**
 * Guarded delete. Node tokens in use by a registered node are refused;
 * the master SSH key may be deleted (it regenerates on next use).
 * Returns an error message or null on success.
 */
export async function deleteSecret(id: string): Promise<string | null> {
  if (id.startsWith("node-token-")) {
    const node = await prisma.node.findUnique({ where: { id: id.slice("node-token-".length) } });
    if (node) return `token is in use by node "${node.name}" — remove the node or rotate via EDIT`;
  }
  await prisma.secret.deleteMany({ where: { id } });
  return null;
}
/**
 * Re-encrypt every secret under a new master key. Rows are expected to be
 * under the env MASTER_KEY unless oldKeyHex is given (e.g. rotating back
 * after a prior rotation or recovering from a partial one). The operator
 * must update MASTER_KEY in the environment and restart afterwards.
 */
export async function rotateMasterKey(newKeyHex: string, oldKeyHex?: string): Promise<number> {
  const rows = await prisma.secret.findMany();
  // Decrypt everything first — fail before touching the DB if any row is unreadable
  const plaintexts = rows.map((row) => ({ id: row.id, plaintext: decrypt(row, oldKeyHex) }));
  await prisma.$transaction(
    plaintexts.map(({ id, plaintext }) =>
      prisma.secret.update({ where: { id }, data: encrypt(plaintext, newKeyHex) }),
    ),
  );
  return plaintexts.length;
}
