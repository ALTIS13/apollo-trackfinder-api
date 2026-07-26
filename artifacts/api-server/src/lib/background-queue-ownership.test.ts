import { readFile } from "node:fs/promises";

import {
  DOWNLOAD_JOB_CANCELLATION_FIELD,
  DOWNLOAD_JOB_CANCELLATION_SENTINEL,
  encodeDownloadAdmissionIntent,
  getDownloadQueueAdmissionLedgerKey,
  getDownloadQueueJobHashKey,
} from "@workspace/tf-download-contract";
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
const QUEUE_URL = `redis://default:${encodeURIComponent(
  `p@ss${"q".repeat(28)}`,
)}@tf-download-redis:6379/0`;

const queueModule = await import("./background-queue.js");

type PendingState =
  | "delayed"
  | "prioritized"
  | "active"
  | "waiting"
  | "paused"
  | "waiting-children";
type TerminalState = "completed" | "failed";
type SeededState = PendingState | TerminalState | "unknown";

function job(id: string, data: unknown, state: string, failedReason?: string) {
  return {
    id,
    data,
    progress: 42,
    returnvalue: undefined,
    failedReason,
    getState: vi.fn(async () => state),
  };
}

class CancellationRedis {
  readonly eval = vi.fn(
    async (
      script: string,
      keyCount: number,
      ...arguments_: string[]
    ): Promise<string> => {
      this.beforeEval?.();
      this.beforeEval = undefined;
      const keys = arguments_.slice(0, keyCount);
      const args = arguments_.slice(keyCount);
      if (!script.includes("worker-mediated-download-cancellation")) {
        throw new Error("unexpected script");
      }
      const [
        completedKey,
        failedKey,
        delayedKey,
        prioritizedKey,
        activeKey,
        waitKey,
        pausedKey,
        waitingChildrenKey,
        jobKey,
        ledgerKey,
      ] = keys;
      const [jobId, accountId, markerField, markerSentinel, expectedIntent] =
        args;
      const rawData = this.hashes.get(jobKey!)?.get("data");
      if (rawData === undefined) return "unknown";

      let data: unknown;
      try {
        data = JSON.parse(rawData);
      } catch {
        return "unknown";
      }
      if (
        data === null ||
        typeof data !== "object" ||
        Array.isArray(data) ||
        typeof (data as { accountId?: unknown }).accountId !== "string" ||
        (data as { accountId: string }).accountId !== accountId
      ) {
        return "unknown";
      }

      let state:
        | "completed"
        | "failed"
        | "canceled"
        | "waiting"
        | "active"
        | "unknown";
      if (this.zset(completedKey!).has(jobId!)) {
        state = "completed";
      } else if (this.zset(failedKey!).has(jobId!)) {
        state =
          this.hashes.get(jobKey!)?.get("failedReason") === "download_canceled"
            ? "canceled"
            : "failed";
      } else if (this.zset(delayedKey!).has(jobId!)) {
        state = "waiting";
      } else if (this.zset(prioritizedKey!).has(jobId!)) {
        state = "waiting";
      } else if (this.list(activeKey!).includes(jobId!)) {
        state = "active";
      } else if (this.list(waitKey!).includes(jobId!)) {
        state = "waiting";
      } else if (this.list(pausedKey!).includes(jobId!)) {
        state = "waiting";
      } else if (this.zset(waitingChildrenKey!).has(jobId!)) {
        state = "waiting";
      } else {
        state = "unknown";
      }

      const pending = state === "waiting" || state === "active";
      const terminal =
        state === "completed" || state === "failed" || state === "canceled";
      if (!pending && !terminal) return state;
      const ledger = this.hash(ledgerKey!);
      const storedIntent = ledger.get(jobId!);
      if (storedIntent !== undefined && storedIntent !== expectedIntent) {
        return "ledger_mismatch";
      }
      if (pending) this.hash(jobKey!).set(markerField!, markerSentinel!);
      if (storedIntent === expectedIntent) ledger.delete(jobId!);
      return state;
    },
  );
  readonly set = vi.fn(async () => "OK");
  readonly del = vi.fn(async () => 0);
  readonly hashes = new Map<string, Map<string, string>>();
  readonly zsets = new Map<string, Set<string>>();
  readonly lists = new Map<string, string[]>();
  beforeEval: (() => void) | undefined;

