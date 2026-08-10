import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type IRouter } from "express";
import { parseDashboardSnapshot } from "@workspace/admin-dashboard-contract";
import {
  adminRequestTelemetry,
  createAdminDashboardSnapshot,
} from "../lib/admin-telemetry.js";
import { loadAdminDashboardToken } from "../lib/admin-dashboard-token.js";
import { moduleHeartbeatService } from "../lib/module-heartbeat.js";
import {
  loadRuntimeAdminAccountOverview,
  unavailableAdminAccountOverview,
} from "../lib/admin-account-overview-client.js";

const DATABASE_PROBE_TIMEOUT_MS = 1_000;
const DATABASE_PROBE_CACHE_MS = 5_000;

interface CreateAdminRouterOptions {
  token?: string | null;
  loadSnapshot?: () => Promise<unknown>;
}

interface CachedProbeOptions {
  ttlMs: number;
  now?: () => number;
}

export function isDashboardTokenValid(
  providedToken: string | undefined,
  expectedToken: string | null | undefined,
): boolean {
  if (!providedToken || !expectedToken) return false;

  const providedDigest = createHash("sha256").update(providedToken).digest();
  const expectedDigest = createHash("sha256").update(expectedToken).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

export function createCachedProbe(
  sourceProbe: () => Promise<boolean>,
  options: CachedProbeOptions,
): () => Promise<boolean> {
  const now = options.now ?? Date.now;
  const ttlMs = Math.max(0, options.ttlMs);
  let cachedAt: number | undefined;
  let cachedValue = false;
  let activeProbe: Promise<boolean> | undefined;

  return () => {
    const requestedAt = now();
    if (cachedAt !== undefined && requestedAt - cachedAt < ttlMs) {
      return Promise.resolve(cachedValue);
    }
    if (activeProbe !== undefined) return activeProbe;

    const nextProbe = Promise.resolve()
      .then(sourceProbe)
      .then((value) => {
        cachedValue = value;
        cachedAt = now();
        return value;
      })
      .finally(() => {
        if (activeProbe === nextProbe) activeProbe = undefined;
      });
    activeProbe = nextProbe;
    return nextProbe;
  };
}

const probeDatabase = createCachedProbe(
  async () => {
    try {
      const { probeDatabaseHealth } = await import("@workspace/db");
      return probeDatabaseHealth({ timeoutMs: DATABASE_PROBE_TIMEOUT_MS });
    } catch {
      return false;
    }
  },
  { ttlMs: DATABASE_PROBE_CACHE_MS },
);

function parseOptionalIsoDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp)
    ? undefined
    : new Date(timestamp).toISOString();
}

async function loadRuntimeSnapshot(): Promise<unknown> {
  const [queueTelemetry, { isRedisAvailable }, databaseReady, accountOverview] =
    await Promise.all([
      import("../lib/background-queue.js").then(
        ({ getDownloadQueueTelemetry }) => getDownloadQueueTelemetry(),
      ),
      import("../lib/redis.js"),
      probeDatabase(),
      loadRuntimeAdminAccountOverview(process.env).catch(
        () => unavailableAdminAccountOverview,
      ),
    ]);

  return createAdminDashboardSnapshot({
    now: () => new Date(),
    deployedAt: parseOptionalIsoDate(process.env["APOLLO_DEPLOYED_AT"]),
    version: process.env["APOLLO_API_VERSION"] ?? "unknown",
    telemetry: adminRequestTelemetry,
    getQueueTelemetry: async () => queueTelemetry,
    isDatabaseReady: () => databaseReady,
    isRedisAvailable,
    getModuleHeartbeats: () => moduleHeartbeatService.snapshot(),
    accountOverview,
  });
}

export function createAdminRouter(
  options: CreateAdminRouterOptions = {},
): IRouter {
  const router = Router();
  const configuredToken =
    options.token === undefined
      ? loadAdminDashboardToken(process.env)
      : options.token;
  const loadSnapshot = options.loadSnapshot ?? loadRuntimeSnapshot;

  router.get("/admin/dashboard", async (req, res) => {
    res.set({
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      "X-Content-Type-Options": "nosniff",
    });

    if (!configuredToken) {
      res.status(503).json({ error: "admin_dashboard_disabled" });
      return;
    }

    if (
      !isDashboardTokenValid(
        req.get("X-Admin-Dashboard-Token"),
        configuredToken,
      )
    ) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    try {
      const snapshot = parseDashboardSnapshot(await loadSnapshot());
      res.status(200).json(snapshot);
    } catch (error) {
      req.log?.warn(
        { errorType: error instanceof Error ? error.name : "UnknownError" },
        "Admin dashboard snapshot unavailable",
      );
      res.status(503).json({ error: "admin_dashboard_unavailable" });
    }
  });

  return router;
}

export const adminRouter = createAdminRouter();
