import { performance } from "node:perf_hooks";

import {
  canonicalNonceSchema,
  createSignedBodySignature,
  hasMatchingSignedBodySignature,
} from "@workspace/module-runtime-contract";

const MAX_NONCES = 256;
const MAX_NONCES_PER_ACCOUNT = 32;
const TIMESTAMP_TOLERANCE_MS = 60_000;
const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface InternalAuthenticationInput {
  readonly method: string;
  readonly path: string;
  readonly timestamp?: string;
  readonly nonce?: string;
  readonly signature?: string;
  readonly rawBody: Buffer;
}

export interface InternalRequestAuthenticator {
  verify(
    input: InternalAuthenticationInput,
  ): VerifiedInternalRequest | undefined;
  claim(
    accountId: string,
    proof: VerifiedInternalRequest,
  ): boolean;
}

export interface VerifiedInternalRequest {
  readonly __opaqueInternalRequestProof: unique symbol;
}

export interface HmacInternalRequestAuthenticatorOptions {
  readonly secret: string;
  readonly now?: () => number;
  readonly monotonicNow?: () => number;
}

function parseTimestamp(timestamp: string): number | undefined {
  if (!/^\d+$/.test(timestamp)) return undefined;
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds)) return undefined;
  const milliseconds = seconds * 1_000;
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

export class HmacInternalRequestAuthenticator implements InternalRequestAuthenticator {
  readonly #options: HmacInternalRequestAuthenticatorOptions;
  readonly #now: () => number;
  readonly #monotonicNow: () => number;
  readonly #nonces = new Map<string, Map<string, number>>();
  #nonceCount = 0;

  constructor(options: HmacInternalRequestAuthenticatorOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#monotonicNow =
      options.monotonicNow ??
      (options.now === undefined
        ? performance.now.bind(performance)
        : options.now);
  }

  verify(
    input: InternalAuthenticationInput,
  ): VerifiedInternalRequest | undefined {
    const timestamp = input.timestamp ?? "";
    const nonce = input.nonce ?? "";
    const rawBody = Buffer.isBuffer(input.rawBody)
      ? input.rawBody
      : Buffer.alloc(0);
    const expectedSignature = createSignedBodySignature({
      method: input.method,
      path: input.path,
      timestamp,
      nonce,
      rawBody,
      secret: this.#options.secret,
    });

    if (!hasMatchingSignedBodySignature(input.signature, expectedSignature)) {
      return undefined;
    }

    const signedAt = parseTimestamp(timestamp);
    if (
      signedAt === undefined ||
      !canonicalNonceSchema.safeParse(nonce).success
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
    const replayValidFor = signedAt + TIMESTAMP_TOLERANCE_MS - wallTime;
    if (
      !Number.isFinite(monotonicTime) ||
      !Number.isFinite(replayValidFor) ||
      replayValidFor < 0
    ) {
      return undefined;
    }
    return {
      owner: this,
      nonce,
      expiresAt: monotonicTime + replayValidFor,
    } as unknown as VerifiedInternalRequest;
  }

  claim(
    accountId: string,
    proof: VerifiedInternalRequest,
  ): boolean {
    if (!CANONICAL_UUID_PATTERN.test(accountId)) return false;
    const candidate = proof as unknown as {
      readonly owner?: unknown;
      readonly nonce?: unknown;
      readonly expiresAt?: unknown;
    };
    if (
      candidate.owner !== this ||
      typeof candidate.nonce !== "string" ||
      typeof candidate.expiresAt !== "number"
    ) {
      return false;
    }

    const monotonicTime = this.#monotonicNow();
    if (
      !Number.isFinite(monotonicTime) ||
      monotonicTime > candidate.expiresAt
    ) {
      return false;
    }
    this.#prune(monotonicTime);

    const partition = this.#nonces.get(accountId) ?? new Map<string, number>();
    if (
      partition.has(candidate.nonce) ||
      partition.size >= MAX_NONCES_PER_ACCOUNT ||
      this.#nonceCount >= MAX_NONCES
    ) {
      return false;
    }
    partition.set(candidate.nonce, candidate.expiresAt);
    if (!this.#nonces.has(accountId)) {
      this.#nonces.set(accountId, partition);
    }
    this.#nonceCount += 1;
    return true;
  }

  #prune(monotonicTime: number): void {
    for (const [accountId, partition] of this.#nonces) {
      for (const [recordedNonce, expiresAt] of partition) {
        if (monotonicTime > expiresAt) {
          partition.delete(recordedNonce);
          this.#nonceCount -= 1;
        }
      }
      if (partition.size === 0) {
        this.#nonces.delete(accountId);
      }
    }
  }
}