  on = vi.fn();
  async connect(): Promise<void> {}
  async ping(): Promise<string> {
    return "PONG";
  }
  async quit(): Promise<void> {}

  hash(key: string): Map<string, string> {
    let hash = this.hashes.get(key);
    if (hash === undefined) {
      hash = new Map();
      this.hashes.set(key, hash);
    }
    return hash;
  }

  zset(key: string): Set<string> {
    let zset = this.zsets.get(key);
    if (zset === undefined) {
      zset = new Set();
      this.zsets.set(key, zset);
    }
    return zset;
  }

  list(key: string): string[] {
    let list = this.lists.get(key);
    if (list === undefined) {
      list = [];
      this.lists.set(key, list);
    }
    return list;
  }
}

function createAdapter(
  jobs: Map<string, ReturnType<typeof job>> = new Map(),
  collections: Partial<
    Record<"waiting" | "delayed" | "active" | "completed" | "failed", unknown[]>
  > = {},
) {
  const redis = new CancellationRedis();
  const producer = {
    on: vi.fn(),
    waitUntilReady: async () => {},
    close: async () => {},
    getWaitingCount: async () => 0,
    getActiveCount: async () => 0,
    toKey: (suffix: string) =>
      `{apollo-tf-downloads}:apollo-tf-downloads-v1:${suffix}`,
    add: async () => ({ id: "new" }),
    getJob: vi.fn(async (id: string) => jobs.get(id)),
    getWaiting: async () => collections.waiting ?? [...jobs.values()],
    getDelayed: async () => collections.delayed ?? [],
    getActive: async () => collections.active ?? [],
    getCompleted: async () => collections.completed ?? [],
    getFailed: async () => collections.failed ?? [],
  };
  const adapter = queueModule.createDownloadQueueAdapter({
    environment: {
      TF_DOWNLOAD_QUEUE_REDIS_URL_FILE: "/queue-url",
      TF_DOWNLOAD_QUEUE_ALLOW_INSECURE_REDIS: "true",
    },
    readFile: async () => Buffer.from(QUEUE_URL),
    createQueue: vi
      .fn()
      .mockReturnValueOnce(producer)
      .mockReturnValueOnce({ ...producer, on: vi.fn() }),
    createRedis: vi.fn().mockReturnValue(redis),
  });
  return { adapter, producer, redis };
}

function seedState(
  redis: CancellationRedis,
  producer: { toKey(suffix: string): string },
  jobId: string,
  state: SeededState,
  options: {
    readonly data?: unknown;
    readonly rawData?: string;
    readonly failedReason?: string;
  } = {},
): void {
  const jobKey = getDownloadQueueJobHashKey(producer.toKey, jobId);
  const hash = redis.hash(jobKey);
  if (options.rawData !== undefined) hash.set("data", options.rawData);
  else hash.set("data", JSON.stringify(options.data ?? JOB_DATA));
  if (options.failedReason !== undefined) {
    hash.set("failedReason", options.failedReason);
  }

  if (
    state === "completed" ||
    state === "failed" ||
    state === "delayed" ||
    state === "prioritized" ||
    state === "waiting-children"
  ) {
    redis.zset(producer.toKey(state)).add(jobId);
  } else if (state === "active") {
    redis.list(producer.toKey("active")).push(jobId);
  } else if (state === "waiting") {
    redis.list(producer.toKey("wait")).push(jobId);
  } else if (state === "paused") {
    redis.list(producer.toKey("paused")).push(jobId);
  }
}

function marker(
  redis: CancellationRedis,
  producer: { toKey(suffix: string): string },
  jobId: string,
): string | undefined {
  return redis.hashes
    .get(getDownloadQueueJobHashKey(producer.toKey, jobId))
    ?.get(DOWNLOAD_JOB_CANCELLATION_FIELD);
}

