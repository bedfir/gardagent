import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import { fixtureShutdown } from "./gateway-lifecycle";

test("gateway fixture shutdown closes an idle connection without waiting for HTTP", async () => {
  const server = createServer();
  const shutdown = fixtureShutdown(server, () => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
  const accepted = once(server, "connection");
  const socket = connect(address.port, "127.0.0.1");
  const connected = once(socket, "connect");
  try {
    await Promise.all([accepted, connected]);
    // No HTTP bytes: this also covers speculative browser connections.
    const disconnected = once(socket, "close");
    await shutdown();
    await disconnected;
    expect(server.listening).toBe(false);
    expect(socket.destroyed).toBe(true);
  } finally {
    socket.destroy();
    if (server.listening) await shutdown();
  }
});
