import { createSignedBodySignature } from "@workspace/module-runtime-contract";
import {
  TF_INTEGRATIONS_COMMAND_PATH,
  type TfIntegrationsCommand,
  type TfIntegrationsSuccessResponse,
} from "../../../../lib/tf-integrations-contract/src/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HttpTfIntegrationsClient,
  TfIntegrationsUnavailableError,
  parseTfIntegrationsClientConfig,
} from "./tf-integrations-client.js";

const SECRET = "i".repeat(32);
const ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_ACCOUNT_ID = "90000000-0000-4000-8000-000000000009";
const FIRST_REQUEST_ID = "20000000-0000-4000-8000-000000000002";
const SECOND_REQUEST_ID = "30000000-0000-4000-8000-000000000003";
const FIRST_NONCE = Buffer.alloc(32, 1).toString("base64url");
const SECOND_NONCE = Buffer.alloc(32, 2).toString("base64url");
const NOW_MS = 1_753_337_100_000;

type GatewayCommand = Omit<
  Extract<TfIntegrationsCommand, { operation: "spotify.status" }>,
  "schemaVersion" | "requestId"
>;

function statusCommand(): GatewayCommand {
  return {
    accountId: ACCOUNT_ID,
    operation: "spotify.status",
    input: {},
  };
}

function statusResponse(
  requestId: string,
  overrides: Partial<TfIntegrationsSuccessResponse> = {},
): TfIntegrationsSuccessResponse {
  return {
    schemaVersion: 1,
    requestId,
    accountId: ACCOUNT_ID,
    operation: "spotify.status",
    result: {
      account: {
        provider: "spotify",
        connected: false,
      },
    },
    ...overrides,
  } as TfIntegrationsSuccessResponse;
}

