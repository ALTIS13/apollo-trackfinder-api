import {
  createTfDownloadFileSignature,
  DOWNLOAD_MAX_FILE_BYTES,
} from "@workspace/tf-download-contract";
import { describe, expect, it, vi } from "vitest";

import {
  HttpTfDownloadWorkerClient,
  TfDownloadWorkerError,
  parseTfDownloadWorkerClientConfig,
} from "./tf-download-worker-client.js";

const SECRET = "s".repeat(32);
const REQUEST_ID = "10000000-0000-4000-8000-000000000001";
const ACCOUNT_ID = "20000000-0000-4000-8000-000000000002";
const JOB_ID = "30000000-0000-4000-8000-000000000003";
const NONCE = "a".repeat(64);
const NOW_MS = 1_753_337_100_000;

function validResponse(
  body: ConstructorParameters<typeof Response>[0] = "audio",
  overrides: {
    readonly status?: number;
    readonly headers?: Record<string, string>;
  } = {},
): Response {
  return new Response(body, {
    status: overrides.status ?? 200,
    headers: {
      "content-type": "audio/mpeg",
      "content-length": "5",
      "content-disposition":
        "attachment; filename=\"Artist - Title.mp3\"; filename*=UTF-8''Artist%20-%20Title.mp3",
      "accept-ranges": "bytes",
      "cache-control": "private, no-store",
      ...overrides.headers,
    },
  });
}

function client(
  fetchImplementation: typeof fetch,
  overrides: Partial<
    ConstructorParameters<typeof HttpTfDownloadWorkerClient>[0]
  > = {},
): HttpTfDownloadWorkerClient {
  return new HttpTfDownloadWorkerClient(
    {
      origin: "https://downloads.apollot.ru",
      internalAuthSecret: SECRET,
      headersTimeoutMs: 250,
      ...overrides,
    },
    {
      fetch: fetchImplementation,
      now: () => NOW_MS,
      randomUuid: () => REQUEST_ID,
      randomNonce: () => NONCE,
    },
  );
}

function openInput(overrides: {
  readonly range?: { readonly start: number; readonly end?: number };
  readonly signal?: AbortSignal;
} = {}) {
  return {
    accountId: ACCOUNT_ID,
    jobId: JOB_ID,
    signal: overrides.signal ?? new AbortController().signal,
    ...(overrides.range === undefined ? {} : { range: overrides.range }),
  };
}

describe("parseTfDownloadWorkerClientConfig", () => {
  it("loads a strict file-backed secret and exact HTTPS origin", async () => {
    const readSecret = vi.fn().mockResolvedValue(` ${SECRET}\n`);

    await expect(
      parseTfDownloadWorkerClientConfig(
        {
          TF_DOWNLOAD_WORKER_ORIGIN: "https://downloads.apollot.ru",
          TF_DOWNLOAD_WORKER_INTERNAL_AUTH_SECRET_FILE:
            "/run/secrets/tf-download-worker",
        },
        readSecret,
      ),
    ).resolves.toEqual({
      origin: "https://downloads.apollot.ru",
      internalAuthSecret: SECRET,
      headersTimeoutMs: 10_000,
    });
    expect(readSecret).toHaveBeenCalledWith(
      "/run/secrets/tf-download-worker",
    );
  });

  it("allows exact local or container HTTP only with the explicit flag", async () => {
    const readSecret = vi.fn().mockResolvedValue(SECRET);
    for (const origin of [
      "http://tf-download-worker:8080",
      "http://127.0.0.1:8080",
      "http://localhost:8080",
    ]) {
      await expect(
        parseTfDownloadWorkerClientConfig(
          {
            TF_DOWNLOAD_WORKER_ORIGIN: origin,
            TF_DOWNLOAD_WORKER_ALLOW_INSECURE_HTTP: "true",
            TF_DOWNLOAD_WORKER_INTERNAL_AUTH_SECRET_FILE: "/run/secrets/file",
          },
          readSecret,
        ),
      ).resolves.toMatchObject({ origin });
    }

    for (const origin of [
      "http://tf-download-worker:8080",
      "http://public.example:8080",
      " https://downloads.apollot.ru",
      "https://downloads.apollot.ru/",
      "https://user:pass@downloads.apollot.ru",
      "https://downloads.apollot.ru/path",
      "https://downloads.apollot.ru?query=1",
    ]) {
      await expect(
        parseTfDownloadWorkerClientConfig(
          {
            TF_DOWNLOAD_WORKER_ORIGIN: origin,
            TF_DOWNLOAD_WORKER_INTERNAL_AUTH_SECRET_FILE: "/run/secrets/file",
          },
          readSecret,
        ),
      ).rejects.toThrow("invalid runtime configuration");
    }

    await expect(
      parseTfDownloadWorkerClientConfig(
        {
          TF_DOWNLOAD_WORKER_ORIGIN: "https://downloads.apollot.ru",
          TF_DOWNLOAD_WORKER_ALLOW_INSECURE_HTTP: "yes",
          TF_DOWNLOAD_WORKER_INTERNAL_AUTH_SECRET_FILE: "/run/secrets/file",
        },
        readSecret,
      ),
    ).rejects.toThrow("invalid runtime configuration");
  });

  it("rejects inline, missing, unreadable, and weak secrets", async () => {
    const base = {
      TF_DOWNLOAD_WORKER_ORIGIN: "https://downloads.apollot.ru",
      TF_DOWNLOAD_WORKER_INTERNAL_AUTH_SECRET: SECRET,
    };
    await expect(
      parseTfDownloadWorkerClientConfig(base, vi.fn()),
    ).rejects.toThrow("invalid runtime configuration");
    await expect(
      parseTfDownloadWorkerClientConfig(
        {
          ...base,
          TF_DOWNLOAD_WORKER_INTERNAL_AUTH_SECRET_FILE: "/run/secrets/file",
        },
        vi.fn().mockRejectedValue(new Error("private path")),
      ),
    ).rejects.toThrow("invalid runtime configuration");
    await expect(
      parseTfDownloadWorkerClientConfig(
        {
          ...base,
          TF_DOWNLOAD_WORKER_INTERNAL_AUTH_SECRET_FILE: "/run/secrets/file",
        },
        vi.fn().mockResolvedValue("x".repeat(31)),
      ),
    ).rejects.toThrow("invalid runtime configuration");
  });

  it.each(["", SECRET])(
    "rejects any inline secret presence when a valid file secret is configured",
    async (inlineSecret) => {
      const readSecret = vi.fn().mockResolvedValue(SECRET);

      await expect(
        parseTfDownloadWorkerClientConfig(
          {
            TF_DOWNLOAD_WORKER_ORIGIN: "https://downloads.apollot.ru",
            TF_DOWNLOAD_WORKER_INTERNAL_AUTH_SECRET: inlineSecret,
            TF_DOWNLOAD_WORKER_INTERNAL_AUTH_SECRET_FILE:
              "/run/secrets/tf-download-worker",
          },
          readSecret,
        ),
      ).rejects.toThrow("invalid runtime configuration");
      expect(readSecret).not.toHaveBeenCalled();
    },
  );
});

