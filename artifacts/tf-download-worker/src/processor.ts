import {
  downloadJobDataSchema,
  parseAllowedDownloadSourceUrl,
} from "@workspace/tf-download-contract";
import type {
  DownloadJobData,
  DownloadJobResult,
} from "@workspace/tf-download-contract";
import type { Job } from "bullmq";
import type { DownloadCancellationStore } from "./cancellation";
import {
  spawnYtDlpDownload,
  type DownloaderProcess,
  type SpawnDownload,
} from "./downloader";
import {
  noopDownloadLogger,
  type DownloadLogger,
} from "./logger";
import {
  DownloadStorageError,
  type DownloadCommitMetadata,
  type DownloadExtension,
} from "./storage";

const DEFAULT_DEADLINE_MS = 30 * 60 * 1_000;
const MAX_CANCELLATION_POLL_MS = 250;
const DEFAULT_KILL_GRACE_MS = 2_000;
const CANONICAL_JOB_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FORBIDDEN_FILENAME_CHARACTERS = /[\r\n/\\\0]/g;
const MAX_FILENAME_LENGTH = 255;

export type DownloadProcessingErrorCode =
  | "download_canceled"
  | "invalid_job"
  | "source_not_allowed"
  | "download_failed"
  | "output_too_large"
  | "deadline_exceeded"
  | "storage_quota_exceeded"
  | "storage_unavailable";

export class DownloadProcessingError extends Error {
  readonly code: DownloadProcessingErrorCode;
  readonly retriable: boolean;

  constructor(
    code: DownloadProcessingErrorCode,
    options: { readonly retriable: boolean },
  ) {
    super(code);
    this.name = "DownloadProcessingError";
    this.code = code;
    this.retriable = options.retriable;
  }
}

interface StorageOutputBoundary {
  readonly failure?: DownloadStorageError;
  write(data: Uint8Array): Promise<boolean>;
  commit(
    metadata: DownloadCommitMetadata,
    signal?: AbortSignal,
  ): Promise<DownloadJobResult>;
  abort(): Promise<void>;
}

interface StorageBoundary {
  begin(
    jobId: string,
    extension: DownloadExtension,
    signal?: AbortSignal,
  ): Promise<StorageOutputBoundary>;
}

export type DownloadProcessor = (
  job: Job<DownloadJobData, DownloadJobResult>,
  signal: AbortSignal,
) => Promise<DownloadJobResult>;

export interface CreateDownloadProcessorOptions {
  readonly storage: StorageBoundary;
  readonly cancellationStore: DownloadCancellationStore;
  readonly spawnDownload?: SpawnDownload;
  readonly logger?: DownloadLogger;
  readonly downloaderExecutable?: string;
  readonly deadlineMs?: number;
  readonly cancellationPollMs?: number;
  readonly killGraceMs?: number;
  readonly now?: () => number;
}