function ledger(
  redis: CancellationRedis,
  producer: { toKey(suffix: string): string },
): Map<string, string> {
  return redis.hash(
    getDownloadQueueAdmissionLedgerKey((suffix) => producer.toKey(suffix)),
  );
}

describe("download queue ownership, states, and cancellation", () => {
  it("hides foreign and malformed owners from status and list", async () => {
    const foreign = job(
      "foreign",
      { ...JOB_DATA, accountId: FOREIGN_ACCOUNT_ID },
      "active",
    );
    const malformed = job(
      "malformed",
      { ...JOB_DATA, accountId: "legacy-owner" },
      "completed",
    );
    const { adapter } = createAdapter(
      new Map([
        [foreign.id, foreign],
        [malformed.id, malformed],
      ]),
      { active: [foreign], completed: [malformed] },
    );
    await adapter.init();

    await expect(adapter.status(foreign.id, ACCOUNT_ID)).resolves.toEqual({
      status: "unknown",
      progress: 0,
    });
    await expect(adapter.status(malformed.id, ACCOUNT_ID)).resolves.toEqual({
      status: "unknown",
      progress: 0,
    });
    await expect(adapter.list(ACCOUNT_ID)).resolves.toEqual([]);
  });

  it("maps delayed and other pending BullMQ states to waiting", async () => {
    for (const state of [
      "waiting",
      "delayed",
      "paused",
      "prioritized",
      "waiting-children",
    ]) {
      const current = job(state, JOB_DATA, state);
      const { adapter } = createAdapter(new Map([[current.id, current]]), {
        waiting: state === "waiting" ? [current] : [],
        delayed: state === "delayed" ? [current] : [],
      });
      await adapter.init();
      await expect(adapter.status(current.id, ACCOUNT_ID)).resolves.toEqual(
        expect.objectContaining({ status: "waiting" }),
      );
    }
  });

  it.each([
    ["completed", "completed", undefined],
    ["failed", "failed", "upstream_failed"],
    ["failed", "canceled", "download_canceled"],
    ["delayed", "waiting", undefined],
    ["prioritized", "waiting", undefined],
    ["active", "active", undefined],
    ["waiting", "waiting", undefined],
    ["paused", "waiting", undefined],
    ["waiting-children", "waiting", undefined],
    ["unknown", "unknown", undefined],
  ] as const)(
    "atomically maps BullMQ %s to %s with exact getState precedence",
    async (state, expected, failedReason) => {
      const { adapter, producer, redis } = createAdapter();
      seedState(redis, producer, state, state, { failedReason });
      await adapter.init();

      await expect(adapter.cancel(state, ACCOUNT_ID)).resolves.toEqual({
        status: expected,
      });
      expect(marker(redis, producer, state)).toBe(
        expected === "waiting" || expected === "active"
          ? DOWNLOAD_JOB_CANCELLATION_SENTINEL
          : undefined,
      );
    },
  );

  it.each([
    ["completed", "completed", undefined],
    ["failed", "failed", "upstream_failed"],
    ["failed", "canceled", "download_canceled"],
  ] as const)(
    "releases the exact pending owner intent before returning terminal %s as %s",
    async (state, expected, failedReason) => {
      const { adapter, producer, redis } = createAdapter();
      const jobId = `terminal-${expected}`;
      seedState(redis, producer, jobId, state, { failedReason });
      ledger(redis, producer).set(
        jobId,
        encodeDownloadAdmissionIntent("pending", ACCOUNT_ID),
      );
      await adapter.init();

      await expect(adapter.cancel(jobId, ACCOUNT_ID)).resolves.toEqual({
        status: expected,
      });
      expect(marker(redis, producer, jobId)).toBeUndefined();
      expect(ledger(redis, producer).has(jobId)).toBe(false);
    },
  );

  it.each([
    encodeDownloadAdmissionIntent("pending", FOREIGN_ACCOUNT_ID),
    encodeDownloadAdmissionIntent("confirmed", ACCOUNT_ID),
    "corrupt",
  ])(
    "fails closed without mutating terminal ownership evidence for ledger value %s",
    async (intent) => {
      const { adapter, producer, redis } = createAdapter();
      const jobId = "terminal-ledger-mismatch";
      seedState(redis, producer, jobId, "completed");
      ledger(redis, producer).set(jobId, intent);
      await adapter.init();

      await expect(adapter.cancel(jobId, ACCOUNT_ID)).rejects.toBeInstanceOf(
        queueModule.DownloadQueueUnavailableError,
      );
      expect(marker(redis, producer, jobId)).toBeUndefined();
      expect(ledger(redis, producer).get(jobId)).toBe(intent);
    },
  );

  it.each([
    ["foreign", JSON.stringify({ ...JOB_DATA, accountId: FOREIGN_ACCOUNT_ID })],
    ["malformed-json", "{"],
    ["json-string", JSON.stringify("legacy")],
    ["json-array", JSON.stringify([JOB_DATA])],
    ["numeric-owner", JSON.stringify({ ...JOB_DATA, accountId: 7 })],
  ])(
    "returns unknown for %s job data without mutation",
    async (jobId, rawData) => {
      const { adapter, producer, redis } = createAdapter();
      seedState(redis, producer, jobId, "waiting", { rawData });
      ledger(redis, producer).set(
        jobId,
        encodeDownloadAdmissionIntent("pending", ACCOUNT_ID),
      );
      await adapter.init();

      await expect(adapter.cancel(jobId, ACCOUNT_ID)).resolves.toEqual({
        status: "unknown",
      });
      expect(marker(redis, producer, jobId)).toBeUndefined();
      expect(ledger(redis, producer).get(jobId)).toBe(
        encodeDownloadAdmissionIntent("pending", ACCOUNT_ID),
      );
    },
  );

  it("returns unknown for a missing data field without mutation", async () => {
    const { adapter, producer, redis } = createAdapter();
    const jobId = "missing-data";
    redis.hash(getDownloadQueueJobHashKey(producer.toKey, jobId));
    redis.list(producer.toKey("wait")).push(jobId);
    await adapter.init();

    await expect(adapter.cancel(jobId, ACCOUNT_ID)).resolves.toEqual({
      status: "unknown",
    });
    expect(marker(redis, producer, jobId)).toBeUndefined();
  });

  it("sets the marker and releases only the exact pending owner intent", async () => {
    const { adapter, producer, redis } = createAdapter();
    const jobId = "exact-ledger";
    seedState(redis, producer, jobId, "waiting");
    ledger(redis, producer).set(
      jobId,
      encodeDownloadAdmissionIntent("pending", ACCOUNT_ID),
    );
    await adapter.init();

    await expect(adapter.cancel(jobId, ACCOUNT_ID)).resolves.toEqual({
      status: "waiting",
    });
    expect(marker(redis, producer, jobId)).toBe(
      DOWNLOAD_JOB_CANCELLATION_SENTINEL,
    );
    expect(ledger(redis, producer).has(jobId)).toBe(false);
  });

  it("sets the marker when no admission intent remains", async () => {
    const { adapter, producer, redis } = createAdapter();
    const jobId = "no-ledger";
    seedState(redis, producer, jobId, "active");
    await adapter.init();

    await expect(adapter.cancel(jobId, ACCOUNT_ID)).resolves.toEqual({
      status: "active",
    });
    expect(marker(redis, producer, jobId)).toBe(
      DOWNLOAD_JOB_CANCELLATION_SENTINEL,
    );
  });

  it.each([
    encodeDownloadAdmissionIntent("pending", FOREIGN_ACCOUNT_ID),
    encodeDownloadAdmissionIntent("confirmed", ACCOUNT_ID),
    "corrupt",
  ])("fails closed without mutation for ledger value %s", async (intent) => {
    const { adapter, producer, redis } = createAdapter();
    const jobId = "mismatched-ledger";
    seedState(redis, producer, jobId, "waiting");
    ledger(redis, producer).set(jobId, intent);
    await adapter.init();

    await expect(adapter.cancel(jobId, ACCOUNT_ID)).rejects.toBeInstanceOf(
      queueModule.DownloadQueueUnavailableError,
    );
    expect(String(redis.eval.mock.calls[0]?.[0])).toContain(
      "worker-mediated-download-cancellation",
    );
    expect(marker(redis, producer, jobId)).toBeUndefined();
    expect(ledger(redis, producer).get(jobId)).toBe(intent);
  });

  it("makes duplicate same-owner requests idempotent", async () => {
    const { adapter, producer, redis } = createAdapter();
    const jobId = "duplicate";
    seedState(redis, producer, jobId, "waiting");
    ledger(redis, producer).set(
      jobId,
      encodeDownloadAdmissionIntent("pending", ACCOUNT_ID),
    );
    await adapter.init();

    await expect(adapter.cancel(jobId, ACCOUNT_ID)).resolves.toEqual({
      status: "waiting",
    });
    await expect(adapter.cancel(jobId, ACCOUNT_ID)).resolves.toEqual({
      status: "waiting",
    });
    expect(marker(redis, producer, jobId)).toBe(
      DOWNLOAD_JOB_CANCELLATION_SENTINEL,
    );
    expect(ledger(redis, producer).has(jobId)).toBe(false);
  });

  it("returns active when a queued job races active before the script", async () => {
    const { adapter, producer, redis } = createAdapter();
    const jobId = "queued-active";
    seedState(redis, producer, jobId, "waiting");
    ledger(redis, producer).set(
      jobId,
      encodeDownloadAdmissionIntent("pending", ACCOUNT_ID),
    );
    redis.beforeEval = () => {
      redis.lists.set(
        producer.toKey("wait"),
        redis.list(producer.toKey("wait")).filter((id) => id !== jobId),
      );
      redis.list(producer.toKey("active")).push(jobId);
    };
    await adapter.init();

    await expect(adapter.cancel(jobId, ACCOUNT_ID)).resolves.toEqual({
      status: "active",
    });
    expect(marker(redis, producer, jobId)).toBe(
      DOWNLOAD_JOB_CANCELLATION_SENTINEL,
    );
    expect(ledger(redis, producer).has(jobId)).toBe(false);
  });

  it("returns completed and releases the exact intent when active races completed", async () => {
    const { adapter, producer, redis } = createAdapter();
    const jobId = "active-completed";
    seedState(redis, producer, jobId, "active");
    ledger(redis, producer).set(
      jobId,
      encodeDownloadAdmissionIntent("pending", ACCOUNT_ID),
    );
    redis.beforeEval = () => {
      redis.zset(producer.toKey("completed")).add(jobId);
    };
    await adapter.init();

    await expect(adapter.cancel(jobId, ACCOUNT_ID)).resolves.toEqual({
      status: "completed",
    });
    expect(marker(redis, producer, jobId)).toBeUndefined();
    expect(ledger(redis, producer).has(jobId)).toBe(false);
  });

  it("uses one same-slot Lua call and no remove, events, tombstones, or cancel keys", async () => {
    const { adapter, producer, redis } = createAdapter();
    const jobId = "single-operation";
    seedState(redis, producer, jobId, "waiting");
    await adapter.init();

    await adapter.cancel(jobId, ACCOUNT_ID);

    expect(redis.eval).toHaveBeenCalledOnce();
    expect(producer.getJob).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
    const [, keyCount, ...arguments_] = redis.eval.mock.calls[0]!;
    const keys = arguments_.slice(0, keyCount as number).map(String);
    expect(keys).toHaveLength(10);
    expect(keys).toContain(getDownloadQueueJobHashKey(producer.toKey, jobId));
    expect(keys).toContain(
      getDownloadQueueAdmissionLedgerKey((suffix) => producer.toKey(suffix)),
    );
    expect(new Set(keys.map((key) => key.match(/\{[^{}]+\}/)?.[0]))).toEqual(
      new Set(["{apollo-tf-downloads}"]),
    );
    expect(keys.join("\n")).not.toMatch(/events|canceled|cursor/);

    const source = await readFile(
      new URL("./background-queue.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/job\.remove|canceled-cursor|QueueEvents/);
    expect(source).not.toMatch(/tombstone|cancellation-receipt/i);
    expect(source).not.toContain(`${"${DOWNLOAD_QUEUE_NAME}"}:cancel:`);
  });
});
