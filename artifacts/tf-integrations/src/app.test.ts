import { Buffer } from "node:buffer";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createSignedBodySignature } from "@workspace/module-runtime-contract";
import type {
  TfIntegrationsCommand,
  TfIntegrationsErrorResponse,
  TfIntegrationsSuccessResponse,
} from "@workspace/tf-integrations-contract";
import type { TfIntegrationsCommandContext } from "@workspace/tf-integrations-db";
import { describe, expect, it, vi } from "vitest";

import {
  createTfIntegrationsApp,
  createTfIntegrationsReadiness,
} from "./app.js";
import {
  HmacInternalRequestAuthenticator,
  type InternalRequestAuthenticator,
} from "./internal-auth.js";
import type { TfIntegrationsAdminOverviewService } from "./admin-overview.js";

const commandSecret = "c".repeat(32);
const requestId = "10000000-0000-4000-8000-000000000001";
const accountId = "20000000-0000-4000-8000-000000000002";
const fetchBlockedPorts = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69,
  77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119,
  123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515,
  526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990,
  993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000,
  6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

function isFetchBlockedPort(port: number): boolean {
  return fetchBlockedPorts.has(port);
}

const command: TfIntegrationsCommand = {
  schemaVersion: 1,
  requestId,
  accountId,
  operation: "spotify.status",
  input: {},
};
const response: TfIntegrationsSuccessResponse = {
  schemaVersion: 1,
  requestId,
  accountId,
  operation: "spotify.status",
  result: {
    account: { provider: "spotify", connected: false },
  },
};

interface TestService {
  execute(
    input: TfIntegrationsCommand,
    context: TfIntegrationsCommandContext,
  ): Promise<TfIntegrationsSuccessResponse | TfIntegrationsErrorResponse>;
}

function service(
  execute: TestService["execute"] = async () => response,
): TestService {
  return { execute };
}

function signedHeaders(path: string, rawBody: Buffer, nonceIndex = 1) {
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const nonceBytes = Buffer.alloc(32);
  nonceBytes.writeUInt32BE(nonceIndex, 28);
  const nonce = nonceBytes.toString("base64url");
  return {
    "content-type": "application/json",
    "x-apollo-internal-timestamp": timestamp,
    "x-apollo-internal-nonce": nonce,
    "x-apollo-internal-signature": createSignedBodySignature({
      method: "POST",
      path,
      timestamp,
      nonce,
      rawBody,
      secret: commandSecret,
    }),
  };
}

function app(
  options: {
    readonly execute?: TestService["execute"];
    readonly readiness?: ReturnType<typeof createTfIntegrationsReadiness>;
    readonly commandTimeoutMs?: number;
    readonly maxConcurrentCommands?: number;
    readonly shutdownSignal?: AbortSignal;
    readonly now?: () => number;
    readonly auth?: InternalRequestAuthenticator;
    readonly adminOverview?: TfIntegrationsAdminOverviewService;
  } = {},
) {
  return createTfIntegrationsApp({
    service: service(options.execute),
    auth:
      options.auth ??
      new HmacInternalRequestAuthenticator({ secret: commandSecret }),
    readiness:
      options.readiness ??
      createTfIntegrationsReadiness({
        isMigrationCurrent: async () => true,
        probeDatabase: async () => true,
      }),
    ...(options.commandTimeoutMs === undefined
      ? {}
      : { commandTimeoutMs: options.commandTimeoutMs }),
    ...(options.maxConcurrentCommands === undefined
      ? {}
      : { maxConcurrentCommands: options.maxConcurrentCommands }),
    ...(options.shutdownSignal === undefined
      ? {}
      : { shutdownSignal: options.shutdownSignal }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.adminOverview === undefined
      ? {}
      : { adminOverview: options.adminOverview }),
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) =>
      error === undefined ? resolve() : reject(error),
    );
  });
}

async function listenForFetch(
  instance: ReturnType<typeof createTfIntegrationsApp>,
): Promise<{ readonly port: number; readonly server: Server }> {
  for (;;) {
    const server = instance.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    if (!isFetchBlockedPort(port)) return { port, server };
    await closeServer(server);
  }
}

async function request(
  instance: ReturnType<typeof createTfIntegrationsApp>,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const { port, server } = await listenForFetch(instance);
  try {
    return await fetch(`http://127.0.0.1:${port}${path}`, init);
  } finally {
    await closeServer(server);
  }
}

