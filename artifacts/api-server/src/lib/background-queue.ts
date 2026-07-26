import { readFile } from "node:fs/promises";

import {
  DOWNLOAD_QUEUE_NAME,
  downloadJobDataSchema,
  downloadJobResultSchema,
  type DownloadJobData,
  type DownloadJobResult,
} from "@workspace/tf-download-contract";
import { Queue } from "bullmq";
import Redis, { type RedisOptions } from "ioredis";

const QUEUE_CAPACITY = 200;
const CANCELLATION_TTL_MS = 1_800_000;
const LOCAL_QUEUE_HOST = "tf-download-redis";
const LOCAL_QUEUE_PORT = "6379";
const LOCAL_QUEUE_DATABASE = "/0";

export { type DownloadJobData, type DownloadJobResult };

export class DownloadQueueUnavailableError extends Error {
  readonly code = "download_queue_unavailable";

  constructor() {
    super("Download queue is unavailable");
    this.name = "DownloadQueueUnavailableError";
  }
}

export class DownloadQueueCapacityError extends Error {
  readonly code = "download_queue_full";

  constructor() {
    super("download_queue_full");
    this.name = "DownloadQueueCapacityError";
  }
}

export interface DownloadQueueTelemetry {
  depth?: number;
  status: "healthy" | "unknown";
  redisStatus: "healthy" | "unknown";
}

export interface EnqueueResult {
  readonly jobId: string;
  readonly position: number;
}

export interface JobStatus {
  readonly status:
    | "waiting"
    | "active"
    | "completed"
    | "failed"
    | "canceled"
    | "unknown";
  readonly progress: number;
  readonly position?: number;
  readonly fileSize?: number;
}

export interface DownloadQueueCountReader {
  getWaitingCount(): Promise<number>;
  getActiveCount(): Promise<number>;
}

interface DownloadQueueJob {
  readonly id?: string;
  readonly data: unknown;
  readonly progress: unknown;
  readonly returnvalue: unknown;
  readonly failedReason: string | undefined;
  getState(): Promise<string>;
  remove(): Promise<void>;
}

interface DownloadQueue {
  waitUntilReady?(): Promise<unknown>;
  close(): Promise<void>;
  getWaitingCount(): Promise<number>;
  getActiveCount(): Promise<number>;
  add(name: string, data: DownloadJobData): Promise<{ id?: string }>;
  getJob(id: string): Promise<DownloadQueueJob | undefined>;
  getWaiting(start?: number, end?: number): Promise<DownloadQueueJob[]>;
  getActive(start?: number, end?: number): Promise<DownloadQueueJob[]>;
  getCompleted(start?: number, end?: number): Promise<DownloadQueueJob[]>;
  getFailed(start?: number, end?: number): Promise<DownloadQueueJob[]>;
}

interface DownloadCancellationClient {
  connect?(): Promise<void>;
  ping?(): Promise<unknown>;
  set(key: string, value: string, mode: "PX", ttl: number): Promise<unknown>;
  quit(): Promise<unknown>;
}

interface DownloadQueueClients {
  readonly producer: DownloadQueue;
  readonly telemetry: DownloadQueue;
  readonly cancellation: DownloadCancellationClient;
}

interface DownloadQueueAdapterOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly readFile?: (path: string) => Promise<Buffer>;
  readonly createQueue?: (
    name: string,
    options: ConstructorParameters<typeof Queue>[1],
  ) => DownloadQueue;
  readonly createRedis?: (options: RedisOptions) => DownloadCancellationClient;
}

interface QueueConfiguration {
  readonly producerConnection: RedisOptions;
  readonly telemetryConnection: RedisOptions;
  readonly cancellationConnection: RedisOptions;
}

function unavailable(): DownloadQueueUnavailableError {
  return new DownloadQueueUnavailableError();
}

function invalidRuntimeConfiguration(): Error {
  return new Error("invalid runtime configuration");
}

function parseQueueUrl(value: string): RedisOptions {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalidRuntimeConfiguration();
  }

  const isLocalPlaintext =
    parsed.protocol === "redis:" &&
    parsed.hostname === LOCAL_QUEUE_HOST &&
    parsed.port === LOCAL_QUEUE_PORT &&
    parsed.pathname === LOCAL_QUEUE_DATABASE &&
    parsed.search === "" &&
    parsed.hash === "";
  if (parsed.protocol !== "rediss:" && !isLocalPlaintext) {
    throw invalidRuntimeConfiguration();
  }

  const port = Number(parsed.port || "6379");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw invalidRuntimeConfiguration();
  }

  return {
    host: parsed.hostname,
    port,
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    ...(parsed.protocol === "rediss:" ? { tls: {} } : {}),
  };
}

