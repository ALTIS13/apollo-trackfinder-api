import { Queue, Worker, type Job } from "bullmq";
import type { RedisOptions } from "ioredis";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "./logger.js";
import { purgeStaleCaches } from "./cache.js";
import { spawnAudioDownload, type AudioQuality } from "./ytdlp.js";

export const DOWNLOAD_DIR = process.env["DOWNLOAD_DIR"] ?? "/tmp/tf-downloads";

export const VALID_QUALITIES: AudioQuality[] = [
  "128",
  "192",
  "256",
  "320",
  "flac",
];

export interface DownloadJobData {
  trackId: string;
  artist: string;
  title: string;
  quality: AudioQuality;
  sourceUrl: string;
  sessionId: string;
}

export interface DownloadJobResult {
  filePath: string;
  fileSize: number;
}

// In-memory fallback job store (used when Redis is unavailable)
interface InMemoryJob {
  id: string;
  data: DownloadJobData;
  status: "waiting" | "active" | "completed" | "failed";
  progress: number;
  result?: DownloadJobResult;
  error?: string;
  createdAt: number;
}

const inMemoryJobs = new Map<string, InMemoryJob>();
let inMemoryWorkerRunning = false;
let inMemoryQueue: InMemoryJob[] = [];

let cleanupQueue: Queue | null = null;
let cleanupWorker: Worker | null = null;
let downloadQueue: Queue<DownloadJobData, DownloadJobResult> | null = null;
let downloadTelemetryQueue: Queue<DownloadJobData, DownloadJobResult> | null =
  null;
let downloadWorker: Worker<DownloadJobData, DownloadJobResult> | null = null;
let redisAvailable = false;
let workerErrorCount = 0;
let telemetryFailureCount = 0;

function parseRedisConnection(): RedisOptions | null {
  const url = process.env["REDIS_URL"];
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname || "localhost",
      port: parseInt(parsed.port || "6379", 10),
      password: parsed.password || undefined,
      connectTimeout: 3000,
    };
  } catch {
    return null;
  }
}

async function runDownloadJob(
  job: DownloadJobData,
  updateProgress: (n: number) => void,
): Promise<DownloadJobResult> {
  await fs.mkdir(DOWNLOAD_DIR, { recursive: true });

  const ext = job.quality === "flac" ? "flac" : "mp3";
  const filename = `${job.trackId.replace(/[^a-z0-9_-]/gi, "_").slice(0, 32)}.${ext}`;
  const filePath = path.join(DOWNLOAD_DIR, filename);

  updateProgress(5);

  const proc = spawnAudioDownload(job.sourceUrl, job.quality);
  const writeStream = (await import("node:fs")).createWriteStream(filePath);

  await new Promise<void>((resolve, reject) => {
    proc.stdout!.pipe(writeStream);
    proc.stderr!.on("data", () => {});
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`yt-dlp exited with code ${code}`));
      } else {
        resolve();
      }
    });
    proc.on("error", reject);
  });

  const stats = await fs.stat(filePath);
  if (stats.size < 1024) {
    await fs.unlink(filePath).catch(() => {});
    throw new Error("Download produced empty or corrupt file");
  }

  updateProgress(100);
  return { filePath, fileSize: stats.size };
}

async function processInMemoryQueue() {
  if (inMemoryWorkerRunning) return;
  inMemoryWorkerRunning = true;

  while (inMemoryQueue.length > 0) {
    const job = inMemoryQueue.shift()!;
    job.status = "active";
    try {
      const result = await runDownloadJob(job.data, (p) => {
        job.progress = p;
      });
      job.status = "completed";
      job.progress = 100;
      job.result = result;
    } catch (err) {
      job.status = "failed";
      job.error = (err as Error).message;
    }
  }

  inMemoryWorkerRunning = false;
}

