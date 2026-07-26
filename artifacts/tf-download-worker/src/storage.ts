import {
  DOWNLOAD_MAX_FILE_BYTES,
  downloadJobResultSchema,
} from "@workspace/tf-download-contract";
import type { DownloadJobResult } from "@workspace/tf-download-contract";
import {
  link,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  unlink,
} from "node:fs/promises";
import type { BigIntStats, ReadStream } from "node:fs";
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

export interface DownloadStorageDependencies {
  readonly afterOpen?: () => void | Promise<void>;
  readonly beforePublish?: () => void | Promise<void>;
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

export interface DownloadStorageReadRange {
  readonly start: number;
  readonly end: number;
}

export class DownloadStorageRead {
  private closed = false;
  private streamCreated = false;

  constructor(
    private readonly handle: FileHandle,
    readonly size: number,
  ) {}

  createReadStream(range: DownloadStorageReadRange): ReadStream {
    if (
      this.closed ||
      this.streamCreated ||
      !Number.isSafeInteger(range.start) ||
      !Number.isSafeInteger(range.end) ||
      range.start < 0 ||
      range.end < range.start ||
      range.end >= this.size
    ) {
      throw unavailable(false);
    }
    this.streamCreated = true;
    return this.handle.createReadStream({
      start: range.start,
      end: range.end,
      autoClose: false,
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.handle.close().catch(() => undefined);
  }
}

interface OwnedEntry {
  readonly name: string;
  readonly fullPath: string;
  readonly kind: "file" | "part";
  readonly size: number;
  readonly mtimeMs: number;
  readonly identity: FileIdentity;
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
  readonly partIdentity: FileIdentity;
  handle: FileHandle | undefined;
  bytesWritten: number;
  failure: DownloadStorageError | undefined;
  state: "active" | "committing" | "committed" | "finalized" | "aborted";
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

type RemovalResult = "removed" | "missing" | "mismatch";

export class DownloadStorageOutput {
  private readonly storage: DownloadStorage;
  private readonly operation: OperationState;

  constructor(storage: DownloadStorage, operation: OperationState) {
    this.storage = storage;
    this.operation = operation;
  }

  async write(data: Uint8Array, signal?: AbortSignal): Promise<boolean> {
    return this.storage.write(this.operation, data, signal);
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

  async abort(signal?: AbortSignal): Promise<void> {
    await this.storage.abort(this.operation, signal);
  }

  finalize(): void {
    this.storage.finalize(this.operation);
  }
}

// Security model: this root is a private 0700, single-UID volume. Portable Node
// has no dirfd-relative link/unlink API, so retained dev/ino checks are paired
// with that ownership boundary to close path-replacement races by other users.
export class DownloadStorage {
  readonly root: string;
  readonly maxFileBytes: number;
  readonly quotaBytes: number;
  readonly ttlMs: number;
  readonly maxSweepEntries: number;

  private readonly now: () => number;
  private readonly rootIdentity: FileIdentity;
  private readonly dependencies: DownloadStorageDependencies;
  private readonly operations = new Map<string, symbol>();
  private readonly pinnedFinals = new Map<string, symbol>();
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
    rootIdentity: FileIdentity;
    dependencies: DownloadStorageDependencies;
  }) {
    this.root = options.root;
    this.maxFileBytes = options.maxFileBytes;
    this.quotaBytes = options.quotaBytes;
    this.ttlMs = options.ttlMs;
    this.maxSweepEntries = options.maxSweepEntries;
    this.now = options.now;
    this.rootIdentity = options.rootIdentity;
    this.dependencies = options.dependencies;
  }

  static async create(
    options: DownloadStorageOptions,
    dependencies: DownloadStorageDependencies = {},
  ): Promise<DownloadStorage> {
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
    const rootStat = await lstat(options.root, { bigint: true });
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
      rootIdentity: identityOf(rootStat),
      dependencies,
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
      await this.assertRootIdentity(signal);
      throwIfAborted(signal);

      const partPath = this.containedPath(`${jobId}.${extension}.part`);
      const finalPath = this.containedPath(`${jobId}.${extension}`);
      if (this.operations.has(partPath) || this.pinnedFinals.has(finalPath)) {
        throw unavailable(true);
      }
      await this.ensureCapacity(0, signal);

      let handle: FileHandle;
      throwIfAborted(signal);
      try {
        handle = await open(partPath, "wx", 0o600);
      } catch (error) {
        throw unavailable(!isPathSafetyCollision(error));
      }

      let partIdentity: FileIdentity | undefined;
      try {
        await this.dependencies.afterOpen?.();
        const [pathStat, handleStat] = await Promise.all([
          lstat(partPath, { bigint: true }),
          handle.stat({ bigint: true }),
        ]);
        throwIfAborted(signal);
        if (!sameRegularFile(pathStat, handleStat) || pathStat.size !== 0n) {
          throw unavailable(false);
        }
        partIdentity = identityOf(pathStat);
        await this.assertRootIdentity(signal);
      } catch (error) {
        if (!partIdentity) {
          try {
            const [pathStat, handleStat] = await Promise.all([
              lstat(partPath, { bigint: true }),
              handle.stat({ bigint: true }),
            ]);
            if (sameRegularFile(pathStat, handleStat)) {
              partIdentity = identityOf(pathStat);
            }
          } catch {
            // Without matching identities, cleanup must leave the path alone.
          }
        }
        await handle.close().catch(() => undefined);
        if (partIdentity) {
          let size = 0;
          try {
            const stat = await lstat(partPath, { bigint: true });
            if (sameIdentity(identityOf(stat), partIdentity)) {
              size = safeInteger(stat.size);
            }
          } catch {
            // The exact cleanup below safely handles a missing path.
          }
          await this.removeExactFile(partPath, partIdentity, size).catch(
            () => undefined,
          );
        }
        throw asStorageError(error, false);
      }
      if (!partIdentity) throw unavailable(false);

      const operation: OperationState = {
        token: Symbol(jobId),
        jobId,
        extension,
        partPath,
        finalPath,
        partIdentity,
        handle,
        bytesWritten: 0,
        failure: undefined,
        state: "active",
      };
      this.operations.set(partPath, operation.token);
      return new DownloadStorageOutput(this, operation);
    }, signal).catch((error: unknown) => {
      throw asStorageError(error, true);
    });
  }

