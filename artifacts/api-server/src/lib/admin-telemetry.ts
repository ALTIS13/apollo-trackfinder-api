import {
  parseDashboardSnapshot,
  type DashboardSnapshot,
  type HealthStatus,
  type ServiceEdge,
  type ServiceModule,
} from "@workspace/admin-dashboard-contract";
import {
  isCanonicalModuleHeartbeatPath,
  type ModuleHeartbeatObservation,
} from "./module-heartbeat.js";

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 10_000;
const TREND_BUCKETS = 6;

interface RequestTelemetryEvent {
  category: "search" | "account" | "download" | "other";
  statusCode: number;
  at: number;
}

export interface RecordRequestTelemetry {
  method: string;
  path: string;
  statusCode: number;
  at?: number;
}

export interface RequestTelemetrySnapshot {
  totalRequestsPerMinute: number;
  searchesPerMinute: number;
  accountRequestsPerMinute: number;
  downloadRequestsPerMinute: number;
  errorRatePercent: number;
  searchTrend: number[];
  errorRateTrend: number[];
}

interface RollingRequestTelemetryOptions {
  windowMs?: number;
  maxEntries?: number;
}

function normalizePath(path: string): string {
  const queryIndex = path.indexOf("?");
  return queryIndex === -1 ? path : path.slice(0, queryIndex);
}

function categorizeRequest(
  method: string,
  path: string,
): RequestTelemetryEvent["category"] {
  if (
    method === "POST" &&
    (path === "/api/tracks/search" || path === "/api/tracks/batch-search")
  ) {
    return "search";
  }
  if (path.startsWith("/api/spotify/") || path.startsWith("/api/yandex/")) {
    return "account";
  }
  if (
    path.startsWith("/api/downloads/") ||
    /^\/api\/tracks\/download(?:\/|$)/.test(path) ||
    /^\/api\/tracks\/[^/]+\/(?:stream|download|audio-stream)$/.test(path)
  ) {
    return "download";
  }
  return "other";
}

function isExcludedPath(path: string): boolean {
  return (
    path === "/api/healthz" ||
    path === "/api/admin/dashboard" ||
    isCanonicalModuleHeartbeatPath(path)
  );
}

function isSearchRequest(event: RequestTelemetryEvent): boolean {
  return event.category === "search";
}

function isAccountRequest(event: RequestTelemetryEvent): boolean {
  return event.category === "account";
}

function isDownloadRequest(event: RequestTelemetryEvent): boolean {
  return event.category === "download";
}

function percentage(part: number, total: number): number {
  return total === 0 ? 0 : Number(((part / total) * 100).toFixed(1));
}

export class RollingRequestTelemetry {
  private readonly entries: RequestTelemetryEvent[] = [];
  private readonly windowMs: number;
  private readonly maxEntries: number;

