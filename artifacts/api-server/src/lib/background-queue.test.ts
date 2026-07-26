import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

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

class FakeQueue {
  readonly added: Array<{ name: string; data: unknown; options: unknown }> = [];
  readonly events = new Map<string, () => void>();
  closed = false;
  fail?: Error;
  constructor(
    readonly waiting = 0,
    readonly active = 0,
  ) {}
  on = vi.fn((event: string, listener: () => void) =>
    this.events.set(event, listener),
  );
  async waitUntilReady(): Promise<void> {
    if (this.fail) throw this.fail;
  }
  async getWaitingCount(): Promise<number> {
    return this.waiting;
  }
  async getActiveCount(): Promise<number> {
    return this.active;
  }
  async add(
    name: string,
    data: unknown,
    options: unknown,
  ): Promise<{ id: string }> {
    if (this.fail) throw this.fail;
    this.added.push({ name, data, options });
    return { id: (options as { jobId: string }).jobId };
  }
  async getJob(): Promise<undefined> {
    return undefined;
  }
  async getWaiting(): Promise<never[]> {
    return [];
  }
  async getDelayed(): Promise<never[]> {
    return [];
  }
  async getActive(): Promise<never[]> {
    return [];
  }
  async getCompleted(): Promise<never[]> {
    return [];
  }
  async getFailed(): Promise<never[]> {
    return [];
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeRedis {
  readonly events = new Map<string, () => void>();
  readonly reservations = new Set<string>();
  readonly writes: unknown[][] = [];
  closed = false;
  on = vi.fn((event: string, listener: () => void) =>
    this.events.set(event, listener),
  );
  async connect(): Promise<void> {}
  async ping(): Promise<string> {
    return "PONG";
  }
  async eval(
    _script: string,
    _keys: number,
    _key: string,
    _now: string,
    _expiry: string,
    capacity: string,
    jobId: string,
  ): Promise<number> {
    if (this.reservations.size >= Number(capacity)) return 0;
    this.reservations.add(jobId);
    return 1;
  }
  async zrem(_key: string, jobId: string): Promise<number> {
    return this.reservations.delete(jobId) ? 1 : 0;
  }
  async set(...args: unknown[]): Promise<string> {
    this.writes.push(args);
    return "OK";
  }
  async del(): Promise<number> {
    return 1;
  }
  async quit(): Promise<void> {
    this.closed = true;
  }
}

const queueModule = await import("./background-queue.js");
const adapterModule = queueModule as typeof queueModule & {
  createDownloadQueueAdapter(options: unknown): {
    init(): Promise<void>;
    shutdown(): Promise<void>;
    enqueue(
      data: typeof validJob,
    ): Promise<{ jobId: string; position: number }>;
    runtimeState(): unknown;
  };
};

function createAdapter(
  options: {
    producer?: FakeQueue;
    telemetry?: FakeQueue;
    redis?: FakeRedis;
    url?: string;
    environment?: Record<string, string | undefined>;
    createQueue?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const producer = options.producer ?? new FakeQueue();
  const telemetry = options.telemetry ?? new FakeQueue();
  const redis = options.redis ?? new FakeRedis();
  const createQueue =
    options.createQueue ??
    vi.fn().mockReturnValueOnce(producer).mockReturnValueOnce(telemetry);
  const createRedis = vi.fn().mockReturnValue(redis);
  return {
    adapter: adapterModule.createDownloadQueueAdapter({
      environment: options.environment ?? {
        TF_DOWNLOAD_QUEUE_REDIS_URL_FILE: "/queue-url",
        TF_DOWNLOAD_QUEUE_ALLOW_INSECURE_REDIS: "true",
      },
      readFile: async () =>
        Buffer.from(options.url ?? "redis://tf-download-redis:6379/0"),
      createQueue,
      createRedis,
    }),
    producer,
    telemetry,
    redis,
    createQueue,
    createRedis,
  };
}

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

  it("uses an atomic Redis reservation so concurrent callers at 199 admit only one", async () => {
    const redis = new FakeRedis();
    for (let index = 0; index < 199; index += 1)
      redis.reservations.add(`existing-${index}`);
    const { adapter, producer } = createAdapter({ redis });
    await adapter.init();
    const results = await Promise.allSettled([
      adapter.enqueue(validJob),
      adapter.enqueue(validJob),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(producer.added).toHaveLength(1);
    expect(producer.added[0]!.options).toEqual(
      expect.objectContaining({
        jobId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      }),
    );
  });

  it("passes strict data and full retention options to Queue.add", async () => {
    const { adapter, producer } = createAdapter();
    await adapter.init();
    await adapter.enqueue(validJob);
    expect(producer.added[0]).toEqual({
      name: "download",
      data: validJob,
      options: { jobId: expect.stringMatching(/^[0-9a-f-]{36}$/) },
    });
    expect(producer.added[0]!.data).not.toHaveProperty("sessionId");
    expect(producer.added).toHaveLength(1);
  });

  it("uses exact default job options and decoded credentials with a numeric Redis database", async () => {
    const { adapter, createQueue, createRedis } = createAdapter({
      url: "rediss://user%20name:p%40ss@queue.example.test:6380/3",
      environment: { TF_DOWNLOAD_QUEUE_REDIS_URL_FILE: "/queue-url" },
    });
    await adapter.init();
    expect(createQueue.mock.calls[0]![1]).toMatchObject({
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: "fixed", delay: 5_000 },
        removeOnComplete: { age: 86_400, count: 200 },
        removeOnFail: { age: 86_400, count: 200 },
      },
      connection: { username: "user name", password: "p@ss", db: 3 },
    });
    expect(createRedis.mock.calls[0]![0]).toMatchObject({
      username: "user name",
      password: "p@ss",
      db: 3,
    });
  });

  it("rejects noncanonical or out-of-range Redis database paths", async () => {
    for (const url of [
      "rediss://queue.example.test/03",
      "rediss://queue.example.test/16",
      "rediss://queue.example.test/3/extra",
      "redis://tf-download-redis:6379/1",
    ]) {
      await expect(createAdapter({ url }).adapter.init()).rejects.toThrow(
        "invalid runtime configuration",
      );
    }
  });

  it("cleans partial synchronous initialization failures and sanitizes the error", async () => {
    const producer = new FakeQueue();
    const createQueue = vi
      .fn()
      .mockReturnValueOnce(producer)
      .mockImplementationOnce(() => {
        throw new Error("redis://secret");
      });
    const { adapter } = createAdapter({ producer, createQueue });
    await expect(adapter.init()).rejects.toBeInstanceOf(
      queueModule.DownloadQueueUnavailableError,
    );
    expect(producer.closed).toBe(true);
  });

  it("shares concurrent initialization and registers non-throwing client error listeners", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const producer = new FakeQueue();
    producer.waitUntilReady = async () => gate;
    const { adapter, telemetry, redis, createQueue } = createAdapter({
      producer,
    });
    const first = adapter.init();
    const second = adapter.init();
    release();
    await Promise.all([first, second]);
    expect(createQueue).toHaveBeenCalledTimes(2);
    expect(producer.on).toHaveBeenCalledWith("error", expect.any(Function));
    expect(telemetry.on).toHaveBeenCalledWith("error", expect.any(Function));
    expect(redis.on).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("does not import an API worker or downloader implementation", async () => {
    const source = await readFile(
      new URL("./background-queue.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/new\s+Worker/);
    expect(source).not.toContain("spawnAudioDownload");
    expect(source).not.toContain("inMemory");
  });
});