async function readQueueConfiguration(
  environment: NodeJS.ProcessEnv,
  readQueueUrl: (path: string) => Promise<Buffer>,
): Promise<QueueConfiguration> {
  const filePath = environment["TF_DOWNLOAD_QUEUE_REDIS_URL_FILE"];
  if (filePath === undefined || filePath.length === 0) {
    throw invalidRuntimeConfiguration();
  }

  let contents: Buffer;
  try {
    contents = await readQueueUrl(filePath);
  } catch {
    throw invalidRuntimeConfiguration();
  }
  if (contents.length < 1 || contents.length > 2_048) {
    throw invalidRuntimeConfiguration();
  }

  const rawUrl = contents.toString("utf8").trim();
  if (rawUrl.length === 0) {
    throw invalidRuntimeConfiguration();
  }
  const connection = parseQueueUrl(rawUrl);
  const isLocalPlaintext =
    rawUrl.startsWith("redis:") &&
    connection.host === LOCAL_QUEUE_HOST &&
    connection.port === Number(LOCAL_QUEUE_PORT);
  if (
    isLocalPlaintext &&
    environment["TF_DOWNLOAD_QUEUE_ALLOW_INSECURE_REDIS"] !== "true"
  ) {
    throw invalidRuntimeConfiguration();
  }

  const common: RedisOptions = {
    ...connection,
    connectTimeout: 3_000,
    enableOfflineQueue: false,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  };
  return {
    producerConnection: { ...common, commandTimeout: 5_000 },
    telemetryConnection: { ...common, commandTimeout: 1_000 },
    cancellationConnection: { ...common, commandTimeout: 1_000 },
  };
}

function isOwnedJob(data: unknown, accountId: string): data is DownloadJobData {
  const parsed = downloadJobDataSchema.safeParse(data);
  return parsed.success && parsed.data.accountId === accountId;
}

function mapJobState(state: string, failedReason: string | undefined): JobStatus["status"] {
  if (state === "failed" && failedReason === "download_canceled") {
    return "canceled";
  }
  if (
    state === "waiting" ||
    state === "active" ||
    state === "completed" ||
    state === "failed"
  ) {
    return state;
  }
  return "unknown";
}

function toJobStatus(
  job: DownloadQueueJob,
  state: string,
  position?: number,
): JobStatus {
  const result = downloadJobResultSchema.safeParse(job.returnvalue);
  return {
    status: mapJobState(state, job.failedReason),
    progress: typeof job.progress === "number" ? job.progress : 0,
    ...(position === undefined ? {} : { position }),
    ...(result.success ? { fileSize: result.data.fileSize } : {}),
  };
}

export async function collectDownloadQueueTelemetry(
  queue: DownloadQueueCountReader,
): Promise<DownloadQueueTelemetry> {
  try {
    const [waiting, active] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
    ]);
    return {
      depth: waiting + active,
      status: "healthy",
      redisStatus: "healthy",
    };
  } catch {
    return { status: "unknown", redisStatus: "unknown" };
  }
}

