import { Buffer } from "node:buffer";
import type { AddressInfo } from "node:net";

import { createSignedBodySignature } from "@workspace/module-runtime-contract";
import type {
  TfIntegrationsCommand,
  TfIntegrationsErrorResponse,
  TfIntegrationsSuccessResponse,
} from "@workspace/tf-integrations-contract";
import { describe, expect, it, vi } from "vitest";

import {
  createTfIntegrationsApp,
  createTfIntegrationsReadiness,
} from "./app.js";
import { HmacInternalRequestAuthenticator } from "./internal-auth.js";

const commandSecret = "c".repeat(32);
const requestId = "10000000-0000-4000-8000-000000000001";
const accountId = "20000000-0000-4000-8000-000000000002";
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
  ): Promise<TfIntegrationsSuccessResponse | TfIntegrationsErrorResponse>;
}

function service(
  execute: TestService["execute"] = async () => response,
): TestService {
  return { execute };
}

function signedHeaders(path: string, rawBody: Buffer, nonceByte = 1) {
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const nonce = Buffer.alloc(32, nonceByte).toString("base64url");
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
  } = {},
) {
  return createTfIntegrationsApp({
    service: service(options.execute),
    auth: new HmacInternalRequestAuthenticator({ secret: commandSecret }),
    readiness:
      options.readiness ??
      createTfIntegrationsReadiness({
        isMigrationCurrent: async () => true,
        probeDatabase: async () => true,
      }),
  });
}

async function request(
  instance: ReturnType<typeof createTfIntegrationsApp>,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const server = instance.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fetch(`http://127.0.0.1:${port}${path}`, init);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) =>
        error === undefined ? resolve() : reject(error),
      );
    });
  }
}

describe("TF integrations private HTTP runtime", () => {
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

  it("returns a schema-validated correlated success or sanitized internal error", async () => {
    const body = Buffer.from(JSON.stringify(command), "utf8");
    const success = await request(app(), "/v1/commands", {
      method: "POST",
      headers: signedHeaders("/v1/commands", body, 7),
      body,
    });
    expect(success.status).toBe(200);
    await expect(success.json()).resolves.toEqual(response);

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
});