async function rawTargetRequest(
  instance: ReturnType<typeof createTfIntegrationsApp>,
  target: string,
  rawRequestBody: Buffer,
  headers: Readonly<Record<string, string>>,
): Promise<{ readonly status: number; readonly body: string }> {
  const server = instance.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await new Promise((resolve, reject) => {
      const outgoing = httpRequest(
        {
          hostname: "127.0.0.1",
          port,
          method: "POST",
          path: target,
          headers: {
            ...headers,
            "content-length": String(rawRequestBody.byteLength),
          },
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
          incoming.once("error", reject);
          incoming.once("end", () => {
            resolve({
              status: incoming.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );
      outgoing.once("error", reject);
      outgoing.end(rawRequestBody);
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) =>
        error === undefined ? resolve() : reject(error),
      );
    });
  }
}

describe("TF integrations private HTTP runtime", () => {
  it("classifies fetch-blocked listener ports", () => {
    expect(isFetchBlockedPort(6000)).toBe(true);
    expect(isFetchBlockedPort(49_152)).toBe(false);
  });

  it("reports liveness independently from database readiness", async () => {
    const result = await request(
      app({
        readiness: createTfIntegrationsReadiness({
          isMigrationCurrent: async () => false,
          probeDatabase: async () => false,
        }),
      }),
      "/healthz",
    );

    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toEqual({ status: "ok" });
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("exposes only exact permitted routes and methods", async () => {
    const execute = vi.fn<TestService["execute"]>(async () => response);
    const instance = app({ execute });

    for (const [method, path] of [
      ["HEAD", "/healthz"],
      ["HEAD", "/readyz"],
      ["OPTIONS", "/healthz"],
      ["OPTIONS", "/readyz"],
      ["OPTIONS", "/v1/commands"],
      ["POST", "/healthz"],
      ["POST", "/readyz"],
      ["GET", "/v1/commands"],
    ] as const) {
      const result = await request(instance, path, { method });
      expect({
        method,
        path,
        status: result.status,
        allow: result.headers.get("allow"),
      }).toEqual({ method, path, status: 404, allow: null });
    }

    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects query, fragment, and every other extra command target without canonicalizing HMAC input", async () => {
    const execute = vi.fn<TestService["execute"]>(async () => response);
    const instance = app({ execute });
    const body = Buffer.from(JSON.stringify(command), "utf8");

    for (const target of [
      "/v1/commands?debug=1",
      "/v1/commands#fragment",
      "/v1/commands/extra",
    ]) {
      const result = await rawTargetRequest(
        instance,
        target,
        body,
        signedHeaders(target, body, 20 + target.length),
      );
      expect(result).toEqual({ status: 404, body: "" });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("reports ready only after current migrations and a bounded database probe", async () => {
    const cases = [
      {
        migration: async () => true,
        probe: async () => true,
        status: 200,
        body: { status: "ok" },
      },
      {
        migration: async () => false,
        probe: async () => true,
        status: 503,
        body: { status: "unavailable" },
      },
      {
        migration: async () => true,
        probe: async () => false,
        status: 503,
        body: { status: "unavailable" },
      },
      {
        migration: async () => new Promise<boolean>(() => undefined),
        probe: async () => true,
        status: 503,
        body: { status: "unavailable" },
      },
    ];

    for (const current of cases) {
      const result = await request(
        app({
          readiness: createTfIntegrationsReadiness({
            isMigrationCurrent: current.migration,
            probeDatabase: current.probe,
            timeoutMs: 10,
          }),
        }),
        "/readyz",
      );
      expect(result.status).toBe(current.status);
      await expect(result.json()).resolves.toEqual(current.body);
    }
  });

  it("rejects unsupported encoding, non-JSON, oversized, unsigned, replayed, and malformed commands", async () => {
    const execute = vi.fn<TestService["execute"]>(async () => response);
    const instance = app({ execute });
    const body = Buffer.from(JSON.stringify(command), "utf8");
    const attempts: RequestInit[] = [
      {
        method: "POST",
        headers: {
          ...signedHeaders("/v1/commands", body, 1),
          "content-encoding": "gzip",
        },
        body,
      },
      {
        method: "POST",
        headers: {
          ...signedHeaders("/v1/commands", body, 2),
          "content-type": "text/plain",
        },
        body,
      },
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      },
    ];

    for (const init of attempts) {
      const result = await request(instance, "/v1/commands", init);
      expect(result.status).toBe(401);
      await expect(result.json()).resolves.toEqual({
        error: "unauthorized",
      });
    }

    const replayHeaders = signedHeaders("/v1/commands", body, 3);
    const accepted = await request(instance, "/v1/commands", {
      method: "POST",
      headers: replayHeaders,
      body,
    });
    expect(accepted.status).toBe(200);
    const replayed = await request(instance, "/v1/commands", {
      method: "POST",
      headers: replayHeaders,
      body,
    });
    expect(replayed.status).toBe(401);

    const malformedBody = Buffer.from('{"schemaVersion":1}', "utf8");
    const malformed = await request(instance, "/v1/commands", {
      method: "POST",
      headers: signedHeaders("/v1/commands", malformedBody, 4),
      body: malformedBody,
    });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({
      error: "invalid_request",
    });

    const oversizedBody = Buffer.alloc(64 * 1024 + 1, 0x20);
    const oversized = await request(instance, "/v1/commands", {
      method: "POST",
      headers: signedHeaders("/v1/commands", oversizedBody, 5),
      body: oversizedBody,
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toEqual({
      error: "invalid_request",
    });

    const wrongCase = await request(instance, "/V1/commands", {
      method: "POST",
      headers: signedHeaders("/V1/commands", body, 6),
      body,
    });
    expect(wrongCase.status).toBe(404);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("claims replay state only after a strict command identifies its canonical account partition", async () => {
    const execute = vi.fn<TestService["execute"]>(async () => response);
    const instance = app({ execute });
    const reusedNonce = 40;
    const malformedBody = Buffer.from('{"schemaVersion":1}', "utf8");
    const malformed = await request(instance, "/v1/commands", {
      method: "POST",
      headers: signedHeaders("/v1/commands", malformedBody, reusedNonce),
      body: malformedBody,
    });
    expect(malformed.status).toBe(400);

    const body = Buffer.from(JSON.stringify(command), "utf8");
    const accepted = await request(instance, "/v1/commands", {
      method: "POST",
      headers: signedHeaders("/v1/commands", body, reusedNonce),
      body,
    });
    expect(accepted.status).toBe(200);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("does not consume replay state when readiness rejects a command", async () => {
    let ready = false;
    const execute = vi.fn<TestService["execute"]>(async () => response);
    const instance = app({
      execute,
      readiness: createTfIntegrationsReadiness({
        isMigrationCurrent: async () => ready,
        probeDatabase: async () => true,
      }),
    });
    const body = Buffer.from(JSON.stringify(command), "utf8");
    const headers = signedHeaders("/v1/commands", body, 41);

    const rejected = await request(instance, "/v1/commands", {
      method: "POST",
      headers,
      body,
    });
    expect(rejected.status).toBe(503);
    expect(execute).not.toHaveBeenCalled();

    ready = true;
    const admitted = await request(instance, "/v1/commands", {
      method: "POST",
      headers,
      body,
    });
    expect(admitted.status).toBe(200);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("surfaces replay backpressure after the live nonce capacity is exhausted", async () => {
    const execute = vi.fn<TestService["execute"]>(async (input) => {
      if (input.operation !== "spotify.liked.list") {
        throw new Error("unexpected operation");
      }
      return {
        schemaVersion: 1,
        requestId: input.requestId,
        accountId: input.accountId,
        operation: input.operation,
        result: {
          tracks: [],
          total: 12_850,
          offset: input.input.offset,
          limit: input.input.limit,
        },
      };
    });
    const instance = app({ execute });

    for (let page = 0; page <= 256; page += 1) {
      const pageCommand: TfIntegrationsCommand = {
        schemaVersion: 1,
        requestId: `10000000-0000-4000-8000-${String(page + 1).padStart(12, "0")}`,
        accountId,
        operation: "spotify.liked.list",
        input: { offset: page * 50, limit: 50 },
      };
      const body = Buffer.from(JSON.stringify(pageCommand), "utf8");
      const result = await request(instance, "/v1/commands", {
        method: "POST",
        headers: signedHeaders("/v1/commands", body, 80 + page),
        body,
      });
      if (page < 256) {
        expect(result.status).toBe(200);
        await result.body?.cancel();
      } else {
        expect(result.status).toBe(503);
        await expect(result.json()).resolves.toEqual({
          error: "integrations_unavailable",
        });
      }
    }

    expect(execute).toHaveBeenCalledTimes(256);
  });

  it("propagates one absolute command deadline with the abort signal", async () => {
    let observed: TfIntegrationsCommandContext | undefined;
    const result = await request(
      app({
        commandTimeoutMs: 250,
        execute: async (_input, context) => {
          observed = context;
          return response;
        },
      }),
      "/v1/commands",
      {
        method: "POST",
        headers: signedHeaders(
          "/v1/commands",
          Buffer.from(JSON.stringify(command), "utf8"),
          50,
        ),
        body: JSON.stringify(command),
      },
    );

    expect(result.status).toBe(200);
    expect(observed?.signal).toBeInstanceOf(AbortSignal);
    expect(observed?.deadlineAt).toEqual(expect.any(Number));
    expect(observed!.deadlineAt! - Date.now()).toBeGreaterThan(0);
    expect(observed!.deadlineAt! - Date.now()).toBeLessThanOrEqual(250);
  });

  it("never reports service success after command timeout or runtime shutdown abort", async () => {
    const timeoutResult = await request(
      app({
        commandTimeoutMs: 25,
        execute: async (_input, context) => {
          if (context === undefined) {
            return {
              schemaVersion: 1,
              requestId,
              accountId,
              operation: "spotify.status",
              error: { code: "provider_unavailable" },
            };
          }
          await new Promise<void>((resolve) => {
            context.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          return response;
        },
      }),
      "/v1/commands",
      {
        method: "POST",
        headers: signedHeaders(
          "/v1/commands",
          Buffer.from(JSON.stringify(command), "utf8"),
          51,
        ),
        body: JSON.stringify(command),
      },
    );
    expect(timeoutResult.status).toBe(503);
    await expect(timeoutResult.json()).resolves.toEqual({
      error: "integrations_unavailable",
    });

    const shutdown = new AbortController();
    let started: (() => void) | undefined;
    const executionStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const shutdownPending = request(
      app({
        shutdownSignal: shutdown.signal,
        execute: async (_input, context) => {
          started?.();
          if (context === undefined) {
            return {
              schemaVersion: 1,
              requestId,
              accountId,
              operation: "spotify.status",
              error: { code: "provider_unavailable" },
            };
          }
          await new Promise<void>((resolve) => {
            context.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          return response;
        },
      }),
      "/v1/commands",
      {
        method: "POST",
        headers: signedHeaders(
          "/v1/commands",
          Buffer.from(JSON.stringify(command), "utf8"),
          52,
        ),
        body: JSON.stringify(command),
      },
    );
    await executionStarted;
    shutdown.abort();
    const shutdownResult = await shutdownPending;
    expect(shutdownResult.status).toBe(503);
    await expect(shutdownResult.json()).resolves.toEqual({
      error: "integrations_unavailable",
    });
  });

  it("checks the absolute deadline after serializing and immediately before writing success bytes", async () => {
    let clockReads = 0;
    const now = vi.fn(() => {
      clockReads += 1;
      return clockReads < 5 ? 10_000 : 10_101;
    });
    const body = Buffer.from(JSON.stringify(command), "utf8");

    const result = await request(
      app({
        commandTimeoutMs: 100,
        now,
        execute: async () => response,
      }),
      "/v1/commands",
      {
        method: "POST",
        headers: signedHeaders("/v1/commands", body, 54),
        body,
      },
    );

    expect(result.status).toBe(503);
    expect(await result.text()).toBe(
      '{"error":"integrations_unavailable"}',
    );
    expect(now).toHaveBeenCalledTimes(5);
  });

  it("aborts command work when the HTTP client disconnects", async () => {
    let observedSignal: AbortSignal | undefined;
    let started: (() => void) | undefined;
    const executionStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let aborted: (() => void) | undefined;
    const executionAborted = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    const instance = app({
      execute: async (_input, context) => {
        started?.();
        if (context === undefined) {
          aborted?.();
          return response;
        }
        observedSignal = context.signal;
        await new Promise<void>((resolve) => {
          context.signal.addEventListener(
            "abort",
            () => {
              aborted?.();
              resolve();
            },
            { once: true },
          );
        });
        return response;
      },
    });
    const server = instance.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    const body = Buffer.from(JSON.stringify(command), "utf8");
    const outgoing = httpRequest({
      hostname: "127.0.0.1",
      port,
      method: "POST",
      path: "/v1/commands",
      headers: {
        ...signedHeaders("/v1/commands", body, 53),
        "content-length": String(body.byteLength),
      },
    });
    outgoing.on("error", () => undefined);
    outgoing.end(body);
    await executionStarted;
    outgoing.destroy();
    await executionAborted;
    expect(observedSignal?.aborted).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("bounds concurrent module commands before invoking provider service work", async () => {
    let calls = 0;
    let started: (() => void) | undefined;
    const firstTwoStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const instance = app({
      maxConcurrentCommands: 2,
      execute: async () => {
        calls += 1;
        if (calls === 2) started?.();
        await blocked;
        return response;
      },
    });
    const server = instance.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    const body = Buffer.from(JSON.stringify(command), "utf8");
    const send = (nonceByte: number) =>
      fetch(`http://127.0.0.1:${port}/v1/commands`, {
        method: "POST",
        headers: signedHeaders("/v1/commands", body, nonceByte),
        body,
      });

    const first = send(61);
    const second = send(62);
    await firstTwoStarted;
    let rejectionTimer: ReturnType<typeof setTimeout> | undefined;
    const third = send(63);
    const rejected = await Promise.race([
      third,
      new Promise<"timeout">((resolve) => {
        rejectionTimer = setTimeout(() => resolve("timeout"), 100);
      }),
    ]);
    if (rejectionTimer !== undefined) clearTimeout(rejectionTimer);
    expect(rejected).not.toBe("timeout");
    expect((rejected as Response).status).toBe(503);
    await expect((rejected as Response).json()).resolves.toEqual({
      error: "integrations_unavailable",
    });
    release?.();
    await Promise.all([first, second]);
    const retried = await send(63);
    expect(retried.status).toBe(200);
    await retried.body?.cancel();
    expect(calls).toBe(3);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("atomically rejects a duplicate only after both requests pass command admission", async () => {
    let calls = 0;
    let started: (() => void) | undefined;
    const executionStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const readiness = {
      check: vi.fn(async () => true),
    };
    const instance = app({
      maxConcurrentCommands: 2,
      readiness,
      execute: async () => {
        calls += 1;
        started?.();
        await blocked;
        return response;
      },
    });
    const server = instance.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    const body = Buffer.from(JSON.stringify(command), "utf8");
    const headers = signedHeaders("/v1/commands", body, 64);
    const send = () =>
      fetch(`http://127.0.0.1:${port}/v1/commands`, {
        method: "POST",
        headers,
        body,
      });

    const first = send();
    await executionStarted;
    const duplicate = await send();

    expect(duplicate.status).toBe(401);
    expect(readiness.check).toHaveBeenCalledTimes(2);
    expect(calls).toBe(1);
    release?.();
    expect((await first).status).toBe(200);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns a schema-validated correlated success or sanitized internal error", async () => {
    const body = Buffer.from(JSON.stringify(command), "utf8");
    const success = await request(app(), "/v1/commands", {
      method: "POST",
      headers: signedHeaders("/v1/commands", body, 7),
      body,
    });
    expect(success.status).toBe(200);
    expect(success.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(await success.text()).toBe(JSON.stringify(response));

    const canary = "raw-upstream-secret-canary";
    const mismatched = await request(
      app({
        execute: async () =>
          ({
            ...response,
            requestId: "30000000-0000-4000-8000-000000000003",
            canary,
          }) as unknown as TfIntegrationsSuccessResponse,
      }),
      "/v1/commands",
      {
        method: "POST",
        headers: signedHeaders("/v1/commands", body, 8),
        body,
      },
    );
    expect(mismatched.status).toBe(500);
    expect(await mismatched.text()).toBe('{"error":"internal_error"}');

    const thrown = await request(
      app({
        execute: async () => {
          throw new Error(canary);
        },
      }),
      "/v1/commands",
      {
        method: "POST",
        headers: signedHeaders("/v1/commands", body, 9),
        body,
      },
    );
    expect(thrown.status).toBe(500);
    expect(await thrown.text()).toBe('{"error":"internal_error"}');
  });

  it("does not make readiness depend on Spotify or Yandex availability", async () => {
    const execute = vi.fn<TestService["execute"]>(async () => {
      throw new Error("spotify and yandex unavailable");
    });
    const instance = app({ execute });

    const ready = await request(instance, "/readyz");
    expect(ready.status).toBe(200);
    expect(execute).not.toHaveBeenCalled();
  });

  it("claims the fixed admin replay partition before loading connections", async () => {
    const proof = {} as never;
    const auth: InternalRequestAuthenticator = {
      verify: vi.fn(() => proof),
      claim: vi.fn(() => "accepted" as const),
    };
    const load = vi.fn(async () => ({ connections: [] }));
    const body = Buffer.from(JSON.stringify({ accountIds: [] }), "utf8");

    const result = await request(
      app({
        auth,
        adminOverview: {
          load,
        } as unknown as TfIntegrationsAdminOverviewService,
      }),
      "/v1/internal/admin/connections",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      },
    );

    expect(result.status).toBe(200);
    expect(auth.claim).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000000",
      proof,
    );
    expect(load).toHaveBeenCalledWith({ accountIds: [] });
  });
});
