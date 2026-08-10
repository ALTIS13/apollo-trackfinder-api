import { randomUUID } from "node:crypto";

import type { Pool, PoolClient, QueryResultRow } from "pg";

import { INTEGRATIONS_MIGRATION_MANIFEST } from "./migrations.js";

const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GENERATION_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_LOCK_TIMEOUT_MS = 3_000;
const MAX_POSTGRES_TIMEOUT_MS = 2_147_483_647;

export type Provider = "spotify" | "yandex";

export interface TfIntegrationsCommandContext {
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
}

export interface EncryptedTokenEnvelopeV1 {
  readonly version: 1;
  readonly keyId: string;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly tag: string;
}

export interface ProviderAccountRecord {
  readonly accountId: string;
  readonly provider: Provider;
  readonly generation: string;
  readonly tokenEnvelope: EncryptedTokenEnvelopeV1;
  readonly providerUserId: string;
  readonly displayName: string;
  readonly providerLogin?: string;
}

export interface AdminConnectionSummary {
  readonly accountId: string;
  readonly provider: Provider;
  readonly displayName: string;
  readonly updatedAt: Date;
}

export type ProviderAccountWrite = Omit<ProviderAccountRecord, "generation">;

export interface ProviderAccountRepository {
  get(
    accountId: string,
    provider: Provider,
  ): Promise<ProviderAccountRecord | null>;
  upsert(
    record: ProviderAccountWrite,
    context: TfIntegrationsCommandContext,
  ): Promise<void>;
  updateTokenEnvelopeIfGeneration(
    accountId: string,
    provider: Provider,
    generation: string,
    tokenEnvelope: EncryptedTokenEnvelopeV1,
    context: TfIntegrationsCommandContext,
  ): Promise<boolean>;
  delete(
    accountId: string,
    provider: Provider,
    context: TfIntegrationsCommandContext,
  ): Promise<boolean>;
  isMigrationCurrent(): Promise<boolean>;
}

export interface AdminConnectionSummaryRepository {
  listAdminConnectionSummaries(
    accountIds: readonly string[],
  ): Promise<readonly AdminConnectionSummary[]>;
}

export type IntegrationsStorageErrorCode =
  | "constraint_violation"
  | "storage_unavailable";

export interface IntegrationsStorageError extends Error {
  readonly code: IntegrationsStorageErrorCode;
}

const STORAGE_ERROR_MESSAGES: Readonly<
  Record<IntegrationsStorageErrorCode, string>
> = Object.freeze({
  constraint_violation:
    "The provider account record violates a storage constraint.",
  storage_unavailable:
    "The provider account storage operation could not be completed.",
});

function storageError(
  code: IntegrationsStorageErrorCode,
): IntegrationsStorageError {
  return Object.assign(new Error(STORAGE_ERROR_MESSAGES[code]), { code });
}

function mapStorageError(error: unknown): IntegrationsStorageError {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { readonly code?: unknown }).code === "string" &&
    (error as { readonly code: string }).code.startsWith("23")
  ) {
    return storageError("constraint_violation");
  }
  return storageError("storage_unavailable");
}

function remainingCommandMilliseconds(
  context: TfIntegrationsCommandContext,
): number {
  if (!Number.isSafeInteger(context.deadlineAt)) return 0;
  return Math.min(
    MAX_POSTGRES_TIMEOUT_MS,
    Math.max(0, context.deadlineAt - Date.now()),
  );
}

function isPlainObject(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isCanonicalBase64Url(
  value: unknown,
  options: { readonly exactLength?: number; readonly maxLength?: number } = {},
): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("=") ||
    !BASE64URL_PATTERN.test(value) ||
    (options.maxLength !== undefined && value.length > options.maxLength)
  ) {
    return false;
  }
  const decoded = Buffer.from(value, "base64url");
  return (
    decoded.toString("base64url") === value &&
    (options.exactLength === undefined ||
      decoded.length === options.exactLength)
  );
}

function validateEnvelope(value: unknown): EncryptedTokenEnvelopeV1 {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ["ciphertext", "keyId", "nonce", "tag", "version"]) ||
    value.version !== 1 ||
    typeof value.keyId !== "string" ||
    !KEY_ID_PATTERN.test(value.keyId) ||
    !isCanonicalBase64Url(value.nonce, { exactLength: 12 }) ||
    !isCanonicalBase64Url(value.ciphertext, { maxLength: 32_768 }) ||
    !isCanonicalBase64Url(value.tag, { exactLength: 16 })
  ) {
    throw storageError("storage_unavailable");
  }
  return Object.freeze({
    version: 1,
    keyId: value.keyId,
    nonce: value.nonce,
    ciphertext: value.ciphertext,
    tag: value.tag,
  });
}