export async function initBackgroundQueues(): Promise<void> {
  await fs.mkdir(DOWNLOAD_DIR, { recursive: true }).catch(() => {});

  const connection = parseRedisConnection();
  if (!connection) {
    logger.info(
      "REDIS_URL not set — BullMQ queues disabled; using in-memory download fallback",
    );
    return;
  }

  const workerConnection: RedisOptions = {
    ...connection,
    maxRetriesPerRequest: null,
  };
  const producerConnection: RedisOptions = {
    ...connection,
    commandTimeout: 5000,
    maxRetriesPerRequest: 1,
  };
  const telemetryConnection: RedisOptions = {
    ...connection,
    commandTimeout: 1000,
    maxRetriesPerRequest: 1,
  };
  workerErrorCount = 0;
  telemetryFailureCount = 0;

  try {
    // Cache cleanup queue
    cleanupQueue = new Queue("cache-cleanup", {
      connection: producerConnection,
    });
    cleanupWorker = new Worker(
      "cache-cleanup",
      async (job) => {
        if (job.name === "purge-stale") {
          await purgeStaleCaches();
          logger.info("BullMQ: purged stale cache entries");
        }
      },
      { connection: workerConnection },
    );
    cleanupWorker.on("error", (error) => {
      workerErrorCount += 1;
      logger.warn({ err: error.message }, "BullMQ cache-cleanup worker error");
    });
    cleanupWorker.on("failed", (job, err) => {
      logger.warn(
        { jobId: job?.id, err: (err as Error).message },
        "BullMQ cache-cleanup job failed",
      );
    });
    const repeatables = await cleanupQueue.getRepeatableJobs();
    if (!repeatables.some((r) => r.name === "purge-stale")) {
      await cleanupQueue.add(
        "purge-stale",
        {},
        {
          repeat: { every: 60 * 60 * 1000 },
          removeOnComplete: 5,
          removeOnFail: 3,
        },
      );
      logger.info("BullMQ: scheduled hourly cache cleanup");
    }

    // Download queue
    downloadQueue = new Queue<DownloadJobData, DownloadJobResult>(
      "track-downloads",
      {
        connection: producerConnection,
        defaultJobOptions: {
          attempts: 2,
          backoff: { type: "fixed", delay: 5000 },
          removeOnComplete: 20,
          removeOnFail: 10,
        },
      },
    );
    downloadTelemetryQueue = new Queue<DownloadJobData, DownloadJobResult>(
      "track-downloads",
      { connection: telemetryConnection },
    );
    downloadWorker = new Worker<DownloadJobData, DownloadJobResult>(
      "track-downloads",
      async (job: Job<DownloadJobData, DownloadJobResult>) => {
        return runDownloadJob(job.data, (p) => job.updateProgress(p));
      },
      { connection: workerConnection, concurrency: 2 },
    );
    downloadWorker.on("error", (error) => {
      workerErrorCount += 1;
      logger.warn({ err: error.message }, "BullMQ download worker error");
    });
    downloadWorker.on("failed", (job, err) => {
      logger.warn(
        { jobId: job?.id, err: (err as Error).message },
        "BullMQ download job failed",
      );
    });
    downloadWorker.on("completed", (job) => {
      logger.info(
        { jobId: job.id, trackId: job.data.trackId },
        "BullMQ download completed",
      );
    });

    redisAvailable = true;
    logger.info("BullMQ background queues (cleanup + downloads) initialized");
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      "BullMQ init failed — using in-memory download fallback",
    );
    await Promise.allSettled([
      cleanupQueue?.close(),
      cleanupWorker?.close(),
      downloadQueue?.close(),
      downloadTelemetryQueue?.close(),
      downloadWorker?.close(),
    ]);
    cleanupQueue = null;
    cleanupWorker = null;
    downloadQueue = null;
    downloadTelemetryQueue = null;
    downloadWorker = null;
    redisAvailable = false;
  }
}

export async function shutdownBackgroundQueues(): Promise<void> {
  try {
    await downloadWorker?.close();
    await downloadTelemetryQueue?.close();
    await downloadQueue?.close();
    await cleanupWorker?.close();
    await cleanupQueue?.close();
  } catch {}
  redisAvailable = false;
}

export interface DownloadQueueTelemetry {
  depth?: number;
  status: "healthy" | "unknown";
  redisStatus: "healthy" | "unknown";
}

function getInMemoryQueueDepth(): number {
  let active = 0;
  for (const job of inMemoryJobs.values()) {
    if (job.status === "active") active += 1;
  }
  return inMemoryQueue.length + active;
}

