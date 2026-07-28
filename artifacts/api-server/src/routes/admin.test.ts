import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDashboardSnapshot } from "@workspace/admin-dashboard-contract";
import {
  createAdminRouter,
  createCachedProbe,
  isDashboardTokenValid,
} from "./admin";

const validSnapshot = {
  generatedAt: "2026-07-14T12:00:00.000Z",
  metrics: [
    { id: "active", label: "Active", value: "1", change: "0", trend: [1] },
    { id: "search", label: "Search", value: "0", change: "0", trend: [0] },
    { id: "queue", label: "Queue", value: "0", change: "0", trend: [0] },
    { id: "errors", label: "Errors", value: "0%", change: "0", trend: [0] },
  ],
  modules: [
    {
      id: "core-api",
      name: "Core API",
      status: "healthy",
      version: "2.0.0",
      requestsPerMinute: 0,
    },
  ],
  edges: [],
  incidents: [],
  providers: [],
} as const;

const servers: Server[] = [];
const temporaryRoots: string[] = [];

async function startAdminServer(
  options: Parameters<typeof createAdminRouter>[0],
) {
  const app = express();
  app.use("/api", createAdminRouter(options));
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/api/admin/dashboard`;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all([
    ...servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
    ...temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  ]);
});

describe("admin dashboard token", () => {
  it("accepts only the exact non-empty token", () => {
    expect(isDashboardTokenValid("secret-value", "secret-value")).toBe(true);
    expect(isDashboardTokenValid("secret-value", "other-value")).toBe(false);
    expect(isDashboardTokenValid("short", "a-much-longer-value")).toBe(false);
    expect(isDashboardTokenValid(undefined, "secret-value")).toBe(false);
    expect(isDashboardTokenValid("", "")).toBe(false);
  });
});

describe("cached runtime probes", () => {
  it("coalesces concurrent work and reuses a fresh result", async () => {
    let now = 1_000;
    let releaseProbe!: (value: boolean) => void;
    const sourceProbe = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          releaseProbe = resolve;
        }),
    );
    const probe = createCachedProbe(sourceProbe, {
      ttlMs: 5_000,
      now: () => now,
    });

    const first = probe();
    const second = probe();
    await Promise.resolve();
    expect(sourceProbe).toHaveBeenCalledTimes(1);
    releaseProbe(true);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);

    now += 4_000;
    await expect(probe()).resolves.toBe(true);
    expect(sourceProbe).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/admin/dashboard", () => {
  it("loads the default dashboard token from its configured file", async () => {
    const root = await mkdtemp(join(tmpdir(), "apollo-admin-route-"));
    temporaryRoots.push(root);
    const tokenPath = join(root, "admin_dashboard_token");
    const token = "route-token-".padEnd(32, "x");
    await writeFile(tokenPath, `${token}\n`);
    vi.stubEnv("ADMIN_DASHBOARD_TOKEN_FILE", tokenPath);
    vi.stubEnv("ADMIN_DASHBOARD_TOKEN", undefined);

    const url = await startAdminServer({
      loadSnapshot: async () => validSnapshot,
    });
    const response = await fetch(url, {
      headers: { "X-Admin-Dashboard-Token": token },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(validSnapshot);
  });

  it.each([
    ["missing", undefined],
    ["wrong same-length", "wrong-token!"],
    ["wrong different-length", "no"],
  ])("returns 401 for a %s token", async (_label, token) => {
    const loadSnapshot = vi.fn(async () => validSnapshot);
    const url = await startAdminServer({ token: "admin-secret", loadSnapshot });

    const response = await fetch(url, {
      headers:
        token === undefined ? undefined : { "X-Admin-Dashboard-Token": token },
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    expect(loadSnapshot).not.toHaveBeenCalled();
  });

  it("returns 503 when the server token is not configured", async () => {
    const url = await startAdminServer({
      token: null,
      loadSnapshot: async () => validSnapshot,
    });

    const response = await fetch(url, {
      headers: { "X-Admin-Dashboard-Token": "anything" },
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "admin_dashboard_disabled",
    });
  });

  it("returns a validated non-cacheable snapshot for the configured token", async () => {
    const url = await startAdminServer({
      token: "admin-secret",
      loadSnapshot: async () => validSnapshot,
    });

    const response = await fetch(url, {
      headers: { "X-Admin-Dashboard-Token": "admin-secret" },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(parseDashboardSnapshot(body)).toEqual(validSnapshot);
    expect(JSON.stringify(body)).not.toContain("admin-secret");
  });

  it("returns a sanitized 503 when snapshot collection fails", async () => {
    const url = await startAdminServer({
      token: "admin-secret",
      loadSnapshot: async () => {
        throw new Error("DATABASE_URL=postgres://private-host/internal");
      },
    });

    const response = await fetch(url, {
      headers: { "X-Admin-Dashboard-Token": "admin-secret" },
    });

    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toBe('{"error":"admin_dashboard_unavailable"}');
    expect(body).not.toContain("private-host");
  });
});
