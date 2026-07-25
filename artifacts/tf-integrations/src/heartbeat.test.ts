import { createModuleHeartbeatSignature } from "@workspace/module-runtime-contract";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createTfIntegrationsShutdown,
  startTfIntegrationsHeartbeat,
} from "./heartbeat.js";

const heartbeatSecret = "h".repeat(32);
const commandSecret = "c".repeat(32);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("TF integrations heartbeat and shutdown", () => {
  it("sends account-integrations immediately and every 30 seconds with the separate heartbeat key", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T12:00:00.000Z"));
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response("", { status: 202 }),
    );
    const heartbeat = startTfIntegrationsHeartbeat({
      apiOrigin: "https://api.example.test",
      secret: heartbeatSecret,
      version: "build-4",
      deployedAt: "2026-07-25T11:00:00.000Z",
      ready: async () => true,
      fetch,
      createNonce: () => "A".repeat(43),
    });

    await vi.runAllTicks();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(
      "https://api.example.test/api/internal/modules/account-integrations/heartbeat",
    );
    expect(init?.body).toBe(
      '{"schemaVersion":1,"status":"healthy","version":"build-4","deployedAt":"2026-07-25T11:00:00.000Z","requestsPerMinute":0}',
    );
    const headers = init?.headers as Record<string, string>;
    const heartbeatSignature = createModuleHeartbeatSignature({
      moduleId: "account-integrations",
      timestamp: "1784980800",
      nonce: "A".repeat(43),
      rawBody: Buffer.from(init?.body as string, "utf8"),
      secret: heartbeatSecret,
    });
    expect(headers["x-apollo-heartbeat-signature"]).toBe(heartbeatSignature);
    expect(headers["x-apollo-heartbeat-signature"]).not.toBe(
      createModuleHeartbeatSignature({
        moduleId: "account-integrations",
        timestamp: "1784980800",
        nonce: "A".repeat(43),
        rawBody: Buffer.from(init?.body as string, "utf8"),
        secret: commandSecret,
      }),
    );

    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    await heartbeat.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses fixed 30-second start ticks without overlapping a slow attempt", async () => {
    vi.useFakeTimers();
    let completeFirst: (() => void) | undefined;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            completeFirst = () => resolve(new Response("", { status: 202 }));
          }),
      )
      .mockResolvedValue(new Response("", { status: 202 }));
    const heartbeat = startTfIntegrationsHeartbeat({
      apiOrigin: "https://api.example.test",
      secret: heartbeatSecret,
      version: "build-4",
      ready: async () => true,
      fetch,
    });

    await vi.runAllTicks();
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    completeFirst?.();
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(24_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);

    await heartbeat.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops heartbeat timers and closes the pool during graceful shutdown", async () => {
    const order: string[] = [];
    const shutdown = createTfIntegrationsShutdown({
      closeListener: async () => {
        order.push("listener");
      },
      heartbeat: {
        async stop() {
          order.push("heartbeat");
        },
      },
      closePool: async () => {
        order.push("pool");
      },
    });

    await Promise.all([shutdown(), shutdown()]);
    expect(order).toEqual(["listener", "heartbeat", "pool"]);
  });
});
