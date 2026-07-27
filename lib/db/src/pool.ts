import pg from "pg";

const { Pool } = pg;

export type TfPoolProfile = "runtime" | "migration";

export function createTfPool(
  connectionString: string,
  profile: TfPoolProfile = "runtime",
): pg.Pool {
  const migration = profile === "migration";

  return new Pool({
    connectionString,
    connectionTimeoutMillis: migration ? 10_000 : 5_000,
    idleTimeoutMillis: 30_000,
    max: migration ? 2 : 10,
    query_timeout: migration ? 120_000 : 10_000,
    statement_timeout: migration ? 120_000 : 10_000,
    lock_timeout: migration ? 10_000 : 3_000,
    idle_in_transaction_session_timeout: migration ? 30_000 : 10_000,
  });
}
