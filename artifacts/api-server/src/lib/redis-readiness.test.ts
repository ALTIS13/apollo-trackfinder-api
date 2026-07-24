import { once } from "node:events";
import { createServer, type Server, type Socket } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { probeRedisHealth } from "./redis-readiness.js";

const servers: Server[] = [];
const sockets = new Set<Socket>();

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

describe("probeRedisHealth", () => {
  it("uses disposable clients for repeated blackhole timeouts", async () => {
    let acceptedConnections = 0;
    let maxConcurrentConnections = 0;
    let receivedCommands = 0;
    const server = createServer((socket) => {
      acceptedConnections += 1;
      sockets.add(socket);
      maxConcurrentConnections = Math.max(
        maxConcurrentConnections,
        sockets.size,
      );
      socket.on("data", () => {
        receivedCommands += 1;
      });
      socket.once("close", () => sockets.delete(socket));
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("blackhole fixture did not bind");
    }
    const redisUrl = `redis://127.0.0.1:${address.port}/0`;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        probeRedisHealth(redisUrl, { timeoutMs: 100 }),
      ).resolves.toBe(false);
      await vi.waitFor(() => expect(sockets.size).toBe(0), {
        timeout: 1_000,
      });
    }

    expect(acceptedConnections).toBe(3);
    expect(receivedCommands).toBeGreaterThanOrEqual(3);
    expect(maxConcurrentConnections).toBe(1);
    expect(sockets.size).toBe(0);
  });
});
