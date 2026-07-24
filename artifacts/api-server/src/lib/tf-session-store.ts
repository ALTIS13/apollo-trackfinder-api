import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  PLATFORM_MODULE_KEYS,
  platformAssertionClaimsSchema,
  policyIntrospectionResponseSchema,
  type PlatformAssertionClaims,
  type PolicyIntrospectionResponse,
} from "@workspace/platform-contract";
import { z } from "zod";
import type Redis from "ioredis";

const TRANSACTION_TTL_SECONDS = 300;
const WEBSOCKET_TICKET_TTL_SECONDS = 30;
const SESSION_MAX_TTL_SECONDS = 8 * 60 * 60;
const POLICY_REFRESH_SECONDS = 300;
const RANDOM_WRITE_ATTEMPTS = 4;
const CAS_ATTEMPTS = 16;
const OPAQUE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

const transactionInputSchema = z
  .object({
    state: z.string().regex(OPAQUE_PATTERN),
    codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
    nonce: z.string().regex(OPAQUE_PATTERN),
    installationId: z.string().uuid(),
    installationLabel: z.string().trim().min(1).max(120),
  })
  .strict();

const transactionSchema = transactionInputSchema
  .extend({
    createdAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

const entitlementSchema = z.enum(PLATFORM_MODULE_KEYS);

const tfSessionSchema = z
  .object({
    id: z.string().uuid(),
    accountId: z.string().uuid(),
    platformSessionId: z.string().uuid(),
    installationId: z.string().uuid(),
    entitlements: z
      .array(entitlementSchema)
      .max(PLATFORM_MODULE_KEYS.length)
      .refine((values) => new Set(values).size === values.length)
      .refine((values) =>
        values.every(
          (value, index) =>
            index === 0 || values[index - 1]!.localeCompare(value) < 0,
        ),
      ),
    assertionExpiresAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

const websocketTicketSchema = z
  .object({
    accountId: z.string().uuid(),
    sessionId: z.string().uuid(),
    sessionHandle: z.string().regex(OPAQUE_PATTERN),
    sessionDigest: z.string().regex(SHA256_HEX_PATTERN),
    createdAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

const CONSUME_SCRIPT = `
local value = redis.call("GET", KEYS[1])
if value then
  redis.call("DEL", KEYS[1])
end
return value
`;

const COMPARE_AND_REPLACE_SCRIPT = `
local current = redis.call("GET", KEYS[1])
if not current then
  return -1
end
if current ~= ARGV[1] then
  return 0
end
redis.call("SET", KEYS[1], ARGV[2], "KEEPTTL")
return 1
`;

const ISSUE_TICKET_SCRIPT = `
local current = redis.call("GET", KEYS[1])
if not current or current ~= ARGV[1] then
  return -1
end
local result = redis.call("SET", KEYS[2], ARGV[2], "EX", ARGV[3], "NX")
if result then
  return 1
end
return 0
`;

export interface StrictRedisClient {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    ...arguments_: Array<string | number>
  ): Promise<unknown>;
  eval(
    script: string,
    numberOfKeys: number,
    ...arguments_: Array<string | number>
  ): Promise<unknown>;
}

export function createStrictRedisClient(redis: Redis): StrictRedisClient {
  return {
    get: (key) => redis.get(key),
    set: (key, value, ...arguments_) =>
      redis.call("SET", key, value, ...arguments_.map(String)),
    eval: (script, numberOfKeys, ...arguments_) =>
      redis.call(
        "EVAL",
        script,
        String(numberOfKeys),
        ...arguments_.map(String),
      ),
  };
}

export interface TfAuthTransaction extends z.infer<typeof transactionSchema> {}

export interface TfSession {
  readonly id: string;
  readonly accountId: string;
  readonly platformSessionId: string;
  readonly installationId: string;
  readonly entitlements: readonly string[];
  readonly assertionExpiresAt: string;
  readonly expiresAt: string;
}

export interface WebSocketTicket {
  readonly accountId: string;
  readonly sessionId: string;
  readonly sessionHandle: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export class TfSessionStoreUnavailableError extends Error {
  constructor() {
    super("TF authentication storage unavailable");
    this.name = "TfSessionStoreUnavailableError";
  }
}

function opaqueValue(): string {
  return randomBytes(32).toString("base64url");
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function transactionKey(handle: string): string {
  return `tf-auth:tx:${digest(handle)}`;
}

function sessionKey(handle: string): string {
  return `tf-auth:session:${digest(handle)}`;
}

function ticketKey(ticket: string): string {
  return `tf-auth:ticket:${digest(ticket)}`;
}

function sortedEntitlements(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function finiteTimestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("invalid timestamp");
  return parsed;
}

function positiveTtl(expiresAt: number, now: number): number {
  const ttl = Math.floor((expiresAt - now) / 1_000);
  if (!Number.isFinite(ttl) || ttl < 1) {
    throw new Error("invalid lifetime");
  }
  return ttl;
}

function parseScriptInteger(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (
    typeof value === "string" &&
    /^-?\d+$/.test(value) &&
    Number.isSafeInteger(Number(value))
  ) {
    return Number(value);
  }
  throw new Error("invalid script result");
}

interface StoredSession {
  readonly raw: string;
  readonly session: TfSession;
}

export class TfSessionStore {
  constructor(
    private readonly redis: StrictRedisClient,
    private readonly now: () => number = Date.now,
  ) {}

  async createTransaction(
    input: z.input<typeof transactionInputSchema>,
  ): Promise<string> {
    try {
      const parsed = transactionInputSchema.parse(input);
      const now = this.checkedNow();
      const transaction = transactionSchema.parse({
        ...parsed,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(
          now + TRANSACTION_TTL_SECONDS * 1_000,
        ).toISOString(),
      });
      return await this.storeRandomValue(
        "transaction",
        JSON.stringify(transaction),
        TRANSACTION_TTL_SECONDS,
      );
    } catch {
      throw new TfSessionStoreUnavailableError();
    }
  }

  async consumeTransaction(handle: string): Promise<TfAuthTransaction | null> {
    if (!OPAQUE_PATTERN.test(handle)) return null;
    try {
      const raw = await this.redis.eval(
        CONSUME_SCRIPT,
        1,
        transactionKey(handle),
      );
      if (raw === null) return null;
      if (typeof raw !== "string") throw new Error("invalid transaction");
      const transaction = transactionSchema.parse(JSON.parse(raw) as unknown);
      const now = this.checkedNow();
      const createdAt = finiteTimestamp(transaction.createdAt);
      const expiresAt = finiteTimestamp(transaction.expiresAt);
      if (
        expiresAt <= now ||
        createdAt > now ||
        expiresAt - createdAt !== TRANSACTION_TTL_SECONDS * 1_000
      ) {
        return null;
      }
      return transaction;
    } catch (error) {
      if (error instanceof TfSessionStoreUnavailableError) throw error;
      throw new TfSessionStoreUnavailableError();
    }
  }

  async createSession(input: {
    readonly assertionClaims: PlatformAssertionClaims;
    readonly introspection: PolicyIntrospectionResponse;
  }): Promise<{ readonly handle: string; readonly session: TfSession }> {
    try {
      const claims = platformAssertionClaimsSchema.parse(input.assertionClaims);
      const introspection = policyIntrospectionResponseSchema.parse(
        input.introspection,
      );
      if (
        !introspection.active ||
        claims.sub !== introspection.accountId ||
        claims.sid !== introspection.sessionId ||
        claims.installation_id !== introspection.installationId
      ) {
        throw new Error("invalid binding");
      }
      const now = this.checkedNow();
      const platformExpiresAt = finiteTimestamp(introspection.expiresAt);
      const expiresAt = Math.min(
        platformExpiresAt,
        now + SESSION_MAX_TTL_SECONDS * 1_000,
      );
      const assertionExpiresAt = Math.min(claims.exp * 1_000, expiresAt);
      const ttl = positiveTtl(expiresAt, now);
      positiveTtl(assertionExpiresAt, now);
      const session = tfSessionSchema.parse({
        id: randomUUID(),
        accountId: claims.sub,
        platformSessionId: claims.sid,
        installationId: claims.installation_id,
        entitlements: sortedEntitlements(introspection.entitlements),
        assertionExpiresAt: new Date(assertionExpiresAt).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
      });
      const handle = await this.storeRandomValue(
        "session",
        JSON.stringify(session),
        ttl,
      );
      return { handle, session };
    } catch {
      throw new TfSessionStoreUnavailableError();
    }
  }

  async getSession(handle: string): Promise<TfSession | null> {
    if (!OPAQUE_PATTERN.test(handle)) return null;
    try {
      const stored = await this.readSession(handle);
      return stored?.session ?? null;
    } catch {
      throw new TfSessionStoreUnavailableError();
    }
  }

  async refreshSession(
    handle: string,
    input: PolicyIntrospectionResponse,
  ): Promise<TfSession | null> {
    if (!OPAQUE_PATTERN.test(handle)) return null;
    try {
      const introspection = policyIntrospectionResponseSchema.parse(input);
      if (!introspection.active) throw new Error("inactive session");

      for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
        const stored = await this.readSession(handle);
        if (stored === null) return null;
        const now = this.checkedNow();
        const platformExpiresAt = finiteTimestamp(introspection.expiresAt);
        const currentExpiresAt = finiteTimestamp(stored.session.expiresAt);
        if (
          introspection.accountId !== stored.session.accountId ||
          introspection.sessionId !== stored.session.platformSessionId ||
          introspection.installationId !== stored.session.installationId ||
          platformExpiresAt < currentExpiresAt ||
          platformExpiresAt <= now
        ) {
          throw new Error("invalid refresh binding");
        }
        const assertionExpiresAt = Math.min(
          now + POLICY_REFRESH_SECONDS * 1_000,
          platformExpiresAt,
          currentExpiresAt,
        );
        positiveTtl(assertionExpiresAt, now);
        const refreshed = tfSessionSchema.parse({
          ...stored.session,
          entitlements: sortedEntitlements(introspection.entitlements),
          assertionExpiresAt: new Date(assertionExpiresAt).toISOString(),
        });
        const result = parseScriptInteger(
          await this.redis.eval(
            COMPARE_AND_REPLACE_SCRIPT,
            1,
            sessionKey(handle),
            stored.raw,
            JSON.stringify(refreshed),
          ),
        );
        if (result === 1) return refreshed;
        if (result === -1) return null;
        if (result !== 0) throw new Error("invalid refresh result");
      }
      throw new Error("refresh contention");
    } catch {
      throw new TfSessionStoreUnavailableError();
    }
  }

  async revokeSession(handle: string): Promise<boolean> {
    if (!OPAQUE_PATTERN.test(handle)) return false;
    try {
      const result = parseScriptInteger(
        await this.redis.eval(
          'return redis.call("DEL", KEYS[1])',
          1,
          sessionKey(handle),
        ),
      );
      if (result !== 0 && result !== 1) {
        throw new Error("invalid revoke result");
      }
      return result === 1;
    } catch {
      throw new TfSessionStoreUnavailableError();
    }
  }

  async issueWebSocketTicket(sessionHandle: string): Promise<string> {
    if (!OPAQUE_PATTERN.test(sessionHandle)) {
      throw new TfSessionStoreUnavailableError();
    }
    try {
      const stored = await this.readSession(sessionHandle);
      if (stored === null) throw new Error("missing session");
      const now = this.checkedNow();
      const sessionDigest = digest(sessionHandle);
      for (let attempt = 0; attempt < RANDOM_WRITE_ATTEMPTS; attempt += 1) {
        const ticket = opaqueValue();
        const payload = websocketTicketSchema.parse({
          accountId: stored.session.accountId,
          sessionId: stored.session.id,
          sessionHandle,
          sessionDigest,
          createdAt: new Date(now).toISOString(),
          expiresAt: new Date(
            now + WEBSOCKET_TICKET_TTL_SECONDS * 1_000,
          ).toISOString(),
        });
        const result = parseScriptInteger(
          await this.redis.eval(
            ISSUE_TICKET_SCRIPT,
            2,
            sessionKey(sessionHandle),
            ticketKey(ticket),
            stored.raw,
            JSON.stringify(payload),
            WEBSOCKET_TICKET_TTL_SECONDS,
          ),
        );
        if (result === 1) return ticket;
        if (result === -1) throw new Error("missing session");
        if (result !== 0) throw new Error("invalid ticket result");
      }
      throw new Error("ticket collision");
    } catch {
      throw new TfSessionStoreUnavailableError();
    }
  }

  async consumeWebSocketTicket(
    ticket: string,
  ): Promise<WebSocketTicket | null> {
    if (!OPAQUE_PATTERN.test(ticket)) return null;
    try {
      const raw = await this.redis.eval(CONSUME_SCRIPT, 1, ticketKey(ticket));
      if (raw === null) return null;
      if (typeof raw !== "string") throw new Error("invalid ticket");
      const parsed = websocketTicketSchema.parse(JSON.parse(raw) as unknown);
      const now = this.checkedNow();
      if (
        finiteTimestamp(parsed.expiresAt) <= now ||
        finiteTimestamp(parsed.createdAt) > now ||
        finiteTimestamp(parsed.expiresAt) -
          finiteTimestamp(parsed.createdAt) !==
          WEBSOCKET_TICKET_TTL_SECONDS * 1_000 ||
        digest(parsed.sessionHandle) !== parsed.sessionDigest
      ) {
        return null;
      }
      const backing = await this.readSession(parsed.sessionHandle);
      if (
        backing === null ||
        backing.session.id !== parsed.sessionId ||
        backing.session.accountId !== parsed.accountId
      ) {
        return null;
      }
      return {
        accountId: parsed.accountId,
        sessionId: parsed.sessionId,
        sessionHandle: parsed.sessionHandle,
        createdAt: parsed.createdAt,
        expiresAt: parsed.expiresAt,
      };
    } catch {
      throw new TfSessionStoreUnavailableError();
    }
  }

  private checkedNow(): number {
    const now = this.now();
    if (!Number.isFinite(now) || now < 0) throw new Error("invalid clock");
    return now;
  }

  private async readSession(handle: string): Promise<StoredSession | null> {
    const raw = await this.redis.get(sessionKey(handle));
    if (raw === null) return null;
    const session = tfSessionSchema.parse(JSON.parse(raw) as unknown);
    const now = this.checkedNow();
    if (
      finiteTimestamp(session.expiresAt) <= now ||
      finiteTimestamp(session.assertionExpiresAt) >
        finiteTimestamp(session.expiresAt)
    ) {
      return null;
    }
    return { raw, session };
  }

  private async storeRandomValue(
    kind: "transaction" | "session",
    value: string,
    ttlSeconds: number,
  ): Promise<string> {
    for (let attempt = 0; attempt < RANDOM_WRITE_ATTEMPTS; attempt += 1) {
      const handle = opaqueValue();
      const key =
        kind === "transaction" ? transactionKey(handle) : sessionKey(handle);
      const result = await this.redis.set(key, value, "EX", ttlSeconds, "NX");
      if (result === "OK") return handle;
      if (result !== null) throw new Error("invalid set result");
    }
    throw new Error("random collision");
  }
}
