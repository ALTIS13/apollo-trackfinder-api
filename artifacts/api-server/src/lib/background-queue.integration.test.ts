import {
  DOWNLOAD_JOB_CANCELLATION_ARMED_SENTINEL,
  DOWNLOAD_JOB_CANCELLATION_FIELD,
  DOWNLOAD_JOB_CANCELLATION_SENTINEL,
  DOWNLOAD_QUEUE_NAME,
  DOWNLOAD_QUEUE_PREFIX,
  encodeDownloadAdmissionIntent,
  getDownloadQueueAdmissionLedgerKey,
  getDownloadQueueJobHashKey,
} from "@workspace/tf-download-contract";
import { Queue, UnrecoverableError, Worker } from "bullmq";
import Redis, { type RedisOptions } from "ioredis";
import { describe, expect, it } from "vitest";

import { createDownloadQueueAdapter } from "./background-queue.js";

const ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";
const WAIT_JOB_ID = "31000000-0000-4000-8000-000000000001";
const DELAYED_JOB_ID = "31000000-0000-4000-8000-000000000002";
const ACTIVE_JOB_ID = "31000000-0000-4000-8000-000000000003";
const FAILED_JOB_ID = "31000000-0000-4000-8000-000000000004";
const COMPLETION_WINDOW_JOB_ID = "31000000-0000-4000-8000-000000000005";
const INTEGRATION_REDIS_URL = process.env.TF_DOWNLOAD_REDIS_INTEGRATION_URL;
const integrationIt = INTEGRATION_REDIS_URL === undefined ? it.skip : it;

const jobData = {
  schemaVersion: 1,
  accountId: ACCOUNT_ID,
  trackId: "yt_integration",
  artist: "Integration Artist",
  title: "Integration Title",
  quality: "320",
  sourceUrl: "https://www.youtube.com/watch?v=integration",
  createdAt: "2026-07-26T00:00:00.000Z",
} as const;

function redisOptions(redisUrl: string): RedisOptions {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || "6379"),
    db: Number(url.pathname.slice(1) || "0"),
    username:
      url.username === "" ? undefined : decodeURIComponent(url.username),
    password:
      url.password === "" ? undefined : decodeURIComponent(url.password),
  };
}

function redisSlot(key: string): number {
  const tagged = /\{([^{}]+)\}/.exec(key)?.[1] ?? key;
  let crc = 0;
  for (const byte of Buffer.from(tagged)) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc =
        (crc & 0x8000) === 0
          ? (crc << 1) & 0xffff
          : ((crc << 1) ^ 0x1021) & 0xffff;
    }
  }
  return crc % 16_384;
}

