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
  createDownloadQueueAdapter: (options: unknown) => {
    init(): Promise<void>;
    status(jobId: string, accountId: string): Promise<{ status: string; progress: number }>;
    list(accountId: string): Promise<readonly { jobId: string; status: string }[]>;
    cancel(jobId: string, accountId: string): Promise<{ status: string }>;
  };
};

function job(
  id: string,
  data: unknown,
  state: string,
  failedReason?: string,
) {
  return {
    id,
    data,
    progress: 42,
    failedReason,
    getState: vi.fn(async () => state),
    remove: vi.fn(async () => {}),
  };
}

function createAdapter(jobs: Map<string, ReturnType<typeof job>>) {
  const producer = {
    waitUntilReady: async () => {},
    getJob: async (id: string) => jobs.get(id),
    getWaitingCount: async () => 0,
    getActiveCount: async () => 0,
    getWaiting: async () => [...jobs.values()],
    getActive: async () => [...jobs.values()],
    getCompleted: async () => [...jobs.values()],
    getFailed: async () => [...jobs.values()],
    add: async () => ({ id: "new-job" }),
    close: async () => {},
  };
  const telemetry = { ...producer };
  const cancellation = {
    connect: async () => {},
    ping: async () => "PONG",
    set: vi.fn(async () => "OK"),
    quit: async () => {},
  };
  return {
    adapter: adapterModule.createDownloadQueueAdapter({
      environment: {
        TF_DOWNLOAD_QUEUE_REDIS_URL_FILE: "/queue-url",
        TF_DOWNLOAD_QUEUE_ALLOW_INSECURE_REDIS: "true",
      },
      readFile: async () => Buffer.from("redis://tf-download-redis:6379/0"),
      createQueue: vi.fn().mockReturnValueOnce(producer).mockReturnValueOnce(telemetry),
      createRedis: vi.fn().mockReturnValue(cancellation),
    }),
    cancellation,
  };
}

describe("download queue ownership and cancellation", () => {
  it("hides foreign and malformed owners from status and list results", async () => {
    const owned = job("owned", JOB_DATA, "waiting");
    const foreign = job("foreign", { ...JOB_DATA, accountId: FOREIGN_ACCOUNT_ID }, "active");
    const malformed = job("malformed", { ...JOB_DATA, accountId: "legacy-owner" }, "completed");
    const { adapter } = createAdapter(new Map([[owned.id, owned], [foreign.id, foreign], [malformed.id, malformed]]));
    await adapter.init();

    await expect(adapter.status("foreign", ACCOUNT_ID)).resolves.toEqual({ status: "unknown", progress: 0 });
    await expect(adapter.status("malformed", ACCOUNT_ID)).resolves.toEqual({ status: "unknown", progress: 0 });
    await expect(adapter.list(ACCOUNT_ID)).resolves.toEqual([
      expect.objectContaining({ jobId: "owned", status: "waiting" }),
    ]);
  });

  it("removes a waiting owned job and reports cancellation", async () => {
    const waiting = job("waiting", JOB_DATA, "waiting");
    const { adapter, cancellation } = createAdapter(new Map([[waiting.id, waiting]]));
    await adapter.init();

    await expect(adapter.cancel("waiting", ACCOUNT_ID)).resolves.toEqual({ status: "canceled" });
    expect(waiting.remove).toHaveBeenCalledOnce();
    expect(cancellation.set).not.toHaveBeenCalled();
  });

  it("marks active owned work with a bounded cancellation key", async () => {
    const active = job("active", JOB_DATA, "active");
    const { adapter, cancellation } = createAdapter(new Map([[active.id, active]]));
    await adapter.init();

    await expect(adapter.cancel("active", ACCOUNT_ID)).resolves.toEqual({ status: "canceled" });
    expect(cancellation.set).toHaveBeenCalledWith(
      "apollo-tf-downloads-v1:cancel:active",
      "1",
      "PX",
      expect.any(Number),
    );
    expect(cancellation.set).toHaveBeenCalledWith(
      "apollo-tf-downloads-v1:cancel:active",
      "1",
      "PX",
      expect.any(Number),
    );
  });

  it("is idempotent for completed and canceled jobs", async () => {
    const completed = job("completed", JOB_DATA, "completed");
    const canceled = job("canceled", JOB_DATA, "failed", "download_canceled");
    const { adapter, cancellation } = createAdapter(new Map([[completed.id, completed], [canceled.id, canceled]]));
    await adapter.init();

    await expect(adapter.cancel("completed", ACCOUNT_ID)).resolves.toEqual({ status: "completed" });
    await expect(adapter.cancel("canceled", ACCOUNT_ID)).resolves.toEqual({ status: "canceled" });
    expect(cancellation.set).not.toHaveBeenCalled();
  });
});