export function createDownloadProcessor(
  options: CreateDownloadProcessorOptions,
): DownloadProcessor {
  const spawnDownload = options.spawnDownload ?? spawnYtDlpDownload;
  const logger = options.logger ?? noopDownloadLogger;
  const downloaderExecutable = options.downloaderExecutable ?? "yt-dlp";
  const deadlineMs = boundedPositiveInteger(
    options.deadlineMs,
    DEFAULT_DEADLINE_MS,
  );
  const cancellationPollMs = Math.min(
    boundedPositiveInteger(
      options.cancellationPollMs,
      MAX_CANCELLATION_POLL_MS,
    ),
    MAX_CANCELLATION_POLL_MS,
  );
  const killGraceMs = boundedPositiveInteger(
    options.killGraceMs,
    DEFAULT_KILL_GRACE_MS,
  );
  const now = options.now ?? Date.now;

  return async (job, externalSignal) => {
    const startedAt = now();
    const deadlineAt = startedAt + deadlineMs;
    const controller = new AbortController();
    const deadlineError = () =>
      new DownloadProcessingError("deadline_exceeded", { retriable: false });
    const canceledError = () =>
      new DownloadProcessingError("download_canceled", { retriable: false });
    const abortWith = (error: DownloadProcessingError): void => {
      if (!controller.signal.aborted) controller.abort(error);
    };
    const onExternalAbort = (): void => abortWith(canceledError());
    if (externalSignal.aborted) onExternalAbort();
    else externalSignal.addEventListener("abort", onExternalAbort, {
      once: true,
    });
    const deadlineTimer = setTimeout(
      () => abortWith(deadlineError()),
      Math.max(0, deadlineAt - now()),
    );

    let output: StorageOutputBoundary | undefined;
    let child: DownloaderProcess | undefined;
    let childExited = false;
    let stopCancellationMonitor: (() => void) | undefined;
    const jobId = typeof job.id === "string" ? job.id : "";
    const logJobId = CANONICAL_JOB_ID.test(jobId) ? jobId : "invalid";

    try {
      throwSignalReason(controller.signal);
      const parsed = downloadJobDataSchema.safeParse(job.data);
      if (!parsed.success) {
        const onlySourceIssues = parsed.error.issues.every(
          (issue) => issue.path[0] === "sourceUrl",
        );
        throw new DownloadProcessingError(
          onlySourceIssues ? "source_not_allowed" : "invalid_job",
          { retriable: false },
        );
      }
      if (!CANONICAL_JOB_ID.test(jobId)) {
        throw new DownloadProcessingError("invalid_job", {
          retriable: false,
        });
      }
      const sourceUrl = parseAllowedDownloadSourceUrl(parsed.data.sourceUrl);
      if (!sourceUrl) {
        throw new DownloadProcessingError("source_not_allowed", {
          retriable: false,
        });
      }
      throwSignalReason(controller.signal);

      const canceledBeforeSpawn = await raceWithAbort(
        options.cancellationStore.isCanceled(jobId, controller.signal),
        controller.signal,
      );
      if (canceledBeforeSpawn) throw canceledError();
      throwSignalReason(controller.signal);

      const extension: DownloadExtension =
        parsed.data.quality === "flac" ? "flac" : "mp3";
      const filename = createFilename(
        parsed.data.artist,
        parsed.data.title,
        extension,
      );
      const mimeType =
        extension === "flac" ? ("audio/flac" as const) : ("audio/mpeg" as const);
      output = await raceWithAbort(
        options.storage.begin(jobId, extension, controller.signal),
        controller.signal,
      );
      if (controller.signal.aborted) {
        await output.abort();
        throwSignalReason(controller.signal);
      }

      child = spawnDownload({
        executable: downloaderExecutable,
        quality: parsed.data.quality,
        sourceUrl: sourceUrl.href,
        signal: controller.signal,
      });
      const childCompletion = child.completion.then(
        (exit) => {
          childExited = true;
          return exit;
        },
        (error: unknown) => {
          childExited = true;
          throw error;
        },
      );
      void childCompletion.catch(() => undefined);
      await raceWithAbort(
        Promise.resolve(job.updateProgress(5)),
        controller.signal,
      );
      logger.info({ jobId: logJobId, state: "started" });

      const monitorStop = createDeferred();
      stopCancellationMonitor = monitorStop.resolve;
      void monitorCancellation({
        store: options.cancellationStore,
        jobId,
        signal: controller.signal,
        pollMs: cancellationPollMs,
        stop: monitorStop.promise,
      }).catch((error: unknown) => {
        abortWith(
          error instanceof DownloadProcessingError
            ? error
            : new DownloadProcessingError("download_failed", {
                retriable: true,
              }),
        );
      });

      const stdoutTask = writeStdout(child.stdout, output);
      const stderrTask = discardStderr(child.stderr);
      const downloadTask = Promise.all([
        childCompletion,
        stdoutTask,
        stderrTask,
      ]).then(([exit, bytesWritten]) => {
        if (exit.code !== 0) {
          throw new DownloadProcessingError("download_failed", {
            retriable: true,
          });
        }
        if (bytesWritten === 0) {
          throw new DownloadProcessingError("download_failed", {
            retriable: true,
          });
        }
      });

      await raceWithAbort(downloadTask, controller.signal);
      throwSignalReason(controller.signal);
      const metadata: DownloadCommitMetadata = {
        filename,
        mimeType,
        completedAt: new Date(now()).toISOString(),
      };
      const result = await output.commit(metadata, controller.signal);
      throwSignalReason(controller.signal);
      stopCancellationMonitor();
      stopCancellationMonitor = undefined;
      await raceWithAbort(
        Promise.resolve(job.updateProgress(100)),
        controller.signal,
      );
      clearTimeout(deadlineTimer);
      logger.info({
        jobId: logJobId,
        state: "completed",
        durationMs: Math.max(0, now() - startedAt),
        size: result.fileSize,
      });
      return result;
    } catch (error) {
      const failure = toProcessingError(error, controller.signal);
      abortWith(failure);
      stopCancellationMonitor?.();
      if (child) {
        await terminateChild(
          child,
          () => childExited,
          killGraceMs,
        );
      }
      await output?.abort().catch(() => undefined);
      const event = {
        jobId: logJobId,
        state:
          failure.code === "download_canceled"
            ? ("canceled" as const)
            : ("failed" as const),
        code: failure.code,
        durationMs: Math.max(0, now() - startedAt),
      };
      if (failure.retriable) logger.error(event);
      else logger.warn(event);
      throw failure;
    } finally {
      clearTimeout(deadlineTimer);
      externalSignal.removeEventListener("abort", onExternalAbort);
      stopCancellationMonitor?.();
    }
  };
}