async function waitForState(
  queue: Queue,
  jobId: string,
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  let observed = "missing";
  while (Date.now() < deadline) {
    const current = await queue.getJob(jobId);
    observed = current === undefined ? "missing" : await current.getState();
    if (observed === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `job ${jobId} did not reach ${expected}; last state was ${observed}`,
  );
}

async function waitForSignal(
  signal: Promise<void>,
  label: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${label}`)),
          10_000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe("download cancellation with Redis 7 and BullMQ", () => {
  integrationIt(
    "keeps jobs until worker terminal state and releases capacity before retention",
    async () => {
      if (INTEGRATION_REDIS_URL === undefined) {
        throw new Error("integration Redis URL is required");
      }
      const connection = redisOptions(INTEGRATION_REDIS_URL);
      const inspection = new Redis(connection);
      const queue = new Queue(DOWNLOAD_QUEUE_NAME, {
        prefix: DOWNLOAD_QUEUE_PREFIX,
        connection,
      });
      const adapterQueues: Queue[] = [];
      const adapter = createDownloadQueueAdapter({
        environment: {
          TF_DOWNLOAD_QUEUE_REDIS_URL_FILE: "/integration-queue-url",
          TF_DOWNLOAD_QUEUE_ALLOW_INSECURE_REDIS: "true",
        },
        readFile: async () =>
          Buffer.from(
            `redis://default:${encodeURIComponent(
              "integration-password-is-long-enough",
            )}@tf-download-redis:6379/0`,
          ),
        createQueue: ((name: string, options: object) => {
          const client = new Queue(name, {
            ...options,
            connection,
          });
          adapterQueues.push(client);
          return client;
        }) as never,
        createRedis: (() =>
          new Redis({
            ...connection,
            commandTimeout: 1_000,
            enableOfflineQueue: false,
            lazyConnect: true,
            maxRetriesPerRequest: 1,
            retryStrategy: () => null,
          })) as never,
      });
      let worker: Worker | undefined;
      let workerRun: Promise<void> | undefined;
      let releaseActive: (() => void) | undefined;
      let releaseCompletion: (() => void) | undefined;
      let releaseCompletedMove: (() => void) | undefined;

      try {
        await inspection.flushdb();
        await queue.waitUntilReady();
        await adapter.init();

        const ledgerKey = getDownloadQueueAdmissionLedgerKey((suffix) =>
          queue.toKey(suffix),
        );
        const leaseKey = queue.toKey("admission-intent-leases");
        const waitKey = getDownloadQueueJobHashKey(
          queue.toKey.bind(queue),
          WAIT_JOB_ID,
        );
        const delayedKey = getDownloadQueueJobHashKey(
          queue.toKey.bind(queue),
          DELAYED_JOB_ID,
        );
        const activeKey = getDownloadQueueJobHashKey(
          queue.toKey.bind(queue),
          ACTIVE_JOB_ID,
        );
        const stateKeys = [
          queue.toKey("completed"),
          queue.toKey("failed"),
          queue.toKey("delayed"),
          queue.toKey("prioritized"),
          queue.toKey("active"),
          queue.toKey("wait"),
          queue.toKey("paused"),
          queue.toKey("waiting-children"),
          waitKey,
          ledgerKey,
          leaseKey,
        ];
        expect(new Set(stateKeys.map(redisSlot)).size).toBe(1);

        const leaseExpiresAt = Date.now() + 60_000;
        const phantomIntents = Array.from(
          { length: 200 },
          (_, index) =>
            [
              `phantom-${index}`,
              encodeDownloadAdmissionIntent("pending", ACCOUNT_ID),
            ] as const,
        );
        const leasePipeline = inspection.pipeline();
        for (const [jobId, intent] of phantomIntents) {
          leasePipeline.hset(ledgerKey, jobId, intent);
          leasePipeline.zadd(leaseKey, leaseExpiresAt, jobId);
        }
        await leasePipeline.exec();
        await expect(adapter.enqueue(jobData)).rejects.toMatchObject({
          code: "download_queue_full",
        });
        await inspection.zadd(leaseKey, Date.now() - 1, "phantom-0");
        const recovered = await adapter.enqueue(jobData);
        expect(recovered.position).toBe(200);
        await expect(inspection.hget(ledgerKey, "phantom-0")).resolves.toBe(
          null,
        );
        await expect(inspection.zscore(leaseKey, "phantom-0")).resolves.toBe(
          null,
        );
        await (await queue.getJob(recovered.jobId))?.remove();
        await inspection.del(ledgerKey, leaseKey);

        await queue.add("download", jobData, {
          jobId: WAIT_JOB_ID,
          attempts: 2,
        });
        await inspection.hset(
          ledgerKey,
          WAIT_JOB_ID,
          encodeDownloadAdmissionIntent("pending", ACCOUNT_ID),
        );
        await queue.add("download", jobData, {
          jobId: DELAYED_JOB_ID,
          delay: 60_000,
        });

        await expect(adapter.cancel(WAIT_JOB_ID, ACCOUNT_ID)).resolves.toEqual({
          status: "waiting",
        });
        await expect(
          adapter.cancel(DELAYED_JOB_ID, ACCOUNT_ID),
        ).resolves.toEqual({ status: "waiting" });
        await expect(
          inspection.hget(waitKey, DOWNLOAD_JOB_CANCELLATION_FIELD),
        ).resolves.toBe(DOWNLOAD_JOB_CANCELLATION_SENTINEL);
        await expect(
          inspection.hget(delayedKey, DOWNLOAD_JOB_CANCELLATION_FIELD),
        ).resolves.toBe(DOWNLOAD_JOB_CANCELLATION_SENTINEL);
        await expect(inspection.hget(ledgerKey, WAIT_JOB_ID)).resolves.toBe(
          null,
        );
        await expect(
          (await queue.getJob(WAIT_JOB_ID))?.getState(),
        ).resolves.toBe("waiting");
        await expect(
          (await queue.getJob(DELAYED_JOB_ID))?.getState(),
        ).resolves.toBe("delayed");

        let activeStarted!: () => void;
        const activeStartedPromise = new Promise<void>((resolve) => {
          activeStarted = resolve;
        });
        const activeGate = new Promise<void>((resolve) => {
          releaseActive = resolve;
        });
        let completionStarted!: () => void;
        const completionStartedPromise = new Promise<void>((resolve) => {
          completionStarted = resolve;
        });
        const completionGate = new Promise<void>((resolve) => {
          releaseCompletion = resolve;
        });
        let completionDisarmed!: () => void;
        const completionDisarmedPromise = new Promise<void>((resolve) => {
          completionDisarmed = resolve;
        });
        const completedMoveGate = new Promise<void>((resolve) => {
          releaseCompletedMove = resolve;
        });
        const closeCancellationWindow = async (
          jobId: string,
        ): Promise<boolean> =>
          Number(
            await inspection.eval(
              `