  async openOwnedFile(
    candidate: DownloadJobResult,
    signal?: AbortSignal,
  ): Promise<DownloadStorageRead> {
    let result: DownloadJobResult;
    try {
      result = downloadJobResultSchema.parse(candidate);
    } catch {
      throw unavailable(false);
    }
    const completedAt = Date.parse(result.completedAt);
    if (
      !Number.isFinite(completedAt) ||
      completedAt > this.now() ||
      this.now() - completedAt >= this.ttlMs
    ) {
      throw unavailable(false);
    }

    let handle: FileHandle | undefined;
    try {
      throwIfAborted(signal);
      await this.assertRootIdentity(signal);
      const filePath = this.containedPath(result.storageKey);
      const pathStat = await lstat(filePath, { bigint: true });
      throwIfAborted(signal);
      if (
        pathStat.isSymbolicLink() ||
        !pathStat.isFile() ||
        pathStat.size !== BigInt(result.fileSize)
      ) {
        throw unavailable(false);
      }
      const identity = identityOf(pathStat);

      handle = await open(filePath, "r");
      const handleStat = await handle.stat({ bigint: true });
      throwIfAborted(signal);
      if (
        !handleStat.isFile() ||
        handleStat.size !== BigInt(result.fileSize) ||
        !sameIdentity(identityOf(handleStat), identity)
      ) {
        throw unavailable(false);
      }
      await this.assertRootIdentity(signal);
      const currentPathStat = await lstat(filePath, { bigint: true });
      throwIfAborted(signal);
      if (
        currentPathStat.isSymbolicLink() ||
        !currentPathStat.isFile() ||
        currentPathStat.size !== BigInt(result.fileSize) ||
        !sameIdentity(identityOf(currentPathStat), identity)
      ) {
        throw unavailable(false);
      }
      return new DownloadStorageRead(handle, result.fileSize);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      throw asStorageError(error, false);
    }
  }