describe("HttpTfDownloadWorkerClient", () => {
  it("serializes and signs the exact fixed-path command without ambient credentials", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      validResponse("udi", {
        status: 206,
        headers: {
          "content-length": "3",
          "content-range": "bytes 1-3/5",
        },
      }),
    );
    const gateway = client(fetchImplementation);

    const result = await gateway.openFile(
      openInput({ range: { start: 1, end: 3 } }),
    );

    expect(result).toMatchObject({
      status: 206,
      contentLength: 3,
      contentType: "audio/mpeg",
      contentDisposition:
        "attachment; filename=\"Artist - Title.mp3\"; filename*=UTF-8''Artist%20-%20Title.mp3",
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImplementation.mock.calls[0]!;
    expect(String(url)).toBe("https://downloads.apollot.ru/v1/files");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "manual",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    const rawBody = Buffer.from(String(init?.body), "utf8");
    expect(rawBody.toString("utf8")).toBe(
      `{"schemaVersion":1,"requestId":"${REQUEST_ID}","accountId":"${ACCOUNT_ID}","jobId":"${JOB_ID}","range":{"start":1,"end":3}}`,
    );
    const headers = new Headers(init?.headers);
    expect([...headers.keys()].sort()).toEqual([
      "content-type",
      "x-apollo-internal-nonce",
      "x-apollo-internal-signature",
      "x-apollo-internal-timestamp",
    ]);
    expect(headers.get("x-apollo-internal-timestamp")).toBe(
      String(Math.floor(NOW_MS / 1_000)),
    );
    expect(headers.get("x-apollo-internal-nonce")).toBe(NONCE);
    expect(headers.get("x-apollo-internal-signature")).toBe(
      createTfDownloadFileSignature({
        method: "POST",
        path: "/v1/files",
        timestamp: String(Math.floor(NOW_MS / 1_000)),
        nonce: NONCE,
        rawBody,
        secret: SECRET,
      }),
    );
    const serialized = JSON.stringify({
      url: String(url),
      headers: Object.fromEntries(headers),
    }).toLowerCase();
    for (const forbidden of [
      "cookie",
      "authorization",
      "session",
      "sourceurl",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("returns the downstream web stream without reading or buffering it", async () => {
    let pullCount = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        controller.enqueue(Buffer.from("audio"));
        controller.close();
      },
    });
    const gateway = client(
      vi.fn<typeof fetch>(async () => validResponse(body)),
    );

    const result = await gateway.openFile(openInput());
    expect(result.body).toBeInstanceOf(ReadableStream);
    expect(pullCount).toBeLessThanOrEqual(1);
    await expect(new Response(result.body).text()).resolves.toBe("audio");
  });

  it("propagates browser abort after response headers are accepted", async () => {
    const browser = new AbortController();
    let internalSignal: AbortSignal | undefined;
    const gateway = client(
      vi.fn<typeof fetch>(async (_input, init) => {
        internalSignal = init?.signal ?? undefined;
        return validResponse(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(Buffer.from("a"));
            },
          }),
        );
      }),
    );
    const result = await gateway.openFile(
      openInput({ signal: browser.signal }),
    );

    browser.abort();

    expect(internalSignal?.aborted).toBe(true);
    await result.body.cancel();
  });

  it("aborts the upstream response when streaming fails", async () => {
    let internalSignal: AbortSignal | undefined;
    const gateway = client(
      vi.fn<typeof fetch>(async (_input, init) => {
        internalSignal = init?.signal ?? undefined;
        return validResponse(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new Error("private upstream failure"));
            },
          }),
        );
      }),
    );

    const result = await gateway.openFile(openInput());
    await expect(result.body.getReader().read()).rejects.toMatchObject({
      status: 503,
      code: "worker_unavailable",
    });
    expect(internalSignal?.aborted).toBe(true);
  });

  it("bounds only the wait for response headers and aborts a stalled fetch", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const gateway = client(fetchImplementation, { headersTimeoutMs: 10 });

    await expect(gateway.openFile(openInput())).rejects.toMatchObject({
      status: 503,
      code: "worker_unavailable",
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it.each([
    [404, 404, "file_not_found"],
    [409, 409, "file_not_ready"],
    [416, 416, "range_not_satisfiable"],
    [503, 503, "worker_unavailable"],
  ] as const)(
    "preserves intended worker status %s as a sanitized typed error",
    async (workerStatus, publicStatus, code) => {
      const gateway = client(
        vi.fn<typeof fetch>(async () =>
          new Response("private downstream error", {
            status: workerStatus,
          }),
        ),
      );

      const error = await gateway
        .openFile(openInput())
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(TfDownloadWorkerError);
      expect(error).toMatchObject({ status: publicStatus, code });
      expect(String(error)).not.toContain("private downstream error");
    },
  );

  it.each([
    ["redirect", validResponse("", { status: 302 })],
    ["unauthorized", validResponse("", { status: 401 })],
    ["server error", validResponse("", { status: 500 })],
    [
      "missing length",
      new Response("audio", {
        status: 200,
        headers: {
          "content-type": "audio/mpeg",
          "content-disposition":
            "attachment; filename=\"file.mp3\"; filename*=UTF-8''file.mp3",
          "accept-ranges": "bytes",
          "cache-control": "private, no-store",
        },
      }),
    ],
    [
      "invalid MIME",
      validResponse("audio", {
        headers: { "content-type": "application/octet-stream" },
      }),
    ],
    [
      "oversized length",
      validResponse("audio", {
        headers: {
          "content-length": String(DOWNLOAD_MAX_FILE_BYTES + 1),
        },
      }),
    ],
    [
      "invalid disposition",
      validResponse("audio", {
        headers: { "content-disposition": "inline" },
      }),
    ],
    [
      "unexpected content range",
      validResponse("audio", {
        headers: { "content-range": "bytes 0-4/5" },
      }),
    ],
    [
      "missing partial range",
      validResponse("udi", {
        status: 206,
        headers: { "content-length": "3" },
      }),
    ],
    [
      "inconsistent partial range",
      validResponse("udi", {
        status: 206,
        headers: {
          "content-length": "3",
          "content-range": "bytes 1-4/5",
        },
      }),
    ],
  ])("rejects %s response metadata before exposing the body", async (
    _label,
    response,
  ) => {
    const gateway = client(vi.fn<typeof fetch>(async () => response));

    await expect(gateway.openFile(openInput())).rejects.toMatchObject({
      status: 503,
      code: "worker_unavailable",
    });
  });

  it("accepts and validates a strict 206 response for the forwarded range", async () => {
    const gateway = client(
      vi.fn<typeof fetch>(async () =>
        validResponse("udi", {
          status: 206,
          headers: {
            "content-length": "3",
            "content-range": "bytes 1-3/5",
          },
        }),
      ),
    );

    await expect(
      gateway.openFile(openInput({ range: { start: 1, end: 3 } })),
    ).resolves.toMatchObject({
      status: 206,
      contentLength: 3,
      contentRange: "bytes 1-3/5",
    });
  });

  it("requires an open-ended range response to reach the declared total", async () => {
    const gateway = client(
      vi.fn<typeof fetch>(async () =>
        validResponse("udi", {
          status: 206,
          headers: {
            "content-length": "3",
            "content-range": "bytes 1-3/5",
          },
        }),
      ),
    );

    await expect(
      gateway.openFile(openInput({ range: { start: 1 } })),
    ).rejects.toMatchObject({
      status: 503,
      code: "worker_unavailable",
    });
  });

  it("accepts the worker's maximum bounded UTF-8 disposition", async () => {
    const filename = "\u044f".repeat(255);
    const disposition =
      `attachment; filename="${"_".repeat(255)}"; ` +
      `filename*=UTF-8''${encodeURIComponent(filename)}`;
    const gateway = client(
      vi.fn<typeof fetch>(async () =>
        validResponse("audio", {
          headers: { "content-disposition": disposition },
        }),
      ),
    );

    await expect(gateway.openFile(openInput())).resolves.toMatchObject({
      contentDisposition: disposition,
    });
  });
});
