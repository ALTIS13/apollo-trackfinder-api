import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import type { Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";

import {
  createTfDownloadFileSignature,
  type DownloadFileCommand,
  type DownloadJobData,
  type DownloadJobResult,
} from "@workspace/tf-download-contract";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createTfDownloadWorkerApp,
  type DownloadFileJob,
  type DownloadFileStorage,
} from "./app.js";
import { HmacFileRequestAuthenticator } from "./internal-auth.js";
import { DownloadStorage } from "./storage.js";

const SECRET = Buffer.from("s".repeat(32), "utf8");
const ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_ACCOUNT_ID = "20000000-0000-4000-8000-000000000002";
const JOB_ID = "30000000-0000-4000-8000-000000000003";
const REQUEST_ID = "40000000-0000-4000-8000-000000000004";
const NOW_MS = Date.parse("2026-07-26T12:00:00.000Z");
const COMPLETED_AT = "2026-07-26T11:59:00.000Z";
const servers: Server[] = [];
const roots: string[] = [];

const jobData: DownloadJobData = {
  schemaVersion: 1,
  accountId: ACCOUNT_ID,
  trackId: "yt_track",
  artist: "Artist",
  title: "Title",
  quality: "192",
  sourceUrl: "https://www.youtube.com/watch?v=owned",
  createdAt: "2026-07-26T11:58:00.000Z",
};

const jobResult: DownloadJobResult = {
  schemaVersion: 1,
  storageKey: `${JOB_ID}.mp3`,
  fileSize: 5,
  mimeType: "audio/mpeg",
  filename: "Artist - Title.mp3",
  completedAt: COMPLETED_AT,
};

const command: DownloadFileCommand = {
  schemaVersion: 1,
  requestId: REQUEST_ID,
  accountId: ACCOUNT_ID,
  jobId: JOB_ID,
};

function completedJob(
  overrides: Partial<DownloadFileJob> = {},
): DownloadFileJob {
  return {
    id: JOB_ID,
    data: jobData,
    returnvalue: jobResult,
    getState: vi.fn().mockResolvedValue("completed"),
    ...overrides,
  };
}

function memoryStorage(
  bytes = Buffer.from("audio", "utf8"),
): DownloadFileStorage & { readonly close: ReturnType<typeof vi.fn> } {
  const close = vi.fn().mockResolvedValue(undefined);
  return {
    close,
    openOwnedFile: vi.fn().mockResolvedValue({
      createReadStream: ({ start, end }: { start: number; end: number }) =>
        Readable.from(bytes.subarray(start, end + 1)),
      close,
    }),
  };
}

async function startApp(options: {
  readonly job?: DownloadFileJob | undefined;
  readonly storage?: DownloadFileStorage;
  readonly auth?: HmacFileRequestAuthenticator;
  readonly ready?: () => boolean | Promise<boolean>;
} = {}): Promise<{
  readonly baseUrl: string;
  readonly auth: HmacFileRequestAuthenticator;
  readonly getJob: ReturnType<typeof vi.fn>;
  readonly storage: DownloadFileStorage;
}> {
  const auth =
    options.auth ??
    new HmacFileRequestAuthenticator({
      secret: SECRET,
      now: () => NOW_MS,
      monotonicNow: () => 5_000,
    });
  const getJob = vi.fn().mockResolvedValue(options.job);
  const storage = options.storage ?? memoryStorage();
  const handler = createTfDownloadWorkerApp({
    auth,
    jobs: { getJob },
    storage,
    ready: options.ready ?? (() => true),
  });
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    auth,
    getJob,
    storage,
  };
}

function signedHeaders(
  rawBody: Buffer,
  nonce = "0".repeat(64),
): Record<string, string> {
  const timestamp = String(Math.floor(NOW_MS / 1_000));
  return {
    "content-type": "application/json",
    "x-apollo-internal-timestamp": timestamp,
    "x-apollo-internal-nonce": nonce,
    "x-apollo-internal-signature": createTfDownloadFileSignature({
      method: "POST",
      path: "/v1/files",
      timestamp,
      nonce,
      rawBody,
      secret: SECRET,
    }),
  };
}

