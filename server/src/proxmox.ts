import https from "node:https";
import type { TLSSocket } from "node:tls";
import type { Node } from "@prisma/client";

// Proxmox API client (PVE + PBS). Token auth; TLS certificate is NOT CA-verified —
// trust comes from TOFU fingerprint pinning done by the caller (2026-09-30 decision).

export type PveResponse = {
  status: number;
  data: unknown; // parsed JSON body (Proxmox wraps payloads in { data: ... })
  fingerprint: string; // SHA-256 fingerprint of the peer certificate
};

function authHeader(node: Node, secret: string): string {
  // PVE uses '=', PBS uses ':' between token id and secret
  return node.type === "pbs"
    ? `PBSAPIToken=${node.tokenId}:${secret}`
    : `PVEAPIToken=${node.tokenId}=${secret}`;
}

/** Unwrap Proxmox's { data: ... } response envelope. */
export function pveData(body: unknown): unknown {
  return body && typeof body === "object" && "data" in body ? body.data : undefined;
}

export async function pveRequest(
  node: Node,
  secret: string,
  path: string,
  timeoutMs = 15_000,
): Promise<PveResponse> {
  const url = new URL(path, node.url.endsWith("/") ? node.url : `${node.url}/`);
  const { promise, resolve, reject } = Promise.withResolvers<PveResponse>();
  let fingerprint = "";

  const req = https.request(
    url,
    {
      method: "GET",
      headers: { authorization: authHeader(node, secret) },
      rejectUnauthorized: false, // TOFU pinning replaces CA verification
      // No session cache: a resumed TLS session skips the server certificate,
      // leaving getPeerCertificate() empty and breaking fingerprint verification.
      agent: new https.Agent({ keepAlive: false, maxCachedSessions: 0 }),
      timeout: timeoutMs,
    },
    (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        let data: unknown = body;
        try {
          data = JSON.parse(body);
        } catch {
          // non-JSON body (error pages) — keep raw text
        }
        resolve({ status: res.statusCode ?? 0, data, fingerprint });
      });
    },
  );

  req.on("socket", (socket) => {
    socket.on("secureConnect", () => {
      // https.request always negotiates a TLSSocket; net.Socket lacks getPeerCertificate
      const tlsSocket = socket as TLSSocket;
      fingerprint = tlsSocket.getPeerCertificate()?.fingerprint256 ?? "";
    });
  });
  req.on("timeout", () => req.destroy(new Error(`request timed out after ${timeoutMs}ms`)));
  req.on("error", reject);
  req.end();

  return promise;
}