function validateProvider(value: unknown): Provider {
  if (value !== "spotify" && value !== "yandex") {
    throw storageError("constraint_violation");
  }
  return value;
}

function validateAccountId(value: unknown): string {
  if (typeof value !== "string" || !CANONICAL_UUID_PATTERN.test(value)) {
    throw storageError("constraint_violation");
  }
  return value;
}

function validateGeneration(value: unknown): string {
  if (typeof value !== "string" || !GENERATION_UUID_PATTERN.test(value)) {
    throw storageError("constraint_violation");
  }
  return value;
}

function validateMetadata(value: unknown, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maxLength
  ) {
    throw storageError("constraint_violation");
  }
  return value;
}

function validateRecord(record: ProviderAccountWrite): ProviderAccountWrite {
  if (!isPlainObject(record)) {
    throw storageError("constraint_violation");
  }
  const provider = validateProvider(record.provider);
  const providerLogin =
    record.providerLogin === undefined
      ? undefined
      : validateMetadata(record.providerLogin, 500);
  if (
    (provider === "yandex" && providerLogin === undefined) ||
    (provider === "spotify" && providerLogin !== undefined)
  ) {
    throw storageError("constraint_violation");
  }
  return Object.freeze({
    accountId: validateAccountId(record.accountId),
    provider,
    tokenEnvelope: validateEnvelope(record.tokenEnvelope),
    providerUserId: validateMetadata(record.providerUserId, 512),
    displayName: validateMetadata(record.displayName, 500),
    ...(providerLogin === undefined ? {} : { providerLogin }),
  });
}

interface ProviderAccountRow extends QueryResultRow {
  account_id: unknown;
  provider: unknown;
  generation: unknown;
  token_envelope: unknown;
  provider_user_id: unknown;
  display_name: unknown;
  provider_login: unknown;
}

interface AdminConnectionSummaryRow extends QueryResultRow {
  account_id: unknown;
  provider: unknown;
  display_name: unknown;
  updated_at: unknown;
}

function mapRow(row: ProviderAccountRow): ProviderAccountRecord {
  try {
    const parsedEnvelope =
      typeof row.token_envelope === "string"
        ? (JSON.parse(row.token_envelope) as unknown)
        : row.token_envelope;
    const provider = validateProvider(row.provider);
    const providerLogin =
      row.provider_login === null || row.provider_login === undefined
        ? undefined
        : validateMetadata(row.provider_login, 500);
    if (provider === "spotify" && providerLogin !== undefined) {
      throw storageError("storage_unavailable");
    }
    return Object.freeze({
      accountId: validateAccountId(row.account_id),
      provider,
      generation: validateGeneration(row.generation),
      tokenEnvelope: validateEnvelope(parsedEnvelope),
      providerUserId: validateMetadata(row.provider_user_id, 512),
      displayName: validateMetadata(row.display_name, 500),
      ...(providerLogin === undefined ? {} : { providerLogin }),
    });
  } catch {
    throw storageError("storage_unavailable");
  }
}

function mapAdminConnectionSummary(
  row: AdminConnectionSummaryRow,
): AdminConnectionSummary {
  try {
    return Object.freeze({
      accountId: validateAccountId(row.account_id),
      provider: validateProvider(row.provider),
      displayName: validateMetadata(row.display_name, 500),
      updatedAt: (() => {
        if (!(row.updated_at instanceof Date) || Number.isNaN(row.updated_at.getTime())) {
          throw storageError("storage_unavailable");
        }
        return row.updated_at;
      })(),
    });
  } catch {
    throw storageError("storage_unavailable");
  }
}

