import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { TextDecoder } from "node:util";

import {
  DOWNLOAD_JOB_CANCELLATION_FIELD,
  DOWNLOAD_JOB_CANCELLATION_SENTINEL,
  DOWNLOAD_QUEUE_NAME,
  DOWNLOAD_QUEUE_PREFIX,
  downloadJobDataSchema,
  downloadJobResultSchema,
  encodeDownloadAdmissionIntent,
  getDownloadQueueAdmissionLedgerKey,
  getDownloadQueueJobHashKey,
  parseDownloadQueueRedisConnection,
  type DownloadJobData,
  type DownloadJobResult,
} from "@workspace/tf-download-contract";
import { Queue } from "bullmq";
import Redis, { type RedisOptions } from "ioredis";

const QUEUE_CAPACITY = 200;
const MAX_QUEUE_FILE_BYTES = 2_048;
const JOB_RETENTION_SECONDS = 86_400;
const PRODUCER_COMMAND_TIMEOUT_MS = 5_000;
const RESERVE_ADMISSION_INTENT_SCRIPT = `
local rcall = redis.call
local function listCount(key)
  local marker = rcall("LINDEX", key, -1)
  if marker and string.sub(marker, 1, 2) == "0:" then
    local count = rcall("LLEN", key)
    if count > 1 then
      rcall("RPOP", key)
      return count - 1
    end
    return 0
  end
  return rcall("LLEN", key)
end
local ledger = KEYS[7]
local entries = rcall("HGETALL", ledger)
for index = 1, #entries, 2 do
  local jobId = entries[index]
  local intent = entries[index + 1]
  if string.sub(intent, 1, 10) == "confirmed:" or
    rcall("EXISTS", ARGV[4] .. jobId) == 1 then
    rcall("HDEL", ledger, jobId)
  end
end
local total = listCount(KEYS[1]) + rcall("LLEN", KEYS[2]) + rcall("ZCARD", KEYS[3]) + rcall("ZCARD", KEYS[4]) + rcall("ZCARD", KEYS[5]) + listCount(KEYS[6]) + rcall("HLEN", ledger)
if total >= tonumber(ARGV[3]) then return 0 end
rcall("HSET", ledger, ARGV[1], ARGV[2])
return total + 1
`;
const RELEASE_ADMISSION_INTENT_SCRIPT = `
local stored = redis.call("HGET", KEYS[1], ARGV[1])
if not stored then return 1 end
if stored ~= ARGV[2] then return 0 end
return redis.call("HDEL", KEYS[1], ARGV[1])
`;
const REQUEST_DOWNLOAD_CANCELLATION_SCRIPT = `
-- worker-mediated-download-cancellation
local rcall = redis.call
local jobId = ARGV[1]
local rawData = rcall("HGET", KEYS[9], "data")
if not rawData then return "unknown" end
local decoded, data = pcall(cjson.decode, rawData)
if not decoded or type(data) ~= "table" or
  type(data.accountId) ~= "string" or data.accountId ~= ARGV[2] then
  return "unknown"
end

local state = "unknown"
if rcall("ZSCORE", KEYS[1], jobId) then
  state = "completed"
elseif rcall("ZSCORE", KEYS[2], jobId) then
  if rcall("HGET", KEYS[9], "failedReason") == "download_canceled" then
    state = "canceled"
  else
    state = "failed"
  end
elseif rcall("ZSCORE", KEYS[3], jobId) then
  state = "waiting"
elseif rcall("ZSCORE", KEYS[4], jobId) then
  state = "waiting"
else
  local function listContains(key)
    local items = rcall("LRANGE", key, 0, -1)
    for _, item in ipairs(items) do
      if item == jobId then return true end
    end
    return false
  end
  if listContains(KEYS[5]) then
    state = "active"
  elseif listContains(KEYS[6]) then
    state = "waiting"
  elseif listContains(KEYS[7]) then
    state = "waiting"
  elseif rcall("ZSCORE", KEYS[8], jobId) then
    state = "waiting"
  end
end

if state ~= "waiting" and state ~= "active" then return state end
local intent = rcall("HGET", KEYS[10], jobId)
if intent and intent ~= ARGV[5] then return "ledger_mismatch" end
rcall("HSET", KEYS[9], ARGV[3], ARGV[4])
if intent == ARGV[5] then rcall("HDEL", KEYS[10], jobId) end
return state
`;

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
}
interface QueueClient {
  on?(event: "error", listener: () => void): unknown;
  waitUntilReady?(): Promise<unknown>;
  close(): Promise<unknown>;
  getWaitingCount(): Promise<number>;
  getActiveCount(): Promise<number>;
  toKey(type: string): string;
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
  quit(): Promise<unknown>;
}
interface Clients {
  producer: QueueClient;
  telemetry: QueueClient;
  cancellation: RedisClient;
}
interface AdapterOptions {
  environment?: NodeJS.ProcessEnv;
  readFile?: (path: string, maximumBytes: number) => Promise<Buffer>;
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

async function readBoundedRegularFile(
  filePath: string,
  maximumBytes: number,
): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maximumBytes) throw invalid();

    const bytes = Buffer.alloc(maximumBytes + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(
        bytes,
        offset,
        bytes.byteLength - offset,
        null,
      );
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

async function configuration(
  env: NodeJS.ProcessEnv,
  read: (path: string, maximumBytes: number) => Promise<Buffer>,
): Promise<{
  producer: RedisOptions;
  telemetry: RedisOptions;
  cancellation: RedisOptions;
}> {
  const path = env.TF_DOWNLOAD_QUEUE_REDIS_URL_FILE;
  if (!path) throw invalid();
  let bytes: Buffer;
  try {
    bytes = await read(path, MAX_QUEUE_FILE_BYTES);
  } catch {
    throw invalid();
  }
  if (bytes.length < 1 || bytes.length > MAX_QUEUE_FILE_BYTES) throw invalid();
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  } catch {
    throw invalid();
  }
  const parsed = parseDownloadQueueRedisConnection(
    raw,
    env.TF_DOWNLOAD_QUEUE_ALLOW_INSECURE_REDIS === "true",
  );
  if (parsed === undefined) throw invalid();
  const common: RedisOptions = {
    host: parsed.host,
    port: parsed.port,
    db: parsed.db,
    username: parsed.username,
    password: parsed.password,
    ...(parsed.protocol === "rediss:" ? { tls: {} } : {}),
    connectTimeout: 3000,
    commandTimeout: 1000,
    enableOfflineQueue: false,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  };
  return {
    producer: { ...common, commandTimeout: PRODUCER_COMMAND_TIMEOUT_MS },
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
  const read = options.readFile ?? readBoundedRegularFile;
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
  const releaseAdmissionIntent = async (
    producer: QueueClient,
    cancellation: RedisClient,
    jobId: string,
    accountId: string,
  ): Promise<void> => {
    const released = Number(
      await cancellation.eval(
        RELEASE_ADMISSION_INTENT_SCRIPT,
        1,
        getDownloadQueueAdmissionLedgerKey((suffix) => producer.toKey(suffix)),
        jobId,
        encodeDownloadAdmissionIntent("pending", accountId),
      ),
    );
    if (released !== 1) throw unavailable();
  };
  const reserveAdmissionIntent = async (
    producer: QueueClient,
    cancellation: RedisClient,
    jobId: string,
    accountId: string,
  ): Promise<number> => {
    const position = Number(
      await cancellation.eval(
        RESERVE_ADMISSION_INTENT_SCRIPT,
        7,
        producer.toKey("wait"),
        producer.toKey("active"),
        producer.toKey("delayed"),
        producer.toKey("prioritized"),
        producer.toKey("waiting-children"),
        producer.toKey("paused"),
        getDownloadQueueAdmissionLedgerKey((suffix) => producer.toKey(suffix)),
        jobId,
        encodeDownloadAdmissionIntent("pending", accountId),
        String(QUEUE_CAPACITY),
        producer.toKey(""),
      ),
    );
    if (
      !Number.isSafeInteger(position) ||
      position < 0 ||
      position > QUEUE_CAPACITY
    )
      throw unavailable();
    return position;
  };
  const requestCancellation = async (
    producer: QueueClient,
    cancellation: RedisClient,
    jobId: string,
    accountId: string,
  ): Promise<{ status: JobStatus["status"] }> => {
    const status = await cancellation.eval(
      REQUEST_DOWNLOAD_CANCELLATION_SCRIPT,
      10,
      producer.toKey("completed"),
      producer.toKey("failed"),
      producer.toKey("delayed"),
      producer.toKey("prioritized"),
      producer.toKey("active"),
      producer.toKey("wait"),
      producer.toKey("paused"),
      producer.toKey("waiting-children"),
      getDownloadQueueJobHashKey((suffix) => producer.toKey(suffix), jobId),
      getDownloadQueueAdmissionLedgerKey((suffix) => producer.toKey(suffix)),
      jobId,
      accountId,
      DOWNLOAD_JOB_CANCELLATION_FIELD,
      DOWNLOAD_JOB_CANCELLATION_SENTINEL,
      encodeDownloadAdmissionIntent("pending", accountId),
    );
    if (
      status !== "waiting" &&
      status !== "active" &&
      status !== "completed" &&
      status !== "failed" &&
      status !== "canceled" &&
      status !== "unknown"
    ) {
      throw unavailable();
    }
    return { status };
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
            prefix: DOWNLOAD_QUEUE_PREFIX,
            connection: config.producer,
            defaultJobOptions: {
              attempts: 2,
              backoff: { type: "fixed", delay: 5000 },
              removeOnComplete: { age: JOB_RETENTION_SECONDS, count: 200 },
              removeOnFail: { age: JOB_RETENTION_SECONDS, count: 200 },
            },
          });
          attachErrorListener(partial.producer);
          partial.telemetry = makeQueue(DOWNLOAD_QUEUE_NAME, {
            prefix: DOWNLOAD_QUEUE_PREFIX,
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
        const position = await reserveAdmissionIntent(
          current.producer,
          current.cancellation,
          jobId,
          parsed.data.accountId,
        );
        if (position === 0) throw new DownloadQueueCapacityError();
        const reconcile = async (): Promise<EnqueueResult> => {
          let accepted: Job | undefined;
          try {
            accepted = await current.producer.getJob(jobId);
          } catch {
            throw unavailable();
          }
          if (accepted === undefined) {
            await releaseAdmissionIntent(
              current.producer,
              current.cancellation,
              jobId,
              parsed.data.accountId,
            );
            throw unavailable();
          }
          if (
            !owned(accepted.data, parsed.data.accountId) ||
            JSON.stringify(accepted.data) !== JSON.stringify(parsed.data)
          )
            throw unavailable();
          await releaseAdmissionIntent(
            current.producer,
            current.cancellation,
            jobId,
            parsed.data.accountId,
          );
          return { jobId, position };
        };
        try {
          const added = await current.producer.add("download", parsed.data, {
            jobId,
          });
          if (added.id !== jobId) return reconcile();
          await releaseAdmissionIntent(
            current.producer,
            current.cancellation,
            jobId,
            parsed.data.accountId,
          );
          return { jobId, position };
        } catch {
          return reconcile();
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
        return result.slice(0, QUEUE_CAPACITY);
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
        return await requestCancellation(
          current.producer,
          current.cancellation,
          jobId,
          accountId,
        );
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
