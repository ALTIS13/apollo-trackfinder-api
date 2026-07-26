import type {
  DownloadJobData,
  DownloadJobResult,
} from "@workspace/tf-download-contract";
import { downloadJobResultSchema } from "@workspace/tf-download-contract";
import type { Job } from "bullmq";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  spawnYtDlpDownload,
  type DownloaderProcess,
  type DownloaderProcessExit,
  type ProcessSpawner,
} from "./downloader";
import type { DownloadLogger } from "./logger";
import {
  createDownloadProcessor,
  DownloadProcessingError,
} from "./processor";
import { DownloadStorage } from "./storage";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SOURCE_URL = "https://www.youtube.com/watch?v=sensitive-source";
const STDERR_SECRET = "provider stderr with a signed token";

const validData: DownloadJobData = {
  schemaVersion: 1,
  accountId: ACCOUNT_ID,
  trackId: "yt_sensitive",
  artist: "Sensitive Artist",
  title: "Sensitive Title",
  quality: "320",
  sourceUrl: SOURCE_URL,
  createdAt: "2026-07-26T00:00:00.000Z",
};

const roots: string[] = [];

async function createStorage(
  options: { maxFileBytes?: number; quotaBytes?: number } = {},
): Promise<{ root: string; storage: DownloadStorage }> {
  const root = await mkdtemp(path.join(tmpdir(), "tf-download-processor-"));
  roots.push(root);
  return {
    root,
    storage: await DownloadStorage.create({ root, ...options }),
  };
}

function createJob(
  data: unknown = validData,
  jobId: string | null = JOB_ID,
): Job<DownloadJobData, DownloadJobResult> & {
  updateProgress: ReturnType<typeof vi.fn>;
} {
  return {
    id: jobId ?? undefined,
    data,
    updateProgress: vi.fn(async () => undefined),
  } as unknown as Job<DownloadJobData, DownloadJobResult> & {
    updateProgress: ReturnType<typeof vi.fn>;
  };
}

function createCancellationStore(
  implementation: () => boolean | Promise<boolean> = () => false,
) {
  const isCanceled = vi.fn(
    async (_jobId: string, _signal: AbortSignal): Promise<boolean> =>
      implementation(),
  );
  return {
    isCanceled,
  };
}

function createLogger() {
  const info = vi.fn(
    (_event: Parameters<DownloadLogger["info"]>[0]) => undefined,
  );
  const warn = vi.fn(
    (_event: Parameters<DownloadLogger["warn"]>[0]) => undefined,
  );
  const error = vi.fn(
    (_event: Parameters<DownloadLogger["error"]>[0]) => undefined,
  );
  return {
    info,
    warn,
    error,
  };
}

interface FakeProcess extends DownloaderProcess {
  readonly kills: NodeJS.Signals[];
}