export class PostgresProviderAccountRepository
  implements ProviderAccountRepository, AdminConnectionSummaryRepository
{
  readonly #pool: Pool;
  readonly #createGeneration: () => string;

  constructor(pool: Pool, createGeneration: () => string = randomUUID) {
    this.#pool = pool;
    this.#createGeneration = createGeneration;
  }

  async get(
    accountId: string,
    provider: Provider,
  ): Promise<ProviderAccountRecord | null> {
    const validatedAccountId = validateAccountId(accountId);
    const validatedProvider = validateProvider(provider);
    try {
      const result = await this.#pool.query<ProviderAccountRow>(
        `
          select account_id, provider, generation, token_envelope,
                 provider_user_id, display_name, provider_login
          from apollo_tf_integrations.provider_accounts
          where account_id = $1 and provider = $2
        `,
        [validatedAccountId, validatedProvider],
      );
      return result.rows[0] === undefined ? null : mapRow(result.rows[0]);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        ((error as { readonly code?: unknown }).code ===
          "constraint_violation" ||
          (error as { readonly code?: unknown }).code === "storage_unavailable")
      ) {
        throw error;
      }
      throw mapStorageError(error);
    }
  }

  async #mutate<T>(
    context: TfIntegrationsCommandContext,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    let client: PoolClient | undefined;
    let released = false;
    let cancelled = false;
    let sessionTimeoutConfigured = false;
    let sessionSettingUncertain = false;
    let transactionState:
      | "none"
      | "beginning"
      | "active"
      | "committing"
      | "committed" = "none";
    let cleanupFailed = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let failed = false;
    let failure: unknown;
    let result: T | undefined;
    let hasResult = false;

    const releaseClient = (destroy: boolean): void => {
      if (client === undefined || released) return;
      const target = client;
      released = true;
      try {
        if (destroy) target.release(true);
        else target.release();
      } catch (error) {
        cleanupFailed = true;
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    };
    const destroyClient = (): void => {
      cancelled = true;
      releaseClient(true);
    };
    const requireActive = (): number => {
      const remaining = remainingCommandMilliseconds(context);
      if (cancelled || context.signal.aborted || remaining === 0) {
        destroyClient();
        throw storageError("storage_unavailable");
      }
      return remaining;
    };
    const resetSessionTimeout = async (): Promise<void> => {
      if (client === undefined || !sessionTimeoutConfigured || released) return;
      sessionSettingUncertain = true;
      await client.query("RESET transaction_timeout");
      sessionTimeoutConfigured = false;
      sessionSettingUncertain = false;
    };
    const onAbort = (): void => destroyClient();

    context.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const initialRemaining = requireActive();
      deadlineTimer = setTimeout(destroyClient, initialRemaining);

      client = await this.#pool.connect();
      requireActive();
      const transactionTimeoutMs = requireActive();
      sessionSettingUncertain = true;
      await client.query(
        `SET SESSION transaction_timeout = ${transactionTimeoutMs}`,
      );
      sessionTimeoutConfigured = true;
      sessionSettingUncertain = false;

      requireActive();
      transactionState = "beginning";
      await client.query("BEGIN");
      transactionState = "active";

      requireActive();
      await client.query(
        `SET LOCAL statement_timeout = ${transactionTimeoutMs}`,
      );
      const lockTimeoutMs = Math.min(
        MAX_LOCK_TIMEOUT_MS,
        transactionTimeoutMs,
      );
      requireActive();
      await client.query(`SET LOCAL lock_timeout = ${lockTimeoutMs}`);

      requireActive();
      result = await operation(client);
      requireActive();
      transactionState = "committing";
      await client.query("COMMIT");
      transactionState = "committed";
      requireActive();
      await resetSessionTimeout();
      requireActive();
      hasResult = true;
    } catch (error) {
      failed = true;
      failure = error;
      if (client !== undefined && !released) {
        if (
          sessionSettingUncertain ||
          transactionState === "beginning" ||
          transactionState === "committing"
        ) {
          destroyClient();
        } else {
          if (transactionState === "active") {
            try {
              await client.query("ROLLBACK");
              transactionState = "none";
            } catch {
              destroyClient();
            }
          }
          if (!released && sessionTimeoutConfigured) {
            try {
              await resetSessionTimeout();
            } catch {
              destroyClient();
            }
          }
        }
      }
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      context.signal.removeEventListener("abort", onAbort);
      if (client !== undefined && !released) {
        if (
          sessionTimeoutConfigured ||
          sessionSettingUncertain ||
          transactionState === "beginning" ||
          transactionState === "active" ||
          transactionState === "committing"
        ) {
          destroyClient();
        } else {
          releaseClient(false);
        }
      }
    }

    if (failed || cleanupFailed || !hasResult) {
      throw mapStorageError(failure);
    }
    return result as T;
  }

  async upsert(
    record: ProviderAccountWrite,
    context: TfIntegrationsCommandContext,
  ): Promise<void> {
    const validated = validateRecord(record);
    const generation = validateGeneration(this.#createGeneration());
    await this.#mutate(context, async (client) => {
      await client.query(
        `
          insert into apollo_tf_integrations.provider_accounts
            (account_id, provider, generation, token_envelope,
             provider_user_id, display_name, provider_login)
          values ($1, $2, $3::uuid, $4::jsonb, $5, $6, $7)
          on conflict (account_id, provider) do update
          set generation = excluded.generation,
              token_envelope = excluded.token_envelope,
              provider_user_id = excluded.provider_user_id,
              display_name = excluded.display_name,
              provider_login = excluded.provider_login,
              updated_at = now()
        `,
        [
          validated.accountId,
          validated.provider,
          generation,
          JSON.stringify(validated.tokenEnvelope),
          validated.providerUserId,
          validated.displayName,
          validated.providerLogin ?? null,
        ],
      );
    });
  }

  async updateTokenEnvelopeIfGeneration(
    accountId: string,
    provider: Provider,
    generation: string,
    tokenEnvelope: EncryptedTokenEnvelopeV1,
    context: TfIntegrationsCommandContext,
  ): Promise<boolean> {
    const validatedAccountId = validateAccountId(accountId);
    const validatedProvider = validateProvider(provider);
    const validatedGeneration = validateGeneration(generation);
    const validatedEnvelope = validateEnvelope(tokenEnvelope);
    return this.#mutate(context, async (client) => {
      const result = await client.query(
        `
          update apollo_tf_integrations.provider_accounts
          set token_envelope = $4::jsonb,
              updated_at = now()
          where account_id = $1
            and provider = $2
            and generation = $3::uuid
        `,
        [
          validatedAccountId,
          validatedProvider,
          validatedGeneration,
          JSON.stringify(validatedEnvelope),
        ],
      );
      return result.rowCount === 1;
    });
  }

  async delete(
    accountId: string,
    provider: Provider,
    context: TfIntegrationsCommandContext,
  ): Promise<boolean> {
    const validatedAccountId = validateAccountId(accountId);
    const validatedProvider = validateProvider(provider);
    return this.#mutate(context, async (client) => {
      const result = await client.query(
        `
          delete from apollo_tf_integrations.provider_accounts
          where account_id = $1 and provider = $2
        `,
        [validatedAccountId, validatedProvider],
      );
      return result.rowCount === 1;
    });
  }

  async listAdminConnectionSummaries(
    accountIds: readonly string[],
  ): Promise<readonly AdminConnectionSummary[]> {
    if (accountIds.length > 100 || new Set(accountIds).size !== accountIds.length) {
      throw storageError("constraint_violation");
    }
    const validatedAccountIds = accountIds.map(validateAccountId);
    if (validatedAccountIds.length === 0) return Object.freeze([]);
    try {
      const result = await this.#pool.query<AdminConnectionSummaryRow>(
        `select account_id, provider, display_name, updated_at
         from apollo_tf_integrations.provider_accounts
         where account_id = any($1::uuid[])
         order by account_id, provider`,
        [validatedAccountIds],
      );
      return Object.freeze(result.rows.map(mapAdminConnectionSummary));
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        ((error as { readonly code?: unknown }).code ===
          "constraint_violation" ||
          (error as { readonly code?: unknown }).code === "storage_unavailable")
      ) {
        throw error;
      }
      throw mapStorageError(error);
    }
  }

  async isMigrationCurrent(): Promise<boolean> {
    if (INTEGRATIONS_MIGRATION_MANIFEST.length === 0) return false;
    try {
      const result = await this.#pool.query<{ current: boolean }>(
        `
          with expected as (
            select entry ->> 'name' as name,
                   entry ->> 'checksum' as checksum
            from jsonb_array_elements($1::jsonb) as entry
          ),
          persisted as (
            select name, checksum
            from apollo_tf_integrations.schema_migrations
          )
          select (
            (select count(*) from persisted) = $2
            and (select count(*) from expected) = $2
            and (
              select count(*)
              from persisted, expected
              where persisted.name = expected.name
                and persisted.checksum = expected.checksum
            ) = $2
          ) as current
        `,
        [
          JSON.stringify(INTEGRATIONS_MIGRATION_MANIFEST),
          INTEGRATIONS_MIGRATION_MANIFEST.length,
        ],
      );
      return result.rows[0]?.current === true;
    } catch (error) {
      throw mapStorageError(error);
    }
  }
}
