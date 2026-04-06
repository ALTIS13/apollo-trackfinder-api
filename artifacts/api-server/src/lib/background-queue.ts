import { Queue, Worker, type ConnectionOptions, type Job } from "bullmq";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "./logger.js";
import { purgeStaleCaches } from "./cache.js";
import { spawnAudioDownload, type AudioQuality } from "./ytdlp.js";

export const DOWNLOAD_DIR = process.env["DOWNLOAD_DIR"] ?? "/tmp/tf-downloads";

export interface DownloadJobData {
  trackId: string;
  artist: string;
  title: string;
  quality: AudioQuality;
  sourceUrl: string;
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
let downloadWorker: Worker<DownloadJobData, DownloadJobResult> | null = null;
let redisAvailable = false;

function parseRedisConnection(): ConnectionOptions | null {
  const url = process.env["REDIS_URL"];
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname || "localhost",
      port: parseInt(parsed.port || "6379", 10),
      password: parsed.password || undefined,
    };
  } catch {
    return null;
  }
}

async function runDownloadJob(job: DownloadJobData, updateProgress: (n: number) => void): Promise<DownloadJobResult> {
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
    logger.info("REDIS_URL not set — BullMQ queues disabled; using in-memory download fallback");
    return;
  }

  try {
    // Cache cleanup queue
    cleanupQueue = new Queue("cache-cleanup", { connection });
    cleanupWorker = new Worker(
      "cache-cleanup",
      async (job) => {
        if (job.name === "purge-stale") {
          await purgeStaleCaches();
          logger.info("BullMQ: purged stale cache entries");
        }
      },
      { connection },
    );
    cleanupWorker.on("failed", (job, err) => {
      logger.warn({ jobId: job?.id, err: (err as Error).message }, "BullMQ cache-cleanup job failed");
    });
    const repeatables = await cleanupQueue.getRepeatableJobs();
    if (!repeatables.some((r) => r.name === "purge-stale")) {
      await cleanupQueue.add("purge-stale", {}, {
        repeat: { every: 60 * 60 * 1000 },
        removeOnComplete: 5,
        removeOnFail: 3,
      });
      logger.info("BullMQ: scheduled hourly cache cleanup");
    }

    // Download queue
    downloadQueue = new Queue<DownloadJobData, DownloadJobResult>("track-downloads", {
      connection,
      defaultJobOptions: { attempts: 2, backoff: { type: "fixed", delay: 5000 }, removeOnComplete: 20, removeOnFail: 10 },
    });
    downloadWorker = new Worker<DownloadJobData, DownloadJobResult>(
      "track-downloads",
      async (job: Job<DownloadJobData, DownloadJobResult>) => {
        return runDownloadJob(job.data, (p) => job.updateProgress(p));
      },
      { connection, concurrency: 2 },
    );
    downloadWorker.on("failed", (job, err) => {
      logger.warn({ jobId: job?.id, err: (err as Error).message }, "BullMQ download job failed");
    });
    downloadWorker.on("completed", (job) => {
      logger.info({ jobId: job.id, trackId: job.data.trackId }, "BullMQ download completed");
    });

    redisAvailable = true;
    logger.info("BullMQ background queues (cleanup + downloads) initialized");
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "BullMQ init failed — using in-memory download fallback");
    cleanupQueue = null;
    cleanupWorker = null;
    downloadQueue = null;
    downloadWorker = null;
    redisAvailable = false;
  }
}

export async function shutdownBackgroundQueues(): Promise<void> {
  try {
    await downloadWorker?.close();
    await downloadQueue?.close();
    await cleanupWorker?.close();
    await cleanupQueue?.close();
  } catch {
  }
}

export interface EnqueueResult {
  jobId: string;
  position: number;
}

export async function enqueueDownload(data: DownloadJobData): Promise<EnqueueResult> {
  if (redisAvailable && downloadQueue) {
    const job = await downloadQueue.add("download", data);
    const waiting = await downloadQueue.getWaitingCount();
    return { jobId: job.id!, position: waiting };
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
  filePath?: string;
  fileSize?: number;
  error?: string;
}

export async function getDownloadJobStatus(jobId: string): Promise<JobStatus> {
  if (redisAvailable && downloadQueue) {
    try {
      const job = await downloadQueue.getJob(jobId);
      if (!job) return { status: "unknown", progress: 0 };
      const state = await job.getState();
      const progress = typeof job.progress === "number" ? job.progress : 0;
      const result = job.returnvalue as DownloadJobResult | null;
      const position = state === "waiting" ? await downloadQueue!.getWaitingCount() : undefined;
      return {
        status: state === "active" ? "active" : state === "completed" ? "completed" : state === "failed" ? "failed" : "waiting",
        progress,
        position,
        filePath: result?.filePath,
        fileSize: result?.fileSize,
        error: job.failedReason,
      };
    } catch {
      return { status: "unknown", progress: 0 };
    }
  }

  const job = inMemoryJobs.get(jobId);
  if (!job) return { status: "unknown", progress: 0 };
  const queuePos = inMemoryQueue.findIndex((j) => j.id === jobId);
  return {
    status: job.status,
    progress: job.progress,
    position: queuePos >= 0 ? queuePos + 1 : undefined,
    filePath: job.result?.filePath,
    fileSize: job.result?.fileSize,
    error: job.error,
  };
}
