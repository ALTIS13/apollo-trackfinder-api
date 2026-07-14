import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Client, Pool } = pg;

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: databaseUrl });
export const db = drizzle(pool, { schema });

interface DatabaseHealthProbeOptions {
  timeoutMs?: number;
}

export async function probeDatabaseHealth(
  options: DatabaseHealthProbeOptions = {},
): Promise<boolean> {
  const timeoutMs = Math.min(10_000, Math.max(100, options.timeoutMs ?? 1_000));
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
    statement_timeout: timeoutMs,
    application_name: "apollo-admin-health",
  });
  let connected = false;

  try {
    await client.connect();
    connected = true;
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    if (connected) await client.end().catch(() => undefined);
  }
}

export * from "./schema";
