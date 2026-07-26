import { describe, expect, it, vi } from "vitest";

const ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";
const FOREIGN_ACCOUNT_ID = "20000000-0000-4000-8000-000000000002";
const pendingCancellation = (accountId: string) => `pending:${accountId}`;
const finalCancellation = (accountId: string) => `canceled:${accountId}`;
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
  const values = new Map<string, string>();
  const redis = {
    on: vi.fn(),
    connect: async () => {},
    ping: async () => "PONG",
    eval: vi.fn(
      async (_script: string, keyCount: number, ...args: string[]) => {
        const keys = args.slice(0, keyCount);
        const commandArgs = args.slice(keyCount);
        if (_script.includes("persist-waiting-cancellation")) {
          const [pending, final] = commandArgs;
          const stored = values.get(keys[0]!);
          if (stored !== undefined && stored !== pending && stored !== final) {
            return 0;
          }
          if (stored !== final) values.set(keys[0]!, pending!);
          return 1;
        }
        if (_script.includes("finalize-waiting-cancellation")) {
          const [jobId, expectedIntent, pending, final] = commandArgs;
          const tombstone = values.get(keys[1]!);
          const intent = ledger.get(jobId!);
          if (
            (tombstone !== pending && tombstone !== final) ||
            (intent !== undefined && intent !== expectedIntent)
          ) {
            return 0;
          }
          values.set(keys[1]!, final!);
          if (intent !== undefined) ledger.delete(jobId!);
          return 1;
        }
        if (_script.includes("clear-pending-cancellation")) {
          const [pending, final] = commandArgs;
          const stored = values.get(keys[0]!);
          if (stored === undefined || stored === final) return 1;
          if (stored !== pending) return 0;
          values.delete(keys[0]!);
          return 1;
        }
        const stored = ledger.get(commandArgs[0]!);
        if (stored === undefined) return 1;
        if (stored !== commandArgs[1]) return 0;
        ledger.delete(commandArgs[0]!);
        return 1;
      },
    ),
    set: vi.fn(async (key: string, value: string): Promise<string | null> => {
      values.set(key, value);
      return "OK";
    }),
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    del: vi.fn(async (key: string) => (values.delete(key) ? 1 : 0)),
    quit: async () => {},
  };
  return {
    adapter: adapterModule.createDownloadQueueAdapter({
      environment: {
        TF_DOWNLOAD_QUEUE_REDIS_URL_FILE: "/queue-url",
        TF_DOWNLOAD_QUEUE_ALLOW_INSECURE_REDIS: "true",
      },
      readFile: async () =>
        Buffer.from(
          `redis://default:${encodeURIComponent(
            `p@ss${"q".repeat(28)}`,
          )}@tf-download-redis:6379/0`,
        ),
      createQueue: vi
        .fn()
        .mockReturnValueOnce(producer)
        .mockReturnValueOnce(telemetry),
      createRedis: vi.fn().mockReturnValue(redis),
    }),
    producer,
    redis,
    ledger,
    values,
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

  it("lists at most 200 unique owned jobs in deterministic collection order", async () => {
    const owned = Array.from({ length: 205 }, (_, index) =>
      job(`owned-${String(index).padStart(3, "0")}`, JOB_DATA, []),
    );
    const foreign = job(
      "foreign-first",
      { ...JOB_DATA, accountId: FOREIGN_ACCOUNT_ID },
      [],
    );
    const { adapter } = createAdapter(new Map(), {
      waiting: [foreign, ...owned.slice(0, 120)],
      delayed: [owned[5]!, ...owned.slice(120)],
      active: [],
      completed: [],
      failed: [],
    });
    await adapter.init();

    const listed = await adapter.list(ACCOUNT_ID);

    expect(listed).toHaveLength(200);
    expect(
      listed.map((current: { readonly jobId: string }) => current.jobId),
    ).toEqual(owned.slice(0, 200).map((current) => current.id));
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

  it("writes pending before removal then atomically finalizes and releases capacity", async () => {
    const waiting = job("waiting-job", JOB_DATA, ["waiting"]);
    const jobs = new Map([[waiting.id, waiting]]);
    const events: string[] = [];
    waiting.remove.mockImplementation(async () => {
      events.push("remove");
      jobs.delete(waiting.id);
    });
    const { adapter, producer, redis, ledger, values } = createAdapter(jobs);
    ledger.set(waiting.id, pendingCancellation(ACCOUNT_ID));
    const set = redis.set.getMockImplementation()!;
    redis.set.mockImplementation(async (key: string, value: string) => {
      if (key === producer.toKey(`canceled:${waiting.id}`)) {
        events.push("pending");
      }
      values.set(key, value);
      return set(key, value);
    });
    const evaluate = redis.eval.getMockImplementation()!;
    redis.eval.mockImplementation(
      async (script: string, keyCount: number, ...args: string[]) => {
        if (script.includes("persist-waiting-cancellation")) {
          events.push("pending");
        } else if (
          script.includes("finalize-waiting-cancellation") ||
          script.includes("HDEL")
        ) {
          events.push("finalize");
        }
        return evaluate(script, keyCount, ...args);
      },
    );
    await adapter.init();

    await expect(adapter.cancel(waiting.id, ACCOUNT_ID)).resolves.toEqual({
      status: "canceled",
    });
    expect(events).toEqual(["pending", "remove", "finalize"]);
    expect(ledger).toEqual(new Map());
    expect(values.get(producer.toKey(`canceled:${waiting.id}`))).toBe(
      finalCancellation(ACCOUNT_ID),
    );
  });

  it("does not remove a waiting job when the tombstone write fails", async () => {
    const waiting = job("waiting-job", JOB_DATA, ["waiting"]);
    const { adapter, redis, ledger } = createAdapter(
      new Map([[waiting.id, waiting]]),
    );
    ledger.set(waiting.id, pendingCancellation(ACCOUNT_ID));
    redis.eval.mockRejectedValueOnce(new Error("pending write failed"));
    await adapter.init();

    await expect(adapter.cancel(waiting.id, ACCOUNT_ID)).rejects.toBeInstanceOf(
      queueModule.DownloadQueueUnavailableError,
    );
    expect(waiting.remove).not.toHaveBeenCalled();
    expect(ledger).toEqual(
      new Map([[waiting.id, pendingCancellation(ACCOUNT_ID)]]),
    );
  });

  it("heals finalization and admission release on a missing-job retry", async () => {
    const waiting = job("waiting-job", JOB_DATA, ["waiting"]);
    const jobs = new Map([[waiting.id, waiting]]);
    waiting.remove.mockImplementationOnce(async () => {
      jobs.delete(waiting.id);
    });
    const { adapter, producer, redis, ledger, values } = createAdapter(jobs);
    ledger.set(waiting.id, pendingCancellation(ACCOUNT_ID));
    const evaluate = redis.eval.getMockImplementation()!;
    let failFinalization = true;
    redis.eval.mockImplementation(
      async (script: string, keyCount: number, ...args: string[]) => {
        if (
          failFinalization &&
          (script.includes("finalize-waiting-cancellation") ||
            script.includes("HDEL"))
        ) {
          failFinalization = false;
          throw new Error("finalization unavailable");
        }
        return evaluate(script, keyCount, ...args);
      },
    );
    await adapter.init();

    await expect(adapter.cancel(waiting.id, ACCOUNT_ID)).rejects.toBeInstanceOf(
      queueModule.DownloadQueueUnavailableError,
    );
    expect(values.get(producer.toKey(`canceled:${waiting.id}`))).toBe(
      pendingCancellation(ACCOUNT_ID),
    );
    expect(ledger).toEqual(
      new Map([[waiting.id, pendingCancellation(ACCOUNT_ID)]]),
    );

    await expect(adapter.cancel(waiting.id, ACCOUNT_ID)).resolves.toEqual({
      status: "canceled",
    });
    expect(ledger).toEqual(new Map());
    expect(values.get(producer.toKey(`canceled:${waiting.id}`))).toBe(
      finalCancellation(ACCOUNT_ID),
    );
  });

  it.each(["pending", "canceled"] as const)(
    "reruns finalization for an owned %s tombstone on a missing job",
    async (phase) => {
      const jobId = `${phase}-missing`;
      const { adapter, producer, ledger, values } = createAdapter(new Map());
      ledger.set(jobId, pendingCancellation(ACCOUNT_ID));
      values.set(
        producer.toKey(`canceled:${jobId}`),
        phase === "pending"
          ? pendingCancellation(ACCOUNT_ID)
          : finalCancellation(ACCOUNT_ID),
      );
      await adapter.init();

      await expect(adapter.cancel(jobId, ACCOUNT_ID)).resolves.toEqual({
        status: "canceled",
      });
      expect(ledger).toEqual(new Map());
      expect(values.get(producer.toKey(`canceled:${jobId}`))).toBe(
        finalCancellation(ACCOUNT_ID),
      );
    },
  );

  it.each(["pending", "canceled"] as const)(
    "hides a foreign %s tombstone without mutating it",
    async (phase) => {
      const jobId = `${phase}-foreign`;
      const { adapter, producer, ledger, values } = createAdapter(new Map());
      const foreignTombstone =
        phase === "pending"
          ? pendingCancellation(FOREIGN_ACCOUNT_ID)
          : finalCancellation(FOREIGN_ACCOUNT_ID);
      ledger.set(jobId, pendingCancellation(FOREIGN_ACCOUNT_ID));
      values.set(producer.toKey(`canceled:${jobId}`), foreignTombstone);
      await adapter.init();

      await expect(adapter.cancel(jobId, ACCOUNT_ID)).resolves.toEqual({
        status: "unknown",
      });
      expect(ledger).toEqual(
        new Map([[jobId, pendingCancellation(FOREIGN_ACCOUNT_ID)]]),
      );
      expect(values.get(producer.toKey(`canceled:${jobId}`))).toBe(
        foreignTombstone,
      );
    },
  );

  it("never overwrites a foreign tombstone before waiting removal", async () => {
    const waiting = job("foreign-tombstone", JOB_DATA, ["waiting"]);
    const { adapter, producer, values } = createAdapter(
      new Map([[waiting.id, waiting]]),
    );
    const tombstoneKey = producer.toKey(`canceled:${waiting.id}`);
    values.set(tombstoneKey, pendingCancellation(FOREIGN_ACCOUNT_ID));
    await adapter.init();

    await expect(adapter.cancel(waiting.id, ACCOUNT_ID)).rejects.toBeInstanceOf(
      queueModule.DownloadQueueUnavailableError,
    );
    expect(waiting.remove).not.toHaveBeenCalled();
    expect(values.get(tombstoneKey)).toBe(
      pendingCancellation(FOREIGN_ACCOUNT_ID),
    );
  });

  it("clears only its pending tombstone when removal remains waiting", async () => {
    const waiting = job("waiting-retry", JOB_DATA, ["waiting", "waiting"]);
    waiting.remove.mockRejectedValueOnce(new Error("remove failed"));
    const { adapter, producer, ledger, values } = createAdapter(
      new Map([[waiting.id, waiting]]),
    );
    ledger.set(waiting.id, pendingCancellation(ACCOUNT_ID));
    await adapter.init();

    await expect(adapter.cancel(waiting.id, ACCOUNT_ID)).rejects.toBeInstanceOf(
      queueModule.DownloadQueueUnavailableError,
    );
    expect(values.has(producer.toKey(`canceled:${waiting.id}`))).toBe(false);
    expect(ledger).toEqual(
      new Map([[waiting.id, pendingCancellation(ACCOUNT_ID)]]),
    );
  });

  it("preserves a concurrently finalized tombstone while clearing pending state", async () => {
    const waiting = job("concurrent-final", JOB_DATA, ["waiting", "waiting"]);
    const { adapter, producer, values } = createAdapter(
      new Map([[waiting.id, waiting]]),
    );
    const tombstoneKey = producer.toKey(`canceled:${waiting.id}`);
    waiting.remove.mockImplementationOnce(async () => {
      values.set(tombstoneKey, finalCancellation(ACCOUNT_ID));
      throw new Error("lost remove race");
    });
    await adapter.init();

    await expect(adapter.cancel(waiting.id, ACCOUNT_ID)).rejects.toBeInstanceOf(
      queueModule.DownloadQueueUnavailableError,
    );
    expect(values.get(tombstoneKey)).toBe(finalCancellation(ACCOUNT_ID));
  });

  it.each(["completed", "failed"] as const)(
    "clears pending cancellation when waiting removal races %s",
    async (terminalState) => {
      const raced = job(`raced-${terminalState}`, JOB_DATA, [
        "waiting",
        terminalState,
      ]);
      raced.remove.mockRejectedValueOnce(new Error("state changed"));
      const { adapter, producer, ledger, values } = createAdapter(
        new Map([[raced.id, raced]]),
      );
      ledger.set(raced.id, pendingCancellation(ACCOUNT_ID));
      await adapter.init();

      await expect(adapter.cancel(raced.id, ACCOUNT_ID)).resolves.toEqual({
        status: terminalState,
      });
      expect(values.has(producer.toKey(`canceled:${raced.id}`))).toBe(false);
      expect(ledger).toEqual(
        new Map([[raced.id, pendingCancellation(ACCOUNT_ID)]]),
      );
    },
  );

  it("finalizes only when a waiting removal race is actively canceled", async () => {
    const raced = job("raced-active", JOB_DATA, [
      "waiting",
      "active",
      "active",
    ]);
    raced.remove.mockRejectedValueOnce(new Error("state changed"));
    const { adapter, producer, ledger, values } = createAdapter(
      new Map([[raced.id, raced]]),
    );
    ledger.set(raced.id, pendingCancellation(ACCOUNT_ID));
    await adapter.init();

    await expect(adapter.cancel(raced.id, ACCOUNT_ID)).resolves.toEqual({
      status: "canceled",
    });
    expect(ledger).toEqual(new Map());
    expect(values.get(producer.toKey(`canceled:${raced.id}`))).toBe(
      finalCancellation(ACCOUNT_ID),
    );
  });

  it.each(["completed", "failed"] as const)(
    "does not finalize when active cancellation races %s",
    async (terminalState) => {
      const raced = job(`active-${terminalState}`, JOB_DATA, [
        "waiting",
        "active",
        terminalState,
      ]);
      raced.remove.mockRejectedValueOnce(new Error("state changed"));
      const { adapter, producer, ledger, values } = createAdapter(
        new Map([[raced.id, raced]]),
      );
      ledger.set(raced.id, pendingCancellation(ACCOUNT_ID));
      await adapter.init();

      await expect(adapter.cancel(raced.id, ACCOUNT_ID)).resolves.toEqual({
        status: terminalState,
      });
      expect(values.has(producer.toKey(`canceled:${raced.id}`))).toBe(false);
      expect(ledger).toEqual(
        new Map([[raced.id, pendingCancellation(ACCOUNT_ID)]]),
      );
    },
  );

  it("finalizes an ambiguous remove-to-unknown race", async () => {
    const raced = job("raced-unknown", JOB_DATA, ["waiting", "unknown"]);
    raced.remove.mockRejectedValueOnce(new Error("already removed"));
    const { adapter, producer, ledger, values } = createAdapter(
      new Map([[raced.id, raced]]),
    );
    ledger.set(raced.id, pendingCancellation(ACCOUNT_ID));
    await adapter.init();

    await expect(adapter.cancel(raced.id, ACCOUNT_ID)).resolves.toEqual({
      status: "canceled",
    });
    expect(ledger).toEqual(new Map());
    expect(values.get(producer.toKey(`canceled:${raced.id}`))).toBe(
      finalCancellation(ACCOUNT_ID),
    );
  });

  it("makes concurrent same-owner waiting cancellations both idempotent", async () => {
    const waiting = job("waiting-job", JOB_DATA, []);
    const jobs = new Map([[waiting.id, waiting]]);
    let state = "waiting";
    let removeCalls = 0;
    let releaseFirstRemove!: () => void;
    let finishFirstRemove!: () => void;
    const firstRemoveGate = new Promise<void>((resolve) => {
      releaseFirstRemove = resolve;
    });
    const firstRemoveFinished = new Promise<void>((resolve) => {
      finishFirstRemove = resolve;
    });
    waiting.getState.mockImplementation(async () => state);
    waiting.remove.mockImplementation(async () => {
      removeCalls += 1;
      if (removeCalls === 1) {
        await firstRemoveGate;
        state = "unknown";
        jobs.delete(waiting.id);
        finishFirstRemove();
        return;
      }
      await firstRemoveFinished;
      throw new Error("already removed");
    });
    const { adapter, producer, ledger, values } = createAdapter(jobs);
    ledger.set(waiting.id, pendingCancellation(ACCOUNT_ID));
    await adapter.init();

    const first = adapter.cancel(waiting.id, ACCOUNT_ID);
    await vi.waitFor(() => expect(waiting.remove).toHaveBeenCalledTimes(1));
    const second = adapter.cancel(waiting.id, ACCOUNT_ID);
    await vi.waitFor(() => expect(waiting.remove).toHaveBeenCalledTimes(2));
    releaseFirstRemove();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: "canceled" },
      { status: "canceled" },
    ]);
    expect(ledger).toEqual(new Map());
    expect(values.get(producer.toKey(`canceled:${waiting.id}`))).toBe(
      finalCancellation(ACCOUNT_ID),
    );
  });

  it("keeps waiting cancellation idempotent only for the exact owner", async () => {
    const waiting = job("waiting-job", JOB_DATA, ["waiting"]);
    const jobs = new Map([[waiting.id, waiting]]);
    waiting.remove.mockImplementation(async () => {
      jobs.delete(waiting.id);
    });
    const { adapter, producer, redis, values } = createAdapter(jobs);
    await adapter.init();

    await expect(adapter.cancel(waiting.id, ACCOUNT_ID)).resolves.toEqual({
      status: "canceled",
    });
    await expect(adapter.cancel(waiting.id, ACCOUNT_ID)).resolves.toEqual({
      status: "canceled",
    });
    await expect(
      adapter.cancel(waiting.id, FOREIGN_ACCOUNT_ID),
    ).resolves.toEqual({ status: "unknown" });
    const tombstoneKey = producer.toKey(`canceled:${waiting.id}`);
    expect(values.get(tombstoneKey)).toBe(finalCancellation(ACCOUNT_ID));
    expect(redis.get).toHaveBeenCalledWith(tombstoneKey);
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