async function postRaw(
  baseUrl: string,
  rawBody: Buffer,
  options: {
    readonly nonce?: string;
    readonly headers?: Record<string, string>;
    readonly signal?: AbortSignal;
  } = {},
): Promise<Response> {
  return fetch(`${baseUrl}/v1/files`, {
    method: "POST",
    headers: options.headers ?? signedHeaders(rawBody, options.nonce),
    body: rawBody,
    signal: options.signal,
  });
}

async function postCommand(
  baseUrl: string,
  candidate: unknown = command,
  nonce?: string,
): Promise<Response> {
  const rawBody = Buffer.from(JSON.stringify(candidate), "utf8");
  return postRaw(baseUrl, rawBody, { nonce });
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "tf-download-app-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("TF download worker health boundary", () => {
  it("serves exact health and dependency-injected readiness without configuration", async () => {
    const healthy = await startApp();
    const unavailable = await startApp({ ready: () => false });

    const health = await fetch(`${healthy.baseUrl}/healthz`);
    const ready = await fetch(`${healthy.baseUrl}/readyz`);
    const notReady = await fetch(`${unavailable.baseUrl}/readyz`);
    const alternate = await fetch(`${healthy.baseUrl}/healthz?details=1`);

    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ status: "ok" });
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toEqual({ status: "ok" });
    expect(notReady.status).toBe(503);
    await expect(notReady.json()).resolves.toEqual({
      status: "unavailable",
    });
    expect(alternate.status).toBe(404);
  });
});