function createFakeProcess(options: {
  stdout?: readonly Uint8Array[];
  stderr?: readonly Uint8Array[];
  exitCode?: number;
  holdOpen?: boolean;
  ignoreTerm?: boolean;
  throwTerm?: boolean;
} = {}): FakeProcess {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kills: NodeJS.Signals[] = [];
  let settled = false;
  let resolveCompletion:
    | ((result: DownloaderProcessExit) => void)
    | undefined;
  const completion = new Promise<DownloaderProcessExit>((resolve) => {
    resolveCompletion = resolve;
  });
  const settle = (result: DownloaderProcessExit): void => {
    if (settled) return;
    settled = true;
    stdout.end();
    stderr.end();
    resolveCompletion?.(result);
  };

  queueMicrotask(() => {
    for (const chunk of options.stdout ?? []) stdout.write(chunk);
    for (const chunk of options.stderr ?? []) stderr.write(chunk);
    if (!options.holdOpen) {
      settle({ code: options.exitCode ?? 0, signal: null });
    }
  });

  return {
    stdout,
    stderr,
    completion,
    kills,
    kill(signal) {
      kills.push(signal);
      if (signal === "SIGTERM" && options.throwTerm) {
        throw new Error("kill_failed");
      }
      if (signal === "SIGTERM" && options.ignoreTerm) return;
      queueMicrotask(() => settle({ code: null, signal }));
    },
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return {
    promise,
    resolve: (value) => resolve?.(value),
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition_not_observed");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("spawnYtDlpDownload", () => {
  it("uses argv without a shell and passes the source URL as one final argument", async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => true);
    const spawn = vi.fn(() => child) as unknown as ProcessSpawner;
    const controller = new AbortController();

    const process = spawnYtDlpDownload(
      {
        executable: "yt-dlp",
        quality: "320",
        sourceUrl: SOURCE_URL,
        signal: controller.signal,
      },
      spawn,
    );
    const [, args, options] = vi.mocked(spawn).mock.calls[0];

    expect(args.filter((argument) => argument === SOURCE_URL)).toHaveLength(1);
    expect(args.at(-1)).toBe(SOURCE_URL);
    expect(args.at(-2)).toBe("--");
    expect(options).toMatchObject({
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      signal: controller.signal,
    });

    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0, null);
    await expect(process.completion).resolves.toEqual({
      code: 0,
      signal: null,
    });
  });

  it("settles once when spawn error is followed by close", async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => true);
    const spawn = vi.fn(() => child) as unknown as ProcessSpawner;
    const failure = new Error("spawn_failed");
    const process = spawnYtDlpDownload(
      {
        executable: "yt-dlp",
        quality: "flac",
        sourceUrl: SOURCE_URL,
        signal: new AbortController().signal,
      },
      spawn,
    );

    child.emit("error", failure);
    child.emit("close", 1, null);

    await expect(process.completion).rejects.toBe(failure);
  });
});

