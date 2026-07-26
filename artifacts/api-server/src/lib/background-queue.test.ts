import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

const ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";
const validJob = {
  schemaVersion: 1,
  accountId: ACCOUNT_ID,
  trackId: "yt_example",
  artist: "Artist",
  title: "Title",
  quality: "320",
  sourceUrl: "https://www.youtube.com/watch?v=example",
  createdAt: "2026-07-26T00:00:00.000Z",
} as const;

interface FakeJob {
  id: string;
  data: unknown;
  progress: number;
  returnvalue?: unknown;
  failedReason?: string;
  getState(): Promise<string>;
  remove(): Promise<void>;
}

class FakeQueue {
  readonly added: Array<{ name: string; data: unknown }> = [];
  readonly jobs = new Map<string, FakeJob>();
  waiting = 0;
  active = 0;
  fail?: Error;
  closed = false;

  async waitUntilReady(): Promise<void> {
    if (this.fail) throw this.fail;
  }

  async getWaitingCount(): Promise<number> {
    if (this.fail) throw this.fail;
    return this.waiting;
  }

  async getActiveCount(): Promise<number> {
    if (this.fail) throw this.fail;
    return this.active;
  }

  async add(name: string, data: unknown): Promise<{ id: string }> {
    if (this.fail) throw this.fail;
    this.added.push({ name, data });
    return { id: `job-${this.added.length}` };
  }

  async getJob(id: string): Promise<FakeJob | undefined> {
    if (this.fail) throw this.fail;
    return this.jobs.get(id);
  }

  async getWaiting(): Promise<FakeJob[]> {
    return [...this.jobs.values()].filter(
      async (job) => (await job.getState()) === "waiting",
    );
  }

  async getActive(): Promise<FakeJob[]> {
    return [...this.jobs.values()];
  }

  async getCompleted(): Promise<FakeJob[]> {
    return [...this.jobs.values()];
  }

