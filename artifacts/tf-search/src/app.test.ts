import { Buffer } from "node:buffer";
import type { AddressInfo } from "node:net";
import { createSignedBodySignature } from "@workspace/module-runtime-contract";
import type {
  TfSearchArtistDiscoveryCommand,
  TfSearchArtistDiscoveryResponse,
  TfSearchCommand,
  TfSearchResponse,
  TfSearchSuggestionsCommand,
  TfSearchSuggestionsResponse,
} from "@workspace/tf-search-contract";
import { describe, expect, it, vi } from "vitest";
import { createTfSearchApp } from "./app.js";
import { HmacInternalRequestAuthenticator } from "./internal-auth.js";
import type { SearchService } from "./search-service.js";

const secret = "s".repeat(32);
const requestId = "10000000-0000-4000-8000-000000000001";
const command: TfSearchCommand = {
  schemaVersion: 1,
  requestId,
  artist: "Artist",
  title: "Track",
  mode: "auto",
  sources: ["yt"],
  maxResults: 1,
};
const response: TfSearchResponse = {
  schemaVersion: 1,
  requestId,
  query: "Artist Track",
  results: [],
  cached: false,
  sources: ["yt"],
  fallbackAvailable: false,
  providerStatus: { yt: "ok", sc: "skipped", bc: "skipped", dz: "skipped" },
};
const discoveryCommand: TfSearchArtistDiscoveryCommand = {
  schemaVersion: 1,
  requestId,
  artist: "Artist",
  sources: ["yt", "sc"],
  limitPerSource: 6,
};
const discoveryResponse: TfSearchArtistDiscoveryResponse = {
  schemaVersion: 1,
  requestId,
  query: "Artist",
  results: [],
  sources: ["yt", "sc"],
  providerStatus: { yt: "ok", sc: "ok", bc: "skipped", dz: "skipped" },
};

function service(overrides: Partial<SearchService> = {}): SearchService {
  return {
    async search() {
      return response;
    },
    async suggestions(input: TfSearchSuggestionsCommand): Promise<TfSearchSuggestionsResponse> {
      return { schemaVersion: 1, requestId: input.requestId, suggestions: [] };
    },
    async discoverArtist() {
      return discoveryResponse;
    },
    telemetry() {
      return { requestsPerMinute: 0, status: "healthy" };
    },
    ...overrides,
  };
}

function signedHeaders(path: string, rawBody: Buffer) {
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const nonce = "A".repeat(43);
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
      secret,
    }),
  };
}

async function request(
  app: ReturnType<typeof createTfSearchApp>,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fetch(`http://127.0.0.1:${port}${path}`, init);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
}

function app(options: { readonly service?: SearchService; readonly ready?: () => boolean } = {}) {
  return createTfSearchApp({
    service: options.service ?? service(),
    auth: new HmacInternalRequestAuthenticator({ secret }),
    ready: options.ready ?? (() => true),
  });
}

