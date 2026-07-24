import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import express, { type Express } from "express";
import { afterEach, describe, expect, it } from "vitest";
import {
  createModuleHeartbeatSignature,
  ModuleHeartbeatService,
} from "../lib/module-heartbeat";
import { createModuleHeartbeatRouter } from "./module-heartbeats";

const SEARCH_MEDIA_SECRET = "s".repeat(32);
const ACCOUNT_INTEGRATIONS_SECRET = "a".repeat(32);
const NOW = Date.parse("2026-07-15T04:31:02.000Z");
const TIMESTAMP = String(Math.floor(NOW / 1_000));

const validPayload = {
  schemaVersion: 1,
  status: "healthy",
  version: "2.15.0",
  deployedAt: "2026-07-15T04:30:00.000Z",
  requestsPerMinute: 42,
};

const servers: Server[] = [];

function createService() {
  return new ModuleHeartbeatService({
    keys: new Map([
      ["search-media", SEARCH_MEDIA_SECRET],
      ["account-integrations", ACCOUNT_INTEGRATIONS_SECRET],
    ]),
    now: () => NOW,
  });
}

function nonceFor(value: string): string {
  return `nonce-${value.padStart(16, "0")}`;
}

function signHeartbeat(
  moduleId: string,
  rawBody: Buffer,
  nonce: string,
  timestamp = TIMESTAMP,
  secret = SEARCH_MEDIA_SECRET,
): string {
  return createModuleHeartbeatSignature({
    moduleId,
    timestamp,
    nonce,
    rawBody,
    secret,
  });
}

async function startHeartbeatServer(
  service: Pick<ModuleHeartbeatService, "ingest">,
) {
  const capturedLogs: unknown[] = [];
  const app = express();
  app.use((req, _res, next) => {
    Object.assign(req, {
      log: {
        warn: (bindings: unknown, message: string) => {
          capturedLogs.push({ bindings, message });
        },
      },
    });
    next();
  });
  app.use("/api", createModuleHeartbeatRouter({ service }));
  app.use(express.json());
  app.get("/api/ordinary", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  return { ...(await startServer(app)), capturedLogs };
}

async function startProductionServer() {
  process.env["DATABASE_URL"] ??= "postgres://unused:unused@127.0.0.1:1/unused";
  process.env["LOG_LEVEL"] ??= "silent";
  const { createApiApp } = await import("../app");
  return startServer(createApiApp());
}

async function startServer(serverApp: Express) {
  const server = serverApp.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    baseUrl: `${origin}/api`,
  };
}

function expectHeartbeatHeaders(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}

