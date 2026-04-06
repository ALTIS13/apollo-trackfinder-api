import { Queue, Worker, type ConnectionOptions } from "bullmq";
import { logger } from "./logger.js";
import { purgeStaleCaches } from "./cache.js";

let cleanupQueue: Queue | null = null;
let cleanupWorker: Worker | null = null;

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

export async function initBackgroundQueues(): Promise<void> {
  const connection = parseRedisConnection();
  if (!connection) {
    logger.info("REDIS_URL not set — BullMQ background queues disabled");
    return;
  }

  try {
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

    // Schedule recurring cleanup every hour (if no repeatable job exists yet)
    const repeatables = await cleanupQueue.getRepeatableJobs();
    const alreadyScheduled = repeatables.some((r) => r.name === "purge-stale");
    if (!alreadyScheduled) {
      await cleanupQueue.add(
        "purge-stale",
        {},
        { repeat: { every: 60 * 60 * 1000 }, removeOnComplete: 5, removeOnFail: 3 },
      );
      logger.info("BullMQ: scheduled hourly cache cleanup");
    }

    logger.info("BullMQ background queues initialized");
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "BullMQ init failed — background queues disabled");
    cleanupQueue = null;
    cleanupWorker = null;
  }
}

export async function shutdownBackgroundQueues(): Promise<void> {
  try {
    await cleanupWorker?.close();
    await cleanupQueue?.close();
  } catch {
  }
}

export function getCleanupQueue(): Queue | null {
  return cleanupQueue;
}
