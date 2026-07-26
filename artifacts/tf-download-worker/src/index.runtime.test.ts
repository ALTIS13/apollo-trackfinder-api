import { UnrecoverableError } from "bullmq";
import { describe, expect, it, vi } from "vitest";

import type { TfDownloadWorkerConfig } from "./config.js";
import { DownloadProcessingError } from "./processor.js";
import {
  createTfDownloadWorkerRedisOptions,
  startTfDownloadWorkerRuntime,
} from "./index.js";

const config: TfDownloadWorkerConfig = {
  port: 8_080,
  queueRedisUrl: "rediss://worker:password@queue.apollot.ru:6380/3",
  internalAuthSecret: "c".repeat(32),
  heartbeatSecret: "h".repeat(32),
  heartbeatApiOrigin: "https://api.apollot.ru",
  storageRoot: "/var/lib/apollo-tf/downloads",
  downloaderExecutable: "/usr/local/bin/yt-dlp",
  version: "build-5",
  deployedAt: "2026-07-26T12:00:00.000Z",
  maxFileBytes: 1_073_741_824,
  storageQuotaBytes: 21_474_836_480,
  fileTtlMs: 86_400_000,
  sweepIntervalMs: 300_000,
  shutdownGraceMs: 30_000,
  queueProbeTimeoutMs: 3_000,
};

interface HarnessOptions {
  readonly processJob?: (
    job: unknown,
    signal: AbortSignal,
  ) => Promise<unknown>;
  readonly shutdownGraceMs?: number;
  readonly hangHttpClose?: boolean;
  readonly hangPostGraceClose?: boolean;
  readonly workerRunExits?: boolean;
  readonly hangStartupPing?: boolean;
  readonly queueProbeTimeoutMs?: number;
}

