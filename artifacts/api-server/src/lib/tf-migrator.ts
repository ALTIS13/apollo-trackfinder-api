import { open } from "node:fs/promises";

import {
  baselineTfStartupSchema,
  runTfMigrations,
  type MigrationResult,
} from "@workspace/db/migrations";
import { createTfPool } from "@workspace/db/pool";

const BASELINE_ARGUMENT = "--baseline-existing-startup-schema";
const MAX_DATABASE_URL_BYTES = 4096;
const MIGRATION_DIRECTORY = "/app/migrations";
const GENERIC_FAILURE = "TF migration failed";

type Environment = Readonly<Record<string, string | undefined>>;

export interface TfMigratorOptions {
  readonly args: readonly string[];
  readonly env: Environment;
}

export interface TfMigratorDependencies {
  readonly readFile: (path: string, maxBytes: number) => Promise<string>;
  readonly createPool: typeof createTfPool;
  readonly runMigrations: typeof runTfMigrations;
  readonly baselineSchema: typeof baselineTfStartupSchema;
  readonly writeStdout: (message: string) => void;
}

interface SecretFileHandle {
  stat(): Promise<{ isFile(): boolean; size: number }>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

type OpenSecretFile = (path: string, flags: "r") => Promise<SecretFileHandle>;

export async function readMigratorSecretFile(
  path: string,
  maxBytes: number,
  openFile: OpenSecretFile = open,
): Promise<string> {
  try {
    const handle = await openFile(path, "r");
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) {
        throw new Error(GENERIC_FAILURE);
      }

      const buffer = Buffer.alloc(maxBytes + 1);
      let totalBytes = 0;
      while (totalBytes < buffer.length) {
        const remaining = buffer.length - totalBytes;
        const { bytesRead } = await handle.read(
          buffer,
          totalBytes,
          remaining,
          null,
        );
        if (bytesRead === 0) break;
        if (bytesRead < 0 || bytesRead > remaining) {
          throw new Error(GENERIC_FAILURE);
        }
        totalBytes += bytesRead;
      }

      if (totalBytes < 1 || totalBytes > maxBytes) {
        throw new Error(GENERIC_FAILURE);
      }
      return new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, totalBytes),
      );
    } finally {
      await handle.close();
    }
  } catch {
    throw new Error(GENERIC_FAILURE);
  }
}

const defaultDependencies: TfMigratorDependencies = {
  readFile: readMigratorSecretFile,
  createPool: createTfPool,
  runMigrations: runTfMigrations,
  baselineSchema: baselineTfStartupSchema,
  writeStdout: (message) => process.stdout.write(message),
};

function selectMode(options: TfMigratorOptions): {
  baseline: boolean;
  secretFile: string;
} {
  const baseline =
    options.args.length === 1 && options.args[0] === BASELINE_ARGUMENT;
  const normal = options.args.length === 0;
  if (!normal && !baseline) {
    throw new Error(GENERIC_FAILURE);
  }

  const migratorFile = options.env["TF_MIGRATOR_DATABASE_URL_FILE"];
  const baselineFile = options.env["TF_BASELINE_DATABASE_URL_FILE"];
  if (baseline) {
    if (
      migratorFile !== undefined ||
      baselineFile === undefined ||
      baselineFile.length === 0
    ) {
      throw new Error(GENERIC_FAILURE);
    }
    return { baseline: true, secretFile: baselineFile };
  }

  if (
    baselineFile !== undefined ||
    migratorFile === undefined ||
    migratorFile.length === 0
  ) {
    throw new Error(GENERIC_FAILURE);
  }
  return { baseline: false, secretFile: migratorFile };
}

function successEvent(result: MigrationResult): string {
  return `${JSON.stringify({
    event: "tf_migrations_complete",
    applied: result.applied.length,
    alreadyApplied: result.alreadyApplied.length,
  })}\n`;
}

export async function runTfMigrator(
  options: TfMigratorOptions,
  dependencies: TfMigratorDependencies = defaultDependencies,
): Promise<void> {
  try {
    const mode = selectMode(options);
    const loaded = await dependencies.readFile(
      mode.secretFile,
      MAX_DATABASE_URL_BYTES,
    );
    if (Buffer.byteLength(loaded, "utf8") > MAX_DATABASE_URL_BYTES) {
      throw new Error(GENERIC_FAILURE);
    }
    const databaseUrl = loaded.trim();
    if (databaseUrl.length === 0) {
      throw new Error(GENERIC_FAILURE);
    }

    const pool = dependencies.createPool(databaseUrl, "migration");
    let result: MigrationResult;
    try {
      result = mode.baseline
        ? await dependencies.baselineSchema(pool, MIGRATION_DIRECTORY)
        : await dependencies.runMigrations(pool, MIGRATION_DIRECTORY);
    } finally {
      await pool.end();
    }
    dependencies.writeStdout(successEvent(result));
  } catch {
    throw new Error(GENERIC_FAILURE);
  }
}