async function writeStdout(
  stdout: NodeJS.ReadableStream,
  output: StorageOutputBoundary,
): Promise<number> {
  let bytesWritten = 0;
  for await (const chunk of stdout) {
    const data =
      typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk);
    if (!(await output.write(data))) {
      throw output.failure ?? new DownloadStorageError("storage_unavailable", {
        retriable: true,
      });
    }
    bytesWritten += data.byteLength;
  }
  return bytesWritten;
}

async function discardStderr(stderr: NodeJS.ReadableStream): Promise<void> {
  for await (const _chunk of stderr) {
    // Each chunk is discarded immediately and never retained or emitted.
  }
}

async function monitorCancellation(options: {
  readonly store: DownloadCancellationStore;
  readonly jobId: string;
  readonly signal: AbortSignal;
  readonly pollMs: number;
  readonly stop: Promise<void>;
}): Promise<void> {
  while (!options.signal.aborted) {
    const stopped = await Promise.race([
      delay(options.pollMs).then(() => false),
      options.stop.then(() => true),
    ]);
    if (stopped || options.signal.aborted) return;
    if (await options.store.isCanceled(options.jobId, options.signal)) {
      throw new DownloadProcessingError("download_canceled", {
        retriable: false,
      });
    }
  }
}

async function terminateChild(
  child: DownloaderProcess,
  hasExited: () => boolean,
  graceMs: number,
): Promise<void> {
  if (hasExited()) return;
  safeKill(child, "SIGTERM");
  await Promise.race([settled(child.completion), delay(graceMs)]);
  if (hasExited()) return;
  safeKill(child, "SIGKILL");
  await Promise.race([settled(child.completion), delay(graceMs)]);
}

function safeKill(child: DownloaderProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // Termination is best-effort; cleanup and the original error still proceed.
  }
}

function toProcessingError(
  error: unknown,
  signal: AbortSignal,
): DownloadProcessingError {
  if (
    signal.aborted &&
    signal.reason instanceof DownloadProcessingError
  ) {
    return signal.reason;
  }
  if (error instanceof DownloadProcessingError) return error;
  if (error instanceof DownloadStorageError) {
    return new DownloadProcessingError(error.code, {
      retriable: error.retriable,
    });
  }
  return new DownloadProcessingError("download_failed", { retriable: true });
}

function throwSignalReason(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DownloadProcessingError("download_canceled", {
    retriable: false,
  });
}

async function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function createFilename(
  artist: string,
  title: string,
  extension: DownloadExtension,
): string {
  const suffix = `.${extension}`;
  const cleaned =
    `${artist} - ${title}`.replace(FORBIDDEN_FILENAME_CHARACTERS, "_").trim() ||
    "download";
  return `${cleaned.slice(0, MAX_FILENAME_LENGTH - suffix.length)}${suffix}`;
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0
    ? (value as number)
    : fallback;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function settled(promise: Promise<unknown>): Promise<void> {
  return promise.then(
    () => undefined,
    () => undefined,
  );
}

function createDeferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return {
    promise,
    resolve: () => resolve?.(),
  };
}