  constructor(options: RollingRequestTelemetryOptions = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  record(event: RecordRequestTelemetry): void {
    const method = event.method.toUpperCase();
    const path = normalizePath(event.path);
    if (isExcludedPath(path)) return;
    this.entries.push({
      category: categorizeRequest(method, path),
      statusCode: event.statusCode,
      at: event.at ?? Date.now(),
    });
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
  }

  snapshot(at = Date.now()): RequestTelemetrySnapshot {
    const windowStart = at - this.windowMs;
    const retained = this.entries.filter(
      (entry) => entry.at > windowStart && entry.at <= at,
    );
    this.entries.splice(0, this.entries.length, ...retained);

    const searches = retained.filter(isSearchRequest);
    const errors = retained.filter((entry) => entry.statusCode >= 500);
    const bucketWidth = this.windowMs / TREND_BUCKETS;
    const searchTrend = Array.from({ length: TREND_BUCKETS }, (_, index) => {
      const start = windowStart + index * bucketWidth;
      const end = start + bucketWidth;
      return searches.filter((entry) => entry.at > start && entry.at <= end)
        .length;
    });
    const errorRateTrend = Array.from({ length: TREND_BUCKETS }, (_, index) => {
      const start = windowStart + index * bucketWidth;
      const end = start + bucketWidth;
      const bucket = retained.filter(
        (entry) => entry.at > start && entry.at <= end,
      );
      return percentage(
        bucket.filter((entry) => entry.statusCode >= 500).length,
        bucket.length,
      );
    });

    return {
      totalRequestsPerMinute: retained.length,
      searchesPerMinute: searches.length,
      accountRequestsPerMinute: retained.filter(isAccountRequest).length,
      downloadRequestsPerMinute: retained.filter(isDownloadRequest).length,
      errorRatePercent: percentage(errors.length, retained.length),
      searchTrend,
      errorRateTrend,
    };
  }
}

export interface AdminDashboardSnapshotDependencies {
  now: () => Date;
  deployedAt?: string;
  version: string;
  telemetry: RollingRequestTelemetry;
  getQueueTelemetry: () => Promise<{
    depth?: number;
    status: HealthStatus;
    redisStatus: HealthStatus;
  }>;
  isDatabaseReady: () => boolean;
  isRedisAvailable: () => boolean;
  getModuleHeartbeats: () => ReadonlyArray<ModuleHeartbeatObservation>;
}

function combineStatus(left: HealthStatus, right: HealthStatus): HealthStatus {
  const priority: Record<HealthStatus, number> = {
    healthy: 0,
    unknown: 1,
    warning: 2,
    degraded: 3,
  };
  return priority[left] >= priority[right] ? left : right;
}

export async function createAdminDashboardSnapshot(
  dependencies: AdminDashboardSnapshotDependencies,
): Promise<DashboardSnapshot> {
  const generatedAt = dependencies.now().toISOString();
  const requestTelemetry = dependencies.telemetry.snapshot(
    dependencies.now().getTime(),
  );
  const queueTelemetry = await dependencies.getQueueTelemetry();
  const queueDepth =
    queueTelemetry.depth === undefined
      ? undefined
      : Math.max(0, queueTelemetry.depth);
  const version = dependencies.version.trim() || "unknown";
  const moduleRequests: Record<string, number> = {
    "public-web": requestTelemetry.totalRequestsPerMinute,
    "core-api": requestTelemetry.totalRequestsPerMinute,
    "account-integrations": requestTelemetry.accountRequestsPerMinute,
    "search-media": requestTelemetry.searchesPerMinute,
    "download-worker": requestTelemetry.downloadRequestsPerMinute,
    postgresql: 0,
    redis: 0,
    "queue-redis": 0,
    "media-storage": 0,
  };
  const modules: ServiceModule[] = [
    ["public-web", "Public Web", "unknown", "unknown"],
    ["core-api", "Core API", "healthy", version],
    ["account-integrations", "Account Integrations", "unknown", "unknown"],
    ["search-media", "Search Media", "unknown", "unknown"],
    [
      "download-worker",
      "Download Worker",
      queueTelemetry.status === "healthy" &&
      queueDepth !== undefined &&
      queueDepth >= 25
        ? "warning"
        : queueTelemetry.status,
      version,
    ],
    [
      "postgresql",
      "PostgreSQL",
      dependencies.isDatabaseReady() ? "healthy" : "unknown",
      "unknown",
    ],
    [
      "redis",
      "Redis",
      dependencies.isRedisAvailable() ? "healthy" : "unknown",
      "unknown",
    ],
    ["queue-redis", "Queue Redis", queueTelemetry.redisStatus, "unknown"],
    ["media-storage", "Media Storage", "unknown", "unknown"],
  ].map(([id, name, status, moduleVersion]) => ({
    id,
    name,
    status: status as HealthStatus,
    version: moduleVersion,
    ...(dependencies.deployedAt !== undefined &&
    [
      "core-api",
      "account-integrations",
      "search-media",
      "download-worker",
    ].includes(id)
      ? { lastDeploymentAt: dependencies.deployedAt }
      : {}),
    requestsPerMinute: moduleRequests[id] ?? 0,
  }));
  const managedHeartbeats = new Map(
    dependencies
      .getModuleHeartbeats()
      .filter((observation) => observation.managed)
      .map((observation) => [observation.moduleId, observation]),
  );
  const overlaidModules = modules.map((module) => {
    const heartbeat = managedHeartbeats.get(module.id);
    if (heartbeat === undefined) return module;

    const {
      lastDeploymentAt: _localDeploymentAt,
      lastHeartbeatAt: _localHeartbeatAt,
      ...baseModule
    } = module;
    return {
      ...baseModule,
      status: heartbeat.status,
      version: heartbeat.version,
      ...(heartbeat.deployedAt === undefined
        ? {}
        : { lastDeploymentAt: heartbeat.deployedAt }),
      ...(heartbeat.lastHeartbeatAt === undefined
        ? {}
        : { lastHeartbeatAt: heartbeat.lastHeartbeatAt }),
      requestsPerMinute: heartbeat.requestsPerMinute,
    };
  });
  const modulesById = new Map(
    overlaidModules.map((module) => [module.id, module]),
  );
  const edgeDefinitions = [
    ["public-web", "core-api"],
    ["core-api", "account-integrations"],
    ["core-api", "search-media"],
    ["core-api", "download-worker"],
    ["account-integrations", "postgresql"],
    ["search-media", "redis"],
    ["download-worker", "queue-redis"],
    ["queue-redis", "media-storage"],
  ] as const;
  const edges: ServiceEdge[] = edgeDefinitions.map(([source, target]) => ({
    id: `${source}-${target}`,
    source,
    target,
    status: combineStatus(
      modulesById.get(source)!.status,
      modulesById.get(target)!.status,
    ),
    requestsPerMinute: modulesById.get(target)!.requestsPerMinute,
  }));
  const activeModules = overlaidModules.filter(
    (module) => module.status === "healthy",
  ).length;
  const providerNames = [
    ["spotify", "Spotify"],
    ["yandex-music", "Yandex Music"],
    ["youtube", "YouTube"],
    ["soundcloud", "SoundCloud"],
    ["bandcamp", "Bandcamp"],
    ["deezer", "Deezer"],
  ] as const;

  return parseDashboardSnapshot({
    generatedAt,
    metrics: [
      {
        id: "active-modules",
        label: "Активные модули",
        value: String(activeModules),
        change: "Текущее состояние",
        trend: [activeModules],
      },
      {
        id: "searches-per-minute",
        label: "Поисков в минуту",
        value: String(requestTelemetry.searchesPerMinute),
        change: "Окно 60 секунд",
        trend: requestTelemetry.searchTrend,
      },
      {
        id: "queue-depth",
        label: "Глубина очереди",
        value: queueDepth === undefined ? "Нет данных" : String(queueDepth),
        change:
          queueDepth === undefined ? "Очередь недоступна" : "Текущее состояние",
        trend: [queueDepth ?? 0],
      },
      {
        id: "error-rate",
        label: "Доля ошибок",
        value: `${requestTelemetry.errorRatePercent.toFixed(1)}%`,
        change: "HTTP 5xx за 60 секунд",
        trend: requestTelemetry.errorRateTrend,
      },
    ],
    modules: overlaidModules,
    edges,
    incidents: [],
    providers: providerNames.map(([id, name]) => ({
      id,
      name,
      status: "unknown",
      latencyMs: 0,
      latencyTrendMs: [0],
    })),
  });
}

export const adminRequestTelemetry = new RollingRequestTelemetry();
