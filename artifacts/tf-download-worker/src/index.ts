import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, open, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DOWNLOAD_JOB_CANCELLATION_FIELD,
  DOWNLOAD_JOB_CANCELLATION_SENTINEL,
  DOWNLOAD_QUEUE_NAME,
  DOWNLOAD_QUEUE_PREFIX,
  getDownloadQueueJobHashKey,
  type DownloadQueueRedisConnection,
  type DownloadJobData,
  type DownloadJobResult,
} from "@workspace/tf-download-contract";
import { Queue, UnrecoverableError, Worker, type Job } from "bullmq";
import Redis from "ioredis";
import type { RedisOptions } from "ioredis";

import {
  createTfDownloadWorkerApp,
  type CreateTfDownloadWorkerAppOptions,
} from "./app.js";
import {
  parseTfDownloadWorkerConfig,
  type TfDownloadWorkerConfig,
} from "./config.js";
import {
  startTfDownloadWorkerHeartbeat,
  type TfDownloadWorkerHeartbeatHandle,
  type TfDownloadWorkerHeartbeatOptions,
} from "./heartbeat.js";
import { HmacFileRequestAuthenticator } from "./internal-auth.js";
import {
  createDownloadProcessor,
  DownloadProcessingError,
  type CreateDownloadProcessorOptions,
  type DownloadProcessor,
} from "./processor.js";
import { DownloadStorage, type DownloadStorageSweepResult } from "./storage.js";

export { spawnYtDlpDownload } from "./downloader.js";

type RuntimeHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void;

interface RuntimeRedis {
  connect(): Promise<unknown>;
  ping(): Promise<string>;
  hget(key: string, field: string): Promise<string | null>;
  quit(): Promise<unknown>;
  disconnect(): void;
}

interface RuntimeQueue {
  waitUntilReady(): Promise<unknown>;
  getJobCounts(...types: string[]): Promise<Record<string, number>>;
  getJob(jobId: string): Promise<unknown>;
  toKey(suffix: string): string;
  close(): Promise<void>;
}

interface RuntimeWorker {
  waitUntilReady(): Promise<unknown>;
  run(): Promise<void>;
  pause(doNotWaitActive?: boolean): Promise<void>;
  close(force?: boolean): Promise<void>;
}

interface RuntimeStorage {
  readonly root: string;
  begin: DownloadStorage["begin"];
  openOwnedFile: DownloadStorage["openOwnedFile"];
  sweep(): Promise<DownloadStorageSweepResult>;
  close(): Promise<void>;
}

interface RuntimeHttpListener {
  close(): Promise<void>;
  destroyConnections(): void;
}

interface RuntimeReadiness {
  check(): Promise<boolean>;
}

interface QueueFactoryOptions {
  readonly connection: RuntimeRedis;
  readonly prefix: string;
}

interface WorkerFactoryOptions extends QueueFactoryOptions {
  readonly concurrency: number;
  readonly autorun: false;
}

export interface TfDownloadWorkerRuntimeDependencies {
  readonly parseConfig: (
    env: NodeJS.ProcessEnv,
  ) => Promise<TfDownloadWorkerConfig>;
  readonly createStorage: (
    config: TfDownloadWorkerConfig,
  ) => Promise<RuntimeStorage>;
  readonly createRedis: (
    connection: DownloadQueueRedisConnection,
    role: "worker" | "lookup" | "cancellation",
  ) => RuntimeRedis;
  readonly createQueue: (
    name: string,
    options: QueueFactoryOptions,
  ) => RuntimeQueue;
  readonly createWorker: (
    name: string,
    processor: (job: unknown) => Promise<unknown>,
    options: WorkerFactoryOptions,
  ) => RuntimeWorker;
  readonly createProcessor: (
    options: CreateDownloadProcessorOptions,
  ) => DownloadProcessor;
  readonly createAuthenticator: (
    options: ConstructorParameters<typeof HmacFileRequestAuthenticator>[0],
  ) => HmacFileRequestAuthenticator;
  readonly createApp: (
    options: CreateTfDownloadWorkerAppOptions,
  ) => RuntimeHandler;
  readonly listenHttp: (
    handler: RuntimeHandler,
    port: number,
  ) => Promise<RuntimeHttpListener>;
  readonly probeStorage: (storage: RuntimeStorage) => Promise<boolean>;
  readonly probeDownloader: (executable: string) => Promise<boolean>;
  readonly startHeartbeat: (
    options: TfDownloadWorkerHeartbeatOptions,
  ) => TfDownloadWorkerHeartbeatHandle;
  readonly setSweepInterval: (
    task: () => void,
    milliseconds: number,
  ) => unknown;
  readonly clearSweepInterval: (handle: unknown) => void;
}

export interface StartTfDownloadWorkerRuntimeOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly dependencies?: Partial<TfDownloadWorkerRuntimeDependencies>;
  readonly registerSignals?: boolean;
}

export interface TfDownloadWorkerRuntime {
  readonly readiness: RuntimeReadiness;
  shutdown(): Promise<void>;
}

type TfDownloadWorkerRedisRole = "worker" | "lookup" | "cancellation";

export function createTfDownloadWorkerRedisOptions(
  role: TfDownloadWorkerRedisRole,
): RedisOptions {
  const common = {
    connectTimeout: 3_000,
    enableOfflineQueue: false,
    lazyConnect: true,
  } as const;
  return role === "worker"
    ? { ...common, maxRetriesPerRequest: null }
    : {
        ...common,
        commandTimeout: 1_000,
        maxRetriesPerRequest: 1,
      };
}

function createRedis(
  connection: DownloadQueueRedisConnection,
  role: TfDownloadWorkerRedisRole,
): RuntimeRedis {
  const client = new Redis({
    host: connection.host,
    port: connection.port,
    db: connection.db,
    username: connection.username,
    password: connection.password,
    ...(connection.protocol === "rediss:" ? { tls: {} } : {}),
    ...createTfDownloadWorkerRedisOptions(role),
  });
  client.on("error", () => {});
  return client;
}

async function createStorage(
  config: TfDownloadWorkerConfig,
): Promise<RuntimeStorage> {
  const storage = await DownloadStorage.create({
    root: config.storageRoot,
    maxFileBytes: config.maxFileBytes,
    quotaBytes: config.storageQuotaBytes,
    ttlMs: config.fileTtlMs,
  });
  return Object.assign(storage, {
    async close(): Promise<void> {
      await storage.sweep();
    },
  });
}

async function probeStorage(storage: RuntimeStorage): Promise<boolean> {
  const canary = path.join(
    storage.root,
    `.runtime-${randomBytes(16).toString("hex")}.probe`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(canary, "wx", 0o600);
    await handle.writeFile(Buffer.from([0]));
    await handle.sync();
    await handle.close();
    handle = undefined;
    await unlink(canary);
    return true;
  } catch {
    await handle?.close().catch(() => undefined);
    await unlink(canary).catch(() => undefined);
    return false;
  }
}

async function probeDownloader(executable: string): Promise<boolean> {
  try {
    await access(executable, constants.R_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function listenHttp(
  handler: RuntimeHandler,
  port: number,
): Promise<RuntimeHttpListener> {
  const server = createServer(handler);
  server.listen(port, "0.0.0.0");
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
  } catch (error) {
    server.close();
    throw error;
  }
  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      }),
    destroyConnections() {
      server.closeAllConnections();
    },
  };
}

const defaultDependencies: TfDownloadWorkerRuntimeDependencies = {
  parseConfig: parseTfDownloadWorkerConfig,
  createStorage,
  createRedis,
  createQueue: (name, options) => {
    const queue = new Queue<DownloadJobData, DownloadJobResult>(name, {
      connection: options.connection as Redis,
      prefix: options.prefix,
    });
    queue.on("error", () => {});
    return queue as unknown as RuntimeQueue;
  },
  createWorker: (name, processor, options) => {
    const worker = new Worker<DownloadJobData, DownloadJobResult>(
      name,
      processor as (
        job: Job<DownloadJobData, DownloadJobResult>,
      ) => Promise<DownloadJobResult>,
      {
        connection: options.connection as Redis,
        prefix: options.prefix,
        concurrency: options.concurrency,
        autorun: options.autorun,
      },
    );
    worker.on("error", () => {});
    return worker as unknown as RuntimeWorker;
  },
  createProcessor: createDownloadProcessor,
  createAuthenticator: (options) => new HmacFileRequestAuthenticator(options),
  createApp: createTfDownloadWorkerApp,
  listenHttp,
  probeStorage,
  probeDownloader,
  startHeartbeat: startTfDownloadWorkerHeartbeat,
  setSweepInterval: (task, milliseconds) => setInterval(task, milliseconds),
  clearSweepInterval: (handle) =>
    clearInterval(handle as ReturnType<typeof setInterval>),
};

