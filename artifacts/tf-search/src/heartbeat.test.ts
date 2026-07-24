import { createModuleHeartbeatSignature } from "@workspace/module-runtime-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startSearchHeartbeat } from "./heartbeat.js";

const secret = "h".repeat(32);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("TF search heartbeat", () => {
  it("sends immediately after readiness with the exact signed search-media payload", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T12:00:00.000Z"));
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("", { status: 202 }));
    const handle = startSearchHeartbeat({
      apiOrigin: "https://api.example.test",
      secret,
      version: "build-1",
      deployedAt: "2026-07-24T11:00:00.000Z",
      ready: () => true,
      telemetry: () => ({ requestsPerMinute: 7, status: "warning" }),
      fetch,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.example.test/api/internal/modules/search-media/heartbeat");
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(init?.headers).toMatchObject({ "content-type": "application/json" });
    expect(init?.body).toBe(
      '{"schemaVersion":1,"status":"warning","version":"build-1","deployedAt":"2026-07-24T11:00:00.000Z","requestsPerMinute":7}',
    );
    const headers = init?.headers as Record<string, string>;
    expect(headers["x-apollo-heartbeat-signature"]).toBe(
      createModuleHeartbeatSignature({
        moduleId: "search-media",
        timestamp: "1784894400",
        nonce: headers["x-apollo-heartbeat-nonce"],
        rawBody: Buffer.from(init?.body as string),
        secret,
      }),
    );
    expect(headers["x-apollo-heartbeat-timestamp"]).toBe("1784894400");
    expect(headers["x-apollo-heartbeat-nonce"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await handle.stop();
  });

  it("waits 30 seconds after each completed attempt and never overlaps sends", async () => {
    vi.useFakeTimers();
    let resolveFirst: (() => void) | undefined;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => {
      resolveFirst = () => resolve(new Response("", { status: 202 }));
    }));
    const handle = startSearchHeartbeat({
      apiOrigin: "https://api.example.test",
      secret,
      version: "build-1",
      ready: () => true,
      telemetry: () => ({ requestsPerMinute: 0, status: "healthy" }),
      fetch,
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    resolveFirst?.();
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    resolveFirst?.();
    await vi.runAllTicks();
    await handle.stop();
  });

  it("uses a ten-second abort timeout and continues after failures without changing readiness", async () => {
    vi.useFakeTimers();
    const ready = vi.fn(() => true);
    let timedOutSignal: AbortSignal | undefined;
    const fetch = vi
      .fn()
      .mockImplementationOnce((_url: string, init: RequestInit) => {
        timedOutSignal = init.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) => {
          timedOutSignal?.addEventListener("abort", () => {
            reject(new DOMException("timed out", "AbortError"));
          });
        });
      })
      .mockResolvedValueOnce(new Response("", { status: 202 }));
    const handle = startSearchHeartbeat({
      apiOrigin: "https://api.example.test",
      secret,
      version: "build-1",
      ready,
      telemetry: () => ({ requestsPerMinute: 0, status: "degraded" }),
      fetch,
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(timedOutSignal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(ready).toHaveReturnedWith(true);
    await handle.stop();
  });

  it.each([202, 503])("cancels the heartbeat response body for status %i", async (status) => {
    vi.useFakeTimers();
    const cancel = vi.fn(async () => undefined);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => ({
      status,
      body: { cancel },
    }) as unknown as Response);
    const handle = startSearchHeartbeat({
      apiOrigin: "https://api.example.test",
      secret,
      version: "build-1",
      ready: () => true,
      telemetry: () => ({ requestsPerMinute: 0, status: "healthy" }),
      fetch,
    });

    await vi.runAllTicks();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    await handle.stop();
  });

  it("continues after response-body cancellation fails without changing readiness", async () => {
    vi.useFakeTimers();
    const ready = vi.fn(() => true);
    const failingCancel = vi.fn(async () => {
      throw new Error("body cancellation failed");
    });
    const succeedingCancel = vi.fn(async () => undefined);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce({
        status: 503,
        body: { cancel: failingCancel },
      } as unknown as Response)
      .mockResolvedValueOnce({
        status: 202,
        body: { cancel: succeedingCancel },
      } as unknown as Response);
    const handle = startSearchHeartbeat({
      apiOrigin: "https://api.example.test",
      secret,
      version: "build-1",
      ready,
      telemetry: () => ({ requestsPerMinute: 0, status: "healthy" }),
      fetch,
    });

    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(failingCancel).toHaveBeenCalledTimes(1);
    expect(succeedingCancel).toHaveBeenCalledTimes(1);
    expect(ready).toHaveReturnedWith(true);
    await handle.stop();
  });

  it("continues after a telemetry failure", async () => {
    vi.useFakeTimers();
    let telemetryCalls = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("", { status: 202 }));
    const handle = startSearchHeartbeat({
      apiOrigin: "https://api.example.test",
      secret,
      version: "build-1",
      ready: () => true,
      telemetry: () => {
        telemetryCalls += 1;
        if (telemetryCalls === 1) throw new Error("telemetry unavailable");
        return { requestsPerMinute: 0, status: "healthy" };
      },
      fetch,
    });

    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await handle.stop();
  });

  it("aborts and waits for an active send without leaving a timer", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        (init.signal as AbortSignal).addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      }),
    );
    const handle = startSearchHeartbeat({
      apiOrigin: "https://api.example.test",
      secret,
      version: "build-1",
      ready: () => true,
      telemetry: () => ({ requestsPerMinute: 0, status: "healthy" }),
      fetch,
    });

    await handle.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for a later scheduled send during shutdown", async () => {
    vi.useFakeTimers();
    let completeLaterSend: (() => void) | undefined;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("", { status: 202 }))
      .mockImplementationOnce(
        () => new Promise<Response>((resolve) => {
          completeLaterSend = () => resolve(new Response("", { status: 202 }));
        }),
      );
    const handle = startSearchHeartbeat({
      apiOrigin: "https://api.example.test",
      secret,
      version: "build-1",
      ready: () => true,
      telemetry: () => ({ requestsPerMinute: 0, status: "healthy" }),
      fetch,
    });

    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    let stopped = false;
    const stopping = handle.stop().then(() => {
      stopped = true;
    });
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
    expect(stopped).toBe(false);
    completeLaterSend?.();
    await stopping;
    expect(vi.getTimerCount()).toBe(0);
  });
});
