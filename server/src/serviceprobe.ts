import { Socket } from "node:net";

// App-side TCP probe for declared host services (M3.3). Connecting from the
// app avoids any nc/bash/python requirement on Debian/RHEL/busybox guests.
export function probeServicePort(
  hostname: string,
  port: number,
  timeoutMs = 5000,
): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = new Socket();
  const done = (ok: boolean) => {
    socket.destroy();
    resolve(ok);
  };
  socket.setTimeout(timeoutMs);
  socket.once("connect", () => done(true));
  socket.once("timeout", () => done(false));
  socket.once("error", () => done(false));
  socket.connect(port, hostname);
  return promise;
}
