import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { DOWNLOAD_QUEUE_PREFIX } from "@workspace/tf-download-contract";
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

function intentFor(data: typeof validJob): string {
  return `pending:${data.accountId}`;
}

class FakeRedis {
  lock: string | undefined;
  lockExpiresAt: number | undefined;
  readonly calls: unknown[][] = [];
  readonly events = new Map<string, () => void>();
  readonly ledgers = new Map<string, Map<string, string>>();
  readonly queuesByWaitKey = new Map<string, FakeQueue>();
  reserveResult: unknown | undefined;
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

  bind(queue: FakeQueue): void {
    this.queuesByWaitKey.set(queue.toKey("wait"), queue);
  }

  ledgerFor(queue: FakeQueue): Map<string, string> {
    const key = queue.toKey("admission-intents");
    let ledger = this.ledgers.get(key);
    if (ledger === undefined) {
      ledger = new Map<string, string>();
      this.ledgers.set(key, ledger);
    }
    return ledger;
  }

  async eval(
    script: string,
    keyCount: number,
    ...arguments_: string[]
  ): Promise<number> {
    this.calls.push([script, keyCount, ...arguments_]);
    const keys = arguments_.slice(0, keyCount);
    const args = arguments_.slice(keyCount);
    if (script.includes("HSET")) {
      if (this.reserveResult !== undefined) return this.reserveResult as number;
      const queue = this.queuesByWaitKey.get(keys[0]!);
      if (queue === undefined) throw new Error("unknown queue");
      const ledger = this.ledgerFor(queue);
      for (const [jobId, intent] of ledger) {
        if (intent.startsWith("confirmed:") || queue.jobs.has(jobId)) {
          ledger.delete(jobId);
        }
      }
      const total =
        queue.counts.waiting +
        queue.counts.active +
        queue.counts.delayed +
        queue.counts.prioritized +
        queue.counts["waiting-children"] +
        queue.counts.paused +
        ledger.size;
      if (total >= Number(args[2])) return 0;
      ledger.set(args[0]!, args[1]!);
      return total + 1;
    }
    if (script.includes("HGET")) {
      const ledger = this.ledgers.get(keys[0]!);
      if (ledger === undefined) return 1;
      const stored = ledger.get(args[0]!);
      if (stored === undefined) return 1;
      if (stored !== args[1]) return 0;
      ledger.delete(args[0]!);
      return 1;
    }
    if (this.lock !== args[0]) return 0;
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
  onAddStarted: (() => void) | undefined;
  addGate: Promise<void> | undefined;
  getJobError: Error | undefined;
  closed = false;
  ready: (() => Promise<void>) | undefined;
  keyPrefix = "tenant:apollo-downloads:";

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
  toKey(type: string): string {
    return `${this.keyPrefix}${type}`;
  }
  async add(
    _name: string,
    data: unknown,
    options: { jobId: string },
  ): Promise<{ id: string }> {
    this.added.push({ data, options });
    this.onAddStarted?.();
    await this.addGate;
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
      this.counts.waiting += 1;
    }
    if (this.addError !== undefined) throw this.addError;
    this.jobs.set(options.jobId, job);
    this.counts.waiting += 1;
    this.onAdd?.();
    return { id: this.addId ?? options.jobId };
  }
  async getJob(id: string): Promise<unknown> {
    if (this.getJobError !== undefined) throw this.getJobError;
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
    readFile?: (path: string, maximumBytes: number) => Promise<Buffer>;
    createQueue?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const producer = options.producer ?? new FakeQueue();
  const telemetry = options.telemetry ?? new FakeQueue();
  const redis = options.redis ?? new FakeRedis();
  const createQueue =
    options.createQueue ??
    vi
      .fn()
      .mockImplementationOnce(
        (name: string, queueOptions: { prefix?: string }) => {
          producer.keyPrefix = `${queueOptions.prefix ?? "tenant"}:${name}:`;
          redis.bind(producer);
          return producer;
        },
      )
      .mockImplementationOnce(
        (name: string, queueOptions: { prefix?: string }) => {
          telemetry.keyPrefix = `${queueOptions.prefix ?? "tenant"}:${name}:`;
          return telemetry;
        },
      );
  const createRedis = vi.fn().mockReturnValue(redis);
  redis.bind(producer);
  return {
    adapter: queueModule.createDownloadQueueAdapter({
      environment: options.environment ?? {
        TF_DOWNLOAD_QUEUE_REDIS_URL_FILE: "/queue-url",
        TF_DOWNLOAD_QUEUE_ALLOW_INSECURE_REDIS: "true",
      },
      readFile:
        options.readFile ??
        (async () =>
          Buffer.from(
            options.queueUrl ??
              "redis://default:p%40ss@tf-download-redis:6379/0",
          )),
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

  it("passes the queue file bound to injectable readers", async () => {
    const readQueueFile = vi.fn(async (_path: string, _maximumBytes: number) =>
      Buffer.from("redis://default:p%40ss@tf-download-redis:6379/0"),
    );
    const { adapter } = createAdapter({ readFile: readQueueFile });

    await adapter.init();

    expect(readQueueFile).toHaveBeenCalledOnce();
    expect(readQueueFile).toHaveBeenCalledWith("/queue-url", 2_048);
  });

  it("rejects an oversized sparse queue file before creating clients", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "apollo-api-queue-"));
    const queueFile = path.join(directory, "queue-url");
    const file = await open(queueFile, "w");
    try {
      await file.truncate(2_147_483_648);
    } finally {
      await file.close();
    }
    const createQueue = vi.fn();
    const createRedis = vi.fn();
    const adapter = queueModule.createDownloadQueueAdapter({
      environment: {
        TF_DOWNLOAD_QUEUE_REDIS_URL_FILE: queueFile,
        TF_DOWNLOAD_QUEUE_ALLOW_INSECURE_REDIS: "true",
      },
      createQueue: createQueue as never,
      createRedis,
    });

    try {
      await expect(adapter.init()).rejects.toThrow(
        "invalid runtime configuration",
      );
      expect(createQueue).not.toHaveBeenCalled();
      expect(createRedis).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
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
    const authenticatedLocal = createAdapter({
      queueUrl: "redis://user%20name:p%40ss@tf-download-redis:6379/0",
    });
    await authenticatedLocal.adapter.init();
    expect(authenticatedLocal.createQueue.mock.calls[0]![1]).toMatchObject({
      connection: {
        host: "tf-download-redis",
        port: 6379,
        db: 0,
        username: "user name",
        password: "p@ss",
      },
    });
    for (const queueUrl of [
      "rediss://queue.example.test/03",
      "rediss://queue.example.test/16",
      "rediss://queue.example.test/3/extra",
      "rediss://queue.example.test/3?query=value",
      "rediss://queue.example.test/3#fragment",
      "rediss:///0",
      "redis://tf-download-redis:6379/1",
      "redis://tf-download-redis:6379/0",
      "redis://default:@tf-download-redis:6379/0",
      "redis://default:password@tf-download-redis:6380/0",
      "redis://default:password@api-server:6379/0",
      "redis://default:password@10.0.0.2:6379/0",
      "redis://user%ZZ:password@tf-download-redis:6379/0",
      "redis://default:password%E0%A4%A@tf-download-redis:6379/0",
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

  it("uses the shared hash-tagged prefix for every Queue client and admission key", async () => {
    const { adapter, createQueue, producer, redis } = createAdapter();
    expect(new FakeQueue().toKey("wait")).not.toContain(DOWNLOAD_QUEUE_PREFIX);
    await adapter.init();
    expect(createQueue.mock.calls[0]![1]).toMatchObject({
      prefix: DOWNLOAD_QUEUE_PREFIX,
    });
    expect(createQueue.mock.calls[1]![1]).toMatchObject({
      prefix: DOWNLOAD_QUEUE_PREFIX,
    });
    await adapter.enqueue(validJob);
    const admissionCall = redis.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("HSET"),
    );
    expect(admissionCall).toBeDefined();
    const keys = [...admissionCall!.slice(2, 9), admissionCall!.at(-1)].map(
      String,
    );
    expect(keys).toHaveLength(8);
    expect(
      keys.every((key) => key.startsWith(`${DOWNLOAD_QUEUE_PREFIX}:`)),
    ).toBe(true);
    expect(new Set(keys.map((key) => key.match(/\{[^{}]+\}/)?.[0]))).toEqual(
      new Set([DOWNLOAD_QUEUE_PREFIX]),
    );
    expect(producer.toKey("wait")).toBe(
      `${DOWNLOAD_QUEUE_PREFIX}:apollo-tf-downloads-v1:wait`,
    );
  });

  it("keeps a stalled pending intent through an expired old mutex lease", async () => {
    const redis = new FakeRedis();
    const first = new FakeQueue();
    const second = new FakeQueue();
    first.counts.waiting = 199;
    second.counts = first.counts;
    second.jobs = first.jobs;
    let startAdd!: () => void;
    const addStarted = new Promise<void>((resolve) => {
      startAdd = resolve;
    });
    let resumeAdd!: () => void;
    first.addGate = new Promise<void>((resolve) => {
      resumeAdd = resolve;
    });
    first.onAddStarted = startAdd;
    const a = createAdapter({ producer: first, redis }).adapter;
    const b = createAdapter({ producer: second, redis }).adapter;
    await Promise.all([a.init(), b.init()]);
    const firstAdmission = a.enqueue(validJob);
    await addStarted;
    redis.lockExpiresAt = Date.now() - 1;
    await expect(b.enqueue(validJob)).rejects.toBeInstanceOf(
      queueModule.DownloadQueueCapacityError,
    );
    resumeAdd();
    await expect(firstAdmission).resolves.toMatchObject({ position: 200 });
    expect(first.counts.waiting).toBe(200);
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
    expect(redis.calls).toContainEqual(
      expect.arrayContaining([
        producer.toKey("wait"),
        producer.toKey("active"),
        producer.toKey("delayed"),
        producer.toKey("prioritized"),
        producer.toKey("waiting-children"),
        producer.toKey("paused"),
        producer.toKey("admission-intents"),
      ]),
    );
    expect(producer.added).toHaveLength(0);
  });

  it("reconciles an accepted ambiguous add and removes its intent", async () => {
    const { adapter, producer, redis } = createAdapter();
    producer.ambiguousAccepted = true;
    producer.addError = new Error("timeout");
    await adapter.init();
    await expect(adapter.enqueue(validJob)).resolves.toMatchObject({
      jobId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(redis.ledgerFor(producer)).toEqual(new Map());
  });

  it("releases a confirmed absent intent so the final slot can be retried", async () => {
    const absent = createAdapter();
    absent.producer.counts.waiting = 199;
    absent.producer.addError = new Error("timeout");
    await absent.adapter.init();
    await expect(absent.adapter.enqueue(validJob)).rejects.toBeInstanceOf(
      queueModule.DownloadQueueUnavailableError,
    );
    expect(absent.redis.ledgerFor(absent.producer)).toEqual(new Map());
    absent.producer.addError = undefined;
    await expect(absent.adapter.enqueue(validJob)).resolves.toMatchObject({
      position: 200,
    });
  });

  it("retains an unresolved intent and blocks the final slot", async () => {
    const redis = new FakeRedis();
    const first = new FakeQueue();
    const second = new FakeQueue();
    first.counts.waiting = 199;
    second.counts = first.counts;
    second.jobs = first.jobs;
    first.addError = new Error("timeout");
    first.getJobError = new Error("redis down");
    const a = createAdapter({ producer: first, redis }).adapter;
    const b = createAdapter({ producer: second, redis }).adapter;
    await Promise.all([a.init(), b.init()]);
    await expect(a.enqueue(validJob)).rejects.toBeInstanceOf(
      queueModule.DownloadQueueUnavailableError,
    );
    expect(redis.ledgerFor(first)).toHaveLength(1);
    await expect(b.enqueue(validJob)).rejects.toBeInstanceOf(
      queueModule.DownloadQueueCapacityError,
    );
  });

  it("prunes an existing job's redundant intent before counting capacity", async () => {
    const { adapter, producer, redis } = createAdapter();
    producer.counts.waiting = 199;
    producer.jobs.set("existing", {
      id: "existing",
      data: validJob,
    });
    redis.ledgerFor(producer).set("existing", intentFor(validJob));
    await adapter.init();
    await expect(adapter.enqueue(validJob)).resolves.toMatchObject({
      position: 200,
    });
    expect(redis.ledgerFor(producer)).toEqual(new Map());
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

  it("reconciles a wrong Queue.add return id through the preassigned id", async () => {
    const { adapter, producer, redis } = createAdapter();
    producer.addId = "different-job-id";
    await adapter.init();
    await expect(adapter.enqueue(validJob)).resolves.toMatchObject({
      jobId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(redis.ledgerFor(producer)).toEqual(new Map());
  });

  it("fails closed on a malformed ledger admission result", async () => {
    const { adapter, redis } = createAdapter();
    redis.reserveResult = "not-a-number";
    await adapter.init();
    await expect(adapter.enqueue(validJob)).rejects.toBeInstanceOf(
      queueModule.DownloadQueueUnavailableError,
    );
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

  it("contains no expiring admission lock, worker, or downloader code", async () => {
    const source = await readFile(
      new URL("./background-queue.ts", import.meta.url),
      "utf8",
    );
    const enqueueSource = source.slice(
      source.indexOf("async enqueue"),
      source.indexOf("async telemetry"),
    );
    expect(enqueueSource).not.toContain("ADMISSION_LOCK");
    expect(enqueueSource).not.toContain("PX");
    expect(enqueueSource).not.toContain("Date.now");
    expect(enqueueSource).not.toContain("getJobCounts");
    expect(source).not.toMatch(/new\s+Worker/);
    expect(source).not.toContain("spawnAudioDownload");
  });
});
