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

class FakeRedis {
  lock: string | undefined;
  lockExpiresAt: number | undefined;
  readonly calls: unknown[][] = [];
  readonly events = new Map<string, () => void>();
  closed = false;

  on = vi.fn((event: string, listener: () => void) =>
    this.events.set(event, listener),
  );

  async connect(): Promise<void> {}
  async ping(): Promise<string> {
    return "PONG";
  }
  async quit(): Promise<void> {
    this.closed = true;
  }
  async set(...args: unknown[]): Promise<"OK" | null> {
    this.calls.push(args);
    if (args.includes("NX")) {
      if (
        this.lockExpiresAt !== undefined &&
        this.lockExpiresAt <= Date.now()
      ) {
        this.lock = undefined;
        this.lockExpiresAt = undefined;
      }
      if (this.lock !== undefined) return null;
      this.lock = String(args[1]);
      const lease = args.at(-1);
      this.lockExpiresAt = Date.now() + Number(lease);
    }
    return "OK";
  }
  async eval(
    _script: string,
    _keys: number,
    _key: string,
    token: string,
  ): Promise<number> {
    if (this.lock !== token) return 0;
    this.lock = undefined;
    this.lockExpiresAt = undefined;
    return 1;
  }
  async del(): Promise<number> {
    return 1;
  }
}

class FakeQueue {
  readonly added: Array<{ data: unknown; options: { jobId: string } }> = [];
  readonly events = new Map<string, () => void>();
  jobs = new Map<string, unknown>();
  counts: Record<string, number> = {
    waiting: 0,
    active: 0,
    delayed: 0,
    prioritized: 0,
    "waiting-children": 0,
    paused: 0,
  };
  addError: Error | undefined;
  ambiguousAccepted = false;
  ambiguousJobData: unknown | undefined;
  addId: string | undefined;
  onAdd: (() => void) | undefined;
  closed = false;
  ready: (() => Promise<void>) | undefined;

  on = vi.fn((event: string, listener: () => void) =>
    this.events.set(event, listener),
  );

