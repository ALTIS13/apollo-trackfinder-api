import { timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";

import { createTfDownloadFileSignature } from "@workspace/tf-download-contract";

const FILE_METHOD = "POST";
const FILE_PATH = "/v1/files";
const TIMESTAMP_TOLERANCE_MS = 60_000;
const DEFAULT_MAX_ACCOUNT_PARTITIONS = 256;
const DEFAULT_MAX_NONCES_PER_ACCOUNT = 256;
const MAX_SECRET_BYTES = 512;
const CANONICAL_ACCOUNT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CANONICAL_NONCE = /^[0-9a-f]{64}$/;
const CANONICAL_SIGNATURE = /^[0-9a-f]{64}$/;
const INTEGER_SECONDS = /^\d{1,32}$/;

type HeaderValue = string | readonly string[] | undefined;

export interface FileAuthenticationInput {
  readonly method: string;
  readonly path: string;
  readonly timestamp?: HeaderValue;
  readonly nonce?: HeaderValue;
  readonly signature?: HeaderValue;
  readonly rawBody: Uint8Array;
}

export interface VerifiedFileNonce {
  readonly __opaqueVerifiedFileNonce: unique symbol;
}

export interface VerifiedFileRequest {
  readonly nonce: VerifiedFileNonce;
}

export type FileRequestClaimResult =
  | "accepted"
  | "replayed"
  | "capacity_exhausted"
  | "invalid";

export interface FileRequestAuthenticator {
  verifySignature(
    input: FileAuthenticationInput,
  ): VerifiedFileRequest | undefined;
  claim(input: {
    readonly accountId: string;
    readonly nonce: VerifiedFileNonce;
  }): FileRequestClaimResult;
}

export interface HmacFileRequestAuthenticatorOptions {
  readonly secret: string | Uint8Array;
  readonly now?: () => number;
  readonly monotonicNow?: () => number;
  readonly maxAccountPartitions?: number;
  readonly maxNoncesPerAccount?: number;
}

interface FileNonceProof {
  readonly owner: HmacFileRequestAuthenticator;
  readonly value: string;
  readonly expiresAt: number;
}

function singleHeader(value: HeaderValue): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseTimestamp(value: string): number | undefined {
  if (!INTEGER_SECONDS.test(value)) return undefined;
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds)) return undefined;
  const milliseconds = seconds * 1_000;
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

function boundedLimit(value: number | undefined, fallback: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > fallback) {
    throw new Error("invalid replay capacity");
  }
  return selected;
}

function secretBytes(secret: string | Uint8Array): Buffer {
  const bytes =
    typeof secret === "string"
      ? Buffer.from(secret, "utf8")
      : Buffer.from(secret);
  if (bytes.byteLength < 32 || bytes.byteLength > MAX_SECRET_BYTES) {
    throw new Error("invalid internal authentication secret");
  }
  return bytes;
}

function matchingSignature(
  provided: HeaderValue,
  expected: string,
): boolean {
  const value = singleHeader(provided);
  const providedBytes =
    value !== undefined && CANONICAL_SIGNATURE.test(value)
      ? Buffer.from(value, "hex")
      : Buffer.alloc(32);
  const expectedBytes = Buffer.from(expected, "hex");
  return timingSafeEqual(providedBytes, expectedBytes);
}

export class HmacFileRequestAuthenticator
  implements FileRequestAuthenticator
{
  readonly #secret: Buffer;
  readonly #now: () => number;
  readonly #monotonicNow: () => number;
  readonly #maxAccountPartitions: number;
  readonly #maxNoncesPerAccount: number;
  readonly #nonces = new Map<string, Map<string, number>>();

  constructor(options: HmacFileRequestAuthenticatorOptions) {
    this.#secret = secretBytes(options.secret);
    this.#now = options.now ?? Date.now;
    this.#monotonicNow =
      options.monotonicNow ??
      (options.now === undefined
        ? performance.now.bind(performance)
        : options.now);
    this.#maxAccountPartitions = boundedLimit(
      options.maxAccountPartitions,
      DEFAULT_MAX_ACCOUNT_PARTITIONS,
    );
    this.#maxNoncesPerAccount = boundedLimit(
      options.maxNoncesPerAccount,
      DEFAULT_MAX_NONCES_PER_ACCOUNT,
    );
  }

  verifySignature(
    input: FileAuthenticationInput,
  ): VerifiedFileRequest | undefined {
    const timestamp = singleHeader(input.timestamp) ?? "";
    const nonce = singleHeader(input.nonce) ?? "";
    const rawBody =
      input.rawBody instanceof Uint8Array ? input.rawBody : Buffer.alloc(0);
    const expected = createTfDownloadFileSignature({
      method: input.method,
      path: input.path,
      timestamp,
      nonce,
      rawBody,
      secret: this.#secret,
    });

    if (!matchingSignature(input.signature, expected)) return undefined;
    if (input.method !== FILE_METHOD || input.path !== FILE_PATH) {
      return undefined;
    }
    const signedAt = parseTimestamp(timestamp);
    if (
      signedAt === undefined ||
      !CANONICAL_NONCE.test(nonce) ||
      !CANONICAL_SIGNATURE.test(singleHeader(input.signature) ?? "")
    ) {
      return undefined;
    }

    const wallTime = this.#now();
    if (
      !Number.isFinite(wallTime) ||
      Math.abs(wallTime - signedAt) > TIMESTAMP_TOLERANCE_MS
    ) {
      return undefined;
    }
    const monotonicTime = this.#monotonicNow();
    const replayValidFor =
      signedAt + TIMESTAMP_TOLERANCE_MS - wallTime;
    if (
      !Number.isFinite(monotonicTime) ||
      !Number.isFinite(replayValidFor) ||
      replayValidFor < 0
    ) {
      return undefined;
    }

    return {
      nonce: {
        owner: this,
        value: nonce,
        expiresAt: monotonicTime + replayValidFor,
      } as unknown as VerifiedFileNonce,
    };
  }

  claim(input: {
    readonly accountId: string;
    readonly nonce: VerifiedFileNonce;
  }): FileRequestClaimResult {
    if (!CANONICAL_ACCOUNT.test(input.accountId)) return "invalid";
    const proof = input.nonce as unknown as Partial<FileNonceProof>;
    if (
      proof.owner !== this ||
      typeof proof.value !== "string" ||
      typeof proof.expiresAt !== "number" ||
      !CANONICAL_NONCE.test(proof.value)
    ) {
      return "invalid";
    }

    const monotonicTime = this.#monotonicNow();
    if (!Number.isFinite(monotonicTime) || monotonicTime > proof.expiresAt) {
      return "invalid";
    }
    this.#prune(monotonicTime);

    let partition = this.#nonces.get(input.accountId);
    if (partition?.has(proof.value)) return "replayed";
    if (partition === undefined) {
      if (this.#nonces.size >= this.#maxAccountPartitions) {
        return "capacity_exhausted";
      }
      partition = new Map<string, number>();
      this.#nonces.set(input.accountId, partition);
    }
    if (partition.size >= this.#maxNoncesPerAccount) {
      return "capacity_exhausted";
    }
    partition.set(proof.value, proof.expiresAt);
    return "accepted";
  }

  #prune(monotonicTime: number): void {
    for (const [accountId, partition] of this.#nonces) {
      for (const [nonce, expiresAt] of partition) {
        if (monotonicTime > expiresAt) partition.delete(nonce);
      }
      if (partition.size === 0) this.#nonces.delete(accountId);
    }
  }
}
