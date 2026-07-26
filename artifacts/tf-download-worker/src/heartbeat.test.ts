import { createModuleHeartbeatSignature } from "@workspace/module-runtime-contract";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startTfDownloadWorkerHeartbeat } from "./heartbeat.js";

const heartbeatSecret = "h".repeat(32);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("TF download worker heartbeat", () => {
  it("uses the exact signed path and sends first only after readiness", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-26T12:00:00.000Z"));
    let ready = false;
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response("", { status: 202 }),
    );
    const heartbeat = startTfDownloadWorkerHeartbeat({
      apiOrigin: "https://api.apollot.ru",
      secret: heartbeatSecret,
      version: "build-5",
      deployedAt: "2026-07-26T11:00:00.000Z",
      ready: async () => ready,
      observe: () => ({ status: "warning", jobsPerMinute: 17 }),
      fetch,
      createNonce: () => "A".repeat(43),
    });

    await vi.runAllTicks();
    expect(fetch).not.toHaveBeenCalled();
    ready = true;
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(1);

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(
      "https://api.apollot.ru/api/internal/modules/download-worker/heartbeat",
    );
    expect(init?.redirect).toBe("error");
    expect(init?.body).toBe(
      '{"schemaVersion":1,"status":"warning","version":"build-5","deployedAt":"2026-07-26T11:00:00.000Z","requestsPerMinute":17}',
    );
    const headers = init?.headers as Record<string, string>;
    const timestamp = headers["x-apollo-heartbeat-timestamp"]!;
    const nonce = headers["x-apollo-heartbeat-nonce"]!;
    expect(headers["x-apollo-heartbeat-signature"]).toBe(
      createModuleHeartbeatSignature({
        moduleId: "download-worker",
        timestamp,
        nonce,
        rawBody: Buffer.from(init?.body as string, "utf8"),
        secret: heartbeatSecret,
      }),
    );

    await heartbeat.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds observation values before signing", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response("", { status: 202 }),
    );
    const heartbeat = startTfDownloadWorkerHeartbeat({
      apiOrigin: "https://api.apollot.ru",
      secret: heartbeatSecret,
      version: "build-5",
      ready: async () => true,
      observe: () =>
        ({
          status: "raw-provider-error",
          jobsPerMinute: Number.POSITIVE_INFINITY,
        }) as never,
      fetch,
    });

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(fetch.mock.calls[0]![1]?.body).toBe(
      '{"schemaVersion":1,"status":"degraded","version":"build-5","requestsPerMinute":0}',
    );
    await heartbeat.stop();
  });

  it("uses a bounded timeout and never overlaps attempts", async () => {
    vi.useFakeTimers();
    let aborted = false;
    const fetch = vi.fn<typeof globalThis.fetch>(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    );
    const heartbeat = startTfDownloadWorkerHeartbeat({
      apiOrigin: "https://api.apollot.ru",
      secret: heartbeatSecret,
      version: "build-5",
      ready: async () => true,
      observe: () => ({ status: "healthy", jobsPerMinute: 1 }),
      fetch,
    });

    await vi.runAllTicks();
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    await heartbeat.stop();
  });

  it("stop aborts the active send and prevents post-stop sends", async () => {
    let signal: AbortSignal | undefined;
    let rejectFetch: ((error: Error) => void) | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init?.signal ?? undefined;
          rejectFetch = reject;
          signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        }),
    );
    const heartbeat = startTfDownloadWorkerHeartbeat({
      apiOrigin: "https://api.apollot.ru",
      secret: heartbeatSecret,
      version: "build-5",
      ready: async () => true,
      observe: () => ({ status: "healthy", jobsPerMinute: 1 }),
      fetch,
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    await heartbeat.stop();
    expect(signal?.aborted).toBe(true);
    rejectFetch?.(new Error("late"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rechecks stopped after asynchronous readiness", async () => {
    let release: ((value: boolean) => void) | undefined;
    let started: (() => void) | undefined;
    const readinessStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fetch = vi.fn<typeof globalThis.fetch>();
    const heartbeat = startTfDownloadWorkerHeartbeat({
      apiOrigin: "https://api.apollot.ru",
      secret: heartbeatSecret,
      version: "build-5",
      ready: async () => {
        started?.();
        return new Promise<boolean>((resolve) => {
          release = resolve;
        });
      },
      observe: () => ({ status: "healthy", jobsPerMinute: 0 }),
      fetch,
    });

    await readinessStarted;
    const stopping = heartbeat.stop();
    release?.(true);
    await stopping;
    expect(fetch).not.toHaveBeenCalled();
  });
});
