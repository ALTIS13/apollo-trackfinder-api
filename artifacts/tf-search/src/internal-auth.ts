import { performance } from "node:perf_hooks";
import {
  canonicalNonceSchema,
  createSignedBodySignature,
  hasMatchingSignedBodySignature,
} from "@workspace/module-runtime-contract";

const MAX_NONCES = 256;
const NONCE_TTL_MS = 5 * 60_000;
const TIMESTAMP_TOLERANCE_MS = 60_000;

export interface InternalAuthenticationInput {
  readonly method: string;
  readonly path: string;
  readonly timestamp?: string;
  readonly nonce?: string;
  readonly signature?: string;
  readonly rawBody: Buffer;
}

export interface InternalRequestAuthenticator {
  authenticate(input: InternalAuthenticationInput): boolean;
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

export class HmacInternalRequestAuthenticator
  implements InternalRequestAuthenticator
{
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly nonces = new Map<string, number>();

  constructor(private readonly options: HmacInternalRequestAuthenticatorOptions) {
    this.now = options.now ?? Date.now;
    this.monotonicNow =
      options.monotonicNow ??
      (options.now === undefined ? performance.now.bind(performance) : options.now);
  }

  authenticate(input: InternalAuthenticationInput): boolean {
    const timestamp = input.timestamp ?? "";
    const nonce = input.nonce ?? "";
    const rawBody = Buffer.isBuffer(input.rawBody) ? input.rawBody : Buffer.alloc(0);
    const expectedSignature = createSignedBodySignature({
      method: input.method,
      path: input.path,
      timestamp,
      nonce,
      rawBody,
      secret: this.options.secret,
    });

    if (!hasMatchingSignedBodySignature(input.signature, expectedSignature)) {
      return false;
    }

    const signedAt = parseTimestamp(timestamp);
    if (signedAt === undefined || !canonicalNonceSchema.safeParse(nonce).success) {
      return false;
    }

    const wallTime = this.now();
    if (!Number.isFinite(wallTime) || Math.abs(wallTime - signedAt) > TIMESTAMP_TOLERANCE_MS) {
      return false;
    }

    const monotonicTime = this.monotonicNow();
    if (!Number.isFinite(monotonicTime)) return false;
    for (const [recordedNonce, recordedAt] of this.nonces) {
      if (monotonicTime - recordedAt > NONCE_TTL_MS) this.nonces.delete(recordedNonce);
    }
    if (this.nonces.has(nonce) || this.nonces.size >= MAX_NONCES) return false;

    this.nonces.set(nonce, monotonicTime);
    return true;
  }
}
