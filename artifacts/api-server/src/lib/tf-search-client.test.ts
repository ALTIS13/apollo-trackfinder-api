import { createSignedBodySignature } from "@workspace/module-runtime-contract";
import {
  TF_SEARCH_COMMAND_PATH,
  TF_SEARCH_SUGGESTIONS_PATH,
  type TfSearchResponse,
  type TfSearchSuggestionsResponse,
} from "../../../../lib/tf-search-contract/src/index.js";
import { describe, expect, it, vi } from "vitest";

import {
  HttpTfSearchClient,
  TfSearchUnavailableError,
  parseTfSearchClientConfig,
} from "./tf-search-client.js";

const SECRET = "s".repeat(32);
const FIRST_REQUEST_ID = "10000000-0000-4000-8000-000000000001";
const SECOND_REQUEST_ID = "20000000-0000-4000-8000-000000000002";
const FIRST_NONCE = Buffer.alloc(32, 1).toString("base64url");
const SECOND_NONCE = Buffer.alloc(32, 2).toString("base64url");
const NOW_MS = 1_753_337_100_000;

function searchResponse(requestId: string): TfSearchResponse {
  return {
    schemaVersion: 1,
    requestId,
    query: "Artist Track",
    results: [
      {
        id: "yt_result",
        title: "Track",
        artist: "Artist",
        type: "original",
        duration: 180,
        source: "youtube",
        thumbnailUrl: null,
        quality: ["128", "320"],
        viewCount: 42,
        score: 91,
        sourceUrl: "https://www.youtube.com/watch?v=result",
      },
    ],
    cached: false,
    sources: ["yt", "sc", "bc", "dz"],
    fallbackAvailable: false,
    providerStatus: {
      yt: "ok",
      sc: "ok",
      bc: "ok",
      dz: "ok",
    },
  };
}

function suggestionsResponse(requestId: string): TfSearchSuggestionsResponse {
  return {
    schemaVersion: 1,
    requestId,
    suggestions: [{ artist: "Artist", title: "Track" }],
  };
}

