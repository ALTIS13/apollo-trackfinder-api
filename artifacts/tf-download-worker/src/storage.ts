import { DOWNLOAD_MAX_FILE_BYTES, downloadJobResultSchema } from "@workspace/tf-download-contract";
import type { DownloadJobResult } from "@workspace/tf-download-contract";
import {
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_QUOTA_BYTES = 20 * 1_024 * 1_024 * 1_024;
const DEFAULT_MAX_SWEEP_ENTRIES = 10_000;
const CANONICAL_JOB_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OWNED_FILE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(mp3|flac)$/;
const OWNED_PART =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(mp3|flac)\.part$/;

export type DownloadExtension = "mp3" | "flac";
export type DownloadStorageErrorCode =
  | "output_too_large"
  | "storage_quota_exceeded"
  | "storage_unavailable";

export class DownloadStorageError extends Error {
  readonly code: DownloadStorageErrorCode;
  readonly retriable: boolean;

  constructor(
    code: DownloadStorageErrorCode,
    options: { readonly retriable: boolean },
  ) {
    super(code);
    this.name = "DownloadStorageError";
    this.code = code;
    this.retriable = options.retriable;
  }
}

export interface DownloadStorageOptions {
  readonly root: string;
  readonly maxFileBytes?: number;
  readonly quotaBytes?: number;
  readonly ttlMs?: number;
  readonly maxSweepEntries?: number;
  readonly now?: () => number;
}

export interface DownloadCommitMetadata {
  readonly filename: string;
  readonly mimeType: "audio/mpeg" | "audio/flac";
  readonly completedAt: string;
}

export interface DownloadStorageSweepResult {
  readonly scannedEntries: number;
  readonly removedPartialFiles: number;
  readonly removedStorageKeys: readonly string[];
  readonly bytesRemaining: number;
  readonly quotaSatisfied: boolean;
}

interface OwnedEntry {
  readonly name: string;
  readonly fullPath: string;
  readonly kind: "file" | "part";
  readonly size: number;
  readonly mtimeMs: number;
}

interface ScanResult {
  readonly entries: OwnedEntry[];
  readonly scannedEntries: number;
  readonly truncated: boolean;
}

interface OperationState {
  readonly token: symbol;
  readonly jobId: string;
  readonly extension: DownloadExtension;
  readonly partPath: string;
  readonly finalPath: string;
  handle: FileHandle | undefined;
  bytesWritten: number;
  failure: DownloadStorageError | undefined;
  state: "active" | "committing" | "committed" | "aborted";
}

export class DownloadStorageOutput {
  private readonly storage: DownloadStorage;
  private readonly operation: OperationState;

  constructor(storage: DownloadStorage, operation: OperationState) {
    this.storage = storage;
    this.operation = operation;
  }

  async write(data: Uint8Array): Promise<boolean> {
    return this.storage.write(this.operation, data);
  }

  get failure(): DownloadStorageError | undefined {
    return this.operation.failure;
  }

  async commit(
    metadata: DownloadCommitMetadata,
    signal?: AbortSignal,
  ): Promise<DownloadJobResult> {
    return this.storage.commit(this.operation, metadata, signal);
  }

  async abort(): Promise<void> {
    await this.storage.abort(this.operation);
  }
}

export class DownloadStorage {
  readonly root: string;
  readonly maxFileBytes: number;
  readonly quotaBytes: number;
  readonly ttlMs: number;
  readonly maxSweepEntries: number;

  private readonly now: () => number;
  private readonly operations = new Map<string, symbol>();
  private usedBytes = 0;
  private quotaBlocked = false;
  private lockTail: Promise<void> = Promise.resolve();

  private constructor(options: {
    root: string;
    maxFileBytes: number;
    quotaBytes: number;
    ttlMs: number;
    maxSweepEntries: number;
    now: () => number;
  }) {
    this.root = options.root;
    this.maxFileBytes = options.maxFileBytes;
    this.quotaBytes = options.quotaBytes;
    this.ttlMs = options.ttlMs;
    this.maxSweepEntries = options.maxSweepEntries;
    this.now = options.now;
  }

  static async create(options: DownloadStorageOptions): Promise<DownloadStorage> {
    if (!path.isAbsolute(options.root)) {
      throw unavailable(false);
    }
    const maxFileBytes = positiveInteger(
      options.maxFileBytes ?? DOWNLOAD_MAX_FILE_BYTES,
    );
    const quotaBytes = positiveInteger(
      options.quotaBytes ?? DEFAULT_QUOTA_BYTES,
    );
    const ttlMs = positiveInteger(options.ttlMs ?? DEFAULT_TTL_MS);
    const maxSweepEntries = positiveInteger(
      options.maxSweepEntries ?? DEFAULT_MAX_SWEEP_ENTRIES,
    );

    await mkdir(options.root, { recursive: true, mode: 0o700 });
    const rootStat = await lstat(options.root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw unavailable(false);
    }
    const canonicalRoot = await realpath(options.root);
    const storage = new DownloadStorage({
      root: canonicalRoot,
      maxFileBytes,
      quotaBytes,
      ttlMs,
      maxSweepEntries,
      now: options.now ?? Date.now,
    });
    await storage.removeStartupPartials();
    await storage.refreshUsage();
    return storage;
  }

  async begin(
    jobId: string,
    extension: DownloadExtension,
    signal?: AbortSignal,
  ): Promise<DownloadStorageOutput> {
    if (
      !CANONICAL_JOB_ID.test(jobId) ||
      (extension !== "mp3" && extension !== "flac")
    ) {
      throw unavailable(false);
    }
    throwIfAborted(signal);

    return this.withLock(async () => {
      await this.assertRoot();
      throwIfAborted(signal);
      await this.ensureCapacity(0);

      const partPath = this.containedPath(`${jobId}.${extension}.part`);
      const finalPath = this.containedPath(`${jobId}.${extension}`);
      let handle: FileHandle;
      try {
        handle = await open(partPath, "wx", 0o600);
      } catch {
        throw unavailable(true);
      }

      try {
        const [pathStat, handleStat] = await Promise.all([
          lstat(partPath),
          handle.stat(),
        ]);
        if (
          pathStat.isSymbolicLink() ||
          !pathStat.isFile() ||
          !handleStat.isFile() ||
          pathStat.dev !== handleStat.dev ||
          pathStat.ino !== handleStat.ino
        ) {
          throw unavailable(false);
        }
        throwIfAborted(signal);
      } catch (error) {
        await handle.close().catch(() => undefined);
        await removeRegularFile(partPath);
        throw asStorageError(error, false);
      }

      const operation: OperationState = {
        token: Symbol(jobId),
        jobId,
        extension,
        partPath,
        finalPath,
        handle,
        bytesWritten: 0,
        failure: undefined,
        state: "active",
      };
      this.operations.set(partPath, operation.token);
      return new DownloadStorageOutput(this, operation);
    }).catch((error: unknown) => {
      throw asStorageError(error, true);
    });
  }

  async sweep(): Promise<DownloadStorageSweepResult> {
    return this.withLock(async () => {
      await this.assertRoot();
      const scan = await this.scanOwnedEntries();
      const removedStorageKeys: string[] = [];
      let removedPartialFiles = 0;
      if (scan.truncated) {
        this.usedBytes = scan.entries.reduce(
          (total, entry) => total + entry.size,
          0,
        );
        this.quotaBlocked = true;
        return {
          scannedEntries: scan.scannedEntries,
          removedPartialFiles,
          removedStorageKeys,
          bytesRemaining: this.usedBytes,
          quotaSatisfied: false,
        };
      }

      const parts = scan.entries.filter(
        (entry) =>
          entry.kind === "part" && !this.operations.has(entry.fullPath),
      );
      for (const entry of parts) {
        if (await removeRegularFile(entry.fullPath)) {
          removedPartialFiles += 1;
        }
      }

      const files = scan.entries.filter((entry) => entry.kind === "file");
      const oldestFirst = (left: OwnedEntry, right: OwnedEntry): number =>
        left.mtimeMs - right.mtimeMs || compareNames(left.name, right.name);
      const expired = files
        .filter((entry) => this.now() - entry.mtimeMs >= this.ttlMs)
        .sort(oldestFirst);
      const retained = files
        .filter((entry) => !expired.includes(entry))
        .sort(oldestFirst);
      let bytesRemaining =
        files.reduce((total, entry) => total + entry.size, 0) +
        scan.entries
          .filter(
            (entry) =>
              entry.kind === "part" && this.operations.has(entry.fullPath),
          )
          .reduce((total, entry) => total + entry.size, 0);

      for (const entry of expired) {
        if (await removeRegularFile(entry.fullPath)) {
          bytesRemaining -= entry.size;
          removedStorageKeys.push(entry.name);
        }
      }
      for (const entry of retained) {
        if (bytesRemaining <= this.quotaBytes) break;
        if (await removeRegularFile(entry.fullPath)) {
          bytesRemaining -= entry.size;
          removedStorageKeys.push(entry.name);
        }
      }

      this.usedBytes = Math.max(0, bytesRemaining);
      this.quotaBlocked =
        scan.truncated || this.usedBytes > this.quotaBytes;
      return {
        scannedEntries: scan.scannedEntries,
        removedPartialFiles,
        removedStorageKeys,
        bytesRemaining: this.usedBytes,
        quotaSatisfied: !this.quotaBlocked,
      };
    });
  }

  async write(
    operation: OperationState,
    data: Uint8Array,
  ): Promise<boolean> {
    return this.withLock(async () => {
      this.assertTracked(operation, "active");
      if (operation.failure) return false;
      if (
        operation.bytesWritten + data.byteLength > this.maxFileBytes
      ) {
        operation.failure = new DownloadStorageError("output_too_large", {
          retriable: false,
        });
        return false;
      }
      try {
        await this.ensureCapacity(data.byteLength);
      } catch (error) {
        operation.failure = asStorageError(error, true);
        return false;
      }
      if (data.byteLength === 0) return true;

      const handle = operation.handle;
      if (!handle) {
        operation.failure = unavailable(true);
        return false;
      }
      try {
        let offset = 0;
        while (offset < data.byteLength) {
          const { bytesWritten } = await handle.write(
            data,
            offset,
            data.byteLength - offset,
          );
          if (bytesWritten <= 0) throw unavailable(true);
          offset += bytesWritten;
        }
        operation.bytesWritten += data.byteLength;
        this.usedBytes += data.byteLength;
        return true;
      } catch (error) {
        operation.failure = asStorageError(error, true);
        return false;
      }
    });
  }

  async commit(
    operation: OperationState,
    metadata: DownloadCommitMetadata,
    signal?: AbortSignal,
  ): Promise<DownloadJobResult> {
    if (operation.failure) {
      const failure = operation.failure;
      await this.abort(operation);
      throw failure;
    }

    let result: DownloadJobResult;
    try {
      result = downloadJobResultSchema.parse({
        schemaVersion: 1,
        storageKey: `${operation.jobId}.${operation.extension}`,
        fileSize: operation.bytesWritten,
        mimeType: metadata.mimeType,
        filename: metadata.filename,
        completedAt: metadata.completedAt,
      });
    } catch {
      await this.abort(operation);
      throw unavailable(false);
    }

    return this.withLock(async () => {
      this.assertTracked(operation, "active");
      operation.state = "committing";
      let renamed = false;
      try {
        await this.ensureCapacity(0);
        throwIfAborted(signal);
        const handle = operation.handle;
        if (!handle) throw unavailable(true);
        await handle.sync();
        await handle.close();
        operation.handle = undefined;
        throwIfAborted(signal);

        const partStat = await lstat(operation.partPath);
        if (
          partStat.isSymbolicLink() ||
          !partStat.isFile() ||
          partStat.size !== operation.bytesWritten
        ) {
          throw unavailable(false);
        }
        try {
          await lstat(operation.finalPath);
          throw unavailable(false);
        } catch (error) {
          if (
            error instanceof DownloadStorageError ||
            !isMissingFileError(error)
          ) {
            throw error;
          }
        }

        await rename(operation.partPath, operation.finalPath);
        renamed = true;
        throwIfAborted(signal);
        const finalStat = await lstat(operation.finalPath);
        if (
          finalStat.isSymbolicLink() ||
          !finalStat.isFile() ||
          finalStat.size !== operation.bytesWritten
        ) {
          throw unavailable(false);
        }
        operation.state = "committed";
        this.operations.delete(operation.partPath);
        return result;
      } catch (error) {
        await this.closeHandle(operation);
        const cleanupPath = renamed
          ? operation.finalPath
          : operation.partPath;
        await removeRegularFile(cleanupPath);
        this.usedBytes = Math.max(0, this.usedBytes - operation.bytesWritten);
        operation.state = "aborted";
        this.operations.delete(operation.partPath);
        throw asStorageError(error, true);
      }
    });
  }

  async abort(operation: OperationState): Promise<void> {
    await this.withLock(async () => {
      if (operation.state === "aborted") {
        return;
      }
      if (operation.state === "committed") {
        await removeRegularFile(operation.finalPath);
        this.usedBytes = Math.max(0, this.usedBytes - operation.bytesWritten);
        operation.state = "aborted";
        return;
      }
      this.assertTracked(operation);
      await this.closeHandle(operation);
      await removeRegularFile(operation.partPath);
      this.usedBytes = Math.max(0, this.usedBytes - operation.bytesWritten);
      operation.state = "aborted";
      this.operations.delete(operation.partPath);
    });
  }

  private async removeStartupPartials(): Promise<void> {
    await this.withLock(async () => {
      const scan = await this.scanOwnedEntries();
      if (scan.truncated) {
        this.quotaBlocked = true;
        return;
      }
      for (const entry of scan.entries) {
        if (entry.kind === "part") {
          await removeRegularFile(entry.fullPath);
        }
      }
      this.quotaBlocked = scan.truncated;
    });
  }

  private async refreshUsage(): Promise<void> {
    await this.withLock(async () => {
      const scan = await this.scanOwnedEntries();
      this.usedBytes = scan.entries.reduce(
        (total, entry) => total + entry.size,
        0,
      );
      this.quotaBlocked =
        scan.truncated || this.usedBytes > this.quotaBytes;
    });
  }

  private async ensureCapacity(additionalBytes: number): Promise<void> {
    const scan = await this.scanOwnedEntries();
    let bytesRemaining = scan.entries.reduce(
      (total, entry) => total + entry.size,
      0,
    );
    this.usedBytes = bytesRemaining;
    if (scan.truncated) {
      this.quotaBlocked = true;
      throw new DownloadStorageError("storage_quota_exceeded", {
        retriable: false,
      });
    }

    const oldestFirst = (left: OwnedEntry, right: OwnedEntry): number =>
      left.mtimeMs - right.mtimeMs || compareNames(left.name, right.name);
    const finals = scan.entries
      .filter((entry) => entry.kind === "file")
      .sort(oldestFirst);
    const expired = finals.filter(
      (entry) => this.now() - entry.mtimeMs >= this.ttlMs,
    );
    const retained = finals.filter((entry) => !expired.includes(entry));

    for (const entry of expired) {
      if (await removeRegularFile(entry.fullPath)) {
        bytesRemaining -= entry.size;
      }
    }
    for (const entry of retained) {
      if (bytesRemaining + additionalBytes <= this.quotaBytes) break;
      if (await removeRegularFile(entry.fullPath)) {
        bytesRemaining -= entry.size;
      }
    }

    this.usedBytes = Math.max(0, bytesRemaining);
    this.quotaBlocked =
      this.usedBytes + additionalBytes > this.quotaBytes;
    if (this.quotaBlocked) {
      throw new DownloadStorageError("storage_quota_exceeded", {
        retriable: false,
      });
    }
  }

  private async scanOwnedEntries(): Promise<ScanResult> {
    const names: string[] = [];
    const directory = await opendir(this.root);
    for await (const entry of directory) {
      names.push(entry.name);
      if (names.length > this.maxSweepEntries) break;
    }
    const truncated = names.length > this.maxSweepEntries;
    const selected = names
      .slice(0, this.maxSweepEntries)
      .sort(compareNames);
    const entries: OwnedEntry[] = [];
    for (const name of selected) {
      const kind = OWNED_FILE.test(name)
        ? "file"
        : OWNED_PART.test(name)
          ? "part"
          : undefined;
      if (!kind) continue;
      const fullPath = this.containedPath(name);
      try {
        const stat = await lstat(fullPath);
        if (stat.isSymbolicLink() || !stat.isFile()) continue;
        entries.push({
          name,
          fullPath,
          kind,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      } catch (error) {
        if (!isMissingFileError(error)) throw error;
      }
    }
    return {
      entries,
      scannedEntries: selected.length,
      truncated,
    };
  }

  private containedPath(name: string): string {
    const candidate = path.resolve(this.root, name);
    if (
      path.dirname(candidate) !== this.root ||
      candidate === this.root
    ) {
      throw unavailable(false);
    }
    return candidate;
  }

  private async assertRoot(): Promise<void> {
    const stat = await lstat(this.root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw unavailable(false);
    }
    if ((await realpath(this.root)) !== this.root) {
      throw unavailable(false);
    }
  }

  private assertTracked(
    operation: OperationState,
    expectedState?: OperationState["state"],
  ): void {
    if (
      this.operations.get(operation.partPath) !== operation.token ||
      (expectedState !== undefined && operation.state !== expectedState)
    ) {
      throw unavailable(false);
    }
  }

  private async closeHandle(operation: OperationState): Promise<void> {
    const handle = operation.handle;
    operation.handle = undefined;
    if (handle) await handle.close().catch(() => undefined);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.lockTail;
    let release: (() => void) | undefined;
    this.lockTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw unavailable(false);
  }
  return value;
}

function unavailable(retriable: boolean): DownloadStorageError {
  return new DownloadStorageError("storage_unavailable", { retriable });
}

function asStorageError(
  error: unknown,
  retriable: boolean,
): DownloadStorageError {
  return error instanceof DownloadStorageError
    ? error
    : unavailable(retriable);
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function removeRegularFile(filePath: string): Promise<boolean> {
  try {
    const stat = await lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) return false;
    await rm(filePath, { force: true });
    return true;
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw unavailable(false);
}

function compareNames(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
