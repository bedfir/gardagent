import type { Server } from "node:http";
import type { Socket } from "node:net";

/** Test-only shutdown: browser sockets must not outlive the fixture. */
export function fixtureShutdown(server: Server, close: () => Promise<unknown>): () => Promise<void> {
  const sockets = new Set<Socket>();
  let stopping = false;
  const connected = (socket: Socket) => {
    if (stopping) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  server.on("connection", connected);
  return async () => {
    stopping = true;
    for (const socket of sockets) socket.destroy();
    try {
      await close();
    } finally {
      server.off("connection", connected);
    }
  };
}