function withTimeout<T>(
  operation: Promise<T>,
  milliseconds: number,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    operation,
    new Promise<T>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error("operation timed out")),
        milliseconds,
      );
    }),
  ]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
}

async function settleWithin(
  operation: Promise<unknown>,
  milliseconds: number,
): Promise<boolean> {
  try {
    await withTimeout(operation, Math.max(1, milliseconds));
    return true;
  } catch {
    return false;
  }
}

async function closeRedis(
  client: RuntimeRedis,
  timeoutMs: number,
): Promise<void> {
  if (!(await settleWithin(client.quit(), timeoutMs))) {
    client.disconnect();
  }
}

export async function startTfDownloadWorkerRuntime(
  options: StartTfDownloadWorkerRuntimeOptions = {},
): Promise<TfDownloadWorkerRuntime> {
  const dependencies = {
    ...defaultDependencies,
    ...options.dependencies,
  };
  let config: TfDownloadWorkerConfig | undefined;
  let storage: RuntimeStorage | undefined;
  let workerRedis: RuntimeRedis | undefined;
  let lookupRedis: RuntimeRedis | undefined;
  let cancellationRedis: RuntimeRedis | undefined;
  let queue: RuntimeQueue | undefined;
  let worker: RuntimeWorker | undefined;
  let listener: RuntimeHttpListener | undefined;
  let heartbeat: TfDownloadWorkerHeartbeatHandle | undefined;
  let sweepTimer: unknown;
  let ready = false;
  let workerFailed = false;
  let sweepFailed = false;
  let shutdownPromise: Promise<void> | undefined;
  let signalHandler: (() => void) | undefined;
  const active = new Map<
    symbol,
    { readonly controller: AbortController; readonly done: Promise<void> }
  >();
  const completions: number[] = [];

  try {
    config = await dependencies.parseConfig(options.env ?? process.env);
    storage = await dependencies.createStorage(config);
    await storage.sweep();

    workerRedis = dependencies.createRedis(
      config.queueRedisConnection,
      "worker",
    );
    lookupRedis = dependencies.createRedis(
      config.queueRedisConnection,
      "lookup",
    );
    cancellationRedis = dependencies.createRedis(
      config.queueRedisConnection,
      "cancellation",
    );
    await withTimeout(
      Promise.all([
        workerRedis.connect(),
        lookupRedis.connect(),
        cancellationRedis.connect(),
      ]),
      config.queueProbeTimeoutMs,
    );
    await withTimeout(
      Promise.all([
        workerRedis.ping(),
        lookupRedis.ping(),
        cancellationRedis.ping(),
      ]),
      config.queueProbeTimeoutMs,
    );

    queue = dependencies.createQueue(DOWNLOAD_QUEUE_NAME, {
      connection: lookupRedis,
      prefix: DOWNLOAD_QUEUE_PREFIX,
    });
    await withTimeout(queue.waitUntilReady(), config.queueProbeTimeoutMs);

    const queueClient = queue;
    const cancellationClient = cancellationRedis;
    const processor = dependencies.createProcessor({
      storage,
      downloaderExecutable: config.downloaderExecutable,
      cancellationStore: {
        async isCanceled(jobId, signal) {
          if (signal.aborted) throw signal.reason;
          return (
            (await cancellationClient.hget(
              getDownloadQueueJobHashKey(
                (suffix) => queueClient.toKey(suffix),
                jobId,
              ),
              DOWNLOAD_JOB_CANCELLATION_FIELD,
            )) === DOWNLOAD_JOB_CANCELLATION_SENTINEL
          );
        },
      },
    });
    const processJob = async (job: unknown): Promise<unknown> => {
      const token = Symbol();
      const controller = new AbortController();
      let complete!: () => void;
      const done = new Promise<void>((resolve) => {
        complete = resolve;
      });
      active.set(token, { controller, done });
      try {
        const result = await processor(
          job as Job<DownloadJobData, DownloadJobResult>,
          controller.signal,
        );
        completions.push(Date.now());
        return result;
      } catch (error) {
        if (error instanceof DownloadProcessingError && !error.retriable) {
          throw new UnrecoverableError(error.code);
        }
        throw error;
      } finally {
        active.delete(token);
        complete();
      }
    };
    worker = dependencies.createWorker(DOWNLOAD_QUEUE_NAME, processJob, {
      connection: workerRedis,
      prefix: DOWNLOAD_QUEUE_PREFIX,
      concurrency: 2,
      autorun: false,
    });
    await withTimeout(worker.waitUntilReady(), config.queueProbeTimeoutMs);

    const ownedStorage = storage;
    const runtimeConfig = config;
    const readiness: RuntimeReadiness = {
      async check(): Promise<boolean> {
        if (!ready || workerFailed) return false;
        try {
          const [pong, , storageReady, downloaderReady] = await withTimeout(
            Promise.all([
              lookupRedis!.ping(),
              queueClient.getJobCounts("waiting", "active"),
              dependencies.probeStorage(ownedStorage),
              dependencies.probeDownloader(runtimeConfig.downloaderExecutable),
            ]),
            runtimeConfig.queueProbeTimeoutMs,
          );
          return (
            pong === "PONG" && storageReady === true && downloaderReady === true
          );
        } catch {
          return false;
        }
      },
    };

    ready = true;
    if (!(await readiness.check())) {
      ready = false;
      throw new Error("runtime not ready");
    }
    const auth = dependencies.createAuthenticator({
      secret: config.internalAuthSecret,
    });
    const app = dependencies.createApp({
      auth,
      jobs: queue as never,
      storage,
      ready: () => readiness.check(),
    });
    listener = await dependencies.listenHttp(app, config.port);
    void worker.run().then(
      () => {
        if (ready) {
          workerFailed = true;
          ready = false;
        }
      },
      () => {
        workerFailed = true;
        ready = false;
      },
    );
    heartbeat = dependencies.startHeartbeat({
      apiOrigin: config.heartbeatApiOrigin,
      secret: config.heartbeatSecret,
      version: config.version,
      ...(config.deployedAt === undefined
        ? {}
        : { deployedAt: config.deployedAt }),
      ready: () => readiness.check(),
      observe: () => {
        const cutoff = Date.now() - 60_000;
        while (completions.length > 0 && (completions[0] ?? 0) < cutoff) {
          completions.shift();
        }
        return {
          status:
            !ready || workerFailed
              ? "degraded"
              : sweepFailed
                ? "warning"
                : "healthy",
          jobsPerMinute: completions.length,
        };
      },
    });
    let sweepActive = false;
    sweepTimer = dependencies.setSweepInterval(() => {
      if (sweepActive || !ready) return;
      sweepActive = true;
      void storage!
        .sweep()
        .then(
          () => {
            sweepFailed = false;
          },
          () => {
            sweepFailed = true;
          },
        )
        .finally(() => {
          sweepActive = false;
        });
    }, config.sweepIntervalMs);

    const shutdown = (): Promise<void> => {
      shutdownPromise ??= (async () => {
        ready = false;
        const closeTimeoutMs = Math.max(
          1,
          Math.min(runtimeConfig.shutdownGraceMs, 5_000),
        );
        if (signalHandler !== undefined) {
          process.off("SIGTERM", signalHandler);
          process.off("SIGINT", signalHandler);
        }
        await settleWithin(worker!.pause(true), closeTimeoutMs);
        if (!(await settleWithin(listener!.close(), closeTimeoutMs))) {
          listener!.destroyConnections();
        }
        if (sweepTimer !== undefined) {
          dependencies.clearSweepInterval(sweepTimer);
          sweepTimer = undefined;
        }

        const activeDeadline = Date.now() + runtimeConfig.shutdownGraceMs;
        const activeAtShutdown = Array.from(
          active.values(),
          ({ done }) => done,
        );
        const cleanupReserveMs = Math.min(
          2_000,
          Math.max(1, Math.floor(runtimeConfig.shutdownGraceMs / 4)),
        );
        let drainedGracefully = activeAtShutdown.length === 0;
        if (!drainedGracefully) {
          drainedGracefully = await settleWithin(
            Promise.allSettled(activeAtShutdown),
            Math.max(1, runtimeConfig.shutdownGraceMs - cleanupReserveMs),
          );
        }
        if (!drainedGracefully) {
          const cancellation = new DownloadProcessingError(
            "download_canceled",
            { retriable: false },
          );
          for (const { controller } of active.values()) {
            controller.abort(cancellation);
          }
          const remainingForCleanup = Math.max(0, activeDeadline - Date.now());
          if (active.size > 0 && remainingForCleanup > 0) {
            await settleWithin(
              Promise.allSettled(
                Array.from(active.values(), ({ done }) => done),
              ),
              remainingForCleanup,
            );
          }
          const cleanup = ownedStorage.sweep();
          const remainingForSweep = Math.max(0, activeDeadline - Date.now());
          if (remainingForSweep > 0) {
            await settleWithin(cleanup, remainingForSweep);
          } else {
            void cleanup.catch(() => undefined);
          }
        }

        await settleWithin(worker!.close(!drainedGracefully), closeTimeoutMs);
        await settleWithin(queueClient.close(), closeTimeoutMs);
        await closeRedis(workerRedis!, closeTimeoutMs);
        await closeRedis(lookupRedis!, closeTimeoutMs);
        await closeRedis(cancellationRedis!, closeTimeoutMs);
        await settleWithin(ownedStorage.close(), closeTimeoutMs);
        await settleWithin(heartbeat!.stop(), closeTimeoutMs);
      })();
      return shutdownPromise;
    };

    if (options.registerSignals !== false) {
      signalHandler = () => {
        void shutdown().catch(() => {
          process.stderr.write("TF download worker shutdown failed\n");
          process.exitCode = 1;
        });
      };
      process.once("SIGTERM", signalHandler);
      process.once("SIGINT", signalHandler);
    }
    return { readiness, shutdown };
  } catch {
    ready = false;
    const closeTimeoutMs = Math.max(
      1,
      Math.min(config?.shutdownGraceMs ?? 5_000, 5_000),
    );
    if (sweepTimer !== undefined) dependencies.clearSweepInterval(sweepTimer);
    if (
      listener !== undefined &&
      !(await settleWithin(listener.close(), closeTimeoutMs))
    ) {
      listener.destroyConnections();
    }
    if (worker !== undefined) {
      await settleWithin(worker.close(true), closeTimeoutMs);
    }
    if (queue !== undefined) {
      await settleWithin(queue.close(), closeTimeoutMs);
    }
    if (workerRedis !== undefined) {
      await closeRedis(workerRedis, closeTimeoutMs);
    }
    if (lookupRedis !== undefined) {
      await closeRedis(lookupRedis, closeTimeoutMs);
    }
    if (cancellationRedis !== undefined) {
      await closeRedis(cancellationRedis, closeTimeoutMs);
    }
    if (storage !== undefined) {
      await settleWithin(storage.close(), closeTimeoutMs);
    }
    if (heartbeat !== undefined) {
      await settleWithin(heartbeat.stop(), closeTimeoutMs);
    }
    throw new Error("runtime startup failed");
  }
}

export async function runTfDownloadWorkerMain(): Promise<void> {
  try {
    await startTfDownloadWorkerRuntime();
    process.stdout.write("TF download worker listening\n");
  } catch {
    process.stderr.write("TF download worker startup failed\n");
    process.exitCode = 1;
  }
}

const mainPath = process.argv[1];
if (
  mainPath !== undefined &&
  fileURLToPath(import.meta.url).toLowerCase() === mainPath.toLowerCase()
) {
  void runTfDownloadWorkerMain();
}
