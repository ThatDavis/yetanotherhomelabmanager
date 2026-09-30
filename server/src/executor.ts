import type { Host } from "@prisma/client";
import { Client } from "ssh2";
import { masterPrivateKey } from "./keys.js";

// SSH executor — the only module allowed to open SSH connections.
// Transport details stay here so a future agent transport can slot in (SSH now, agent later).

export type OutputLine = { stream: "stdout" | "stderr"; line: string };

export type ExecResult = {
  ok: boolean; // false on nonzero exit, timeout, or connection failure (expected failures)
  exitCode: number | null;
  lines: OutputLine[]; // combined, ordered, tagged per stream
  output: string; // human rendering: stderr lines prefixed with "!"
};

/** Render tagged lines as the human-readable combined stream. */
export function renderLines(lines: OutputLine[]): string {
  return lines.map((l) => (l.stream === "stderr" ? `! ${l.line}` : l.line)).join("\n");
}

class LineSplitter {
  private buf = "";
  constructor(
    private readonly stream: OutputLine["stream"],
    private readonly lines: OutputLine[],
  ) {}
  push(chunk: Buffer) {
    this.buf += chunk.toString("utf8");
    const parts = this.buf.split("\n");
    this.buf = parts.pop() ?? "";
    for (const line of parts) this.lines.push({ stream: this.stream, line });
  }
  flush() {
    if (this.buf) this.lines.push({ stream: this.stream, line: this.buf });
  }
}

export async function execOnHost(
  host: Host,
  command: string,
  timeoutMs = 30_000,
): Promise<ExecResult> {
  const privateKey = await masterPrivateKey();
  const lines: OutputLine[] = [];
  const { promise, resolve } = Promise.withResolvers<ExecResult>();

  const conn = new Client();
  let settled = false;

  const finish = (exitCode: number | null, extra?: OutputLine) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (extra) lines.push(extra);
    conn.end();
    resolve({ ok: exitCode === 0, exitCode, lines, output: renderLines(lines) });
  };

  const timer = setTimeout(() => {
    finish(null, { stream: "stderr", line: `yahlm: timed out after ${timeoutMs}ms` });
  }, timeoutMs);

  conn
    .on("ready", () => {
      conn.exec(command, (err, channel) => {
        if (err)
          return finish(null, { stream: "stderr", line: `yahlm: exec failed: ${err.message}` });
        const out = new LineSplitter("stdout", lines);
        const errOut = new LineSplitter("stderr", lines);
        channel.on("data", (chunk: Buffer) => out.push(chunk));
        channel.stderr.on("data", (chunk: Buffer) => errOut.push(chunk));
        channel.on("close", (code: number | null) => {
          out.flush();
          errOut.flush();
          finish(code);
        });
      });
    })
    .on("error", (err) => {
      finish(null, { stream: "stderr", line: `yahlm: connection failed: ${err.message}` });
    })
    .connect({
      host: host.hostname,
      port: host.port,
      username: host.username,
      privateKey,
      readyTimeout: 10_000,
    });

  return promise;
}