export interface DownloadQueueCountReader {
  getWaitingCount: () => Promise<number>;
  getActiveCount: () => Promise<number>;
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

export async function getDownloadQueueTelemetry(): Promise<DownloadQueueTelemetry> {
  if (redisAvailable && downloadTelemetryQueue) {
    const telemetry = await collectDownloadQueueTelemetry(
      downloadTelemetryQueue,
    );
    if (telemetry.status === "unknown") telemetryFailureCount += 1;
    return telemetry;
  }

  return {
    depth: getInMemoryQueueDepth(),
    status: "healthy",
    redisStatus: "unknown",
  };
}

export function getDownloadQueueRuntimeState(): {
  backend: "redis" | "memory";
  workerErrorCount: number;
  telemetryFailureCount: number;
} {
  return {
    backend: redisAvailable ? "redis" : "memory",
    workerErrorCount,
    telemetryFailureCount,
  };
}

export async function getDownloadQueueDepth(): Promise<number> {
  const telemetry = await getDownloadQueueTelemetry();
  if (telemetry.depth === undefined) {
    throw new Error("Download queue depth is unavailable");
  }
  return telemetry.depth;
}

export interface EnqueueResult {
  jobId: string;
  position: number;
}

export async function enqueueDownload(
  data: DownloadJobData,
): Promise<EnqueueResult> {
  if (redisAvailable && downloadQueue) {
    const waiting = await downloadQueue.getWaitingCount();
    const job = await downloadQueue.add("download", data);
    return { jobId: job.id!, position: waiting + 1 };
  }

  // In-memory fallback
  const jobId = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const job: InMemoryJob = {
    id: jobId,
    data,
    status: "waiting",
    progress: 0,
    createdAt: Date.now(),
  };
  inMemoryJobs.set(jobId, job);
  inMemoryQueue.push(job);
  const position = inMemoryQueue.length;
  processInMemoryQueue().catch(() => {});
  return { jobId, position };
}

export interface JobStatus {
  status: "waiting" | "active" | "completed" | "failed" | "unknown";
  progress: number;
  position?: number;
  fileSize?: number;
  error?: string;
  sessionId?: string;
}

/** Internal method for file serving — returns filePath only for same session */
export async function getDownloadFilePath(
  jobId: string,
  requesterSessionId: string,
): Promise<string | null> {
  if (redisAvailable && downloadQueue) {
    try {
      const job = await downloadQueue.getJob(jobId);
      if (!job) return null;
      if (job.data.sessionId && job.data.sessionId !== requesterSessionId)
        return null;
      const state = await job.getState();
      if (state !== "completed") return null;
      const result = job.returnvalue as DownloadJobResult | null;
      return result?.filePath ?? null;
    } catch {
      return null;
    }
  }

  const job = inMemoryJobs.get(jobId);
  if (!job) return null;
  if (job.data.sessionId && job.data.sessionId !== requesterSessionId)
    return null;
  if (job.status !== "completed") return null;
  return job.result?.filePath ?? null;
}

export async function getDownloadJobStatus(
  jobId: string,
  requesterSessionId: string,
): Promise<JobStatus> {
  if (redisAvailable && downloadQueue) {
    try {
      const job = await downloadQueue.getJob(jobId);
      if (!job) return { status: "unknown", progress: 0 };
      // Ownership check
      if (job.data.sessionId && job.data.sessionId !== requesterSessionId) {
        return { status: "unknown", progress: 0 };
      }
      const state = await job.getState();
      const progress = typeof job.progress === "number" ? job.progress : 0;
      const result = job.returnvalue as DownloadJobResult | null;

      // Compute job-specific position by scanning waiting list
      let position: number | undefined;
      if (state === "waiting") {
        try {
          const waiting = await downloadQueue!.getWaiting(0, 200);
          const idx = waiting.findIndex((j) => j.id === jobId);
          position = idx >= 0 ? idx + 1 : 1;
        } catch {
          position = 1;
        }
      }

      return {
        status:
          state === "active"
            ? "active"
            : state === "completed"
              ? "completed"
              : state === "failed"
                ? "failed"
                : "waiting",
        progress,
        position,
        fileSize: result?.fileSize,
        error: job.failedReason,
      };
    } catch {
      return { status: "unknown", progress: 0 };
    }
  }

  const job = inMemoryJobs.get(jobId);
  if (!job) return { status: "unknown", progress: 0 };
  // Ownership check
  if (job.data.sessionId && job.data.sessionId !== requesterSessionId) {
    return { status: "unknown", progress: 0 };
  }
  // Specific position within waiting queue
  const queuePos = inMemoryQueue.findIndex((j) => j.id === jobId);
  return {
    status: job.status,
    progress: job.progress,
    position: queuePos >= 0 ? queuePos + 1 : undefined,
    fileSize: job.result?.fileSize,
    error: job.error,
  };
}

/** List all download jobs for a given session (for client rehydration after restart) */
export async function listSessionDownloadJobs(sessionId: string): Promise<
  {
    jobId: string;
    status: string;
    progress: number;
    position?: number;
    fileSize?: number;
  }[]
> {
  const results: {
    jobId: string;
    status: string;
    progress: number;
    position?: number;
    fileSize?: number;
  }[] = [];

  if (redisAvailable && downloadQueue) {
    try {
      const [waiting, active, completed, failed] = await Promise.all([
        downloadQueue.getWaiting(0, 200),
        downloadQueue.getActive(),
        downloadQueue.getCompleted(0, 50),
        downloadQueue.getFailed(0, 50),
      ]);
      for (const [jobs, st] of [
        [waiting, "waiting"],
        [active, "active"],
        [completed, "completed"],
        [failed, "failed"],
      ] as const) {
        for (const j of jobs as import("bullmq").Job[]) {
          if (j.data.sessionId !== sessionId) continue;
          const result = j.returnvalue as DownloadJobResult | null;
          const pos =
            st === "waiting"
              ? waiting.findIndex((wj) => wj.id === j.id) + 1
              : undefined;
          results.push({
            jobId: j.id!,
            status: st,
            progress: typeof j.progress === "number" ? j.progress : 0,
            position: pos || undefined,
            fileSize: result?.fileSize,
          });
        }
      }
    } catch {
      // ignore
    }
    return results;
  }

  // In-memory fallback
  for (const [jobId, job] of inMemoryJobs) {
    if (job.data.sessionId !== sessionId) continue;
    const queuePos = inMemoryQueue.findIndex((j) => j.id === jobId);
    results.push({
      jobId,
      status: job.status,
      progress: job.progress,
      position: queuePos >= 0 ? queuePos + 1 : undefined,
      fileSize: job.result?.fileSize,
    });
  }
  return results;
}
