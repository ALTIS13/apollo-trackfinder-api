import { Pool, type PoolClient, type PoolConfig } from "pg";

export {
  PLATFORM_MIGRATION_MANIFEST,
  runPlatformMigrations,
  type MigrationManifestEntry,
  type MigrationResult,
} from "./migrations.js";

export type PlatformPoolProfile = "runtime" | "migration";

const POOL_PROFILES: Readonly<Record<PlatformPoolProfile, PoolConfig>> = {
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

export function createPlatformPool(
  connectionString: string,
  profile: PlatformPoolProfile = "runtime",
): Pool {
  return new Pool({ connectionString, ...POOL_PROFILES[profile] });
}

export async function withPlatformTransaction<T>(
  pool: Pool,
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let releaseError: Error | undefined;
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;
    const result = await callback(client);
    await client.query("COMMIT");
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        releaseError =
          rollbackError instanceof Error
            ? rollbackError
            : new Error("Transaction rollback failed");
      }
    } else if (error instanceof Error) {
      releaseError = error;
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}

export async function setAccountContext(
  client: PoolClient,
  accountId: string,
): Promise<void> {
  await client.query("select set_config('app.account_id', $1, true)", [
    accountId,
  ]);
}
