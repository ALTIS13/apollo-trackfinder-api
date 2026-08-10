import { describe, expect, it } from "vitest";
import { parseDashboardSnapshot } from "./index";

const validSnapshot = {
  generatedAt: "2026-07-14T12:00:00.000Z",
  metrics: [
    {
      id: "active-modules",
      label: "Active modules",
      value: "1",
      change: "0",
      trend: [1],
    },
    {
      id: "active-users",
      label: "Active users",
      value: "1",
      change: "0",
      trend: [1],
    },
    {
      id: "parser-warnings",
      label: "Parser warnings",
      value: "0",
      change: "0",
      trend: [0],
    },
    {
      id: "open-incidents",
      label: "Open incidents",
      value: "1",
      change: "0",
      trend: [1],
    },
  ],
  modules: [
    {
      id: "core-api",
      name: "Core API",
      status: "warning",
      version: "1.0.0",
      lastDeploymentAt: "2026-07-14T11:00:00.000Z",
      requestsPerMinute: 1,
    },
    {
      id: "search-media",
      name: "Search Media",
      status: "healthy",
      version: "1.0.0",
      lastDeploymentAt: "2026-07-14T11:00:00.000Z",
      requestsPerMinute: 1,
    },
  ],
  edges: [
    {
      id: "core-api-search-media",
      source: "core-api",
      target: "search-media",
      status: "warning",
      requestsPerMinute: 1,
      incidentId: "search-warning",
    },
  ],
  incidents: [
    {
      id: "search-warning",
      title: "Search warning",
      severity: "warning",
      status: "open",
      serviceId: "search-media",
      createdAt: "2026-07-14T11:59:00.000Z",
      diagnostic: {
        message: "Search provider is degraded",
        observedAt: "2026-07-14T11:59:30.000Z",
      },
    },
  ],
  providers: [],
  parsers: [
    {
      id: "youtube",
      name: "YouTube",
      status: "healthy",
      version: "1.0.0",
      requestsPerMinute: 4,
      failuresPerMinute: 0,
      previewsRejectedPerMinute: 1,
      lastCheckedAt: "2026-07-14T11:59:30.000Z",
    },
  ],
  accountSummary: {
    availability: "available",
    total: 1,
    activeNow: 1,
    pending: 0,
    suspended: 0,
    connectionSummary: {
      availability: "available",
      spotifyConnectedInList: 0,
      yandexConnectedInList: 0,
    },
  },
  accounts: [
    {
      id: "10000000-0000-4000-8000-000000000001",
      email: "operator@example.com",
      displayName: "Apollo Operator",
      status: "active",
      activeSessionCount: 1,
      moduleKeys: ["tf.search"],
      spotify: { state: "disconnected" },
      yandex: { state: "unavailable" },
    },
  ],
} as const;

describe("admin dashboard contract", () => {
  it("accepts a bounded snapshot with a valid incident edge relation", () => {
    expect(parseDashboardSnapshot(validSnapshot)).toEqual(validSnapshot);
  });

  it("accepts an optional module heartbeat receipt time", () => {
    const snapshot = {
      ...validSnapshot,
      modules: validSnapshot.modules.map((module, index) =>
        index === 0
          ? { ...module, lastHeartbeatAt: "2026-07-15T04:31:02.123Z" }
          : module,
      ),
    };
    expect(parseDashboardSnapshot(snapshot)).toEqual(snapshot);
    expect(() =>
      parseDashboardSnapshot({
        ...snapshot,
        modules: [{ ...snapshot.modules[0], lastHeartbeatAt: "not-a-time" }],
      }),
    ).toThrow("Invalid admin dashboard snapshot");
  });

  it("accepts bounded parser state and rejects duplicate parser IDs", () => {
    expect(parseDashboardSnapshot(validSnapshot).parsers).toEqual(
      validSnapshot.parsers,
    );
    expect(() =>
      parseDashboardSnapshot({
        ...validSnapshot,
        parsers: [validSnapshot.parsers[0], validSnapshot.parsers[0]],
      }),
    ).toThrow("Duplicate parsers ID");
  });

  it("distinguishes an unavailable account section from an available zero", () => {
    const unavailable = {
      ...validSnapshot,
      accountSummary: { availability: "unavailable" },
      accounts: [],
    } as const;
    const availableZero = {
      ...validSnapshot,
      accountSummary: {
        availability: "available",
        total: 0,
        activeNow: 0,
        pending: 0,
        suspended: 0,
        connectionSummary: {
          availability: "available",
          spotifyConnectedInList: 0,
          yandexConnectedInList: 0,
        },
      },
      accounts: [],
    } as const;

    expect(parseDashboardSnapshot(unavailable).accountSummary).toEqual({
      availability: "unavailable",
    });
    expect(parseDashboardSnapshot(availableZero).accountSummary).toEqual(
      availableZero.accountSummary,
    );
    expect(() =>
      parseDashboardSnapshot({
        ...unavailable,
        accounts: validSnapshot.accounts,
      }),
    ).toThrow("Unavailable account summaries cannot include account rows");
  });

  it("rejects an incident linked from a healthy edge", () => {
    expect(() =>
      parseDashboardSnapshot({
        ...validSnapshot,
        edges: [{ ...validSnapshot.edges[0], status: "healthy" }],
      }),
    ).toThrow("Invalid admin dashboard snapshot");
  });

  it("rejects duplicate directed module connections with distinct edge IDs", () => {
    expect(() =>
      parseDashboardSnapshot({
        ...validSnapshot,
        edges: [
          validSnapshot.edges[0],
          {
            ...validSnapshot.edges[0],
            id: "core-api-search-media-shadow",
            incidentId: undefined,
          },
        ],
      }),
    ).toThrow("Duplicate directed edge relation");
  });

  it("accepts unknown modules and providers without fabricated observation times", () => {
    const modules = validSnapshot.modules.map((module, index) => {
      if (index !== 0) return module;
      const { lastDeploymentAt: _lastDeploymentAt, ...withoutTimestamp } =
        module;
      return withoutTimestamp;
    });

    expect(() =>
      parseDashboardSnapshot({
        ...validSnapshot,
        modules,
        providers: [
          {
            id: "soundcloud",
            name: "SoundCloud",
            status: "unknown",
            latencyMs: 0,
            latencyTrendMs: [0],
          },
        ],
      }),
    ).not.toThrow();
  });
});