  async sweep(): Promise<DownloadStorageSweepResult> {
    return this.withLock(async () => {
      await this.assertRootIdentity();
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
        if ((await this.removeOwnedEntry(entry)) === "removed") {
          removedPartialFiles += 1;
        }
      }

      const files = scan.entries.filter((entry) => entry.kind === "file");
      const evictableFiles = files.filter(
        (entry) => !this.pinnedFinals.has(entry.fullPath),
      );
      const oldestFirst = (left: OwnedEntry, right: OwnedEntry): number =>
        left.mtimeMs - right.mtimeMs || compareNames(left.name, right.name);
      const expired = evictableFiles
        .filter((entry) => this.now() - entry.mtimeMs >= this.ttlMs)
        .sort(oldestFirst);
      const retained = evictableFiles
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
        if ((await this.removeOwnedEntry(entry)) === "removed") {
          bytesRemaining -= entry.size;
          removedStorageKeys.push(entry.name);
        }
      }
      for (const entry of retained) {
        if (bytesRemaining <= this.quotaBytes) break;
        if ((await this.removeOwnedEntry(entry)) === "removed") {
          bytesRemaining -= entry.size;
          removedStorageKeys.push(entry.name);
        }
      }

      this.usedBytes = Math.max(0, bytesRemaining);
      this.quotaBlocked = scan.truncated || this.usedBytes > this.quotaBytes;
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
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.withLock(async () => {
      throwIfAborted(signal);
      await this.assertRootIdentity(signal);
      this.assertTracked(operation, "active");
      if (operation.failure) return false;
      if (operation.bytesWritten + data.byteLength > this.maxFileBytes) {
        operation.failure = new DownloadStorageError("output_too_large", {
          retriable: false,
        });
        return false;
      }
      try {
        await this.ensureCapacity(data.byteLength, signal);
        throwIfAborted(signal);
        if (data.byteLength === 0) return true;

        const handle = operation.handle;
        if (!handle) throw unavailable(true);
        await this.assertExactPart(operation, true, signal);
        let offset = 0;
        while (offset < data.byteLength) {
          throwIfAborted(signal);
          const { bytesWritten } = await handle.write(
            data,
            offset,
            data.byteLength - offset,
          );
          if (bytesWritten <= 0) throw unavailable(true);
          offset += bytesWritten;
          operation.bytesWritten += bytesWritten;
          this.usedBytes += bytesWritten;
          throwIfAborted(signal);
        }
        await this.assertExactPart(operation, true, signal);
        return true;
      } catch (error) {
        operation.failure = asStorageError(error, true);
        if (signal?.aborted) {
          const cleanupFailure = await this.cleanupFailedOperation(
            operation,
            false,
          );
          if (cleanupFailure) operation.failure = cleanupFailure;
        }
        return false;
      }
    }, signal);
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
      let published = false;
      try {
        await this.assertRootIdentity(signal);
        await this.ensureCapacity(0, signal);
        await this.assertExactPart(operation, true, signal);
        const handle = operation.handle;
        if (!handle) throw unavailable(false);

        throwIfAborted(signal);
        await handle.sync();
        throwIfAborted(signal);
        await this.assertExactPart(operation, true, signal);
        await handle.close();
        operation.handle = undefined;
        throwIfAborted(signal);
        await this.assertExactPart(operation, false, signal);

        await this.dependencies.beforePublish?.();
        throwIfAborted(signal);
        await this.assertRootIdentity(signal);
        try {
          throwIfAborted(signal);
          await link(operation.partPath, operation.finalPath);
          published = true;
          throwIfAborted(signal);
        } catch (error) {
          throw asStorageError(error, !isPathSafetyCollision(error));
        }

        await this.assertExactFile(
          operation.finalPath,
          operation.partIdentity,
          operation.bytesWritten,
          signal,
        );
        await this.assertExactPart(operation, false, signal);
        await this.assertRootIdentity(signal);
        throwIfAborted(signal);
        const partRemoval = await this.removeExactFile(
          operation.partPath,
          operation.partIdentity,
          operation.bytesWritten,
          signal,
        );
        if (partRemoval !== "removed") throw unavailable(false);
        await this.assertRootIdentity(signal);
        await this.assertExactFile(
          operation.finalPath,
          operation.partIdentity,
          operation.bytesWritten,
          signal,
        );

        operation.state = "committed";
        if (
          this.operations.get(operation.partPath) !== operation.token ||
          this.pinnedFinals.has(operation.finalPath)
        ) {
          throw unavailable(false);
        }
        this.pinnedFinals.set(operation.finalPath, operation.token);
        return result;
      } catch (error) {
        const cleanupFailure = await this.cleanupFailedOperation(
          operation,
          published,
        );
        throw cleanupFailure ?? asStorageError(error, true);
      }
    }, signal);
  }

  async abort(operation: OperationState, signal?: AbortSignal): Promise<void> {
    await this.withLock(async () => {
      if (operation.state === "aborted" || operation.state === "finalized") {
        return;
      }
      this.assertTracked(operation);
      await this.assertRootIdentity(signal);
      await this.closeHandle(operation, signal);

      const targetPath =
        operation.state === "committed"
          ? operation.finalPath
          : operation.partPath;
      const removal = await this.removeExactFile(
        targetPath,
        operation.partIdentity,
        operation.bytesWritten,
        signal,
      );
      if (removal === "removed") {
        this.usedBytes = Math.max(0, this.usedBytes - operation.bytesWritten);
      }
      operation.state = "aborted";
      this.releaseTracking(operation);
      if (removal === "mismatch") throw unavailable(false);
    }, signal);
  }

  finalize(operation: OperationState): void {
    this.assertTracked(operation, "committed");
    if (this.pinnedFinals.get(operation.finalPath) !== operation.token) {
      throw unavailable(false);
    }
    operation.state = "finalized";
    this.releaseTracking(operation);
  }

  private async removeStartupPartials(): Promise<void> {
    await this.withLock(async () => {
      await this.assertRootIdentity();
      const scan = await this.scanOwnedEntries();
      if (scan.truncated) {
        this.quotaBlocked = true;
        return;
      }
      for (const entry of scan.entries) {
        if (entry.kind === "part") {
          await this.removeOwnedEntry(entry);
        }
      }
      this.quotaBlocked = scan.truncated;
    });
  }

  private async refreshUsage(): Promise<void> {
    await this.withLock(async () => {
      await this.assertRootIdentity();
      const scan = await this.scanOwnedEntries();
      this.usedBytes = scan.entries.reduce(
        (total, entry) => total + entry.size,
        0,
      );
      this.quotaBlocked = scan.truncated || this.usedBytes > this.quotaBytes;
    });
  }

  private async ensureCapacity(
    additionalBytes: number,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    await this.assertRootIdentity(signal);
    const scan = await this.scanOwnedEntries(signal);
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
      .filter(
        (entry) =>
          entry.kind === "file" && !this.pinnedFinals.has(entry.fullPath),
      )
      .sort(oldestFirst);
    const expired = finals.filter(
      (entry) => this.now() - entry.mtimeMs >= this.ttlMs,
    );
    const retained = finals.filter((entry) => !expired.includes(entry));

    for (const entry of expired) {
      throwIfAborted(signal);
      if ((await this.removeOwnedEntry(entry, signal)) === "removed") {
        bytesRemaining -= entry.size;
      }
    }
    for (const entry of retained) {
      if (bytesRemaining + additionalBytes <= this.quotaBytes) break;
      throwIfAborted(signal);
      if ((await this.removeOwnedEntry(entry, signal)) === "removed") {
        bytesRemaining -= entry.size;
      }
    }

    this.usedBytes = Math.max(0, bytesRemaining);
    this.quotaBlocked = this.usedBytes + additionalBytes > this.quotaBytes;
    if (this.quotaBlocked) {
      throw new DownloadStorageError("storage_quota_exceeded", {
        retriable: false,
      });
    }
    await this.assertRootIdentity(signal);
  }

  private async scanOwnedEntries(signal?: AbortSignal): Promise<ScanResult> {
    throwIfAborted(signal);
    const names: string[] = [];
    const directory = await opendir(this.root);
    throwIfAborted(signal);
    for await (const entry of directory) {
      throwIfAborted(signal);
      names.push(entry.name);
      if (names.length > this.maxSweepEntries) break;
    }
    const truncated = names.length > this.maxSweepEntries;
    const selected = names.slice(0, this.maxSweepEntries).sort(compareNames);
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
        throwIfAborted(signal);
        const stat = await lstat(fullPath, { bigint: true });
        throwIfAborted(signal);
        if (stat.isSymbolicLink() || !stat.isFile()) continue;
        entries.push({
          name,
          fullPath,
          kind,
          size: safeInteger(stat.size),
          mtimeMs: safeInteger(stat.mtimeMs),
          identity: identityOf(stat),
        });
      } catch (error) {
        if (!isMissingFileError(error)) throw error;
      }
    }
    await this.assertRootIdentity(signal);
    return {
      entries,
      scannedEntries: selected.length,
      truncated,
    };
  }

  private containedPath(name: string): string {
    const candidate = path.resolve(this.root, name);
    if (path.dirname(candidate) !== this.root || candidate === this.root) {
      throw unavailable(false);
    }
    return candidate;
  }

  private async assertRootIdentity(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const stat = await lstat(this.root, { bigint: true });
    throwIfAborted(signal);
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      !sameIdentity(identityOf(stat), this.rootIdentity)
    ) {
      throw unavailable(false);
    }
    throwIfAborted(signal);
    if ((await realpath(this.root)) !== this.root) {
      throw unavailable(false);
    }
    throwIfAborted(signal);
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

  private async closeHandle(
    operation: OperationState,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const handle = operation.handle;
    operation.handle = undefined;
    if (handle) {
      await handle.close().catch(() => undefined);
      throwIfAborted(signal);
    }
  }

  private async assertExactPart(
    operation: OperationState,
    requireOpenHandle: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.assertExactFile(
      operation.partPath,
      operation.partIdentity,
      operation.bytesWritten,
      signal,
    );
    if (!requireOpenHandle) return;
    const handle = operation.handle;
    if (!handle) throw unavailable(false);
    throwIfAborted(signal);
    const handleStat = await handle.stat({ bigint: true });
    throwIfAborted(signal);
    if (
      !handleStat.isFile() ||
      !sameIdentity(identityOf(handleStat), operation.partIdentity) ||
      handleStat.size !== BigInt(operation.bytesWritten)
    ) {
      throw unavailable(false);
    }
  }

  private async assertExactFile(
    filePath: string,
    identity: FileIdentity,
    size: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.assertRootIdentity(signal);
    throwIfAborted(signal);
    const stat = await lstat(filePath, { bigint: true });
    throwIfAborted(signal);
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      !sameIdentity(identityOf(stat), identity) ||
      stat.size !== BigInt(size)
    ) {
      throw unavailable(false);
    }
  }

  private async removeOwnedEntry(
    entry: OwnedEntry,
    signal?: AbortSignal,
  ): Promise<RemovalResult> {
    return this.removeExactFile(
      entry.fullPath,
      entry.identity,
      entry.size,
      signal,
    );
  }

  private async removeExactFile(
    filePath: string,
    identity: FileIdentity,
    size: number,
    signal?: AbortSignal,
  ): Promise<RemovalResult> {
    await this.assertRootIdentity(signal);
    throwIfAborted(signal);
    let stat: BigIntStats;
    try {
      stat = await lstat(filePath, { bigint: true });
    } catch (error) {
      if (isMissingFileError(error)) return "missing";
      throw error;
    }
    throwIfAborted(signal);
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      !sameIdentity(identityOf(stat), identity) ||
      stat.size !== BigInt(size)
    ) {
      return "mismatch";
    }
    await this.assertRootIdentity(signal);
    throwIfAborted(signal);
    await unlink(filePath);
    throwIfAborted(signal);
    await this.assertRootIdentity(signal);
    return "removed";
  }

  private async cleanupFailedOperation(
    operation: OperationState,
    published: boolean,
  ): Promise<DownloadStorageError | undefined> {
    let cleanupUnsafe = false;
    try {
      await this.closeHandle(operation);
      if (published) {
        const finalRemoval = await this.removeExactFile(
          operation.finalPath,
          operation.partIdentity,
          operation.bytesWritten,
        );
        cleanupUnsafe ||= finalRemoval === "mismatch";
      }
      const partRemoval = await this.removeExactFile(
        operation.partPath,
        operation.partIdentity,
        operation.bytesWritten,
      );
      cleanupUnsafe ||= partRemoval === "mismatch";
      if (published || partRemoval === "removed") {
        this.usedBytes = Math.max(0, this.usedBytes - operation.bytesWritten);
      }
    } catch {
      cleanupUnsafe = true;
    }
    operation.state = "aborted";
    this.releaseTracking(operation);
    return cleanupUnsafe ? unavailable(false) : undefined;
  }

  private releaseTracking(operation: OperationState): void {
    if (this.operations.get(operation.partPath) === operation.token) {
      this.operations.delete(operation.partPath);
    }
    if (this.pinnedFinals.get(operation.finalPath) === operation.token) {
      this.pinnedFinals.delete(operation.finalPath);
    }
  }

  private async withLock<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    throwIfAborted(signal);
    const previous = this.lockTail;
    let release: (() => void) | undefined;
    this.lockTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      throwIfAborted(signal);
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

function safeInteger(value: bigint): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted) || converted < 0) {
    throw unavailable(false);
  }
  return converted;
}

function unavailable(retriable: boolean): DownloadStorageError {
  return new DownloadStorageError("storage_unavailable", { retriable });
}

function asStorageError(
  error: unknown,
  retriable: boolean,
): DownloadStorageError {
  return error instanceof DownloadStorageError ? error : unavailable(retriable);
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isPathSafetyCollision(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ["EEXIST", "EISDIR", "ENOTDIR", "ELOOP"].includes(String(error.code))
  );
}

function identityOf(stat: BigIntStats): FileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameRegularFile(
  pathStat: BigIntStats,
  handleStat: BigIntStats,
): boolean {
  return (
    !pathStat.isSymbolicLink() &&
    pathStat.isFile() &&
    handleStat.isFile() &&
    sameIdentity(identityOf(pathStat), identityOf(handleStat))
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw unavailable(false);
}

function compareNames(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