function createHarness(options: HarnessOptions = {}) {
  const order: string[] = [];
  const redis = Array.from({ length: 3 }, (_, index) => ({
    async connect() {
      order.push(`redis:${index}:connect`);
    },
    async ping() {
      order.push(`redis:${index}:ping`);
      if (options.hangStartupPing && index === 0) {
        return new Promise<never>(() => undefined);
      }
      return "PONG";
    },
    async get() {
      return null;
    },
    async quit() {
      order.push(`redis:${index}:quit`);
      if (options.hangPostGraceClose) {
        return new Promise<never>(() => undefined);
      }
    },
    disconnect() {
      order.push(`redis:${index}:disconnect`);
    },
  }));
  let redisIndex = 0;
  let workerProcessor:
    | ((job: unknown) => Promise<unknown>)
    | undefined;
  let workerOptions: unknown;
  let queueOptions: unknown;
  let appOptions: unknown;
  let sweepTask: (() => void) | undefined;
  let heartbeatOptions: unknown;
  let finishWorkerRun: (() => void) | undefined;
  const workerRun = new Promise<void>((resolve) => {
    finishWorkerRun = resolve;
  });
  const storage = {
    root: config.storageRoot,
    async begin() {
      throw new Error("unused");
    },
    async openOwnedFile() {
      throw new Error("unused");
    },
    async sweep() {
      order.push("storage:sweep");
      return {
        scannedEntries: 0,
        removedPartialFiles: 0,
        removedStorageKeys: [],
        bytesRemaining: 0,
        quotaSatisfied: true,
      };
    },
    async close() {
      order.push("storage:close");
      if (options.hangPostGraceClose) {
        return new Promise<never>(() => undefined);
      }
    },
  };
  const queue = {
    async waitUntilReady() {
      order.push("queue:ready");
    },
    async getJobCounts() {
      order.push("queue:probe");
      return { waiting: 0, active: 0 };
    },
    async getJob() {
      return undefined;
    },
    async close() {
      order.push("queue:close");
      if (options.hangPostGraceClose) {
        return new Promise<never>(() => undefined);
      }
    },
  };
  const worker = {
    async waitUntilReady() {
      order.push("worker:ready");
    },
    run() {
      order.push("worker:run");
      return options.workerRunExits ? Promise.resolve() : workerRun;
    },
    async pause(doNotWaitActive?: boolean) {
      order.push(`worker:pause:${String(doNotWaitActive)}`);
    },
    async close(force?: boolean) {
      order.push(`worker:close:${String(force)}`);
      if (options.hangPostGraceClose) {
        return new Promise<never>(() => undefined);
      }
      finishWorkerRun?.();
    },
  };
  const dependencies = {
    async parseConfig() {
      order.push("config");
      return {
        ...config,
        shutdownGraceMs:
          options.shutdownGraceMs ?? config.shutdownGraceMs,
        queueProbeTimeoutMs:
          options.queueProbeTimeoutMs ?? config.queueProbeTimeoutMs,
      };
    },
    async createStorage() {
      order.push("storage:create");
      return storage;
    },
    createRedis() {
      order.push(`redis:${redisIndex}:create`);
      return redis[redisIndex++]!;
    },
    createQueue(_name: string, passedOptions: unknown) {
      order.push("queue:create");
      queueOptions = passedOptions;
      return queue;
    },
    createWorker(
      _name: string,
      processor: (job: unknown) => Promise<unknown>,
      passedOptions: unknown,
    ) {
      order.push("worker:create");
      workerProcessor = processor;
      workerOptions = passedOptions;
      return worker;
    },
    createProcessor() {
      order.push("processor:create");
      return (
        options.processJob ??
        (async () => ({
          schemaVersion: 1,
          storageKey:
            "10000000-0000-4000-8000-000000000001.mp3",
          fileSize: 1,
          mimeType: "audio/mpeg",
          filename: "track.mp3",
          completedAt: "2026-07-26T12:00:00.000Z",
        }))
      ) as never;
    },
    createAuthenticator() {
      order.push("auth:create");
      return {} as never;
    },
    createApp(passedOptions: unknown) {
      order.push("app:create");
      appOptions = passedOptions;
      return (() => undefined) as never;
    },
    async listenHttp() {
      order.push("http:listen");
      return {
        async close() {
          order.push("http:close");
          if (options.hangHttpClose) {
            return new Promise<never>(() => undefined);
          }
        },
        destroyConnections() {
          order.push("http:destroy");
        },
      };
    },
    async probeStorage() {
      order.push("storage:probe");
      return true;
    },
    async probeDownloader() {
      order.push("downloader:probe");
      return true;
    },
    startHeartbeat(passedOptions: unknown) {
      order.push("heartbeat:start");
      heartbeatOptions = passedOptions;
      return {
        async stop() {
          order.push("heartbeat:stop");
          if (options.hangPostGraceClose) {
            return new Promise<never>(() => undefined);
          }
        },
      };
    },
    setSweepInterval(task: () => void, milliseconds: number) {
      order.push(`sweeper:start:${milliseconds}`);
      sweepTask = task;
      return { timer: true };
    },
    clearSweepInterval() {
      order.push("sweeper:stop");
    },
  };

  return {
    order,
    redis,
    storage,
    queue,
    worker,
    dependencies,
    get workerProcessor() {
      return workerProcessor;
    },
    get workerOptions() {
      return workerOptions;
    },
    get queueOptions() {
      return queueOptions;
    },
    get appOptions() {
      return appOptions;
    },
    get sweepTask() {
      return sweepTask;
    },
    get heartbeatOptions() {
      return heartbeatOptions;
    },
  };
}

