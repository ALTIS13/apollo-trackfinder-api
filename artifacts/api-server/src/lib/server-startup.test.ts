import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startApiListener } from "./server-startup.js";

const servers: Server[] = [];

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
});

describe("API listener startup", () => {
  it("closes queue and Redis resources when post-listen initialization rejects", async () => {
    const app = express();
    const closeQueues = vi.fn(async () => {});
    const closeRedis = vi.fn(async () => {});
    let attempted: Server | undefined;

    await expect(
      startApiListener({
        listen: () => {
          attempted = app.listen(0, "127.0.0.1");
          servers.push(attempted);
          return attempted;
        },
        initialize: async () => {
          throw new Error("queue initialization failed");
        },
        closeQueues,
        closeRedis,
      }),
    ).rejects.toThrow("TF API startup failed");

    expect(closeQueues).toHaveBeenCalledOnce();
    expect(closeRedis).toHaveBeenCalledOnce();
    expect(attempted?.listening).toBe(false);
  });

  it("fails generically and closes startup resources when the port is occupied", async () => {
    const occupied = createServer();
    servers.push(occupied);
    occupied.listen(0, "127.0.0.1");
    await once(occupied, "listening");
    const port = (occupied.address() as AddressInfo).port;
    const app = express();
    const initialize = vi.fn(async () => {});
    const closeQueues = vi.fn(async () => {});
    const closeRedis = vi.fn(async () => {});
    let attempted: Server | undefined;

    await expect(
      startApiListener({
        listen: () => {
          attempted = app.listen(port, "127.0.0.1");
          return attempted;
        },
        initialize,
        closeQueues,
        closeRedis,
      }),
    ).rejects.toThrow("TF API startup failed");

    expect(initialize).not.toHaveBeenCalled();
    expect(closeQueues).toHaveBeenCalledOnce();
    expect(closeRedis).toHaveBeenCalledOnce();
    expect(attempted?.listening).toBe(false);
  });
});
