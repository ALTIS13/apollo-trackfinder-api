import { Pool, type PoolConfig } from "pg";

export {
  INTEGRATIONS_MIGRATION_MANIFEST,
  runIntegrationsMigrations,
  type MigrationManifestEntry,
  type MigrationResult,
} from "./migrations.js";
export {
  PostgresProviderAccountRepository,
  type EncryptedTokenEnvelopeV1,
  type AdminConnectionSummary,
  type AdminConnectionSummaryRepository,
  type IntegrationsStorageError,
  type IntegrationsStorageErrorCode,
  type Provider,
  type ProviderAccountRecord,
  type ProviderAccountRepository,
  type ProviderAccountWrite,
  type TfIntegrationsCommandContext,
} from "./repository.js";

export type IntegrationsPoolProfile = "runtime" | "migration";

const POOL_PROFILES: Readonly<Record<IntegrationsPoolProfile, PoolConfig>> = {
  runtime: {
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    query_timeout: 10_000,
    statement_timeout: 10_000,
    lock_timeout: 3_000,
    idle_in_transaction_session_timeout: 10_000,
    max: 10,
  },
  migration: {
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    query_timeout: 120_000,
    statement_timeout: 120_000,
    lock_timeout: 10_000,
    idle_in_transaction_session_timeout: 30_000,
    max: 2,
  },
};

export function createIntegrationsPool(
  connectionString: string,
  profile: IntegrationsPoolProfile = "runtime",
): Pool {
  return new Pool({ connectionString, ...POOL_PROFILES[profile] });
}

export async function probeIntegrationsDatabase(pool: Pool): Promise<boolean> {
  try {
    const result = await pool.query<{
      server_version_num: number;
      transaction_timeout: string | null;
    }>(`
      select current_setting('server_version_num')::integer
               as server_version_num,
             current_setting('transaction_timeout', true)
               as transaction_timeout
    `);
    const capability = result.rows[0];
    return (
      capability !== undefined &&
      capability.server_version_num >= 170_000 &&
      capability.transaction_timeout !== null
    );
  } catch {
    return false;
  }
}