async function sendHeartbeat(
  baseUrl: string,
  options: {
    moduleId?: string;
    rawBody?: Buffer;
    nonce?: string;
    timestamp?: string;
    signature?: string;
    contentType?: string | null;
    contentEncoding?: string;
  } = {},
) {
  const moduleId = options.moduleId ?? "search-media";
  const rawBody = options.rawBody ?? Buffer.from(JSON.stringify(validPayload));
  const nonce = options.nonce ?? nonceFor("default");
  const timestamp = options.timestamp ?? TIMESTAMP;
  const contentType =
    options.contentType === undefined
      ? "application/json"
      : options.contentType;
  const headers: Record<string, string> = {
    "X-Apollo-Heartbeat-Timestamp": timestamp,
    "X-Apollo-Heartbeat-Nonce": nonce,
  };
  if (contentType !== null) {
    headers["Content-Type"] = contentType;
  }
  if (options.contentEncoding !== undefined) {
    headers["Content-Encoding"] = options.contentEncoding;
  }
  if (Object.hasOwn(options, "signature")) {
    if (options.signature !== undefined) {
      headers["X-Apollo-Heartbeat-Signature"] = options.signature;
    }
  } else {
    headers["X-Apollo-Heartbeat-Signature"] = signHeartbeat(
      moduleId,
      rawBody,
      nonce,
      timestamp,
    );
  }

  return fetch(`${baseUrl}/internal/modules/${moduleId}/heartbeat`, {
    method: "POST",
    headers,
    body: rawBody,
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe("POST /api/internal/modules/:moduleId/heartbeat", () => {
  it("returns a stable disabled response without configured module keys", async () => {
    const { baseUrl } = await startHeartbeatServer(
      new ModuleHeartbeatService({ keys: new Map(), now: () => NOW }),
    );

    const response = await sendHeartbeat(baseUrl);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "heartbeat_disabled",
    });
  });

  it("returns the same unauthorized body for missing, wrong, and other-module signatures", async () => {
    const { baseUrl } = await startHeartbeatServer(createService());
    const rawBody = Buffer.from(JSON.stringify(validPayload));
    const nonce = nonceFor("same-response");
    const responses = await Promise.all([
      sendHeartbeat(baseUrl, { rawBody, nonce, signature: undefined }),
      sendHeartbeat(baseUrl, {
        rawBody,
        nonce: nonceFor("wrong"),
        signature: "v1=" + "0".repeat(64),
      }),
      sendHeartbeat(baseUrl, {
        rawBody,
        nonce: nonceFor("other-module"),
        signature: signHeartbeat(
          "account-integrations",
          rawBody,
          nonceFor("other-module"),
          TIMESTAMP,
          ACCOUNT_INTEGRATIONS_SECRET,
        ),
      }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      401, 401, 401,
    ]);
    await expect(
      Promise.all(responses.map((response) => response.json())),
    ).resolves.toEqual([
      { error: "unauthorized" },
      { error: "unauthorized" },
      { error: "unauthorized" },
    ]);
  });

  it.each([
    ["malformed JSON", Buffer.from("{")],
    [
      "strict JSON with an unknown field",
      Buffer.from(JSON.stringify({ ...validPayload, unexpected: true })),
    ],
  ])("returns invalid_heartbeat for %s", async (_label, rawBody) => {
    const { baseUrl } = await startHeartbeatServer(createService());

    const response = await sendHeartbeat(baseUrl, {
      rawBody,
      nonce: nonceFor(`invalid-${_label}`),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_heartbeat",
    });
  });

  it("returns stale_heartbeat for a signed lower timestamp", async () => {
    const { baseUrl } = await startHeartbeatServer(createService());

    await expect(
      sendHeartbeat(baseUrl, {
        nonce: nonceFor("newer"),
        timestamp: String(Math.floor((NOW + 1_000) / 1_000)),
      }),
    ).resolves.toMatchObject({ status: 202 });
    const response = await sendHeartbeat(baseUrl, {
      nonce: nonceFor("older"),
      timestamp: TIMESTAMP,
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "stale_heartbeat",
    });
  });

  it("accepts an exact signed raw body and returns the server receipt time", async () => {
    const { baseUrl } = await startHeartbeatServer(createService());
    const response = await sendHeartbeat(baseUrl, {
      nonce: nonceFor("accepted"),
      timestamp: String(Math.floor((NOW - 1_000) / 1_000)),
    });

    expect(response.status).toBe(202);
    expectHeartbeatHeaders(response);
    await expect(response.json()).resolves.toEqual({
      accepted: true,
      receivedAt: "2026-07-15T04:31:02.000Z",
    });
  });

  it.each([
    "/API/internal/modules/search-media/heartbeat",
    "/api/Internal/modules/search-media/heartbeat",
    "/api/internal/modules/SEARCH-MEDIA/heartbeat",
    "/api/internal/modules/search-media/Heartbeat",
    "/api/internal/modules/search-media/heartbeat/",
  ])("does not accept non-canonical path %s", async (path) => {
    let ingestCalls = 0;
    const { origin } = await startHeartbeatServer({
      ingest: () => {
        ingestCalls += 1;
        return { kind: "accepted", receivedAt: new Date(NOW).toISOString() };
      },
    });
    const rawBody = Buffer.from(JSON.stringify(validPayload));
    const nonce = nonceFor(`path-${path}`);
    const response = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Apollo-Heartbeat-Timestamp": TIMESTAMP,
        "X-Apollo-Heartbeat-Nonce": nonce,
        "X-Apollo-Heartbeat-Signature": signHeartbeat(
          "search-media",
          rawBody,
          nonce,
        ),
      },
      body: rawBody,
    });

    expect(response.status).toBe(404);
    expectHeartbeatHeaders(response);
    await expect(response.json()).resolves.toEqual({ error: "not_found" });
    expect(ingestCalls).toBe(0);
  });

  it.each(["GET", "PUT", "PATCH", "DELETE", "OPTIONS"])(
    "returns method_not_allowed for %s on the exact heartbeat route",
    async (method) => {
      const { baseUrl } = await startProductionServer();
      const response = await fetch(
        `${baseUrl}/internal/modules/search-media/heartbeat`,
        { method },
      );

      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
      expectHeartbeatHeaders(response);
      await expect(response.json()).resolves.toEqual({
        error: "method_not_allowed",
      });
    },
  );

  it("keeps the exact 8 KiB parser boundary and rejects larger bodies without mutation", async () => {
    const service = createService();
    const { baseUrl } = await startHeartbeatServer(service);
    const atLimit = Buffer.alloc(8 * 1024, "x");
    const overLimit = Buffer.alloc(8 * 1024 + 1, "x");

    const atLimitResponse = await sendHeartbeat(baseUrl, {
      rawBody: atLimit,
      nonce: nonceFor("at-limit"),
    });
    const overLimitResponse = await sendHeartbeat(baseUrl, {
      rawBody: overLimit,
      nonce: nonceFor("over-limit"),
    });

    expect(atLimitResponse.status).toBe(400);
    await expect(atLimitResponse.json()).resolves.toEqual({
      error: "invalid_heartbeat",
    });
    expect(overLimitResponse.status).toBe(413);
    await expect(overLimitResponse.json()).resolves.toEqual({
      error: "heartbeat_too_large",
    });
    expect(service.snapshot()).toEqual([
      {
        moduleId: "search-media",
        managed: true,
        status: "unknown",
        version: "unknown",
        requestsPerMinute: 0,
      },
      {
        moduleId: "account-integrations",
        managed: true,
        status: "unknown",
        version: "unknown",
        requestsPerMinute: 0,
      },
    ]);
  });

  it.each([
    ["text/plain", "text/plain"],
    ["missing content type", null],
  ])(
    "rejects an over-limit %s heartbeat before service mutation",
    async (_label, contentType) => {
      const service = createService();
      const { baseUrl } = await startHeartbeatServer(service);
      const response = await sendHeartbeat(baseUrl, {
        rawBody: Buffer.alloc(8 * 1024 + 1, "x"),
        nonce: nonceFor(`over-limit-${_label}`),
        contentType,
      });

      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual({
        error: "heartbeat_too_large",
      });
      expect(
        service
          .snapshot()
          .find((observation) => observation.moduleId === "search-media"),
      ).toEqual({
        moduleId: "search-media",
        managed: true,
        status: "unknown",
        version: "unknown",
        requestsPerMinute: 0,
      });
    },
  );

  it("rejects a signed non-JSON heartbeat without service mutation", async () => {
    const service = createService();
    const { baseUrl } = await startHeartbeatServer(service);
    const response = await sendHeartbeat(baseUrl, {
      nonce: nonceFor("non-json"),
      contentType: "text/plain",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_heartbeat",
    });
    expect(
      service
        .snapshot()
        .find((observation) => observation.moduleId === "search-media"),
    ).toEqual({
      moduleId: "search-media",
      managed: true,
      status: "unknown",
      version: "unknown",
      requestsPerMinute: 0,
    });
  });

  it("rejects unsupported content encoding before parsing", async () => {
    const rawBody = Buffer.from("private encoded heartbeat payload");
    const { baseUrl, capturedLogs } =
      await startHeartbeatServer(createService());
    const response = await sendHeartbeat(baseUrl, {
      rawBody,
      nonce: nonceFor("unsupported-encoding"),
      contentEncoding: "unsupported-test",
    });
    const body = await response.text();
    const exposed = JSON.stringify({ body, capturedLogs });

    expect(response.status).toBe(400);
    expect(body).toBe('{"error":"invalid_heartbeat"}');
    expect(exposed).not.toContain(rawBody.toString("utf8"));
    expect(exposed).not.toContain("unsupported-test");
    expect(exposed).not.toContain("UnsupportedMediaTypeError");
    expectHeartbeatHeaders(response);
    expect(capturedLogs).toEqual([]);
  });

  it("rejects a gzip bomb before inflation or service authentication", async () => {
    let ingestCalls = 0;
    const expandedBody = Buffer.alloc(128 * 1024, "private-heartbeat-data");
    const wireBody = gzipSync(expandedBody);
    expect(wireBody.byteLength).toBeLessThanOrEqual(8 * 1024);
    const { baseUrl } = await startHeartbeatServer({
      ingest: () => {
        ingestCalls += 1;
        return { kind: "unauthorized" };
      },
    });

    const response = await sendHeartbeat(baseUrl, {
      rawBody: wireBody,
      nonce: nonceFor("gzip-bomb"),
      contentEncoding: "gzip",
    });

    expect(response.status).toBe(400);
    expectHeartbeatHeaders(response);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_heartbeat",
    });
    expect(ingestCalls).toBe(0);
  });

  it("sanitizes malformed percent-encoded module IDs", async () => {
    const { origin } = await startHeartbeatServer(createService());
    const response = await fetch(
      `${origin}/api/internal/modules/search%ZZmedia/heartbeat`,
      { method: "POST" },
    );

    expect(response.status).toBe(400);
    expectHeartbeatHeaders(response);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_heartbeat",
    });
  });

  it("does not apply heartbeat response headers to ordinary API handlers", async () => {
    const { baseUrl } = await startHeartbeatServer(createService());
    const response = await fetch(`${baseUrl}/ordinary`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(response.headers.get("cache-control")).toBeNull();
    expect(response.headers.get("x-content-type-options")).toBeNull();
  });

  it("does not expose secrets or internal errors in responses or captured logs", async () => {
    const secret = "private-heartbeat-secret";
    const signature = "v1=private-signature";
    const rawBody = Buffer.from(
      JSON.stringify({ ...validPayload, version: "9.9.9-private" }),
    );
    const internalMessage = "internal parser failure";
    const { baseUrl, capturedLogs } = await startHeartbeatServer({
      ingest: () => {
        throw new Error(internalMessage);
      },
    });

    const response = await sendHeartbeat(baseUrl, {
      rawBody,
      nonce: secret,
      signature,
    });
    const body = await response.text();
    const exposed = JSON.stringify({ body, capturedLogs });

    expect(response.status).toBe(503);
    expect(body).toBe('{"error":"heartbeat_unavailable"}');
    for (const sensitiveValue of [
      secret,
      signature,
      rawBody.toString("utf8"),
      "9.9.9-private",
      internalMessage,
    ]) {
      expect(exposed).not.toContain(sensitiveValue);
    }
    expect(capturedLogs).toEqual([
      {
        bindings: { errorType: "Error" },
        message: "Module heartbeat unavailable",
      },
    ]);
  });
});