describe("createDownloadProcessor", () => {
  it("rejects a non-strict job before spawning or creating output", async () => {
    const { root, storage } = await createStorage();
    const spawnDownload = vi.fn(() => createFakeProcess());
    const processor = createDownloadProcessor({
      storage,
      cancellationStore: createCancellationStore(),
      spawnDownload,
      logger: createLogger(),
    });
    const job = createJob({ ...validData, unexpected: true });

    await expect(
      processor(job, new AbortController().signal),
    ).rejects.toMatchObject({
      code: "invalid_job",
      retriable: false,
    });
    expect(spawnDownload).not.toHaveBeenCalled();
    expect(job.updateProgress).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it.each([null, "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"])(
    "rejects missing or noncanonical job id %s before storage or spawn",
    async (jobId) => {
      const { root, storage } = await createStorage();
      const begin = vi.spyOn(storage, "begin");
      const spawnDownload = vi.fn(() => createFakeProcess());
      const processor = createDownloadProcessor({
        storage,
        cancellationStore: createCancellationStore(),
        spawnDownload,
        logger: createLogger(),
      });

      await expect(
        processor(
          createJob(validData, jobId),
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({
        code: "invalid_job",
        retriable: false,
      });
      expect(begin).not.toHaveBeenCalled();
      expect(spawnDownload).not.toHaveBeenCalled();
      expect(await readdir(root)).toEqual([]);
    },
  );

  it("uses a bounded constant in logs for an attacker-controlled job id", async () => {
    const { storage } = await createStorage();
    const logger = createLogger();
    const processor = createDownloadProcessor({
      storage,
      cancellationStore: createCancellationStore(),
      spawnDownload: vi.fn(() => createFakeProcess()),
      logger,
    });
    const attackerId = `${ACCOUNT_ID}\r\nraw-log-field`;

    await expect(
      processor(
        createJob(validData, attackerId),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "invalid_job" });

    const calls = JSON.stringify([
      logger.info.mock.calls,
      logger.warn.mock.calls,
      logger.error.mock.calls,
    ]);
    expect(calls).not.toContain(attackerId);
    expect(calls).not.toContain(ACCOUNT_ID);
    expect(calls).toContain('"jobId":"invalid"');
  });

  it("revalidates a disallowed source before child spawn", async () => {
    const { storage } = await createStorage();
    const spawnDownload = vi.fn(() => createFakeProcess());
    const processor = createDownloadProcessor({
      storage,
      cancellationStore: createCancellationStore(),
      spawnDownload,
      logger: createLogger(),
    });
    const job = createJob({
      ...validData,
      sourceUrl: "https://youtube.com.evil.example/watch?v=secret",
    });

    await expect(
      processor(job, new AbortController().signal),
    ).rejects.toMatchObject({
      code: "source_not_allowed",
      retriable: false,
    });
    expect(spawnDownload).not.toHaveBeenCalled();
  });

  it("returns strict metadata and reports 100 only after durable commit", async () => {
    const { root, storage } = await createStorage();
    const commitGate = deferred<void>();
    const spawned = createFakeProcess({
      stdout: [Buffer.from("audio")],
      stderr: [Buffer.from(STDERR_SECRET)],
    });
    const delayedStorage = {
      async begin(jobId: string, extension: "mp3" | "flac") {
        const output = await storage.begin(jobId, extension);
        return {
          write: output.write.bind(output),
          abort: output.abort.bind(output),
          async commit(
            metadata: Parameters<typeof output.commit>[0],
            signal?: AbortSignal,
          ) {
            await commitGate.promise;
            return output.commit(metadata, signal);
          },
        };
      },
    };
    const processor = createDownloadProcessor({
      storage: delayedStorage,
      cancellationStore: createCancellationStore(),
      spawnDownload: vi.fn(() => spawned),
      logger: createLogger(),
    });
    const job = createJob();

    const pending = processor(job, new AbortController().signal);
    await waitUntil(() => job.updateProgress.mock.calls.length === 1);
    expect(job.updateProgress.mock.calls).toEqual([[5]]);
    expect((await readdir(root)).sort()).toEqual([`${JOB_ID}.mp3.part`]);

    commitGate.resolve();
    const result = await pending;

    expect(() => downloadJobResultSchema.parse(result)).not.toThrow();
    expect(result.storageKey).toBe(`${JOB_ID}.mp3`);
    expect(result.filename).toBe("Sensitive Artist - Sensitive Title.mp3");
    expect(JSON.stringify(result)).not.toContain(root);
    expect(job.updateProgress.mock.calls).toEqual([[5], [100]]);
    expect((await readdir(root)).sort()).toEqual([`${JOB_ID}.mp3`]);
  });

  it("waits for all stdout bytes before committing after process completion", async () => {
    const { root, storage } = await createStorage();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stderr.end();
    const child: DownloaderProcess = {
      stdout,
      stderr,
      completion: Promise.resolve({ code: 0, signal: null }),
      kill: vi.fn(),
    };
    const commit = vi.fn();
    const wrappedStorage = {
      async begin(jobId: string, extension: "mp3" | "flac") {
        const output = await storage.begin(jobId, extension);
        return {
          write: output.write.bind(output),
          abort: output.abort.bind(output),
          failure: output.failure,
          commit: commit.mockImplementation(output.commit.bind(output)),
        };
      },
    };
    const processor = createDownloadProcessor({
      storage: wrappedStorage,
      cancellationStore: createCancellationStore(),
      spawnDownload: vi.fn(() => child),
      logger: createLogger(),
    });
    const job = createJob();
    const pending = processor(job, new AbortController().signal);
    await waitUntil(() => job.updateProgress.mock.calls.length === 1);

    stdout.write(Buffer.from("late audio"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(commit).not.toHaveBeenCalled();
    expect((await readdir(root)).sort()).toEqual([`${JOB_ID}.mp3.part`]);

    stdout.end();
    const result = await pending;
    expect(commit).toHaveBeenCalledTimes(1);
    expect(result.fileSize).toBe(10);
  });

  it("records completedAt after stdout and durable commit work", async () => {
    const { storage } = await createStorage();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stderr.end();
    const child: DownloaderProcess = {
      stdout,
      stderr,
      completion: Promise.resolve({ code: 0, signal: null }),
      kill: vi.fn(),
    };
    let currentTime = Date.parse("2026-07-26T00:00:00.000Z");
    const processor = createDownloadProcessor({
      storage,
      cancellationStore: createCancellationStore(),
      spawnDownload: vi.fn(() => child),
      logger: createLogger(),
      now: () => currentTime,
    });
    const job = createJob();
    const pending = processor(job, new AbortController().signal);
    await waitUntil(() => job.updateProgress.mock.calls.length === 1);

    currentTime = Date.parse("2026-07-26T00:05:00.000Z");
    stdout.end(Buffer.from("audio"));
    const result = await pending;

    expect(result.completedAt).toBe("2026-07-26T00:05:00.000Z");
  });

  it("observes cancellation before spawn without creating a child", async () => {
    const { root, storage } = await createStorage();
    const spawnDownload = vi.fn(() => createFakeProcess());
    const processor = createDownloadProcessor({
      storage,
      cancellationStore: createCancellationStore(() => true),
      spawnDownload,
      logger: createLogger(),
    });

    await expect(
      processor(createJob(), new AbortController().signal),
    ).rejects.toMatchObject({
      code: "download_canceled",
      retriable: false,
    });
    expect(spawnDownload).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it("observes active cancellation within 250ms and terminates the child", async () => {
    const { root, storage } = await createStorage();
    let checks = 0;
    const cancellationStore = createCancellationStore(() => {
      checks += 1;
      return checks >= 2;
    });
    const child = createFakeProcess({
      stdout: [Buffer.from("partial")],
      holdOpen: true,
    });
    const processor = createDownloadProcessor({
      storage,
      cancellationStore,
      spawnDownload: vi.fn(() => child),
      logger: createLogger(),
      cancellationPollMs: 20,
      killGraceMs: 20,
    });
    const startedAt = Date.now();

    await expect(
      processor(createJob(), new AbortController().signal),
    ).rejects.toMatchObject({
      code: "download_canceled",
      retriable: false,
    });

    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(child.kills[0]).toBe("SIGTERM");
    expect(await readdir(root)).toEqual([]);
  });

  it("maps external abort to cancellation and removes partial output", async () => {
    const { root, storage } = await createStorage();
    const child = createFakeProcess({
      stdout: [Buffer.from("partial")],
      holdOpen: true,
    });
    const processor = createDownloadProcessor({
      storage,
      cancellationStore: createCancellationStore(),
      spawnDownload: vi.fn(() => child),
      logger: createLogger(),
      cancellationPollMs: 20,
      killGraceMs: 20,
    });
    const controller = new AbortController();
    const job = createJob();
    const pending = processor(job, controller.signal);
    await waitUntil(() => job.updateProgress.mock.calls.length === 1);

    controller.abort();

    await expect(pending).rejects.toMatchObject({
      code: "download_canceled",
      retriable: false,
    });
    expect(child.kills[0]).toBe("SIGTERM");
    expect(await readdir(root)).toEqual([]);
  });

  it("uses one deadline and escalates from SIGTERM to bounded SIGKILL", async () => {
    const { root, storage } = await createStorage();
    const child = createFakeProcess({
      stdout: [Buffer.from("partial")],
      holdOpen: true,
      ignoreTerm: true,
    });
    const processor = createDownloadProcessor({
      storage,
      cancellationStore: createCancellationStore(),
      spawnDownload: vi.fn(() => child),
      logger: createLogger(),
      deadlineMs: 100,
      cancellationPollMs: 20,
      killGraceMs: 20,
    });

    await expect(
      processor(createJob(), new AbortController().signal),
    ).rejects.toMatchObject({
      code: "deadline_exceeded",
      retriable: false,
    });
    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(await readdir(root)).toEqual([]);
  });

  it("applies the absolute deadline to a hung storage begin", async () => {
    const spawnDownload = vi.fn(() => createFakeProcess());
    const processor = createDownloadProcessor({
      storage: {
        begin: vi.fn(() => new Promise<never>(() => undefined)),
      },
      cancellationStore: createCancellationStore(),
      spawnDownload,
      logger: createLogger(),
      deadlineMs: 20,
    });
    const startedAt = Date.now();

    await expect(
      processor(createJob(), new AbortController().signal),
    ).rejects.toMatchObject({
      code: "deadline_exceeded",
      retriable: false,
    });
    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(spawnDownload).not.toHaveBeenCalled();
  });

  it("maps an unavailable owned root before child spawn", async () => {
    const { root, storage } = await createStorage();
    await rm(root, { recursive: true, force: true });
    const spawnDownload = vi.fn(() => createFakeProcess());
    const processor = createDownloadProcessor({
      storage,
      cancellationStore: createCancellationStore(),
      spawnDownload,
      logger: createLogger(),
    });

    await expect(
      processor(createJob(), new AbortController().signal),
    ).rejects.toMatchObject({
      code: "storage_unavailable",
      retriable: true,
    });
    expect(spawnDownload).not.toHaveBeenCalled();
  });

  it(
    "applies the absolute deadline to a hung progress update",
    async () => {
      const { root, storage } = await createStorage();
      const child = createFakeProcess({ holdOpen: true });
      const job = createJob();
      job.updateProgress.mockImplementation(
        () => new Promise<void>(() => undefined),
      );
      const processor = createDownloadProcessor({
        storage,
        cancellationStore: createCancellationStore(),
        spawnDownload: vi.fn(() => child),
        logger: createLogger(),
        deadlineMs: 20,
        killGraceMs: 20,
      });

      await expect(
        processor(job, new AbortController().signal),
      ).rejects.toMatchObject({
        code: "deadline_exceeded",
        retriable: false,
      });
      expect(child.kills[0]).toBe("SIGTERM");
      expect(await readdir(root)).toEqual([]);
    },
    1_000,
  );

  it(
    "removes the durable result when final progress exceeds the deadline",
    async () => {
      const { root, storage } = await createStorage();
      const job = createJob();
      job.updateProgress.mockImplementation((progress: number) =>
        progress === 5
          ? Promise.resolve()
          : new Promise<void>(() => undefined),
      );
      const processor = createDownloadProcessor({
        storage,
        cancellationStore: createCancellationStore(),
        spawnDownload: vi.fn(() =>
          createFakeProcess({ stdout: [Buffer.from("audio")] }),
        ),
        logger: createLogger(),
        deadlineMs: 100,
      });

      await expect(
        processor(job, new AbortController().signal),
      ).rejects.toMatchObject({
        code: "deadline_exceeded",
        retriable: false,
      });
      expect(await readdir(root)).toEqual([]);
    },
    1_000,
  );

  it("maps empty successful stdout to retriable download failure", async () => {
    const { root, storage } = await createStorage();
    const processor = createDownloadProcessor({
      storage,
      cancellationStore: createCancellationStore(),
      spawnDownload: vi.fn(() => createFakeProcess()),
      logger: createLogger(),
    });

    await expect(
      processor(createJob(), new AbortController().signal),
    ).rejects.toMatchObject({
      code: "download_failed",
      retriable: true,
    });
    expect(await readdir(root)).toEqual([]);
  });

  it("maps streamed output refusal to a non-retriable size error", async () => {
    const { root, storage } = await createStorage({ maxFileBytes: 2 });
    const child = createFakeProcess({
      stdout: [Buffer.from("too large")],
      holdOpen: true,
    });
    const processor = createDownloadProcessor({
      storage,
      cancellationStore: createCancellationStore(),
      spawnDownload: vi.fn(() => child),
      logger: createLogger(),
      killGraceMs: 20,
    });

    await expect(
      processor(createJob(), new AbortController().signal),
    ).rejects.toMatchObject({
      code: "output_too_large",
      retriable: false,
    });
    expect(child.kills[0]).toBe("SIGTERM");
    expect(await readdir(root)).toEqual([]);
  });

  it("maps storage quota refusal to a non-retriable error and cleans the child", async () => {
    const { root, storage } = await createStorage({
      maxFileBytes: 4,
      quotaBytes: 1,
    });
    const child = createFakeProcess({
      stdout: [Buffer.from("no")],
      holdOpen: true,
    });
    const processor = createDownloadProcessor({
      storage,
      cancellationStore: createCancellationStore(),
      spawnDownload: vi.fn(() => child),
      logger: createLogger(),
      killGraceMs: 20,
    });

    await expect(
      processor(createJob(), new AbortController().signal),
    ).rejects.toMatchObject({
      code: "storage_quota_exceeded",
      retriable: false,
    });
    expect(child.kills[0]).toBe("SIGTERM");
    expect(await readdir(root)).toEqual([]);
  });

  it("preserves cancellation and cleanup when SIGTERM itself throws", async () => {
    const { root, storage } = await createStorage();
    let checks = 0;
    const child = createFakeProcess({
      stdout: [Buffer.from("partial")],
      holdOpen: true,
      throwTerm: true,
    });
    const processor = createDownloadProcessor({
      storage,
      cancellationStore: createCancellationStore(() => {
        checks += 1;
        return checks >= 2;
      }),
      spawnDownload: vi.fn(() => child),
      logger: createLogger(),
      cancellationPollMs: 20,
      killGraceMs: 20,
    });

    await expect(
      processor(createJob(), new AbortController().signal),
    ).rejects.toMatchObject({
      code: "download_canceled",
      retriable: false,
    });
    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(await readdir(root)).toEqual([]);
  });

  it("maps process failure categorically and never exposes child stderr", async () => {
    const { root, storage } = await createStorage();
    const logger = createLogger();
    const child = createFakeProcess({
      stdout: [Buffer.from("partial")],
      stderr: Array.from({ length: 64 }, () =>
        Buffer.from(STDERR_SECRET),
      ),
      exitCode: 1,
    });
    const processor = createDownloadProcessor({
      storage,
      cancellationStore: createCancellationStore(),
      spawnDownload: vi.fn(() => child),
      logger,
    });

    const failure = await processor(
      createJob(),
      new AbortController().signal,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DownloadProcessingError);
    expect(failure).toMatchObject({
      message: "download_failed",
      code: "download_failed",
      retriable: true,
    });
    expect(JSON.stringify(logger)).not.toContain(STDERR_SECRET);
    expect(await readdir(root)).toEqual([]);
  });

  it("keeps source, account, title, filename, and stderr out of logger calls", async () => {
    const { storage } = await createStorage();
    const logger = createLogger();
    const child = createFakeProcess({
      stdout: [Buffer.from("audio")],
      stderr: [Buffer.from(STDERR_SECRET)],
    });
    const processor = createDownloadProcessor({
      storage,
      cancellationStore: createCancellationStore(),
      spawnDownload: vi.fn(() => child),
      logger,
    });

    await processor(createJob(), new AbortController().signal);

    const calls = JSON.stringify([
      logger.info.mock.calls,
      logger.warn.mock.calls,
      logger.error.mock.calls,
    ]);
    for (const secret of [
      SOURCE_URL,
      ACCOUNT_ID,
      validData.artist,
      validData.title,
      "Sensitive Artist - Sensitive Title.mp3",
      STDERR_SECRET,
    ]) {
      expect(calls).not.toContain(secret);
    }
  });

  it("sanitizes and bounds the result filename", async () => {
    const { storage } = await createStorage();
    const processor = createDownloadProcessor({
      storage,
      cancellationStore: createCancellationStore(),
      spawnDownload: vi.fn(() =>
        createFakeProcess({ stdout: [Buffer.from("audio")] }),
      ),
      logger: createLogger(),
    });
    const job = createJob({
      ...validData,
      artist: `A/${"x".repeat(298)}`,
      title: `B\\\r\n\0${"y".repeat(490)}`,
    });

    const result = await processor(job, new AbortController().signal);

    expect(result.filename.length).toBeLessThanOrEqual(255);
    expect(result.filename).not.toMatch(/[\r\n/\\\0]/);
    expect(() => downloadJobResultSchema.parse(result)).not.toThrow();
  });
});
