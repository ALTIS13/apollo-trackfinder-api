import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Pool, QueryResultRow } from "pg";

const MIGRATION_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;
const MIGRATION_LOCK = "apollo_tf_integrations_migrations";
const DEFAULT_MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../migrations", import.meta.url),
);

interface MigrationRow extends QueryResultRow {
  name: string;
  checksum: string;
}

export interface MigrationResult {
  readonly applied: string[];
  readonly alreadyApplied: string[];
}

export interface MigrationManifestEntry {
  readonly name: string;
  readonly checksum: string;
}

export const INTEGRATIONS_MIGRATION_MANIFEST: readonly MigrationManifestEntry[] =
  Object.freeze([
    {
      name: "0001_integrations.sql",
      checksum:
        "6b21e525b90612e6aef5bf29263294824b3084343cb17f5b2910651951a4af1a",
    },
    {
      name: "0002_canonical_token_envelope.sql",
      checksum:
        "0547c703054892db8b23119c730581ab89477ff3922216784f469cedd6444f88",
    },
    {
      name: "0003_yandex_provider_login.sql",
      checksum:
        "b432377566f927ebf1117cb092aa84748a854da96f169ec41ec56b69391acab0",
    },
    {
      name: "0004_runtime_privileges.sql",
      checksum:
        "5cb5900b1ab737b6a0695eff13b4211e9d04d6c00eb1126d3941a60d47ffb070",
    },
    {
      name: "0005_provider_account_generation.sql",
      checksum:
        "6b40b55e21d0222d383127b48e5a3f14e1a856a1f8dd7c2174e38d74b0825f27",
    },
  ]);

function migrationContractError(
  code: "migration_manifest_mismatch" | "migration_history_mismatch",
  message: string,
): Error {
  return Object.assign(new Error(message), { code });
}

function cleanupError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("Integrations migration cleanup failed");
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
      "Integrations migration manifest does not match filesystem",
    );
  }

  return Promise.all(
    manifest.map(async ({ name, checksum: expectedChecksum }) => {
      const sql = await readFile(join(directory, name), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      if (checksum !== expectedChecksum) {
        throw migrationContractError(
          "migration_manifest_mismatch",
          `Integrations migration manifest checksum does not match filesystem: ${name}`,
        );
      }
      return { name, sql };
    }),
  );
}

export async function runIntegrationsMigrations(
  pool: Pool,
  directory = DEFAULT_MIGRATION_DIRECTORY,
  manifest: readonly MigrationManifestEntry[] = INTEGRATIONS_MIGRATION_MANIFEST,
): Promise<MigrationResult> {
  const migrations = await loadManifestMigrations(directory, manifest);
  const client = await pool.connect();
  let lockAcquired = false;
  let deferredCleanupError: Error | undefined;
  let primaryError: unknown;
  let primaryErrorCaught = false;
  const result: MigrationResult = { applied: [], alreadyApplied: [] };

  try {
    try {
      await client.query("select pg_advisory_lock(hashtext($1))", [
        MIGRATION_LOCK,
      ]);
    } catch (error) {
      deferredCleanupError ??= cleanupError(error);
      throw error;
    }
    lockAcquired = true;

    await client.query("create schema if not exists apollo_tf_integrations");
    await client.query(`
      create table if not exists apollo_tf_integrations.schema_migrations (
        name text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )
    `);

    const persisted = await client.query<MigrationRow>(
      "select name, checksum from apollo_tf_integrations.schema_migrations",
    );
    const manifestNames = new Set(manifest.map(({ name }) => name));
    if (persisted.rows.some(({ name }) => !manifestNames.has(name))) {
      throw migrationContractError(
        "migration_history_mismatch",
        "Persisted integrations migration history contains an unmanifested row",
      );
    }

    const persistedChecksums = new Map(
      persisted.rows.map(({ name, checksum }) => [name, checksum]),
    );
    for (const { name, sql } of migrations) {
      const checksum = createHash("sha256").update(sql).digest("hex");
      const persistedChecksum = persistedChecksums.get(name);
      if (persistedChecksum !== undefined) {
        if (persistedChecksum !== checksum) {
          throw Object.assign(
            new Error(
              `Integrations migration checksum does not match persisted history: ${name}`,
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
          "insert into apollo_tf_integrations.schema_migrations (name, checksum) values ($1, $2)",
          [name, checksum],
        );
        await client.query("COMMIT");
        result.applied.push(name);
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          deferredCleanupError ??= cleanupError(rollbackError);
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
          deferredCleanupError ??= cleanupError(unlockError);
        }
      }
    } finally {
      try {
        client.release(deferredCleanupError);
      } catch (releaseError) {
        deferredCleanupError ??= cleanupError(releaseError);
      }
    }
  }

  if (primaryErrorCaught) throw primaryError;
  if (deferredCleanupError !== undefined) throw deferredCleanupError;
  return result;
}