describe("TF download worker runtime", () => {
  it("uses blocking-safe worker Redis and bounded command clients", () => {
    expect(createTfDownloadWorkerRedisOptions("worker")).toEqual({
      connectTimeout: 3_000,
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: null,
    });
    for (const role of ["lookup", "cancellation"] as const) {
      expect(createTfDownloadWorkerRedisOptions(role)).toEqual({
        connectTimeout: 3_000,
        commandTimeout: 1_000,
        enableOfflineQueue: false,
        lazyConnect: true,
        maxRetriesPerRequest: 1,
      });
    }
  });

  it("completes storage and queue readiness before listen and wires exact BullMQ boundaries", async () => {
    const harness = createHarness();
    const runtime = await startTfDownloadWorkerRuntime({
      registerSignals: false,
      dependencies: harness.dependencies as never,
    });

    expect(harness.order.indexOf("storage:create")).toBeLessThan(
      harness.order.indexOf("http:listen"),
    );
    expect(harness.order.indexOf("storage:sweep")).toBeLessThan(
      harness.order.indexOf("http:listen"),
    );
    expect(harness.order.indexOf("queue:probe")).toBeLessThan(
      harness.order.indexOf("http:listen"),
    );
    expect(harness.order.indexOf("worker:ready")).toBeLessThan(
      harness.order.indexOf("http:listen"),
    );
    expect(harness.workerOptions).toMatchObject({
      concurrency: 2,
      prefix: "{apollo-tf-downloads}",
      autorun: false,
    });
    expect(harness.queueOptions).toMatchObject({
      prefix: "{apollo-tf-downloads}",
    });
    expect(harness.appOptions).toMatchObject({
      jobs: harness.queue,
      storage: harness.storage,
    });
    expect(harness.order.indexOf("worker:run")).toBeLessThan(
      harness.order.indexOf("heartbeat:start"),
    );
    expect(
      await (harness.heartbeatOptions as { ready(): Promise<boolean> }).ready(),
    ).toBe(true);
    expect(harness.order).toContain("sweeper:start:300000");

    harness.sweepTask?.();
    await vi.waitFor(
      () =>
        expect(
          harness.order.filter((entry) => entry === "storage:sweep"),
        ).toHaveLength(2),
    );
    await runtime.shutdown();
  });

  it("maps non-retriable processing errors to BullMQ UnrecoverableError", async () => {
    const harness = createHarness({
      processJob: async () => {
        throw new DownloadProcessingError("invalid_job", {
          retriable: false,
        });
      },
    });
    const runtime = await startTfDownloadWorkerRuntime({
      registerSignals: false,
      dependencies: harness.dependencies as never,
    });

    await expect(harness.workerProcessor?.({ id: "job" })).rejects.toEqual(
      expect.objectContaining({
        name: UnrecoverableError.name,
        message: "invalid_job",
      }),
    );
    await runtime.shutdown();
  });

  it("fails readiness when the BullMQ run loop exits unexpectedly", async () => {
    const harness = createHarness({ workerRunExits: true });
    const runtime = await startTfDownloadWorkerRuntime({
      registerSignals: false,
      dependencies: harness.dependencies as never,
    });

    await vi.waitFor(async () =>
      expect(await runtime.readiness.check()).toBe(false),
    );
    await runtime.shutdown();
  });

  it("stops admission and closes BullMQ, Redis, storage, then heartbeat", async () => {
    const harness = createHarness();
    const runtime = await startTfDownloadWorkerRuntime({
      registerSignals: false,
      dependencies: harness.dependencies as never,
    });

    await Promise.all([runtime.shutdown(), runtime.shutdown()]);
    const shutdown = harness.order.slice(
      harness.order.indexOf("worker:pause:true"),
    );
    expect(shutdown).toEqual([
      "worker:pause:true",
      "http:close",
      "sweeper:stop",
      "worker:close:false",
      "queue:close",
      "redis:0:quit",
      "redis:1:quit",
      "redis:2:quit",
      "storage:close",
      "heartbeat:stop",
    ]);
  });

  it("aborts active jobs after the shutdown grace and sweeps owned partials", async () => {
    let observedSignal: AbortSignal | undefined;
    const harness = createHarness({
      shutdownGraceMs: 5,
      processJob: async (_job, signal) => {
        observedSignal = signal;
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(signal.reason),
            { once: true },
          );
        });
      },
    });
    const runtime = await startTfDownloadWorkerRuntime({
      registerSignals: false,
      dependencies: harness.dependencies as never,
    });
    const processing = harness.workerProcessor?.({ id: "job" });
    await vi.waitFor(() => expect(observedSignal).toBeDefined());

    await runtime.shutdown();
    await expect(processing).rejects.toBeInstanceOf(UnrecoverableError);
    expect(observedSignal?.aborted).toBe(true);
    expect(harness.order).toContain("worker:close:true");
    expect(
      harness.order.filter((entry) => entry === "storage:sweep").length,
    ).toBeGreaterThanOrEqual(2);
  });

  it(
    "bounds keep-alive HTTP close and destroys connections before continuing",
    async () => {
      const harness = createHarness({
        shutdownGraceMs: 5,
        hangHttpClose: true,
      });
      const runtime = await startTfDownloadWorkerRuntime({
        registerSignals: false,
        dependencies: harness.dependencies as never,
      });

      await runtime.shutdown();
      expect(harness.order).toContain("http:destroy");
      expect(harness.order.indexOf("http:destroy")).toBeLessThan(
        harness.order.indexOf("worker:close:false"),
      );
    },
    250,
  );

  it(
    "bounds every post-grace close and preserves best-effort close order",
    async () => {
      const harness = createHarness({
        shutdownGraceMs: 5,
        hangPostGraceClose: true,
      });
      const runtime = await startTfDownloadWorkerRuntime({
        registerSignals: false,
        dependencies: harness.dependencies as never,
      });

      await runtime.shutdown();
      const attempts = harness.order.filter((entry) =>
        /^(worker:close|queue:close|redis:\d:quit|storage:close|heartbeat:stop)/.test(
          entry,
        ),
      );
      expect(attempts).toEqual([
        "worker:close:false",
        "queue:close",
        "redis:0:quit",
        "redis:1:quit",
        "redis:2:quit",
        "storage:close",
        "heartbeat:stop",
      ]);
    },
    500,
  );

  it("readiness probes only queue, owned storage, and downloader", async () => {
    const harness = createHarness();
    const runtime = await startTfDownloadWorkerRuntime({
      registerSignals: false,
      dependencies: harness.dependencies as never,
    });
    const before = harness.order.length;

    await expect(runtime.readiness.check()).resolves.toBe(true);
    expect(harness.order.slice(before)).toEqual([
      "redis:1:ping",
      "queue:probe",
      "storage:probe",
      "downloader:probe",
    ]);
    await runtime.shutdown();
  });

  it("sanitizes startup failures and has no import-time startup side effects", async () => {
    const canary = "redis://user:DO_NOT_LEAK@queue";
    const harness = createHarness();
    const beforeSignals = process.listenerCount("SIGTERM");

    await expect(
      startTfDownloadWorkerRuntime({
        registerSignals: false,
        dependencies: {
          ...harness.dependencies,
          async parseConfig() {
            throw new Error(canary);
          },
        } as never,
      }),
    ).rejects.toThrow("runtime startup failed");
    await expect(
      startTfDownloadWorkerRuntime({
        registerSignals: false,
        dependencies: {
          ...harness.dependencies,
          async parseConfig() {
            throw new Error(canary);
          },
        } as never,
      }),
    ).rejects.not.toThrow(canary);
    expect(process.listenerCount("SIGTERM")).toBe(beforeSignals);
    expect(harness.order).not.toContain("http:listen");
  });

  it(
    "bounds Redis and BullMQ startup readiness with the configured probe timeout",
    async () => {
      const harness = createHarness({
        hangStartupPing: true,
        queueProbeTimeoutMs: 5,
        shutdownGraceMs: 5,
      });

      await expect(
        startTfDownloadWorkerRuntime({
          registerSignals: false,
          dependencies: harness.dependencies as never,
        }),
      ).rejects.toThrow("runtime startup failed");
      expect(harness.order).not.toContain("http:listen");
      expect(harness.order).toContain("redis:0:quit");
    },
    250,
  );
});