describe("TF download worker file app", () => {
  it("authenticates exact raw bytes before parsing or claiming a command", async () => {
    const running = await startApp();
    const claim = vi.spyOn(running.auth, "claim");
    const malformed = Buffer.from("{", "utf8");

    const invalid = await postRaw(running.baseUrl, malformed, {
      headers: {
        ...signedHeaders(malformed),
        "x-apollo-internal-signature": "f".repeat(64),
      },
    });
    expect(invalid.status).toBe(401);
    await expect(invalid.json()).resolves.toEqual({ error: "unauthorized" });
    expect(claim).not.toHaveBeenCalled();
    expect(running.getJob).not.toHaveBeenCalled();

    const validSignature = await postRaw(running.baseUrl, malformed, {
      nonce: "1".repeat(64),
    });
    expect(validSignature.status).toBe(400);
    await expect(validSignature.json()).resolves.toEqual({
      error: "invalid_request",
    });
    expect(claim).not.toHaveBeenCalled();
    expect(running.getJob).not.toHaveBeenCalled();
  });

  it("rejects extra command fields only after valid authentication", async () => {
    const running = await startApp();
    const response = await postCommand(running.baseUrl, {
      ...command,
      internalPath: "C:\\private\\audio.mp3",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_request",
    });
    expect(running.getJob).not.toHaveBeenCalled();
  });

  it("rejects an oversized header block before command dispatch", async () => {
    const running = await startApp();
    const rawBody = Buffer.from(JSON.stringify(command), "utf8");

    const response = await postRaw(running.baseUrl, rawBody, {
      headers: {
        ...signedHeaders(rawBody),
        "x-padding": "x".repeat(9_000),
      },
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "unauthorized",
    });
    expect(running.getJob).not.toHaveBeenCalled();
  });

  it("maps replay to 401 and replay capacity to a sanitized 503", async () => {
    const auth = new HmacFileRequestAuthenticator({
      secret: SECRET,
      now: () => NOW_MS,
      monotonicNow: () => 5_000,
      maxNoncesPerAccount: 1,
    });
    const running = await startApp({ auth });

    const first = await postCommand(running.baseUrl, command, "1".repeat(64));
    const replay = await postCommand(running.baseUrl, command, "1".repeat(64));
    const capacity = await postCommand(
      running.baseUrl,
      command,
      "2".repeat(64),
    );

    expect(first.status).toBe(404);
    expect(replay.status).toBe(401);
    await expect(replay.json()).resolves.toEqual({ error: "unauthorized" });
    expect(capacity.status).toBe(503);
    await expect(capacity.json()).resolves.toEqual({
      error: "worker_unavailable",
    });
  });

  it.each([
    ["unknown job", undefined],
    [
      "foreign owner",
      completedJob({ data: { ...jobData, accountId: OTHER_ACCOUNT_ID } }),
    ],
    [
      "invalid job data",
      completedJob({ data: { ...jobData, sourceUrl: "http://private.test" } }),
    ],
    [
      "invalid result metadata",
      completedJob({ returnvalue: { ...jobResult, fileSize: 0 } }),
    ],
  ])("returns the same 404 for %s", async (_label, job) => {
    const running = await startApp({ job: job as DownloadFileJob | undefined });
    const response = await postCommand(running.baseUrl);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "file_not_found",
    });
    expect(JSON.stringify(await response.headers)).not.toContain(ACCOUNT_ID);
  });

  it("rejects a lookup result whose job identity does not match the command", async () => {
    const running = await startApp({
      job: completedJob({
        id: "50000000-0000-4000-8000-000000000005",
      }),
    });

    const response = await postCommand(running.baseUrl);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "file_not_found",
    });
    expect(running.storage.openOwnedFile).not.toHaveBeenCalled();
  });

  it("rejects result metadata that points at another job's storage key", async () => {
    const storage = memoryStorage();
    const running = await startApp({
      job: completedJob({
        returnvalue: {
          ...jobResult,
          storageKey: "50000000-0000-4000-8000-000000000005.mp3",
        },
      }),
      storage,
    });

    const response = await postCommand(running.baseUrl);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "file_not_found",
    });
    expect(storage.openOwnedFile).not.toHaveBeenCalled();
  });

  it.each(["waiting", "active"])(
    "returns 409 while a strict owned job is %s",
    async (state) => {
      const running = await startApp({
        job: completedJob({
          getState: vi.fn().mockResolvedValue(state),
          returnvalue: undefined,
        }),
      });

      const response = await postCommand(running.baseUrl);

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: "file_not_ready",
      });
    },
  );

  it("streams an exact completed owner without buffering or leaking internal headers", async () => {
    const storage = memoryStorage();
    const running = await startApp({ job: completedJob(), storage });

    const response = await postCommand(running.baseUrl);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(response.headers.get("content-length")).toBe("5");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-range")).toBeNull();
    expect(response.headers.get("content-disposition")).toBe(
      "attachment; filename=\"Artist - Title.mp3\"; filename*=UTF-8''Artist%20-%20Title.mp3",
    );
    await expect(response.text()).resolves.toBe("audio");
    expect(storage.close).toHaveBeenCalledTimes(1);

    const serializedHeaders = JSON.stringify(
      Object.fromEntries(response.headers),
    );
    for (const forbidden of [
      ACCOUNT_ID,
      jobData.sourceUrl,
      "C:\\",
      "/tmp/",
      "x-apollo-internal",
    ]) {
      expect(serializedHeaders).not.toContain(forbidden);
    }
  });

  it("emits an ASCII fallback and RFC 5987 UTF-8 filename", async () => {
    const running = await startApp({
      job: completedJob({
        returnvalue: {
          ...jobResult,
          filename: "Artist - Rock'n \u0422\u0440\u0435\u043a.mp3",
        },
      }),
    });

    const response = await postCommand(running.baseUrl);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      "attachment; filename=\"Artist - Rock_n ____.mp3\"; filename*=UTF-8''Artist%20-%20Rock%27n%20%D0%A2%D1%80%D0%B5%D0%BA.mp3",
    );
    await response.body?.cancel();
  });

  it("streams one bounded inclusive range and rejects invalid or multiple ranges", async () => {
    const running = await startApp({ job: completedJob() });
    const partial = await postCommand(
      running.baseUrl,
      { ...command, range: { start: 1, end: 3 } },
      "1".repeat(64),
    );

    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-length")).toBe("3");
    expect(partial.headers.get("content-range")).toBe("bytes 1-3/5");
    await expect(partial.text()).resolves.toBe("udi");

    for (const [index, range] of [
      { start: 5 },
      { start: 4, end: 5 },
      { start: 3, end: 2 },
      [
        { start: 0, end: 1 },
        { start: 3, end: 4 },
      ],
    ].entries()) {
      const response = await postCommand(
        running.baseUrl,
        { ...command, range },
        nonceForTest(index + 10),
      );
      expect(response.status).toBe(416);
      await expect(response.json()).resolves.toEqual({
        error: "range_not_satisfiable",
      });
    }
  });

  it("returns 206 for an explicit open-ended range covering the full file", async () => {
    const running = await startApp({ job: completedJob() });

    const response = await postCommand(running.baseUrl, {
      ...command,
      range: { start: 0 },
    });

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 0-4/5");
    await expect(response.text()).resolves.toBe("audio");
  });

  it("maps missing, expired, mismatched, symlink, and non-regular storage to one 404", async () => {
    const storage = {
      openOwnedFile: vi
        .fn()
        .mockRejectedValueOnce(new Error("missing C:\\private\\file"))
        .mockRejectedValueOnce(new Error("expired"))
        .mockRejectedValueOnce(new Error("size mismatch"))
        .mockRejectedValueOnce(new Error("symlink"))
        .mockRejectedValueOnce(new Error("directory")),
    };
    const running = await startApp({ job: completedJob(), storage });

    for (let index = 0; index < 5; index += 1) {
      const response = await postCommand(
        running.baseUrl,
        command,
        nonceForTest(index + 20),
      );
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        error: "file_not_found",
      });
    }
  });

  it("closes the owned stream when the browser disconnects", async () => {
    const stream = new PassThrough();
    const close = vi.fn(async () => {
      stream.destroy();
    });
    const storage: DownloadFileStorage = {
      openOwnedFile: vi.fn().mockResolvedValue({
        createReadStream: () => stream,
        close,
      }),
    };
    const running = await startApp({ job: completedJob(), storage });
    const controller = new AbortController();
    const responsePromise = postRaw(
      running.baseUrl,
      Buffer.from(JSON.stringify(command), "utf8"),
      { signal: controller.signal },
    );
    setTimeout(() => stream.write("a"), 0);
    const response = await responsePromise;
    const reader = response.body!.getReader();
    await reader.read();

    controller.abort();
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });
});