local marker = redis.call("HGET", KEYS[1], ARGV[1])
if marker == ARGV[2] then return 0 end
if marker ~= ARGV[3] then return -1 end
redis.call("HDEL", KEYS[1], ARGV[1])
return 1
`,
              1,
              getDownloadQueueJobHashKey(queue.toKey.bind(queue), jobId),
              DOWNLOAD_JOB_CANCELLATION_FIELD,
              DOWNLOAD_JOB_CANCELLATION_SENTINEL,
              DOWNLOAD_JOB_CANCELLATION_ARMED_SENTINEL,
            ),
          ) === 1;
        worker = new Worker(
          DOWNLOAD_QUEUE_NAME,
          async (current) => {
            const marker = await inspection.hget(
              getDownloadQueueJobHashKey(queue.toKey.bind(queue), current.id!),
              DOWNLOAD_JOB_CANCELLATION_FIELD,
            );
            if (marker === DOWNLOAD_JOB_CANCELLATION_SENTINEL) {
              throw new UnrecoverableError("download_canceled");
            }
            await inspection.hset(
              getDownloadQueueJobHashKey(queue.toKey.bind(queue), current.id!),
              DOWNLOAD_JOB_CANCELLATION_FIELD,
              DOWNLOAD_JOB_CANCELLATION_ARMED_SENTINEL,
            );
            if (current.id === ACTIVE_JOB_ID) {
              activeStarted();
              await activeGate;
              if (!(await closeCancellationWindow(current.id))) {
                throw new UnrecoverableError("download_canceled");
              }
              return { completed: true };
            }
            if (current.id === COMPLETION_WINDOW_JOB_ID) {
              completionStarted();
              await completionGate;
              if (!(await closeCancellationWindow(current.id))) {
                throw new UnrecoverableError("download_canceled");
              }
              completionDisarmed();
              await completedMoveGate;
              return { completed: true };
            }
            if (current.id === FAILED_JOB_ID) {
              throw new Error("upstream_failed");
            }
            await closeCancellationWindow(current.id!);
            return { completed: true };
          },
          {
            prefix: DOWNLOAD_QUEUE_PREFIX,
            connection,
            autorun: false,
            concurrency: 1,
          },
        );
        await worker.waitUntilReady();
        workerRun = worker.run();
        void workerRun.catch(() => undefined);

        await queue.add("download", jobData, { jobId: ACTIVE_JOB_ID });
        await waitForSignal(activeStartedPromise, "active worker");
        await expect(
          adapter.cancel(ACTIVE_JOB_ID, ACCOUNT_ID),
        ).resolves.toEqual({ status: "active" });
        await expect(
          inspection.hget(activeKey, DOWNLOAD_JOB_CANCELLATION_FIELD),
        ).resolves.toBe(DOWNLOAD_JOB_CANCELLATION_SENTINEL);
        releaseActive?.();
        await waitForState(queue, ACTIVE_JOB_ID, "failed");
        await expect(
          adapter.cancel(ACTIVE_JOB_ID, ACCOUNT_ID),
        ).resolves.toEqual({ status: "canceled" });

        await queue.add("download", jobData, {
          jobId: COMPLETION_WINDOW_JOB_ID,
        });
        await waitForSignal(completionStartedPromise, "completion worker");
        releaseCompletion?.();
        await waitForSignal(completionDisarmedPromise, "completion disarm");
        await expect(
          adapter.cancel(COMPLETION_WINDOW_JOB_ID, ACCOUNT_ID),
        ).rejects.toMatchObject({ code: "download_queue_unavailable" });
        await expect(
          inspection.hget(
            getDownloadQueueJobHashKey(
              queue.toKey.bind(queue),
              COMPLETION_WINDOW_JOB_ID,
            ),
            DOWNLOAD_JOB_CANCELLATION_FIELD,
          ),
        ).resolves.toBe(null);
        releaseCompletedMove?.();
        await waitForState(queue, COMPLETION_WINDOW_JOB_ID, "completed");

        await waitForState(queue, WAIT_JOB_ID, "failed");
        await expect(adapter.cancel(WAIT_JOB_ID, ACCOUNT_ID)).resolves.toEqual({
          status: "canceled",
        });
        const canceledJob = await queue.getJob(WAIT_JOB_ID);
        expect(canceledJob?.failedReason).toBe("download_canceled");
        await canceledJob?.retry("failed");
        await waitForState(queue, WAIT_JOB_ID, "failed");
        await expect(
          inspection.hget(waitKey, DOWNLOAD_JOB_CANCELLATION_FIELD),
        ).resolves.toBe(DOWNLOAD_JOB_CANCELLATION_SENTINEL);
        expect((await queue.getJob(WAIT_JOB_ID))?.failedReason).toBe(
          "download_canceled",
        );

        await queue.add("download", jobData, {
          jobId: FAILED_JOB_ID,
          attempts: 1,
        });
        await waitForState(queue, FAILED_JOB_ID, "failed");
        await expect(
          adapter.cancel(FAILED_JOB_ID, ACCOUNT_ID),
        ).resolves.toEqual({ status: "failed" });
        await inspection.hset(
          ledgerKey,
          FAILED_JOB_ID,
          encodeDownloadAdmissionIntent("pending", ACCOUNT_ID),
        );
        await expect(
          adapter.cancel(FAILED_JOB_ID, ACCOUNT_ID),
        ).resolves.toEqual({ status: "failed" });
        await expect(inspection.hget(ledgerKey, FAILED_JOB_ID)).resolves.toBe(
          null,
        );

        const failedJob = await queue.getJob(FAILED_JOB_ID);
        await failedJob?.remove();
        await expect(queue.getJob(FAILED_JOB_ID)).resolves.toBeUndefined();
        await expect(
          inspection.exists(
            getDownloadQueueJobHashKey(queue.toKey.bind(queue), FAILED_JOB_ID),
          ),
        ).resolves.toBe(0);

        const retainedIntents = Object.fromEntries(
          Array.from({ length: 198 }, (_, index) => [
            `retained-${index}`,
            encodeDownloadAdmissionIntent("pending", ACCOUNT_ID),
          ]),
        );
        await inspection.hset(ledgerKey, retainedIntents);
        await expect(adapter.enqueue(jobData)).resolves.toEqual({
          jobId: expect.any(String),
          position: 200,
        });
      } finally {
        releaseActive?.();
        releaseCompletion?.();
        releaseCompletedMove?.();
        await worker?.close(true).catch(() => undefined);
        await workerRun?.catch(() => undefined);
        await adapter.shutdown().catch(() => undefined);
        await Promise.allSettled(adapterQueues.map((client) => client.close()));
        await queue.obliterate({ force: true }).catch(() => undefined);
        await queue.close().catch(() => undefined);
        await inspection.flushdb().catch(() => undefined);
        await inspection.quit().catch(() => undefined);
      }
    },
    30_000,
  );
});
