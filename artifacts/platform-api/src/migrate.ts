import { readFile } from "node:fs/promises";

import {
  createPlatformPool,
  runPlatformMigrations,
} from "@workspace/platform-db";

async function requiredSecretFile(name: string): Promise<string> {
  const path = process.env[name]?.trim();
  if (path === undefined || path.length === 0) {
    throw new Error(`${name} must be configured`);
  }
  const value = (await readFile(path, "utf8")).trim();
  if (value.length === 0) throw new Error(`${name} must not be empty`);
  return value;
}

async function migrate(): Promise<void> {
  const connectionString = await requiredSecretFile(
    "MIGRATOR_DATABASE_URL_FILE",
  );
  const pool = createPlatformPool(connectionString, "migration");
  try {
    const result = await runPlatformMigrations(pool, "/app/migrations");
    process.stdout.write(
      `${JSON.stringify({
        event: "platform_migrations_complete",
        applied: result.applied.length,
        alreadyApplied: result.alreadyApplied.length,
      })}\n`,
    );
  } finally {
    await pool.end();
  }
}

void migrate().catch(() => {
  process.stderr.write("Platform migration failed\n");
  process.exitCode = 1;
});
