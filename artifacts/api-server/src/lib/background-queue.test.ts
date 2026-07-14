import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env["DATABASE_URL"] ??= "postgres://unused:unused@127.0.0.1:1/unused";

const queueModule = await import("./background-queue");

describe("download queue telemetry isolation", () => {
  it("recovers on the next observation without mutating queue routing", async () => {
    const initialBackend = queueModule.getDownloadQueueRuntimeState().backend;
    const unavailable = await queueModule.collectDownloadQueueTelemetry({
      getWaitingCount: async () => {
        throw new Error("telemetry unavailable");
      },
      getActiveCount: async () => 0,
    });
    const recovered = await queueModule.collectDownloadQueueTelemetry({
      getWaitingCount: async () => 2,
      getActiveCount: async () => 1,
    });

    expect(unavailable).toEqual({ status: "unknown", redisStatus: "unknown" });
    expect(recovered).toEqual({
      depth: 3,
      status: "healthy",
      redisStatus: "healthy",
    });
    expect(queueModule.getDownloadQueueRuntimeState().backend).toBe(
      initialBackend,
    );
  });
});

const redisIntegrationUrl = process.env["APOLLO_REDIS_INTEGRATION_URL"];

describe.skipIf(redisIntegrationUrl === undefined)(
  "BullMQ disposable Redis integration",
  () => {
    beforeAll(async () => {
      process.env["REDIS_URL"] = redisIntegrationUrl;
      await queueModule.initBackgroundQueues();
    });

    afterAll(async () => {
      await queueModule.shutdownBackgroundQueues();
      delete process.env["REDIS_URL"];
    });

    it("keeps idle blocking workers healthy while telemetry remains bounded", async () => {
      await new Promise((resolve) => setTimeout(resolve, 3_500));

      expect(queueModule.getDownloadQueueRuntimeState()).toMatchObject({
        backend: "redis",
        workerErrorCount: 0,
      });
      await expect(
        queueModule.collectDownloadQueueTelemetry({
          getWaitingCount: async () => {
            throw new Error("simulated telemetry-only failure");
          },
          getActiveCount: async () => 0,
        }),
      ).resolves.toEqual({ status: "unknown", redisStatus: "unknown" });
      expect(queueModule.getDownloadQueueRuntimeState().backend).toBe("redis");
      await expect(
        queueModule.getDownloadQueueTelemetry(),
      ).resolves.toMatchObject({
        status: "healthy",
        redisStatus: "healthy",
      });
    }, 15_000);
  },
);