  async getFailed(): Promise<FakeJob[]> {
    return [...this.jobs.values()];
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeRedis {
  readonly writes: unknown[][] = [];
  closed = false;
  fail?: Error;

  async connect(): Promise<void> {
    if (this.fail) throw this.fail;
  }

  async ping(): Promise<string> {
    if (this.fail) throw this.fail;
    return "PONG";
  }

  async set(...args: unknown[]): Promise<string> {
    if (this.fail) throw this.fail;
    this.writes.push(args);
    return "OK";
  }

  async quit(): Promise<void> {
    this.closed = true;
  }
}

function fakeJob(
  id: string,
  data: unknown,
  state: string,
  options: { progress?: number; failedReason?: string } = {},
): FakeJob {
  return {
    id,
    data,
    progress: options.progress ?? 0,
    failedReason: options.failedReason,
    getState: async () => state,
    remove: async () => {},
  };
}

const queueModule = await import("./background-queue.js");
const adapterModule = queueModule as typeof queueModule & {
  createDownloadQueueAdapter: (options: unknown) => {
    init(): Promise<void>;
    shutdown(): Promise<void>;
    enqueue(data: typeof validJob): Promise<{ jobId: string; position: number }>;
    status(jobId: string, accountId: string): Promise<{ status: string; progress: number }>;
    list(accountId: string): Promise<readonly { jobId: string; status: string }[]>;
    cancel(jobId: string, accountId: string): Promise<{ status: string }>;
    telemetry(): Promise<unknown>;
    runtimeState(): unknown;
  };
};

function createAdapter(
  producer = new FakeQueue(),
  telemetry = new FakeQueue(),
  cancellation = new FakeRedis(),
  environment: Record<string, string | undefined> = {
    TF_DOWNLOAD_QUEUE_REDIS_URL_FILE: "/run/secrets/download-queue-url",
    TF_DOWNLOAD_QUEUE_ALLOW_INSECURE_REDIS: "true",
  },
  readQueueUrl = async () => Buffer.from("redis://tf-download-redis:6379/0"),
) {
  return {
    adapter: adapterModule.createDownloadQueueAdapter({
      environment,
      readFile: readQueueUrl,
      createQueue: vi
        .fn()
        .mockReturnValueOnce(producer)
        .mockReturnValueOnce(telemetry),
      createRedis: vi.fn().mockReturnValue(cancellation),
    }),
    producer,
    telemetry,
    cancellation,
  };
}

afterEach(async () => {
  await queueModule.shutdownBackgroundQueues();
  vi.restoreAllMocks();
});

describe("download queue producer boundary", () => {
  it("is unavailable without initialization and never embeds a worker", async () => {
    expect(queueModule.getDownloadQueueRuntimeState()).toEqual({
      backend: "unavailable",
      workerEmbedded: false,
    });
    await expect(queueModule.enqueueDownload(validJob)).rejects.toBeInstanceOf(
      queueModule.DownloadQueueUnavailableError,
    );
  });

  it("requires a readable bounded file-backed Redis URL", async () => {
    for (const [environment, readQueueUrl] of [
      [{}, async () => Buffer.from("redis://tf-download-redis:6379/0")],
      [
        { TF_DOWNLOAD_QUEUE_REDIS_URL_FILE: "/queue-url" },
        async () => Buffer.alloc(0),
      ],
      [
        { TF_DOWNLOAD_QUEUE_REDIS_URL_FILE: "/queue-url" },
        async () => Buffer.alloc(2_049, 120),
      ],
      [
        { TF_DOWNLOAD_QUEUE_REDIS_URL_FILE: "/queue-url" },
        async () => {
          throw new Error("permission denied");
        },
      ],
    ] as const) {
      const { adapter } = createAdapter(undefined, undefined, undefined, environment, readQueueUrl);
      await expect(adapter.init()).rejects.toThrow("invalid runtime configuration");
    }
  });

  it("allows plaintext Redis only for the exact same-node endpoint with an explicit flag", async () => {
    const localWithoutFlag = createAdapter(
      undefined,
      undefined,
      undefined,
      { TF_DOWNLOAD_QUEUE_REDIS_URL_FILE: "/queue-url" },
    ).adapter;
    await expect(localWithoutFlag.init()).rejects.toThrow("invalid runtime configuration");

    const localWithQuery = createAdapter(
      undefined,
      undefined,
      undefined,
      {
        TF_DOWNLOAD_QUEUE_REDIS_URL_FILE: "/queue-url",
        TF_DOWNLOAD_QUEUE_ALLOW_INSECURE_REDIS: "true",
      },
      async () => Buffer.from("redis://tf-download-redis:6379/0?unsafe=true"),
    ).adapter;
    await expect(localWithQuery.init()).rejects.toThrow("invalid runtime configuration");

    const crossNodePlaintext = createAdapter(
      undefined,
      undefined,
      undefined,
      {
        TF_DOWNLOAD_QUEUE_REDIS_URL_FILE: "/queue-url",
        TF_DOWNLOAD_QUEUE_ALLOW_INSECURE_REDIS: "true",
      },
      async () => Buffer.from("redis://queue.example.test:6379/0"),
    ).adapter;
    await expect(crossNodePlaintext.init()).rejects.toThrow("invalid runtime configuration");

    const secureCrossNode = createAdapter(
      undefined,
      undefined,
      undefined,
      { TF_DOWNLOAD_QUEUE_REDIS_URL_FILE: "/queue-url" },
      async () => Buffer.from("rediss://queue.example.test:6380/0"),
    ).adapter;
    await expect(secureCrossNode.init()).resolves.toBeUndefined();
  });

  it("enforces capacity before adding strict Task 1 data", async () => {
    const { adapter, producer } = createAdapter();
    producer.waiting = 199;
    producer.active = 1;
    await adapter.init();

    await expect(adapter.enqueue(validJob)).rejects.toThrow("download_queue_full");
    expect(producer.added).toEqual([]);
  });

  it("adds only strict account-owned contract data with bounded job options", async () => {
    const { adapter, producer } = createAdapter();
    await adapter.init();

    await expect(adapter.enqueue(validJob)).resolves.toEqual({
      jobId: "job-1",
      position: 1,
    });
    expect(producer.added).toEqual([{ name: "download", data: validJob }]);
    expect(producer.added[0]!.data).not.toHaveProperty("sessionId");
  });

  it("keeps telemetry unknown without changing the available producer backend", async () => {
    const { adapter, telemetry } = createAdapter();
    await adapter.init();
    telemetry.fail = new Error("raw redis failure");

    await expect(adapter.telemetry()).resolves.toEqual({
      status: "unknown",
      redisStatus: "unknown",
    });
    expect(adapter.runtimeState()).toEqual({
      backend: "redis",
      workerEmbedded: false,
    });
  });

  it("maps raw queue failures to a sanitized unavailable error", async () => {
    const { adapter, producer } = createAdapter();
    await adapter.init();
    producer.fail = new Error("redis://secret.example:6379 refused");

    await expect(adapter.enqueue(validJob)).rejects.toMatchObject({
      code: "download_queue_unavailable",
      message: "Download queue is unavailable",
    });
  });

  it("does not import an API worker or downloader implementation", async () => {
    const source = await readFile(new URL("./background-queue.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/new\s+Worker/);
    expect(source).not.toContain("spawnAudioDownload");
    expect(source).not.toContain("inMemory");
  });
});
