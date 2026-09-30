import sshpk from "sshpk";
import { loadSecret, storeSecret } from "./secrets.js";

const KEY_SECRET_ID = "master-ssh-private-key";

// One master ed25519 keypair for all managed hosts (docs/ARCHITECTURE.md decisions).
// The private key lives only in the encrypted secrets store; hosts get the public key
// via the bootstrap script.

let cachedPublicKey: string | null = null;

export async function masterPublicKey(): Promise<string> {
  if (cachedPublicKey) return cachedPublicKey;
  let priv = await loadSecret(KEY_SECRET_ID);
  if (!priv) {
    priv = sshpk.generatePrivateKey("ed25519").toString("openssh");
    await storeSecret(KEY_SECRET_ID, priv);
  }
  const pub = sshpk.parsePrivateKey(priv, "openssh").toPublic().toString("ssh");
  cachedPublicKey = `${pub} yahlm-master`;
  return cachedPublicKey;
}

export async function masterPrivateKey(): Promise<string> {
  const key = await loadSecret(KEY_SECRET_ID);
  if (!key) throw new Error("master keypair not initialized — call masterPublicKey first");
  return key;
}

/** Shell script the operator runs once per host to authorize the master key. */
export function bootstrapScript(publicKey: string): string {
  return `#!/bin/sh
# yahlm bootstrap — authorizes the master management key on this host.
# Review before running. Idempotent: safe to re-run.
set -eu

KEY='${publicKey}'

AUTH="$HOME/.ssh/authorized_keys"
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
touch "$AUTH"
chmod 600 "$AUTH"

if grep -qF "$KEY" "$AUTH"; then
  echo "yahlm: key already present, nothing to do"
else
  echo "$KEY" >> "$AUTH"
  echo "yahlm: master key installed for $(whoami)"
fi
`;
}
