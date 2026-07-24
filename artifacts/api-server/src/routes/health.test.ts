import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createHealthRouter } from "./health.js";

const servers: Server[] = [];

async function start(readiness: () => Promise<boolean>): Promise<string> {
  const app = express();
  app.use("/api", createHealthRouter(readiness));
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

describe("TF readiness", () => {
  it("reports unavailable readiness and recovers on the next probe", async () => {
    const readiness = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const baseUrl = await start(readiness);

    const unavailable = await fetch(`${baseUrl}/readyz`);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ status: "unavailable" });

    const ready = await fetch(`${baseUrl}/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: "ok" });
    expect(readiness).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the readiness probe throws", async () => {
    const baseUrl = await start(async () => {
      throw new Error("secret connection details");
    });

    const response = await fetch(`${baseUrl}/readyz`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unavailable" });
  });

  it("shares one in-flight dependency probe across concurrent checks", async () => {
    const readinessResolvers: Array<(ready: boolean) => void> = [];
    const readiness = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          readinessResolvers.push(resolve);
        }),
    );
    const baseUrl = await start(readiness);

    const first = fetch(`${baseUrl}/readyz`);
    const second = fetch(`${baseUrl}/readyz`);
    await vi.waitFor(() => expect(readiness).toHaveBeenCalled());
    await new Promise((resolve) => setImmediate(resolve));
    const callCountWhilePending = readiness.mock.calls.length;
    for (const resolve of readinessResolvers) resolve(true);

    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(callCountWhilePending).toBe(1);
    expect(readiness).toHaveBeenCalledTimes(1);
  });
});