  async waitUntilReady(): Promise<void> {
    await this.ready?.();
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  async getWaitingCount(): Promise<number> {
    return this.counts.waiting;
  }
  async getActiveCount(): Promise<number> {
    return this.counts.active;
  }
  async getJobCounts(...states: string[]): Promise<Record<string, number>> {
    return Object.fromEntries(
      states.map((state) => [
        state,
        state === "wait" ? this.counts.waiting : (this.counts[state] ?? 0),
      ]),
    );
  }
  async add(
    _name: string,
    data: unknown,
    options: { jobId: string },
  ): Promise<{ id: string }> {
    this.added.push({ data, options });
    const job = {
      id: options.jobId,
      data,
      progress: 0,
      getState: async () => "waiting",
      remove: async () => {},
    };
    if (this.ambiguousAccepted) {
      this.jobs.set(options.jobId, {
        ...job,
        data: this.ambiguousJobData ?? data,
      });
    }
    if (this.addError !== undefined) throw this.addError;
    this.jobs.set(options.jobId, job);
    this.counts.waiting += 1;
    this.onAdd?.();
    return { id: this.addId ?? options.jobId };
  }
  async getJob(id: string): Promise<unknown> {
    return this.jobs.get(id);
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
}

const queueModule = await import("./background-queue.js");

function createAdapter(
  options: {
    producer?: FakeQueue;
    telemetry?: FakeQueue;
    redis?: FakeRedis;
    environment?: Record<string, string | undefined>;
    queueUrl?: string;
    readFile?: () => Promise<Buffer>;
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
    adapter: queueModule.createDownloadQueueAdapter({
      environment: options.environment ?? {
        TF_DOWNLOAD_QUEUE_REDIS_URL_FILE: "/queue-url",
        TF_DOWNLOAD_QUEUE_ALLOW_INSECURE_REDIS: "true",
      },
      readFile:
        options.readFile ??
        (async () =>
          Buffer.from(options.queueUrl ?? "redis://tf-download-redis:6379/0")),
      createQueue: createQueue as never,
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
  it("is unavailable before initialization", async () => {
    expect(queueModule.getDownloadQueueRuntimeState()).toEqual({
      backend: "unavailable",
      workerEmbedded: false,
    });
    await expect(queueModule.enqueueDownload(validJob)).rejects.toBeInstanceOf(
      queueModule.DownloadQueueUnavailableError,
    );
  });

  it("requires a readable 1..2048 byte queue URL file", async () => {
    for (const readFile of [
      async () => Buffer.alloc(0),
      async () => Buffer.alloc(2_049),
      async () => {
        throw new Error("unreadable");
      },
    ]) {
      await expect(createAdapter({ readFile }).adapter.init()).rejects.toThrow(
        "invalid runtime configuration",
      );
    }
  });

  it("preserves strict Redis URL, database, and encoded credential handling", async () => {
    const { adapter, createQueue, createRedis } = createAdapter({
      queueUrl: "rediss://user%20name:p%40ss@queue.example.test:6380/3",
      environment: { TF_DOWNLOAD_QUEUE_REDIS_URL_FILE: "/queue-url" },
    });
    await adapter.init();
    expect(createQueue.mock.calls[0]![1]).toMatchObject({
      connection: { username: "user name", password: "p@ss", db: 3 },
    });
    expect(createRedis.mock.calls[0]![0]).toMatchObject({ db: 3 });
    for (const queueUrl of [
      "rediss://queue.example.test/03",
      "rediss://queue.example.test/16",
      "rediss://queue.example.test/3/extra",
      "rediss://queue.example.test/3?query=value",
      "rediss://queue.example.test/3#fragment",
      "rediss:///0",
      "redis://tf-download-redis:6379/1",
      "redis://user:password@tf-download-redis:6379/0",
      "redis://tf-download-redis:6379/0?query=value",
    ]) {
      await expect(createAdapter({ queueUrl }).adapter.init()).rejects.toThrow(
        "invalid runtime configuration",
      );
    }
  });

  it("uses full bounded default job options and strict account-owned data", async () => {
    const { adapter, createQueue, producer } = createAdapter();
    await adapter.init();
    await adapter.enqueue(validJob);
    expect(createQueue.mock.calls[0]![1]).toMatchObject({
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: "fixed", delay: 5_000 },
        removeOnComplete: { age: 86_400, count: 200 },
        removeOnFail: { age: 86_400, count: 200 },
      },
    });
    expect(producer.added[0]!.data).toEqual(validJob);
    expect(producer.added[0]!.data).not.toHaveProperty("sessionId");
  });

  it("serializes two producer adapters observed at 199 capacity", async () => {
    const redis = new FakeRedis();
    const first = new FakeQueue();
    const second = new FakeQueue();
    first.counts.waiting = 199;
    second.counts = first.counts;
    second.jobs = first.jobs;
    const a = createAdapter({ producer: first, redis }).adapter;
    const b = createAdapter({ producer: second, redis }).adapter;
    await Promise.all([a.init(), b.init()]);
    const outcomes = await Promise.allSettled([
      a.enqueue(validJob),
      b.enqueue(validJob),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.find((outcome) => outcome.status === "rejected"),
    ).toMatchObject({
      reason: expect.objectContaining({ code: "download_queue_full" }),
    });
    expect(first.added.length + second.added.length).toBe(1);
  });

  it("counts delayed, prioritized, paused, and waiting-children capacity states", async () => {
    const { adapter, producer, redis } = createAdapter();
    producer.counts = {
      waiting: 191,
      active: 1,
      delayed: 2,
      prioritized: 2,
      "waiting-children": 2,
      paused: 2,
    };
    await adapter.init();
    await expect(adapter.enqueue(validJob)).rejects.toMatchObject({
      code: "download_queue_full",
    });
    expect(redis.calls[0]).toEqual(
      expect.arrayContaining(["NX", "PX", expect.any(Number)]),
    );
    expect(queueModule.DOWNLOAD_ADMISSION_LOCK_POLICY.leaseMs).toBeGreaterThan(
      queueModule.DOWNLOAD_ADMISSION_LOCK_POLICY
        .maxCriticalSectionCommandWindowMs,
    );
    expect(producer.added).toHaveLength(0);
  });

  it("reconciles an ambiguous add only for the exact accepted job", async () => {
    const { adapter, producer } = createAdapter();
    producer.ambiguousAccepted = true;
    producer.addError = new Error("timeout");
    await adapter.init();
    await expect(adapter.enqueue(validJob)).resolves.toMatchObject({
      jobId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  it("fails closed when ambiguous add is absent or the mutex belongs to another producer", async () => {
    const absent = createAdapter();
    absent.producer.addError = new Error("timeout");
    await absent.adapter.init();
    await expect(absent.adapter.enqueue(validJob)).rejects.toBeInstanceOf(
      queueModule.DownloadQueueUnavailableError,
    );
    const locked = createAdapter();
    locked.redis.lock = "other-token";
    await locked.adapter.init();
    await expect(locked.adapter.enqueue(validJob)).rejects.toBeInstanceOf(
      queueModule.DownloadQueueUnavailableError,
    );
    expect(locked.redis.lock).toBe("other-token");
  });

  it("fails closed when ambiguous add belongs to another owner or payload", async () => {
    for (const ambiguousJobData of [
      { ...validJob, accountId: "20000000-0000-4000-8000-000000000002" },
      { ...validJob, title: "Different title" },
    ]) {
      const adapter = createAdapter();
      adapter.producer.ambiguousAccepted = true;
      adapter.producer.ambiguousJobData = ambiguousJobData;
      adapter.producer.addError = new Error("timeout");
      await adapter.adapter.init();
      await expect(adapter.adapter.enqueue(validJob)).rejects.toBeInstanceOf(
        queueModule.DownloadQueueUnavailableError,
      );
    }
  });

  it("requires Queue.add to return the preassigned job id", async () => {
    const { adapter, producer } = createAdapter();
    producer.addId = "different-job-id";
    await adapter.init();
    await expect(adapter.enqueue(validJob)).rejects.toBeInstanceOf(
      queueModule.DownloadQueueUnavailableError,
    );
  });

  it("does not release a lock after ownership changes", async () => {
    const { adapter, producer, redis } = createAdapter();
    producer.onAdd = () => {
      redis.lock = "new-owner";
      redis.lockExpiresAt = Date.now() + 20_000;
    };
    await adapter.init();
    await adapter.enqueue(validJob);
    expect(redis.lock).toBe("new-owner");
  });

  it("admits after a crashed producer's bounded lease has expired", async () => {
    const { adapter, redis } = createAdapter();
    redis.lock = "crashed-owner";
    redis.lockExpiresAt = Date.now() - 1;
    await adapter.init();
    await expect(adapter.enqueue(validJob)).resolves.toMatchObject({
      position: 1,
    });
    expect(queueModule.DOWNLOAD_ADMISSION_LOCK_POLICY.retryWindowMs).toBe(250);
  });

  it("fails closed on malformed atomic capacity counts", async () => {
    const malformedCounts = [
      {
        wait: -1,
        active: 0,
        delayed: 0,
        prioritized: 0,
        "waiting-children": 0,
        paused: 0,
      },
      {
        wait: 0,
        active: 0,
        delayed: 1.5,
        prioritized: 0,
        "waiting-children": 0,
        paused: 0,
      },
      {
        wait: 0,
        active: 0,
        delayed: 0,
        prioritized: 0,
        "waiting-children": 0,
      },
    ];
    for (const counts of malformedCounts) {
      const { adapter, producer } = createAdapter();
      producer.getJobCounts = async () => counts as Record<string, number>;
      await adapter.init();
      await expect(adapter.enqueue(validJob)).rejects.toBeInstanceOf(
        queueModule.DownloadQueueUnavailableError,
      );
    }
  });

  it("cleans partial sync initialization failures and shares concurrent init with error listeners", async () => {
    const producer = new FakeQueue();
    const failing = vi
      .fn()
      .mockReturnValueOnce(producer)
      .mockImplementationOnce(() => {
        throw new Error("redis secret");
      });
    await expect(
      createAdapter({ producer, createQueue: failing }).adapter.init(),
    ).rejects.toBeInstanceOf(queueModule.DownloadQueueUnavailableError);
    expect(producer.closed).toBe(true);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gated = new FakeQueue();
    gated.ready = async () => gate;
    const ready = createAdapter({ producer: gated });
    const first = ready.adapter.init();
    const second = ready.adapter.init();
    release();
    await Promise.all([first, second]);
    expect(ready.createQueue).toHaveBeenCalledTimes(2);
    expect(gated.on).toHaveBeenCalledWith("error", expect.any(Function));
    expect(ready.redis.on).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("shuts down initialized clients and returns to an unavailable runtime", async () => {
    const { adapter, producer, telemetry, redis } = createAdapter();
    await adapter.init();
    await adapter.shutdown();
    expect(producer.closed).toBe(true);
    expect(telemetry.closed).toBe(true);
    expect(redis.closed).toBe(true);
    expect(adapter.runtimeState()).toEqual({
      backend: "unavailable",
      workerEmbedded: false,
    });
  });

  it("keeps telemetry failure isolated", async () => {
    const { adapter, telemetry } = createAdapter();
    telemetry.getWaitingCount = async () => {
      throw new Error("down");
    };
    await adapter.init();
    await expect(adapter.telemetry()).resolves.toEqual({
      status: "unknown",
      redisStatus: "unknown",
    });
    expect(adapter.runtimeState()).toEqual({
      backend: "redis",
      workerEmbedded: false,
    });
  });

  it("contains no reservation lifecycle, worker, or downloader code", async () => {
    const source = await readFile(
      new URL("./background-queue.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("RESERVATION");
    expect(source).not.toMatch(/new\s+Worker/);
    expect(source).not.toContain("spawnAudioDownload");
  });
});
