import { randomUUID } from "node:crypto";

import type { Pool, QueryResultRow } from "pg";

import { INTEGRATIONS_MIGRATION_MANIFEST } from "./migrations.js";

const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GENERATION_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export type Provider = "spotify" | "yandex";

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

export type ProviderAccountWrite = Omit<
  ProviderAccountRecord,
  "generation"
>;

export interface ProviderAccountRepository {
  get(
    accountId: string,
    provider: Provider,
  ): Promise<ProviderAccountRecord | null>;
  upsert(record: ProviderAccountWrite): Promise<void>;
  updateTokenEnvelopeIfGeneration(
    accountId: string,
    provider: Provider,
    generation: string,
    tokenEnvelope: EncryptedTokenEnvelopeV1,
  ): Promise<boolean>;
  delete(accountId: string, provider: Provider): Promise<boolean>;
  isMigrationCurrent(): Promise<boolean>;
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
  if (
    typeof value !== "string" ||
    !GENERATION_UUID_PATTERN.test(value)
  ) {
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

export class PostgresProviderAccountRepository implements ProviderAccountRepository {
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

  async upsert(record: ProviderAccountWrite): Promise<void> {
    const validated = validateRecord(record);
    const generation = validateGeneration(this.#createGeneration());
    try {
      await this.#pool.query(
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
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async updateTokenEnvelopeIfGeneration(
    accountId: string,
    provider: Provider,
    generation: string,
    tokenEnvelope: EncryptedTokenEnvelopeV1,
  ): Promise<boolean> {
    const validatedAccountId = validateAccountId(accountId);
    const validatedProvider = validateProvider(provider);
    const validatedGeneration = validateGeneration(generation);
    const validatedEnvelope = validateEnvelope(tokenEnvelope);
    try {
      const result = await this.#pool.query(
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
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async delete(accountId: string, provider: Provider): Promise<boolean> {
    const validatedAccountId = validateAccountId(accountId);
    const validatedProvider = validateProvider(provider);
    try {
      const result = await this.#pool.query(
        `
          delete from apollo_tf_integrations.provider_accounts
          where account_id = $1 and provider = $2
        `,
        [validatedAccountId, validatedProvider],
      );
      return result.rowCount === 1;
    } catch (error) {
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
