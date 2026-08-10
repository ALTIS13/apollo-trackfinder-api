import { TextDecoder } from "node:util";

import express, { type Request, type Response, type Router } from "express";
import {
  canonicalNonceSchema,
  createSignedBodySignature,
  hasMatchingSignedBodySignature,
} from "@workspace/module-runtime-contract";

import {
  platformAdminOverviewSchema,
  type PlatformAdminOverview,
} from "../domain/admin-overview.js";
import type { OAuthClientRegistry } from "../domain/oauth-clients.js";
import { parseBasicCredentials } from "./oauth.js";

export const PLATFORM_ADMIN_OVERVIEW_PATH = "/v1/internal/admin/overview";

const BODY_LIMIT_BYTES = 1024;
const TIMESTAMP_TOLERANCE_MS = 60_000;
const MAX_REPLAY_NONCES = 256;

export interface InternalAdminOverviewService {
  load(): Promise<PlatformAdminOverview>;
}

export interface PlatformInternalAdminAuthenticator {
  verify(input: {
    readonly method: string;
    readonly path: string;
    readonly timestamp?: string;
    readonly nonce?: string;
    readonly signature?: string;
    readonly rawBody: Buffer;
    readonly clientId: string;
    readonly clientSecret: string;
  }): boolean;
}

export class HmacPlatformInternalAdminAuthenticator
  implements PlatformInternalAdminAuthenticator
{
  readonly #nonces = new Map<string, number>();

  constructor(
    private readonly clients: OAuthClientRegistry,
    private readonly expectedClientId: string,
    private readonly now: () => number = Date.now,
  ) {}

  verify(input: {
    readonly method: string;
    readonly path: string;
    readonly timestamp?: string;
    readonly nonce?: string;
    readonly signature?: string;
    readonly rawBody: Buffer;
    readonly clientId: string;
    readonly clientSecret: string;
  }): boolean {
    const client = this.clients.get(input.clientId);
    if (
      client === null ||
      client.clientId !== this.expectedClientId ||
      !this.clients.verifySecret(client, input.clientSecret)
    ) {
      return false;
    }
    const timestamp = input.timestamp ?? "";
    const nonce = input.nonce ?? "";
    const expectedSignature = createSignedBodySignature({
      method: input.method,
      path: input.path,
      timestamp,
      nonce,
      rawBody: input.rawBody,
      secret: input.clientSecret,
    });
    if (
      !hasMatchingSignedBodySignature(input.signature, expectedSignature) ||
      !canonicalNonceSchema.safeParse(nonce).success ||
      !/^\d+$/.test(timestamp)
    ) {
      return false;
    }
    const signedAt = Number(timestamp) * 1_000;
    const now = this.now();
    if (
      !Number.isSafeInteger(signedAt) ||
      !Number.isFinite(now) ||
      Math.abs(now - signedAt) > TIMESTAMP_TOLERANCE_MS
    ) {
      return false;
    }
    for (const [recordedNonce, expiresAt] of this.#nonces) {
      if (expiresAt < now) this.#nonces.delete(recordedNonce);
    }
    if (this.#nonces.has(nonce) || this.#nonces.size >= MAX_REPLAY_NONCES) {
      return false;
    }
    this.#nonces.set(nonce, signedAt + TIMESTAMP_TOLERANCE_MS);
    return true;
  }
}

function rawBody(request: Request): Buffer {
  return Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
}

function exactEmptyObject(value: Buffer): boolean {
  try {
    const parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(value),
    ) as unknown;
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Object.keys(parsed).length === 0
    );
  } catch {
    return false;
  }
}

function respondUnauthorized(response: Response): void {
  response.status(401).json({ error: "unauthorized" });
}

export function registerInternalAdminRoutes(
  router: Router,
  options: {
    readonly overview?: InternalAdminOverviewService;
    readonly auth?: PlatformInternalAdminAuthenticator;
  },
): void {
  router.post(
    PLATFORM_ADMIN_OVERVIEW_PATH,
    express.raw({ type: "application/json", limit: BODY_LIMIT_BYTES, inflate: false }),
    async (request, response) => {
      response.set({
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      const body = rawBody(request);
      let credentials: { readonly clientId: string; readonly clientSecret: string };
      try {
        credentials = parseBasicCredentials(request);
      } catch {
        respondUnauthorized(response);
        return;
      }
      if (
        options.auth === undefined ||
        !options.auth.verify({
          method: request.method,
          path: request.originalUrl,
          timestamp: request.get("X-Apollo-Internal-Timestamp"),
          nonce: request.get("X-Apollo-Internal-Nonce"),
          signature: request.get("X-Apollo-Internal-Signature"),
          rawBody: body,
          clientId: credentials.clientId,
          clientSecret: credentials.clientSecret,
        })
      ) {
        respondUnauthorized(response);
        return;
      }
      if (!exactEmptyObject(body)) {
        response.status(400).json({ error: "invalid_request" });
        return;
      }
      if (options.overview === undefined) {
        response.status(503).json({ error: "overview_unavailable" });
        return;
      }
      try {
        response.status(200).json(platformAdminOverviewSchema.parse(await options.overview.load()));
      } catch {
        response.status(503).json({ error: "overview_unavailable" });
      }
    },
  );
}