describe("DownloadStorage owned read handle", () => {
  it("opens and streams the exact committed regular file from one owned handle", async () => {
    const root = await createRoot();
    const storage = await DownloadStorage.create({
      root,
      now: () => NOW_MS,
    });
    const output = await storage.begin(JOB_ID, "mp3");
    expect(await output.write(Buffer.from("audio"))).toBe(true);
    const result = await output.commit({
      filename: jobResult.filename,
      mimeType: jobResult.mimeType,
      completedAt: COMPLETED_AT,
    });
    output.finalize();

    const owned = await storage.openOwnedFile(result);
    const chunks: Buffer[] = [];
    for await (const chunk of owned.createReadStream({ start: 1, end: 3 })) {
      chunks.push(Buffer.from(chunk));
    }
    await owned.close();

    expect(Buffer.concat(chunks).toString("utf8")).toBe("udi");
  });

  it.each(["missing", "mismatch", "symlink", "non-regular"] as const)(
    "rejects a %s result without returning a path-backed stream",
    async (kind) => {
      const root = await createRoot();
      const outside = await createRoot();
      const storage = await DownloadStorage.create({
        root,
        now: () => NOW_MS,
      });
      const target = path.join(root, jobResult.storageKey);
      if (kind === "mismatch") {
        await writeFile(target, "wrong-size");
      } else if (kind === "symlink") {
        await mkdir(path.join(outside, "owned"));
        await symlink(
          path.join(outside, "owned"),
          target,
          process.platform === "win32" ? "junction" : "dir",
        );
      } else if (kind === "non-regular") {
        await mkdir(target);
      }

      await expect(storage.openOwnedFile(jobResult)).rejects.toThrow(
        "storage_unavailable",
      );
    },
  );

  it("rejects expired metadata before exposing a file handle", async () => {
    const root = await createRoot();
    const storage = await DownloadStorage.create({
      root,
      ttlMs: 1_000,
      now: () => NOW_MS,
    });
    await writeFile(path.join(root, jobResult.storageKey), "audio");

    await expect(storage.openOwnedFile(jobResult)).rejects.toThrow(
      "storage_unavailable",
    );
  });
});

function nonceForTest(index: number): string {
  return index.toString(16).padStart(64, "0");
}