function client(
  fetchImplementation: typeof fetch,
  overrides: Partial<ConstructorParameters<typeof HttpTfSearchClient>[0]> = {},
) {
  const requestIds = [FIRST_REQUEST_ID, SECOND_REQUEST_ID];
  const nonces = [FIRST_NONCE, SECOND_NONCE];
  return new HttpTfSearchClient(
    {
      origin: "https://search.apollot.ru",
      internalAuthSecret: SECRET,
      timeoutMs: 250,
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

describe("parseTfSearchClientConfig", () => {
  it("loads a file-backed secret and accepts an exact HTTPS origin", async () => {
    const readSecret = vi.fn().mockResolvedValue(` ${SECRET}\n`);

    await expect(
      parseTfSearchClientConfig(
        {
          TF_SEARCH_ORIGIN: "https://search.apollot.ru",
          TF_SEARCH_INTERNAL_AUTH_SECRET_FILE: "/run/secrets/tf-search",
        },
        readSecret,
      ),
    ).resolves.toEqual({
      origin: "https://search.apollot.ru",
      internalAuthSecret: SECRET,
      timeoutMs: 10_000,
    });
    expect(readSecret).toHaveBeenCalledWith("/run/secrets/tf-search");
  });

  it("allows HTTP only for an exact private service origin with the explicit flag", async () => {
    const readSecret = vi.fn().mockResolvedValue(SECRET);
    await expect(
      parseTfSearchClientConfig(
        {
          TF_SEARCH_ORIGIN: "http://tf-search:8080",
          TF_SEARCH_ALLOW_INSECURE_HTTP: "true",
          TF_SEARCH_INTERNAL_AUTH_SECRET_FILE: "/run/secrets/tf-search",
        },
        readSecret,
      ),
    ).resolves.toMatchObject({ origin: "http://tf-search:8080" });

    for (const origin of [
      "http://tf-search:8080",
      "http://10.0.0.5:8080",
      "https://search.apollot.ru/",
      "https://user:pass@search.apollot.ru",
      "https://search.apollot.ru/path",
      "https://search.apollot.ru?query=1",
    ]) {
      await expect(
        parseTfSearchClientConfig(
          {
            TF_SEARCH_ORIGIN: origin,
            TF_SEARCH_INTERNAL_AUTH_SECRET_FILE: "/run/secrets/tf-search",
          },
          readSecret,
        ),
      ).rejects.toThrow("invalid runtime configuration");
    }
  });

  it("rejects missing, inline, unreadable, and weak secrets", async () => {
    const base = {
      TF_SEARCH_ORIGIN: "https://search.apollot.ru",
      TF_SEARCH_INTERNAL_AUTH_SECRET: SECRET,
    };
    await expect(
      parseTfSearchClientConfig(base, vi.fn()),
    ).rejects.toThrow("invalid runtime configuration");
    await expect(
      parseTfSearchClientConfig(
        {
          ...base,
          TF_SEARCH_INTERNAL_AUTH_SECRET_FILE: "/run/secrets/tf-search",
        },
        vi.fn().mockRejectedValue(new Error("private path")),
      ),
    ).rejects.toThrow("invalid runtime configuration");
    await expect(
      parseTfSearchClientConfig(
        {
          ...base,
          TF_SEARCH_INTERNAL_AUTH_SECRET_FILE: "/run/secrets/tf-search",
        },
        vi.fn().mockResolvedValue("weak"),
      ),
    ).rejects.toThrow("invalid runtime configuration");
  });
});

describe("HttpTfSearchClient", () => {
  it("sends an exact signed search command without browser or account context", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(
      async (input, init) => {
        const body = JSON.parse(String(init?.body)) as {
          requestId: string;
        };
        return new Response(JSON.stringify(searchResponse(body.requestId)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    const gateway = client(fetchImplementation);

    const first = await gateway.search({
      artist: "Artist",
      title: "Track",
      mode: "auto",
      sources: ["yt", "sc", "bc", "dz"],
      maxResults: 20,
    });
    await gateway.search({
      artist: "Artist",
      title: "Track",
      mode: "manual",
      sources: ["yt"],
      maxResults: 3,
    });

    expect(first.requestId).toBe(FIRST_REQUEST_ID);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    const [url, init] = fetchImplementation.mock.calls[0]!;
    expect(String(url)).toBe(
      `https://search.apollot.ru${TF_SEARCH_COMMAND_PATH}`,
    );
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const rawBody = Buffer.from(String(init?.body));
    expect(JSON.parse(rawBody.toString("utf8"))).toEqual({
      schemaVersion: 1,
      requestId: FIRST_REQUEST_ID,
      artist: "Artist",
      title: "Track",
      mode: "auto",
      sources: ["yt", "sc", "bc", "dz"],
      maxResults: 20,
    });
    const headers = new Headers(init?.headers);
    expect([...headers.keys()].sort()).toEqual([
      "content-type",
      "x-apollo-internal-nonce",
      "x-apollo-internal-signature",
      "x-apollo-internal-timestamp",
    ]);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-apollo-internal-timestamp")).toBe(
      String(Math.floor(NOW_MS / 1_000)),
    );
    expect(headers.get("x-apollo-internal-nonce")).toBe(FIRST_NONCE);
    expect(headers.get("x-apollo-internal-signature")).toBe(
      createSignedBodySignature({
        method: "POST",
        path: TF_SEARCH_COMMAND_PATH,
        timestamp: String(Math.floor(NOW_MS / 1_000)),
        nonce: FIRST_NONCE,
        rawBody,
        secret: SECRET,
      }),
    );
    const serialized = JSON.stringify({
      body: JSON.parse(rawBody.toString("utf8")),
      headers: Object.fromEntries(headers),
    });
    for (const forbidden of [
      "cookie",
      "csrf",
      "account",
      "session",
      "installation",
      "entitlement",
      "authorization",
    ]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden);
    }

    const secondBody = JSON.parse(
      String(fetchImplementation.mock.calls[1]![1]?.body),
    ) as { requestId: string };
    const secondHeaders = new Headers(
      fetchImplementation.mock.calls[1]![1]?.headers,
    );
    expect(secondBody.requestId).toBe(SECOND_REQUEST_ID);
    expect(secondHeaders.get("x-apollo-internal-nonce")).toBe(SECOND_NONCE);
  });

  it("signs suggestions on their exact path and validates the response ID", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(
      async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as {
          requestId: string;
        };
        return new Response(
          JSON.stringify(suggestionsResponse(body.requestId)),
          { status: 200 },
        );
      },
    );
    const gateway = client(fetchImplementation);

    await expect(gateway.suggestions("artist", 5)).resolves.toEqual(
      suggestionsResponse(FIRST_REQUEST_ID),
    );
    const [url, init] = fetchImplementation.mock.calls[0]!;
    expect(String(url)).toBe(
      `https://search.apollot.ru${TF_SEARCH_SUGGESTIONS_PATH}`,
    );
    const rawBody = Buffer.from(String(init?.body));
    expect(JSON.parse(rawBody.toString("utf8"))).toEqual({
      schemaVersion: 1,
      requestId: FIRST_REQUEST_ID,
      query: "artist",
      limit: 5,
    });
    const headers = new Headers(init?.headers);
    expect(headers.get("x-apollo-internal-signature")).toBe(
      createSignedBodySignature({
        method: "POST",
        path: TF_SEARCH_SUGGESTIONS_PATH,
        timestamp: String(Math.floor(NOW_MS / 1_000)),
        nonce: FIRST_NONCE,
        rawBody,
        secret: SECRET,
      }),
    );
  });

  it.each([
    ["transport", () => Promise.reject(new Error("network"))],
    [
      "401",
      () =>
        Promise.resolve(
          new Response('{"error":"unauthorized"}', { status: 401 }),
        ),
    ],
    [
      "malformed JSON",
      () => Promise.resolve(new Response("{", { status: 200 })),
    ],
    [
      "invalid schema",
      () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              ...searchResponse(FIRST_REQUEST_ID),
              internal: "leak",
            }),
            { status: 200 },
          ),
        ),
    ],
    [
      "request ID mismatch",
      () =>
        Promise.resolve(
          new Response(JSON.stringify(searchResponse(SECOND_REQUEST_ID)), {
            status: 200,
          }),
        ),
    ],
    [
      "5xx",
      () =>
        Promise.resolve(
          new Response('{"error":"search_unavailable"}', { status: 503 }),
        ),
    ],
  ])("maps %s failures to one typed unavailable error without retry", async (
    _label,
    response,
  ) => {
    const fetchImplementation = vi.fn<typeof fetch>(response);
    const gateway = client(fetchImplementation);

    const error = await gateway
      .search({
        artist: "Artist",
        title: "Track",
        mode: "auto",
        sources: ["yt", "sc", "bc", "dz"],
        maxResults: 20,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TfSearchUnavailableError);
    expect(error).toMatchObject({ code: "search_unavailable" });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("aborts a bounded request and maps the timeout without retry", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const gateway = client(fetchImplementation, { timeoutMs: 10 });

    await expect(
      gateway.search({
        artist: "Artist",
        title: "Track",
        mode: "auto",
        sources: ["yt", "sc", "bc", "dz"],
        maxResults: 20,
      }),
    ).rejects.toMatchObject({ code: "search_unavailable" });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });
});
