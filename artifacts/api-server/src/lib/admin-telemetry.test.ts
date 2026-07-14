import { describe, expect, it } from "vitest";
import { parseDashboardSnapshot } from "@workspace/admin-dashboard-contract";
import {
  createAdminDashboardSnapshot,
  RollingRequestTelemetry,
} from "./admin-telemetry";

describe("RollingRequestTelemetry", () => {
  it("keeps a bounded 60-second window without retaining query strings", () => {
    const now = Date.parse("2026-07-14T12:00:00.000Z");
    const telemetry = new RollingRequestTelemetry({ maxEntries: 3 });

    telemetry.record({
      method: "POST",
      path: "/api/tracks/search?authorization=must-not-survive",
      statusCode: 200,
      at: now - 61_000,
    });
    telemetry.record({
      method: "POST",
      path: "/api/tracks/search",
      statusCode: 200,
      at: now - 30_000,
    });
    telemetry.record({
      method: "POST",
      path: "/api/tracks/batch-search",
      statusCode: 503,
      at: now - 20_000,
    });
    telemetry.record({
      method: "GET",
      path: "/api/spotify/status",
      statusCode: 200,
      at: now - 10_000,
    });
    telemetry.record({
      method: "GET",
      path: "/api/healthz",
      statusCode: 200,
      at: now - 5_000,
    });
    telemetry.record({
      method: "GET",
      path: "/api/admin/dashboard",
      statusCode: 200,
      at: now - 1_000,
    });

    expect(telemetry.snapshot(now)).toMatchObject({
      totalRequestsPerMinute: 3,
      searchesPerMinute: 2,
      accountRequestsPerMinute: 1,
      downloadRequestsPerMinute: 0,
      errorRatePercent: 33.3,
    });
    expect(JSON.stringify(telemetry.snapshot(now))).not.toContain(
      "authorization",
    );
  });

  it("computes search and 5xx metrics for the current window", () => {
    const now = Date.parse("2026-07-14T12:00:00.000Z");
    const telemetry = new RollingRequestTelemetry();

    telemetry.record({
      method: "POST",
      path: "/api/tracks/search",
      statusCode: 200,
      at: now - 20_000,
    });
    telemetry.record({
      method: "POST",
      path: "/api/tracks/batch-search",
      statusCode: 503,
      at: now - 10_000,
    });
    telemetry.record({
      method: "GET",
      path: "/api/spotify/status",
      statusCode: 200,
      at: now - 5_000,
    });
    telemetry.record({
      method: "GET",
      path: "/api/tracks/example/stream",
      statusCode: 200,
      at: now - 4_000,
    });
    telemetry.record({
      method: "POST",
      path: "/api/tracks/download/queue",
      statusCode: 202,
      at: now - 3_000,
    });

    expect(telemetry.snapshot(now)).toMatchObject({
      totalRequestsPerMinute: 5,
      searchesPerMinute: 2,
      accountRequestsPerMinute: 1,
      downloadRequestsPerMinute: 2,
      errorRatePercent: 20,
    });
  });
});

describe("createAdminDashboardSnapshot", () => {
  it("builds a valid truthful snapshot from injected runtime signals", async () => {
    const now = new Date("2026-07-14T12:00:00.000Z");
    const telemetry = new RollingRequestTelemetry();
    telemetry.record({
      method: "POST",
      path: "/api/tracks/search",
      statusCode: 200,
      at: now.getTime() - 1_000,
    });
    telemetry.record({
      method: "GET",
      path: "/api/tracks/example/download",
      statusCode: 500,
      at: now.getTime() - 500,
    });

    const snapshot = await createAdminDashboardSnapshot({
      now: () => now,
      deployedAt: "2026-07-14T11:00:00.000Z",
      version: "2.0.0",
      telemetry,
      getQueueTelemetry: async () => ({
        depth: 7,
        status: "healthy" as const,
        redisStatus: "unknown" as const,
      }),
      isDatabaseReady: () => true,
      isRedisAvailable: () => false,
    });

    expect(parseDashboardSnapshot(snapshot)).toEqual(snapshot);
    expect(snapshot.metrics).toHaveLength(4);
    expect(
      snapshot.metrics.find((metric) => metric.id === "searches-per-minute")
        ?.value,
    ).toBe("1");
    expect(
      snapshot.metrics.find((metric) => metric.id === "queue-depth")?.value,
    ).toBe("7");
    expect(
      snapshot.metrics.find((metric) => metric.id === "error-rate")?.value,
    ).toBe("50.0%");
    expect(
      snapshot.modules.find((module) => module.id === "postgresql")?.status,
    ).toBe("healthy");
    expect(
      snapshot.modules.find((module) => module.id === "redis")?.status,
    ).toBe("unknown");
    expect(
      snapshot.modules.find((module) => module.id === "queue-redis")?.status,
    ).toBe("unknown");
    expect(
      snapshot.modules.find((module) => module.id === "public-web")?.status,
    ).toBe("unknown");
    expect(
      snapshot.modules.find((module) => module.id === "public-web")
        ?.lastDeploymentAt,
    ).toBeUndefined();
    expect(
      snapshot.modules.find((module) => module.id === "core-api")
        ?.lastDeploymentAt,
    ).toBe("2026-07-14T11:00:00.000Z");
    expect(
      snapshot.providers.every((provider) => provider.status === "unknown"),
    ).toBe(true);
    expect(
      snapshot.providers.every(
        (provider) => provider.lastCheckedAt === undefined,
      ),
    ).toBe(true);
    expect(snapshot.incidents).toEqual([]);
  });

  it("returns a valid partial snapshot when queue telemetry is unavailable", async () => {
    const now = new Date("2026-07-14T12:00:00.000Z");
    const snapshot = await createAdminDashboardSnapshot({
      now: () => now,
      version: "2.0.0",
      telemetry: new RollingRequestTelemetry(),
      getQueueTelemetry: async () => ({
        status: "unknown" as const,
        redisStatus: "unknown" as const,
      }),
      isDatabaseReady: () => false,
      isRedisAvailable: () => false,
    });

    expect(parseDashboardSnapshot(snapshot)).toEqual(snapshot);
    expect(
      snapshot.metrics.find((metric) => metric.id === "queue-depth")?.value,
    ).toBe("Нет данных");
    expect(
      snapshot.modules.find((module) => module.id === "download-worker")
        ?.status,
    ).toBe("unknown");
  });
});