export function createDownloadQueueAdapter(options: DownloadQueueAdapterOptions = {}) {
  const environment = options.environment ?? process.env;
  const readQueueUrl = options.readFile ?? readFile;
  const createQueue =
    options.createQueue ??
    ((name, queueOptions) =>
      new Queue<DownloadJobData, DownloadJobResult>(name, queueOptions));
  const createRedis = options.createRedis ?? ((redisOptions) => new Redis(redisOptions));
  let clients: DownloadQueueClients | undefined;

  const requireClients = (): DownloadQueueClients => {
    if (clients === undefined) throw unavailable();
    return clients;
  };

  return {
    async init(): Promise<void> {
      if (clients !== undefined) return;
      const configuration = await readQueueConfiguration(environment, readQueueUrl);
      const producer = createQueue(DOWNLOAD_QUEUE_NAME, {
        connection: configuration.producerConnection,
        defaultJobOptions: {
          attempts: 2,
          backoff: { type: "fixed", delay: 5_000 },
          removeOnComplete: { age: 86_400, count: 200 },
          removeOnFail: { age: 86_400, count: 200 },
        },
      });
      const telemetry = createQueue(DOWNLOAD_QUEUE_NAME, {
        connection: configuration.telemetryConnection,
      });
      const cancellation = createRedis(configuration.cancellationConnection);
      const candidate = { producer, telemetry, cancellation };
      try {
        await Promise.all([
          producer.waitUntilReady?.(),
          telemetry.waitUntilReady?.(),
          cancellation.connect?.(),
        ]);
        await cancellation.ping?.();
        clients = candidate;
      } catch {
        await Promise.allSettled([
          producer.close(),
          telemetry.close(),
          cancellation.quit(),
        ]);
        throw unavailable();
      }
    },

    async shutdown(): Promise<void> {
      const currentClients = clients;
      clients = undefined;
      if (currentClients === undefined) return;
      await Promise.allSettled([
        currentClients.producer.close(),
        currentClients.telemetry.close(),
        currentClients.cancellation.quit(),
      ]);
    },

    async enqueue(data: DownloadJobData): Promise<EnqueueResult> {
      const parsed = downloadJobDataSchema.safeParse(data);
      if (!parsed.success) throw new Error("invalid download job");
      try {
        const producer = requireClients().producer;
        const [waiting, active] = await Promise.all([
          producer.getWaitingCount(),
          producer.getActiveCount(),
        ]);
        if (waiting + active >= QUEUE_CAPACITY) {
          throw new DownloadQueueCapacityError();
        }
        const job = await producer.add("download", parsed.data);
        if (job.id === undefined) throw unavailable();
        return { jobId: job.id, position: waiting + 1 };
      } catch (error) {
        if (error instanceof DownloadQueueCapacityError) throw error;
        if (error instanceof DownloadQueueUnavailableError) throw error;
        throw unavailable();
      }
    },

    async telemetry(): Promise<DownloadQueueTelemetry> {
      if (clients === undefined) {
        return { status: "unknown", redisStatus: "unknown" };
      }
      return collectDownloadQueueTelemetry(clients.telemetry);
    },

    runtimeState(): { backend: "redis" | "unavailable"; workerEmbedded: false } {
      return {
        backend: clients === undefined ? "unavailable" : "redis",
        workerEmbedded: false,
      };
    },

    async status(jobId: string, accountId: string): Promise<JobStatus> {
      try {
        const producer = requireClients().producer;
        const job = await producer.getJob(jobId);
        if (job === undefined || !isOwnedJob(job.data, accountId)) {
          return { status: "unknown", progress: 0 };
        }
        const state = await job.getState();
        if (state !== "waiting") return toJobStatus(job, state);
        const waiting = await producer.getWaiting(0, QUEUE_CAPACITY - 1);
        const position = waiting.findIndex((candidate) => candidate.id === job.id);
        return toJobStatus(job, state, position < 0 ? undefined : position + 1);
      } catch (error) {
        if (error instanceof DownloadQueueUnavailableError) throw error;
        throw unavailable();
      }
    },

    async list(accountId: string): Promise<readonly (JobStatus & { jobId: string })[]> {
      try {
        const producer = requireClients().producer;
        const [waiting, active, completed, failed] = await Promise.all([
          producer.getWaiting(0, QUEUE_CAPACITY - 1),
          producer.getActive(0, QUEUE_CAPACITY - 1),
          producer.getCompleted(0, QUEUE_CAPACITY - 1),
          producer.getFailed(0, QUEUE_CAPACITY - 1),
        ]);
        const results: Array<JobStatus & { jobId: string }> = [];
        const seen = new Set<string>();
        for (const [jobs, state] of [
          [waiting, "waiting"],
          [active, "active"],
          [completed, "completed"],
          [failed, "failed"],
        ] as const) {
          for (const [index, job] of jobs.entries()) {
            if (job.id === undefined || seen.has(job.id) || !isOwnedJob(job.data, accountId)) {
              continue;
            }
            seen.add(job.id);
            results.push({
              jobId: job.id,
              ...toJobStatus(job, state, state === "waiting" ? index + 1 : undefined),
            });
          }
        }
        return results;
      } catch (error) {
        if (error instanceof DownloadQueueUnavailableError) throw error;
        throw unavailable();
      }
    },

    async cancel(jobId: string, accountId: string): Promise<{ status: JobStatus["status"] }> {
      try {
        const currentClients = requireClients();
        const job = await currentClients.producer.getJob(jobId);
        if (job === undefined || !isOwnedJob(job.data, accountId)) {
          return { status: "unknown" };
        }
        const state = mapJobState(await job.getState(), job.failedReason);
        if (state === "waiting") {
          await job.remove();
          return { status: "canceled" };
        }
        if (state === "active") {
          await currentClients.cancellation.set(
            `${DOWNLOAD_QUEUE_NAME}:cancel:${jobId}`,
            "1",
            "PX",
            CANCELLATION_TTL_MS,
          );
          return { status: "canceled" };
        }
        return { status: state };
      } catch (error) {
        if (error instanceof DownloadQueueUnavailableError) throw error;
        throw unavailable();
      }
    },
  };
}

let runtime = createDownloadQueueAdapter();

export async function initBackgroundQueues(): Promise<void> {
  await runtime.init();
}

export async function shutdownBackgroundQueues(): Promise<void> {
  await runtime.shutdown();
}

export async function enqueueDownload(data: DownloadJobData): Promise<EnqueueResult> {
  return runtime.enqueue(data);
}

export async function getDownloadQueueTelemetry(): Promise<DownloadQueueTelemetry> {
  return runtime.telemetry();
}

export function getDownloadQueueRuntimeState(): {
  backend: "redis" | "unavailable";
  workerEmbedded: false;
} {
  return runtime.runtimeState();
}

export const queueRuntimeState = getDownloadQueueRuntimeState;

export async function getDownloadQueueDepth(): Promise<number> {
  const telemetry = await getDownloadQueueTelemetry();
  if (telemetry.depth === undefined) throw unavailable();
  return telemetry.depth;
}

export async function getDownloadJobStatus(
  jobId: string,
  accountId: string,
): Promise<JobStatus> {
  return runtime.status(jobId, accountId);
}

export async function listSessionDownloadJobs(
  accountId: string,
): Promise<readonly (JobStatus & { jobId: string })[]> {
  return runtime.list(accountId);
}

export async function cancelDownloadJob(
  jobId: string,
  accountId: string,
): Promise<{ status: JobStatus["status"] }> {
  return runtime.cancel(jobId, accountId);
}
