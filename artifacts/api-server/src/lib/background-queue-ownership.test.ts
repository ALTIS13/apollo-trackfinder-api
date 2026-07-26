import { describe, expect, it, vi } from "vitest";

const ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";
const FOREIGN_ACCOUNT_ID = "20000000-0000-4000-8000-000000000002";
const JOB_DATA = {
  schemaVersion: 1,
  accountId: ACCOUNT_ID,
  trackId: "yt_example",
  artist: "Artist",
  title: "Title",
  quality: "320",
  sourceUrl: "https://www.youtube.com/watch?v=example",
  createdAt: "2026-07-26T00:00:00.000Z",
} as const;
const queueModule = await import("./background-queue.js");
const adapterModule = queueModule as typeof queueModule & {
  createDownloadQueueAdapter(options: unknown): any;
};

function job(
  id: string,
  data: unknown,
  states: string[],
  failedReason?: string,
) {
  return {
    id,
    data,
    progress: 42,
    failedReason,
    getState: vi.fn(async () => states.shift() ?? "completed"),
    remove: vi.fn(async () => {}),
  };
}

function createAdapter(
  jobs: Map<string, ReturnType<typeof job>>,
  collections: Partial<
    Record<"waiting" | "delayed" | "active" | "completed" | "failed", unknown[]>
  > = {},
) {
  const producer = {
    on: vi.fn(),
    waitUntilReady: async () => {},
    getJob: async (id: string) => jobs.get(id),
    getWaitingCount: async () => 0,
    getActiveCount: async () => 0,
    getJobCounts: async () => ({}),
    toKey: (type: string) => `tenant:{apollo-downloads}:${type}`,
    getWaiting: async () => collections.waiting ?? [...jobs.values()],
    getDelayed: async () => collections.delayed ?? [],
    getActive: async () => collections.active ?? [],
    getCompleted: async () => collections.completed ?? [],
    getFailed: async () => collections.failed ?? [],
    add: async () => ({ id: "new" }),
    close: async () => {},
  };
  const telemetry = { ...producer, on: vi.fn() };
  const ledger = new Map<string, string>();
  const redis = {
    on: vi.fn(),
    connect: async () => {},
    ping: async () => "PONG",
    eval: vi.fn(
      async (_script: string, keyCount: number, ...args: string[]) => {
        const values = args.slice(keyCount);
        const stored = ledger.get(values[0]!);
        if (stored === undefined) return 1;
        if (stored !== values[1]) return 0;
        ledger.delete(values[0]!);
        return 1;
      },
    ),
    set: vi.fn(async () => "OK"),
    del: vi.fn(async () => 1),
    quit: async () => {},
  };
  return {
    adapter: adapterModule.createDownloadQueueAdapter({
      environment: {
        TF_DOWNLOAD_QUEUE_REDIS_URL_FILE: "/queue-url",
        TF_DOWNLOAD_QUEUE_ALLOW_INSECURE_REDIS: "true",
      },
      readFile: async () =>
        Buffer.from("redis://default:p%40ss@tf-download-redis:6379/0"),
      createQueue: vi
        .fn()
        .mockReturnValueOnce(producer)
        .mockReturnValueOnce(telemetry),
      createRedis: vi.fn().mockReturnValue(redis),
    }),
    producer,
    redis,
    ledger,
  };
}

describe("download queue ownership, states, and cancellation", () => {
  it("hides foreign and malformed owners", async () => {
    const foreign = job(
      "foreign",
      { ...JOB_DATA, accountId: FOREIGN_ACCOUNT_ID },
      ["active"],
    );
    const malformed = job(
      "malformed",
      { ...JOB_DATA, accountId: "legacy-owner" },
      ["completed"],
    );
    const { adapter } = createAdapter(
      new Map([
        [foreign.id, foreign],
        [malformed.id, malformed],
      ]),
    );
    await adapter.init();
    await expect(adapter.status("foreign", ACCOUNT_ID)).resolves.toEqual({
      status: "unknown",
      progress: 0,
    });
    await expect(adapter.status("malformed", ACCOUNT_ID)).resolves.toEqual({
      status: "unknown",
      progress: 0,
    });
    await expect(adapter.list(ACCOUNT_ID)).resolves.toEqual([]);
  });

  it("maps delayed and other pending BullMQ states to waiting and lists delayed jobs", async () => {
    const delayed = job("delayed", JOB_DATA, ["delayed", "delayed"]);
    const { adapter } = createAdapter(new Map([[delayed.id, delayed]]), {
      waiting: [],
      delayed: [delayed],
      active: [],
      completed: [],
      failed: [],
    });
    await adapter.init();
    await expect(adapter.status("delayed", ACCOUNT_ID)).resolves.toMatchObject({
      status: "waiting",
    });
    await expect(adapter.list(ACCOUNT_ID)).resolves.toEqual([
      expect.objectContaining({ jobId: "delayed", status: "waiting" }),
    ]);
  });

  it("removes delayed jobs without a separate capacity record", async () => {
    const delayed = job("delayed", JOB_DATA, ["delayed"]);
    const { adapter, redis } = createAdapter(new Map([[delayed.id, delayed]]));
    await adapter.init();
    await expect(adapter.cancel("delayed", ACCOUNT_ID)).resolves.toEqual({
      status: "canceled",
    });
    expect(delayed.remove).toHaveBeenCalledOnce();
  });

  it("owner-releases a matching pending intent after delayed removal", async () => {
    const delayed = job("delayed", JOB_DATA, ["delayed"]);
    const { adapter, ledger } = createAdapter(new Map([[delayed.id, delayed]]));
    ledger.set(delayed.id, `pending:${ACCOUNT_ID}`);
    await adapter.init();
    await expect(adapter.cancel("delayed", ACCOUNT_ID)).resolves.toEqual({
      status: "canceled",
    });
    expect(ledger).toEqual(new Map());
  });

  it("cannot release another account's pending intent", async () => {
    const delayed = job("delayed", JOB_DATA, ["delayed"]);
    const { adapter, ledger } = createAdapter(new Map([[delayed.id, delayed]]));
    ledger.set(delayed.id, `pending:${FOREIGN_ACCOUNT_ID}`);
    await adapter.init();
    await expect(adapter.cancel("delayed", ACCOUNT_ID)).rejects.toBeInstanceOf(
      queueModule.DownloadQueueUnavailableError,
    );
    expect(ledger).toEqual(
      new Map([[delayed.id, `pending:${FOREIGN_ACCOUNT_ID}`]]),
    );
  });

  it("rereads a remove race and cancels active work with the exact TTL", async () => {
    const raced = job("raced", JOB_DATA, ["waiting", "active", "active"]);
    raced.remove.mockRejectedValueOnce(new Error("state changed"));
    const { adapter, redis } = createAdapter(new Map([[raced.id, raced]]));
    await adapter.init();
    await expect(adapter.cancel("raced", ACCOUNT_ID)).resolves.toEqual({
      status: "canceled",
    });
    expect(redis.set).toHaveBeenCalledWith(
      "apollo-tf-downloads-v1:cancel:raced",
      "1",
      "PX",
      1_800_000,
    );
  });

  it("returns the actual terminal state and removes a stale active cancellation key", async () => {
    const raced = job("done", JOB_DATA, ["active", "completed"]);
    const { adapter, redis } = createAdapter(new Map([[raced.id, raced]]));
    await adapter.init();
    await expect(adapter.cancel("done", ACCOUNT_ID)).resolves.toEqual({
      status: "completed",
    });
    expect(redis.del).toHaveBeenCalledWith(
      "apollo-tf-downloads-v1:cancel:done",
    );
  });
});
