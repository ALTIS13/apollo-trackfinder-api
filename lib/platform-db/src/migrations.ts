import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, QueryResultRow } from "pg";

const MIGRATION_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;
const MIGRATION_LOCK = "apollo_platform_migrations";
const DEFAULT_MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../migrations", import.meta.url),
);

interface MigrationRow extends QueryResultRow {
  name: string;
  checksum: string;
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

export interface MigrationManifestEntry {
  readonly name: string;
  readonly checksum: string;
}

export const PLATFORM_MIGRATION_MANIFEST: readonly MigrationManifestEntry[] =
  Object.freeze([
    {
      name: "0001_platform_identity.sql",
      checksum:
        "bf4295282bc99ac2f1125a7c2dd47543103b7ab2de6a9b414ef3ee14587c538a",
    },
    {
      name: "0002_operator_bootstrap_guard.sql",
      checksum:
        "687faecc390f2369b09c414e5ee771a594af3ef05cc02a498a191a29df800217",
    },
    {
      name: "0003_runtime_migration_history_read.sql",
      checksum:
        "110ed2873a6c0965b30effe743ec016bad17bde58a22351736d959114c440cc9",
    },
    {
      name: "0004_authorization_code_binding.sql",
      checksum:
        "c76e504556b0b4fd491392d87e7af97e45ec2af64ae8cca05ab1b04ad8a5757d",
    },
    {
      name: "0005_authorization_code_digest_read.sql",
      checksum:
        "ac2c1405f96d5dc1f03141c1b54254bdc6eb7aca4bdbc257ce468a2f600a61ba",
    },
  ]);

function migrationContractError(
  code: "migration_manifest_mismatch" | "migration_history_mismatch",
  message: string,
): Error {
  return Object.assign(new Error(message), { code });
}

function migrationCleanupError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Migration cleanup failed");
}

async function loadManifestMigrations(
  directory: string,
  manifest: readonly MigrationManifestEntry[],
): Promise<readonly { readonly name: string; readonly sql: string }[]> {
  const filesystemNames = (await readdir(directory))
    .filter((name) => MIGRATION_NAME.test(name))
    .sort();
  const manifestNames = manifest.map(({ name }) => name);
  if (
    new Set(manifestNames).size !== manifestNames.length ||
    manifestNames.some((name) => !MIGRATION_NAME.test(name)) ||
    JSON.stringify(filesystemNames) !== JSON.stringify(manifestNames)
  ) {
    throw migrationContractError(
      "migration_manifest_mismatch",
      "Migration manifest does not match filesystem",
    );
  }

  return Promise.all(
    manifest.map(async ({ name, checksum: expectedChecksum }) => {
      const sql = await readFile(join(directory, name), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      if (checksum !== expectedChecksum) {
        throw migrationContractError(
          "migration_manifest_mismatch",
          `Migration manifest checksum does not match filesystem: ${name}`,
        );
      }
      return { name, sql };
    }),
  );
}

export async function runPlatformMigrations(
  pool: Pool,
  directory = DEFAULT_MIGRATION_DIRECTORY,
  manifest: readonly MigrationManifestEntry[] = PLATFORM_MIGRATION_MANIFEST,
): Promise<MigrationResult> {
  const migrations = await loadManifestMigrations(directory, manifest);
  const client = await pool.connect();
  let lockAcquired = false;
  let cleanupError: Error | undefined;
  let primaryError: unknown;
  let primaryErrorCaught = false;
  const result: MigrationResult = { applied: [], alreadyApplied: [] };

  try {
    try {
      await client.query("select pg_advisory_lock(hashtext($1))", [
        MIGRATION_LOCK,
      ]);
    } catch (lockError) {
      cleanupError ??= migrationCleanupError(lockError);
      throw lockError;
    }
    lockAcquired = true;

    await client.query("create schema if not exists apollo_platform");
    await client.query(`
      create table if not exists apollo_platform.schema_migrations (
        name text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )
    `);

    const persisted = await client.query<MigrationRow>(
      "select name, checksum from apollo_platform.schema_migrations",
    );
    const manifestNames = new Set(manifest.map(({ name }) => name));
    if (persisted.rows.some(({ name }) => !manifestNames.has(name))) {
      throw migrationContractError(
        "migration_history_mismatch",
        "Persisted migration history contains an unmanifested row",
      );
    }
    const checksums = new Map(
      persisted.rows.map(({ name, checksum }) => [name, checksum]),
    );
    for (const { name, sql } of migrations) {
      const checksum = createHash("sha256").update(sql).digest("hex");
      const persistedChecksum = checksums.get(name);

      if (persistedChecksum !== undefined) {
        if (persistedChecksum !== checksum) {
          throw Object.assign(
            new Error(
              `Migration checksum does not match persisted history: ${name}`,
            ),
            { code: "migration_checksum_mismatch" as const },
          );
        }

        result.alreadyApplied.push(name);
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "insert into apollo_platform.schema_migrations (name, checksum) values ($1, $2)",
          [name, checksum],
        );
        await client.query("COMMIT");
        result.applied.push(name);
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          cleanupError ??= migrationCleanupError(rollbackError);
        }
        throw error;
      }
    }
  } catch (error) {
    primaryErrorCaught = true;
    primaryError = error;
  } finally {
    try {
      if (lockAcquired) {
        try {
          await client.query("select pg_advisory_unlock(hashtext($1))", [
            MIGRATION_LOCK,
          ]);
        } catch (unlockError) {
          cleanupError ??= migrationCleanupError(unlockError);
        }
      }
    } finally {
      try {
        client.release(cleanupError);
      } catch (releaseError) {
        cleanupError ??= migrationCleanupError(releaseError);
      }
    }
  }

  if (primaryErrorCaught) throw primaryError;
  if (cleanupError !== undefined) throw cleanupError;
  return result;
}
