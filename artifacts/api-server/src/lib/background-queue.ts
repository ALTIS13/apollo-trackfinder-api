import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  DOWNLOAD_QUEUE_NAME,
  DOWNLOAD_QUEUE_RESERVATION_KEY,
  DOWNLOAD_QUEUE_RESERVATION_TTL_MS,
  downloadJobDataSchema,
  downloadJobResultSchema,
  type DownloadJobData,
  type DownloadJobResult,
} from "@workspace/tf-download-contract";
import { Queue } from "bullmq";
import Redis, { type RedisOptions } from "ioredis";

const QUEUE_CAPACITY = 200;
const CANCELLATION_TTL_MS = 1_800_000;
const RESERVE_SCRIPT =
  "redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1]); if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end; redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4]); return 1";

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

interface Job {
  readonly id?: string;
  readonly data: unknown;
  readonly progress: unknown;
  readonly returnvalue: unknown;
  readonly failedReason?: string;
  getState(): Promise<string>;
  remove(): Promise<void>;
}
interface QueueClient {
  on?(event: "error", listener: () => void): unknown;
  waitUntilReady?(): Promise<unknown>;
  close(): Promise<unknown>;
  getWaitingCount(): Promise<number>;
  getActiveCount(): Promise<number>;
  add(
    name: string,
    data: DownloadJobData,
    options: { jobId: string },
  ): Promise<{ id?: string }>;
  getJob(id: string): Promise<Job | undefined>;
  getWaiting(start?: number, end?: number): Promise<Job[]>;
  getDelayed(start?: number, end?: number): Promise<Job[]>;
  getActive(start?: number, end?: number): Promise<Job[]>;
  getCompleted(start?: number, end?: number): Promise<Job[]>;
  getFailed(start?: number, end?: number): Promise<Job[]>;
}
interface RedisClient {
  on?(event: "error", listener: () => void): unknown;
  connect?(): Promise<unknown>;
  ping?(): Promise<unknown>;
  eval(script: string, keys: number, ...args: string[]): Promise<unknown>;
  zrem(key: string, member: string): Promise<unknown>;
  set(key: string, value: string, mode: "PX", ttl: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  quit(): Promise<unknown>;
}
interface Clients {
  producer: QueueClient;
  telemetry: QueueClient;
  cancellation: RedisClient;
}
interface AdapterOptions {
  environment?: NodeJS.ProcessEnv;
  readFile?: (path: string) => Promise<Buffer>;
  createQueue?: (
    name: string,
    options: ConstructorParameters<typeof Queue>[1],
  ) => QueueClient;
  createRedis?: (options: RedisOptions) => RedisClient;
}

function unavailable(): DownloadQueueUnavailableError {
  return new DownloadQueueUnavailableError();
}
class RuntimeConfigurationError extends Error {
  constructor() {
    super("invalid runtime configuration");
  }
}
function invalid(): RuntimeConfigurationError {
  return new RuntimeConfigurationError();
}
function closeAll(
  clients: Partial<Clients>,
): Promise<PromiseSettledResult<unknown>[]> {
  return Promise.allSettled([
    clients.producer?.close(),
    clients.telemetry?.close(),
    clients.cancellation?.quit(),
  ]);
}
function attachErrorListener(client: {
  on?(event: "error", listener: () => void): unknown;
}): void {
  client.on?.("error", () => {});
}

function parseQueueUrl(value: string): RedisOptions {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid();
  }
  const local =
    url.protocol === "redis:" &&
    url.hostname === "tf-download-redis" &&
    url.port === "6379" &&
    url.pathname === "/0" &&
    url.search === "" &&
    url.hash === "";
  if (url.protocol !== "rediss:" && !local) throw invalid();
  if (url.search || url.hash || !/^\/(?:0|[1-9]|1[0-5])$/.test(url.pathname))
    throw invalid();
  const port = Number(url.port || "6379");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw invalid();
  let username: string | undefined;
  let password: string | undefined;
  try {
    username = url.username ? decodeURIComponent(url.username) : undefined;
    password = url.password ? decodeURIComponent(url.password) : undefined;
  } catch {
    throw invalid();
  }
  return {
    host: url.hostname,
    port,
    db: Number(url.pathname.slice(1)),
    username,
    password,
    ...(url.protocol === "rediss:" ? { tls: {} } : {}),
  };
}
async function configuration(
  env: NodeJS.ProcessEnv,
  read: (path: string) => Promise<Buffer>,
): Promise<{
  producer: RedisOptions;
  telemetry: RedisOptions;
  cancellation: RedisOptions;
}> {
  const path = env.TF_DOWNLOAD_QUEUE_REDIS_URL_FILE;
  if (!path) throw invalid();
  let bytes: Buffer;
  try {
    bytes = await read(path);
  } catch {
    throw invalid();
  }
  if (bytes.length < 1 || bytes.length > 2048) throw invalid();
  const raw = bytes.toString("utf8").trim();
  const parsed = parseQueueUrl(raw);
  if (
    raw.startsWith("redis:") &&
    env.TF_DOWNLOAD_QUEUE_ALLOW_INSECURE_REDIS !== "true"
  )
    throw invalid();
  const common: RedisOptions = {
    ...parsed,
    connectTimeout: 3000,
    commandTimeout: 1000,
    enableOfflineQueue: false,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  };
  return {
    producer: { ...common, commandTimeout: 5000 },
    telemetry: common,
    cancellation: common,
  };
}
function owned(data: unknown, accountId: string): data is DownloadJobData {
  const parsed = downloadJobDataSchema.safeParse(data);
  return parsed.success && parsed.data.accountId === accountId;
}
function mapState(state: string, failedReason?: string): JobStatus["status"] {
  if (state === "failed" && failedReason === "download_canceled")
    return "canceled";
  if (
    [
      "waiting",
      "delayed",
      "paused",
      "prioritized",
      "waiting-children",
    ].includes(state)
  )
    return "waiting";
  if (["active", "completed", "failed"].includes(state))
    return state as JobStatus["status"];
  return "unknown";
}
function statusOf(job: Job, raw: string, position?: number): JobStatus {
  const result = downloadJobResultSchema.safeParse(job.returnvalue);
  return {
    status: mapState(raw, job.failedReason),
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

export function createDownloadQueueAdapter(options: AdapterOptions = {}) {
  const env = options.environment ?? process.env;
  const read = options.readFile ?? readFile;
  const makeQueue =
    options.createQueue ??
    ((name, queueOptions) =>
      new Queue<DownloadJobData, DownloadJobResult>(name, queueOptions));
  const makeRedis =
    options.createRedis ??
    ((redisOptions) => new Redis(redisOptions) as unknown as RedisClient);
  let clients: Clients | undefined;
  let initializing: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  const requireClients = (): Clients => {
    if (!clients) throw unavailable();
    return clients;
  };
  const release = async (client: RedisClient, jobId: string): Promise<void> => {
    await client.zrem(DOWNLOAD_QUEUE_RESERVATION_KEY, jobId);
  };
  const cancelState = async (
    current: Clients,
    job: Job,
    jobId: string,
    raw: string,
  ): Promise<{ status: JobStatus["status"] }> => {
    const state = mapState(raw, job.failedReason);
    if (state === "waiting") {
      try {
        await job.remove();
        await release(current.cancellation, jobId);
        return { status: "canceled" };
      } catch {
        const reread = await job.getState();
        if (mapState(reread, job.failedReason) === "waiting")
          throw unavailable();
        return cancelState(current, job, jobId, reread);
      }
    }
    if (state === "active") {
      await current.cancellation.set(
        `${DOWNLOAD_QUEUE_NAME}:cancel:${jobId}`,
        "1",
        "PX",
        CANCELLATION_TTL_MS,
      );
      const after = mapState(await job.getState(), job.failedReason);
      if (after !== "active") {
        await current.cancellation.del(
          `${DOWNLOAD_QUEUE_NAME}:cancel:${jobId}`,
        );
        return { status: after };
      }
      return { status: "canceled" };
    }
    return { status: state };
  };
  return {
    async init(): Promise<void> {
      if (clients) return;
      if (stopping) await stopping;
      if (clients) return;
      if (initializing) return initializing;
      initializing = (async () => {
        const partial: Partial<Clients> = {};
        try {
          const config = await configuration(env, read);
          partial.producer = makeQueue(DOWNLOAD_QUEUE_NAME, {
            connection: config.producer,
            defaultJobOptions: {
              attempts: 2,
              backoff: { type: "fixed", delay: 5000 },
              removeOnComplete: { age: 86400, count: 200 },
              removeOnFail: { age: 86400, count: 200 },
            },
          });
          attachErrorListener(partial.producer);
          partial.telemetry = makeQueue(DOWNLOAD_QUEUE_NAME, {
            connection: config.telemetry,
          });
          attachErrorListener(partial.telemetry);
          const cancellation = makeRedis(config.cancellation);
          partial.cancellation = cancellation;
          attachErrorListener(cancellation);
          await Promise.all([
            partial.producer.waitUntilReady?.(),
            partial.telemetry.waitUntilReady?.(),
            cancellation.connect?.(),
          ]);
          await cancellation.ping?.();
          clients = partial as Clients;
        } catch (error) {
          await closeAll(partial);
          if (error instanceof RuntimeConfigurationError) throw error;
          throw unavailable();
        }
      })();
      try {
        await initializing;
      } finally {
        initializing = undefined;
      }
    },
    async shutdown(): Promise<void> {
      if (stopping) return stopping;
      stopping = (async () => {
        await initializing?.catch(() => {});
        const current = clients;
        clients = undefined;
        if (current) await closeAll(current);
      })();
      try {
        await stopping;
      } finally {
        stopping = undefined;
      }
    },
    async enqueue(data: DownloadJobData): Promise<EnqueueResult> {
      const parsed = downloadJobDataSchema.safeParse(data);
      if (!parsed.success) throw new Error("invalid download job");
      try {
        const current = requireClients();
        const jobId = randomUUID();
        const now = Date.now();
        const admitted = Number(
          await current.cancellation.eval(
            RESERVE_SCRIPT,
            1,
            DOWNLOAD_QUEUE_RESERVATION_KEY,
            String(now),
            String(now + DOWNLOAD_QUEUE_RESERVATION_TTL_MS),
            String(QUEUE_CAPACITY),
            jobId,
          ),
        );
        if (admitted !== 1) throw new DownloadQueueCapacityError();
        try {
          const job = await current.producer.add("download", parsed.data, {
            jobId,
          });
          if (!job.id) throw unavailable();
          return { jobId, position: 0 };
        } catch (error) {
          await release(current.cancellation, jobId).catch(() => {});
          throw error;
        }
      } catch (error) {
        if (
          error instanceof DownloadQueueCapacityError ||
          error instanceof DownloadQueueUnavailableError
        )
          throw error;
        throw unavailable();
      }
    },
    async telemetry(): Promise<DownloadQueueTelemetry> {
      return clients
        ? collectDownloadQueueTelemetry(clients.telemetry)
        : { status: "unknown", redisStatus: "unknown" };
    },
    runtimeState(): {
      backend: "redis" | "unavailable";
      workerEmbedded: false;
    } {
      return {
        backend: clients ? "redis" : "unavailable",
        workerEmbedded: false,
      };
    },
    async status(jobId: string, accountId: string): Promise<JobStatus> {
      try {
        const producer = requireClients().producer;
        const job = await producer.getJob(jobId);
        if (!job || !owned(job.data, accountId))
          return { status: "unknown", progress: 0 };
        const raw = await job.getState();
        if (mapState(raw, job.failedReason) !== "waiting")
          return statusOf(job, raw);
        const waiting = [
          ...(await producer.getWaiting(0, 199)),
          ...(await producer.getDelayed(0, 199)),
        ];
        const index = waiting.findIndex((candidate) => candidate.id === jobId);
        return statusOf(job, raw, index < 0 ? undefined : index + 1);
      } catch (error) {
        if (error instanceof DownloadQueueUnavailableError) throw error;
        throw unavailable();
      }
    },
    async list(
      accountId: string,
    ): Promise<readonly (JobStatus & { jobId: string })[]> {
      try {
        const producer = requireClients().producer;
        const collections = await Promise.all([
          producer.getWaiting(0, 199),
          producer.getDelayed(0, 199),
          producer.getActive(0, 199),
          producer.getCompleted(0, 199),
          producer.getFailed(0, 199),
        ]);
        const labels = [
          "waiting",
          "delayed",
          "active",
          "completed",
          "failed",
        ] as const;
        const seen = new Set<string>();
        const result: Array<JobStatus & { jobId: string }> = [];
        collections.forEach((jobs, collection) =>
          jobs.forEach((job, index) => {
            if (job.id && !seen.has(job.id) && owned(job.data, accountId)) {
              seen.add(job.id);
              result.push({
                jobId: job.id,
                ...statusOf(
                  job,
                  labels[collection]!,
                  collection < 2 ? index + 1 : undefined,
                ),
              });
            }
          }),
        );
        return result;
      } catch (error) {
        if (error instanceof DownloadQueueUnavailableError) throw error;
        throw unavailable();
      }
    },
    async cancel(
      jobId: string,
      accountId: string,
    ): Promise<{ status: JobStatus["status"] }> {
      try {
        const current = requireClients();
        const job = await current.producer.getJob(jobId);
        if (!job || !owned(job.data, accountId)) return { status: "unknown" };
        return cancelState(current, job, jobId, await job.getState());
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
export async function enqueueDownload(
  data: DownloadJobData,
): Promise<EnqueueResult> {
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