describe("TF search HTTP boundary", () => {
  it("serves liveness and local readiness without invoking providers", async () => {
    const calls: string[] = [];
    const search = service({ async search(input) { calls.push(input.artist); return response; } });
    const readyApp = app({ service: search });

    const health = await request(readyApp, "/healthz");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ status: "ok" });
    expect(health.headers.get("cache-control")).toBe("no-store");
    expect(health.headers.get("x-content-type-options")).toBe("nosniff");
    expect(calls).toEqual([]);

    const ready = await request(readyApp, "/readyz");
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toEqual({ status: "ok" });

    const unavailable = await request(app({ ready: () => false }), "/readyz");
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual({ status: "unavailable" });
  });

  it("returns the same generic unauthorized response and never invokes service after failed auth", async () => {
    let calls = 0;
    const guarded = app({ service: service({ async search() { calls += 1; return response; } }) });
    const rawBody = Buffer.from(JSON.stringify(command));
    const failures = [
      {},
      { ...signedHeaders("/v1/search", rawBody), "x-apollo-internal-signature": "v1=" + "0".repeat(64) },
      { ...signedHeaders("/v1/search", rawBody), "x-apollo-internal-timestamp": "not-a-time" },
    ];

    for (const headers of failures) {
      const result = await request(guarded, "/v1/search", {
        method: "POST",
        headers,
        body: rawBody,
      });
      expect(result.status).toBe(401);
      await expect(result.json()).resolves.toEqual({ error: "unauthorized" });
    }
    expect(calls).toBe(0);
  });

  it("authenticates both command bodies before returning unavailable readiness", async () => {
    let searchCalls = 0;
    let suggestionCalls = 0;
    const unavailableService = service({
        async search() {
          searchCalls += 1;
          return response;
        },
        async suggestions(input) {
          suggestionCalls += 1;
          return { schemaVersion: 1, requestId: input.requestId, suggestions: [] };
        },
    });
    const searchBody = Buffer.from(JSON.stringify(command));
    const suggestionsBody = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      requestId,
      query: "Artist",
      limit: 1,
    }));

    for (const [path, body] of [
      ["/v1/search", searchBody],
      ["/v1/suggestions", suggestionsBody],
    ] as const) {
      const unavailable = app({ ready: () => false, service: unavailableService });
      const unsigned = await request(unavailable, path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(unsigned.status).toBe(401);
      await expect(unsigned.json()).resolves.toEqual({ error: "unauthorized" });

      const signed = await request(unavailable, path, {
        method: "POST",
        headers: signedHeaders(path, body),
        body,
      });
      expect(signed.status).toBe(503);
      await expect(signed.json()).resolves.toEqual({ error: "search_unavailable" });
    }
    expect(searchCalls).toBe(0);
    expect(suggestionCalls).toBe(0);
  });

  it("fails closed with the generic unauthorized response when authentication throws", async () => {
    const rawBody = Buffer.from(JSON.stringify(command));
    const throwingAuthApp = createTfSearchApp({
      service: service(),
      auth: {
        authenticate() {
          throw new Error("unexpected verifier failure");
        },
      },
      ready: () => true,
    });
    const result = await request(throwingAuthApp, "/v1/search", {
      method: "POST",
      headers: signedHeaders("/v1/search", rawBody),
      body: rawBody,
    });

    expect(result.status).toBe(401);
    await expect(result.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("authenticates the exact body before strict command validation", async () => {
    const rawBody = Buffer.from(JSON.stringify(command));
    const result = await request(app(), "/v1/search", {
      method: "POST",
      headers: signedHeaders("/v1/search", rawBody),
      body: rawBody,
    });

    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toEqual(response);

    const invalidBody = Buffer.from('{"schemaVersion":1}', "utf8");
    const invalid = await request(app(), "/v1/search", {
      method: "POST",
      headers: signedHeaders("/v1/search", invalidBody),
      body: invalidBody,
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({ error: "invalid_request" });
  });

  it("rejects non-identity encodings, non-JSON bodies, and oversized bodies before service invocation", async () => {
    let calls = 0;
    const guarded = app({ service: service({ async search() { calls += 1; return response; } }) });
    const rawBody = Buffer.from(JSON.stringify(command));
    const gzip = await request(guarded, "/v1/search", {
      method: "POST",
      headers: { ...signedHeaders("/v1/search", rawBody), "content-encoding": "gzip" },
      body: rawBody,
    });
    expect(gzip.status).toBe(401);

    const text = await request(guarded, "/v1/search", {
      method: "POST",
      headers: { ...signedHeaders("/v1/search", rawBody), "content-type": "text/plain" },
      body: rawBody,
    });
    expect(text.status).toBe(401);

    const oversized = Buffer.alloc(16 * 1024 + 1, 0x20);
    const tooLarge = await request(guarded, "/v1/search", {
      method: "POST",
      headers: signedHeaders("/v1/search", oversized),
      body: oversized,
    });
    expect(tooLarge.status).toBe(413);
    await expect(tooLarge.json()).resolves.toEqual({ error: "invalid_request" });
    expect(calls).toBe(0);
  });

  it("maps service failures to a generic unavailable response", async () => {
    const rawBody = Buffer.from(JSON.stringify(command));
    const result = await request(
      app({ service: service({ async search() { throw new Error("raw provider error"); } }) }),
      "/v1/search",
      { method: "POST", headers: signedHeaders("/v1/search", rawBody), body: rawBody },
    );
    expect(result.status).toBe(503);
    await expect(result.json()).resolves.toEqual({ error: "search_unavailable" });
  });

  it("serves a strictly validated signed suggestions command", async () => {
    const suggestionCommand: TfSearchSuggestionsCommand = {
      schemaVersion: 1,
      requestId,
      query: "Artist",
      limit: 1,
    };
    const rawBody = Buffer.from(JSON.stringify(suggestionCommand));
    const result = await request(app(), "/v1/suggestions", {
      method: "POST",
      headers: signedHeaders("/v1/suggestions", rawBody),
      body: rawBody,
    });

    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toEqual({
      schemaVersion: 1,
      requestId,
      suggestions: [],
    });
  });

  it("serves a strictly validated signed artist-only discovery command", async () => {
    const discoverArtist = vi.fn().mockResolvedValue(discoveryResponse);
    const rawBody = Buffer.from(JSON.stringify(discoveryCommand));
    const result = await request(
      app({ service: service({ discoverArtist }) }),
      "/v1/artist-discovery",
      {
        method: "POST",
        headers: signedHeaders("/v1/artist-discovery", rawBody),
        body: rawBody,
      },
    );

    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toEqual(discoveryResponse);
    expect(discoverArtist).toHaveBeenCalledWith(discoveryCommand);
  });

  it("uses strict case-sensitive paths for signed endpoints", async () => {
    const rawBody = Buffer.from(JSON.stringify(command));
    const result = await request(app(), "/v1/search/", {
      method: "POST",
      headers: signedHeaders("/v1/search", rawBody),
      body: rawBody,
    });
    expect(result.status).toBe(404);
  });
});
