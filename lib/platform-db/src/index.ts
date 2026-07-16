import { Pool, type PoolClient } from "pg";

export {
  PLATFORM_MIGRATION_MANIFEST,
  runPlatformMigrations,
  type MigrationManifestEntry,
  type MigrationResult,
} from "./migrations.js";

export function createPlatformPool(connectionString: string): Pool {
  return new Pool({ connectionString });
}

export async function withPlatformTransaction<T>(
  pool: Pool,
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
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