function client(
  fetchImplementation: typeof fetch,
  overrides: Partial<
    ConstructorParameters<typeof HttpTfIntegrationsClient>[0]
  > = {},
) {
  const requestIds = [FIRST_REQUEST_ID, SECOND_REQUEST_ID];
  const nonces = [FIRST_NONCE, SECOND_NONCE];
  return new HttpTfIntegrationsClient(
    {
      origin: "https://integrations.apollot.ru",
      internalAuthSecret: SECRET,
      timeoutMs: 10_000,
      ...overrides,
    },
    {
      fetch: fetchImplementation,
      now: () => NOW_MS,
      randomUuid: () => requestIds.shift()!,
      randomNonce: () => nonces.shift()!,
    },
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("parseTfIntegrationsClientConfig", () => {
  it("loads a distinct file-backed command secret and exact origin", async () => {
    const readSecret = vi.fn().mockResolvedValue(` ${SECRET}\n`);

    await expect(
      parseTfIntegrationsClientConfig(
        {
          TF_INTEGRATIONS_ORIGIN: "https://integrations.apollot.ru",
          TF_INTEGRATIONS_INTERNAL_AUTH_SECRET_FILE:
            "/run/secrets/tf-integrations-command",
          TF_SEARCH_INTERNAL_AUTH_SECRET_FILE: "/run/secrets/tf-search",
          TF_INTEGRATIONS_INTERNAL_AUTH_SECRET: "inline-is-forbidden",
        },
        readSecret,
      ),
    ).resolves.toEqual({
      origin: "https://integrations.apollot.ru",
      internalAuthSecret: SECRET,
      timeoutMs: 10_000,
    });
    expect(readSecret).toHaveBeenCalledOnce();
    expect(readSecret).toHaveBeenCalledWith(
      "/run/secrets/tf-integrations-command",
    );

    for (const origin of [
      "https://integrations.apollot.ru/",
      "https://user:pass@integrations.apollot.ru",
      "https://integrations.apollot.ru/path",
      "https://integrations.apollot.ru?query=1",
    ]) {
      await expect(
        parseTfIntegrationsClientConfig(
          {
            TF_INTEGRATIONS_ORIGIN: origin,
            TF_INTEGRATIONS_INTERNAL_AUTH_SECRET_FILE:
              "/run/secrets/tf-integrations-command",
          },
          readSecret,
        ),
      ).rejects.toThrow("invalid runtime configuration");
    }
  });

  it("allows local HTTP only for a private hostname with the explicit flag", async () => {
    const readSecret = vi.fn().mockResolvedValue(SECRET);
    await expect(
      parseTfIntegrationsClientConfig(
        {
          TF_INTEGRATIONS_ORIGIN: "http://tf-integrations:8080",
          TF_INTEGRATIONS_ALLOW_INSECURE_HTTP: "true",
          TF_INTEGRATIONS_INTERNAL_AUTH_SECRET_FILE:
            "/run/secrets/tf-integrations-command",
        },
        readSecret,
      ),
    ).resolves.toMatchObject({ origin: "http://tf-integrations:8080" });

    for (const environment of [
      {
        TF_INTEGRATIONS_ORIGIN: "http://tf-integrations:8080",
      },
      {
        TF_INTEGRATIONS_ORIGIN: "http://10.0.0.5:8080",
        TF_INTEGRATIONS_ALLOW_INSECURE_HTTP: "true",
      },
      {
        TF_INTEGRATIONS_ORIGIN: "http://tf-integrations.example:8080",
        TF_INTEGRATIONS_ALLOW_INSECURE_HTTP: "true",
      },
      {
        TF_INTEGRATIONS_ORIGIN: "http://tf-integrations:8080",
        TF_INTEGRATIONS_ALLOW_INSECURE_HTTP: "TRUE",
      },
    ]) {
      await expect(
        parseTfIntegrationsClientConfig(
          {
            ...environment,
            TF_INTEGRATIONS_INTERNAL_AUTH_SECRET_FILE:
              "/run/secrets/tf-integrations-command",
          },
          readSecret,
        ),
      ).rejects.toThrow("invalid runtime configuration");
    }
  });
});

describe("HttpTfIntegrationsClient", () => {
  it("signs the exact command bytes with fresh timestamp, nonce, and request ID", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (_input, init) => {
      const command = JSON.parse(String(init?.body)) as {
        requestId: string;
      };
      return new Response(
        JSON.stringify(statusResponse(command.requestId)),
        { status: 200 },
      );
    });
    const gateway = client(fetchImplementation);

    await gateway.execute(statusCommand());
    await gateway.execute(statusCommand());

    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    const firstInit = fetchImplementation.mock.calls[0]![1];
    const rawBody = Buffer.from(String(firstInit?.body), "utf8");
    expect(JSON.parse(rawBody.toString("utf8"))).toEqual({
      schemaVersion: 1,
      requestId: FIRST_REQUEST_ID,
      accountId: ACCOUNT_ID,
      operation: "spotify.status",
      input: {},
    });
    const firstHeaders = new Headers(firstInit?.headers);
    expect(firstHeaders.get("x-apollo-internal-timestamp")).toBe(
      String(Math.floor(NOW_MS / 1_000)),
    );
    expect(firstHeaders.get("x-apollo-internal-nonce")).toBe(FIRST_NONCE);
    expect(firstHeaders.get("x-apollo-internal-signature")).toBe(
      createSignedBodySignature({
        method: "POST",
        path: TF_INTEGRATIONS_COMMAND_PATH,
        timestamp: String(Math.floor(NOW_MS / 1_000)),
        nonce: FIRST_NONCE,
        rawBody,
        secret: SECRET,
      }),
    );

    const secondBody = JSON.parse(
      String(fetchImplementation.mock.calls[1]![1]?.body),
    ) as { requestId: string };
    const secondHeaders = new Headers(
      fetchImplementation.mock.calls[1]![1]?.headers,
    );
    expect(secondBody.requestId).toBe(SECOND_REQUEST_ID);
    expect(secondHeaders.get("x-apollo-internal-nonce")).toBe(SECOND_NONCE);
  });

  it("uses POST, exact path, JSON identity encoding, redirect error, and a 10 second abort", async () => {
    vi.useFakeTimers();
    const fetchImplementation = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const gateway = client(fetchImplementation);

    const pending = gateway.execute(statusCommand());
    const rejection = expect(pending).rejects.toBeInstanceOf(
      TfIntegrationsUnavailableError,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;

    const [url, init] = fetchImplementation.mock.calls[0]!;
    expect(String(url)).toBe(
      `https://integrations.apollot.ru${TF_INTEGRATIONS_COMMAND_PATH}`,
    );
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(true);
    const headers = new Headers(init?.headers);
    expect([...headers.keys()].sort()).toEqual([
      "accept",
      "accept-encoding",
      "content-type",
      "x-apollo-internal-nonce",
      "x-apollo-internal-signature",
      "x-apollo-internal-timestamp",
    ]);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("accept-encoding")).toBe("identity");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("rejects non-200, oversized, malformed, uncorrelated, and wrong-operation responses", async () => {
    const cases: Array<() => Response> = [
      () => new Response("upstream", { status: 503 }),
      () => new Response("x".repeat(1024 * 1024 + 1), { status: 200 }),
      () => new Response("{", { status: 200 }),
      () =>
        new Response(JSON.stringify(statusResponse(SECOND_REQUEST_ID)), {
          status: 200,
        }),
      () =>
        new Response(
          JSON.stringify(
            statusResponse(FIRST_REQUEST_ID, {
              accountId: OTHER_ACCOUNT_ID,
            }),
          ),
          { status: 200 },
        ),
      () =>
        new Response(
          JSON.stringify({
            schemaVersion: 1,
            requestId: FIRST_REQUEST_ID,
            accountId: ACCOUNT_ID,
            operation: "yandex.status",
            result: {
              account: { provider: "yandex", connected: false },
            },
          }),
          { status: 200 },
        ),
      () =>
        new Response(
          JSON.stringify({
            schemaVersion: 1,
            requestId: FIRST_REQUEST_ID,
            accountId: ACCOUNT_ID,
            operation: "spotify.status",
            result: {
              account: { provider: "yandex", connected: false },
            },
          }),
          { status: 200 },
        ),
    ];

    for (const response of cases) {
      const gateway = client(vi.fn<typeof fetch>().mockResolvedValue(response()));
      await expect(gateway.execute(statusCommand())).rejects.toEqual(
        expect.objectContaining({ code: "integrations_unavailable" }),
      );
    }
  });

  it("maps every transport failure to integrations_unavailable without leaking command values", async () => {
    const tokenCanary = "yandex-secret-token-canary";
    const codeCanary = "spotify-code-canary";
    const failures = [
      new TypeError(`connect failed: ${tokenCanary}`),
      new DOMException(`aborted: ${codeCanary}`, "AbortError"),
      new Error(`socket failed: ${tokenCanary}:${codeCanary}`),
    ];

    for (const failure of failures) {
      const gateway = client(
        vi.fn<typeof fetch>().mockRejectedValue(failure),
      );
      const command = {
        accountId: ACCOUNT_ID,
        operation: "yandex.token.upsert",
        input: { token: tokenCanary },
      } as const;

      let caught: unknown;
      try {
        await gateway.execute(command);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(TfIntegrationsUnavailableError);
      expect(caught).toEqual(
        expect.objectContaining({ code: "integrations_unavailable" }),
      );
      const serialized = JSON.stringify(caught);
      expect(serialized).not.toContain(tokenCanary);
      expect(serialized).not.toContain(codeCanary);
      expect(String(caught)).not.toContain(tokenCanary);
      expect(String(caught)).not.toContain(codeCanary);
    }
  });
});
