import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

const MIGRATION_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;
const SHA_256 = /^[0-9a-f]{64}$/;
const MIGRATION_LOCK = "apollo_tf_migrations";
const LOCK_RETRY_MS = 250;
const LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../migrations", import.meta.url),
);
const MANAGED_TABLES = [
  "track_search_cache",
  "play_history",
  "liked_tracks",
  "playlists",
  "playlist_tracks",
] as const;

export interface MigrationManifestEntry {
  readonly name: string;
  readonly checksum: string;
}

export interface MigrationResult {
  readonly applied: string[];
  readonly alreadyApplied: string[];
}

export interface MigrationRunnerOptions {
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

interface LoadedMigration extends MigrationManifestEntry {
  readonly sql: string;
}

interface MigrationRow extends QueryResultRow {
  readonly name: string;
  readonly checksum: string;
}

interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<T>>;
}

class OperationFailure {
  readonly primary: unknown;
  readonly cleanup: Error;

  constructor(primary: unknown, cleanup: Error) {
    this.primary = primary;
    this.cleanup = cleanup;
  }
}

type MigrationErrorCode =
  | "migration_manifest_mismatch"
  | "migration_history_mismatch"
  | "migration_lock_timeout"
  | "migration_baseline_mismatch";

export const TF_MIGRATION_MANIFEST: readonly MigrationManifestEntry[] =
  Object.freeze([
    {
      name: "0001_tf_core_collections.sql",
      checksum:
        "600de7ad9c9239b3f642c7a09f2195b386e0735aa6cd521d9dbc987b5485bcab",
    },
    {
      name: "0002_tf_runtime_privileges.sql",
      checksum:
        "a9bdbd8012fc237045aa7c57aeac4683a3baccfa66a1b7ec1956a2b1a4185c96",
    },
  ]);

function contractError(code: MigrationErrorCode, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function loadMigrations(
  directory: string,
  manifest: readonly MigrationManifestEntry[],
): Promise<readonly LoadedMigration[]> {
  const filesystemNames = (await readdir(directory))
    .filter((name) => MIGRATION_NAME.test(name))
    .sort();
  const manifestNames = manifest.map(({ name }) => name);

  if (
    manifest.length === 0 ||
    new Set(manifestNames).size !== manifestNames.length ||
    manifest.some(
      ({ name, checksum }) =>
        !MIGRATION_NAME.test(name) || !SHA_256.test(checksum),
    ) ||
    JSON.stringify(filesystemNames) !== JSON.stringify(manifestNames)
  ) {
    throw contractError(
      "migration_manifest_mismatch",
      "TF migration manifest does not match the migration filesystem",
    );
  }

  return Promise.all(
    manifest.map(async ({ name, checksum }) => {
      const sql = await readFile(join(directory, name), "utf8");
      const actual = createHash("sha256").update(sql).digest("hex");
      if (actual !== checksum) {
        throw contractError(
          "migration_manifest_mismatch",
          `TF migration checksum does not match the filesystem: ${name}`,
        );
      }
      return { name, checksum, sql };
    }),
  );
}

function requireHistoryPrefix(
  rows: readonly MigrationRow[],
  manifest: readonly MigrationManifestEntry[],
): void {
  if (rows.length > manifest.length) {
    throw contractError(
      "migration_history_mismatch",
      "TF migration history is not an exact manifest prefix",
    );
  }
  for (const [index, row] of rows.entries()) {
    const expected = manifest[index];
    if (
      expected === undefined ||
      row.name !== expected.name ||
      row.checksum !== expected.checksum
    ) {
      throw contractError(
        "migration_history_mismatch",
        "TF migration history is not an exact manifest prefix",
      );
    }
  }
}

async function acquireLock(
  client: PoolClient,
  options: MigrationRunnerOptions,
): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = now() + LOCK_TIMEOUT_MS;

  while (true) {
    const lock = await client.query<{ acquired: boolean }>(
      "select pg_try_advisory_lock(hashtext($1)) as acquired",
      [MIGRATION_LOCK],
    );
    if (lock.rows[0]?.acquired === true) return;
    if (now() >= deadline) {
      throw contractError(
        "migration_lock_timeout",
        "Timed out waiting for the TF migration advisory lock",
      );
    }
    await sleep(LOCK_RETRY_MS);
  }
}

async function rollbackAfterFailure(
  client: PoolClient,
  primary: unknown,
): Promise<{ primary: unknown; cleanup?: Error }> {
  try {
    await client.query("ROLLBACK");
    return { primary };
  } catch (error) {
    return {
      primary,
      cleanup: asError(error, "TF migration rollback failed"),
    };
  }
}

async function inTransaction(
  client: PoolClient,
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await client.query("BEGIN");
  } catch (error) {
    throw new OperationFailure(
      error,
      asError(error, "TF migration transaction state is uncertain"),
    );
  }
  try {
    await operation();
    await client.query("COMMIT");
  } catch (error) {
    const failure = await rollbackAfterFailure(client, error);
    if (failure.cleanup) {
      throw new OperationFailure(failure.primary, failure.cleanup);
    }
    throw error;
  }
}

async function initializeHistory(client: PoolClient): Promise<void> {
  await inTransaction(client, async () => {
    await client.query("create schema if not exists apollo_tf");
    await client.query(`
      create table if not exists apollo_tf.schema_migrations (
        name text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )
    `);
  });
}

async function loadHistory(client: Queryable): Promise<MigrationRow[]> {
  const persisted = await client.query<MigrationRow>(
    "select name, checksum from apollo_tf.schema_migrations order by name",
  );
  return persisted.rows;
}

async function rejectUnmanagedManagedTables(
  client: PoolClient,
  history: readonly MigrationRow[],
): Promise<void> {
  if (history.length !== 0) return;
  const existing = await client.query<{ table_name: string }>(
    `/* tf_managed_tables */
     select table_name
     from unnest($1::text[]) as managed(table_name)
     where to_regclass(format('public.%I', table_name)) is not null
     order by table_name`,
    [MANAGED_TABLES],
  );
  if (existing.rows.length > 0) {
    throw contractError(
      "migration_history_mismatch",
      "Managed TF tables exist without migration history",
    );
  }
}

async function applyMigration(
  client: PoolClient,
  migration: LoadedMigration,
): Promise<void> {
  await inTransaction(client, async () => {
    await client.query(migration.sql);
    await client.query(
      "insert into apollo_tf.schema_migrations (name, checksum) values ($1, $2)",
      [migration.name, migration.checksum],
    );
  });
}

async function executeWithLock(
  pool: Pool,
  options: MigrationRunnerOptions,
  operation: (client: PoolClient) => Promise<MigrationResult>,
): Promise<MigrationResult> {
  const client = await pool.connect();
  let lockAcquired = false;
  let cleanupError: Error | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  let result: MigrationResult | undefined;

  try {
    try {
      await acquireLock(client, options);
      lockAcquired = true;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        (error as Error & { code?: string }).code !== "migration_lock_timeout"
      ) {
        cleanupError = asError(error, "TF migration lock state is uncertain");
      }
      throw error;
    }
    result = await operation(client);
  } catch (error) {
    hasPrimaryError = true;
    if (error instanceof OperationFailure) {
      primaryError = error.primary;
      cleanupError ??= error.cleanup;
    } else {
      primaryError = error;
    }
  } finally {
    if (lockAcquired) {
      try {
        const unlocked = await client.query<{ unlocked: boolean }>(
          "select pg_advisory_unlock(hashtext($1)) as unlocked",
          [MIGRATION_LOCK],
        );
        if (unlocked.rows[0]?.unlocked !== true) {
          cleanupError ??= new Error("TF migration advisory lock was not held");
        }
      } catch (error) {
        cleanupError ??= asError(error, "TF migration unlock failed");
      }
    }
    try {
      client.release(cleanupError);
    } catch (error) {
      cleanupError ??= asError(error, "TF migration client release failed");
    }
  }

  if (hasPrimaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  if (!result)
    throw new Error("TF migration operation did not return a result");
  return result;
}

async function applyRemainingMigrations(
  client: PoolClient,
  migrations: readonly LoadedMigration[],
  persisted: readonly MigrationRow[],
): Promise<MigrationResult> {
  const result: MigrationResult = {
    applied: [],
    alreadyApplied: persisted.map(({ name }) => name),
  };

  for (const migration of migrations.slice(persisted.length)) {
    await applyMigration(client, migration);
    result.applied.push(migration.name);
  }
  return result;
}

export async function runTfMigrations(
  pool: Pool,
  directory = DEFAULT_MIGRATION_DIRECTORY,
  manifest: readonly MigrationManifestEntry[] = TF_MIGRATION_MANIFEST,
  options: MigrationRunnerOptions = {},
): Promise<MigrationResult> {
  const migrations = await loadMigrations(directory, manifest);

  return executeWithLock(pool, options, async (client) => {
    await initializeHistory(client);
    const persisted = await loadHistory(client);
    requireHistoryPrefix(persisted, manifest);
    await rejectUnmanagedManagedTables(client, persisted);
    return applyRemainingMigrations(client, migrations, persisted);
  });
}

type CatalogValue = string | number | boolean | null | readonly string[];

const EXPECTED_COLUMNS: readonly (readonly CatalogValue[])[] = [
  [
    "track_search_cache",
    "id",
    1,
    "integer",
    false,
    "nextval('public.track_search_cache_id_seq'::regclass)",
  ],
  ["track_search_cache", "cache_key", 2, "text", false, null],
  ["track_search_cache", "results", 3, "jsonb", false, null],
  [
    "track_search_cache",
    "expires_at",
    4,
    "timestamp with time zone",
    false,
    null,
  ],
  [
    "track_search_cache",
    "created_at",
    5,
    "timestamp with time zone",
    false,
    "now()",
  ],
  [
    "play_history",
    "id",
    1,
    "integer",
    false,
    "nextval('public.play_history_id_seq'::regclass)",
  ],
  ["play_history", "session_id", 2, "text", false, null],
  ["play_history", "track_id", 3, "text", false, null],
  ["play_history", "artist", 4, "text", true, null],
  ["play_history", "title", 5, "text", true, null],
  ["play_history", "played_at", 6, "timestamp with time zone", false, "now()"],
  [
    "liked_tracks",
    "id",
    1,
    "integer",
    false,
    "nextval('public.liked_tracks_id_seq'::regclass)",
  ],
  ["liked_tracks", "session_id", 2, "text", false, null],
  ["liked_tracks", "track_id", 3, "text", false, null],
  ["liked_tracks", "artist", 4, "text", true, null],
  ["liked_tracks", "title", 5, "text", true, null],
  ["liked_tracks", "thumbnail_url", 6, "text", true, null],
  ["liked_tracks", "duration", 7, "text", true, null],
  ["liked_tracks", "liked_at", 8, "timestamp with time zone", false, "now()"],
  [
    "playlists",
    "id",
    1,
    "integer",
    false,
    "nextval('public.playlists_id_seq'::regclass)",
  ],
  ["playlists", "session_id", 2, "text", false, null],
  ["playlists", "name", 3, "text", false, null],
  ["playlists", "description", 4, "text", true, null],
  ["playlists", "created_at", 5, "timestamp with time zone", false, "now()"],
  ["playlists", "updated_at", 6, "timestamp with time zone", false, "now()"],
  [
    "playlist_tracks",
    "id",
    1,
    "integer",
    false,
    "nextval('public.playlist_tracks_id_seq'::regclass)",
  ],
  ["playlist_tracks", "playlist_id", 2, "integer", false, null],
  ["playlist_tracks", "track_id", 3, "text", false, null],
  ["playlist_tracks", "artist", 4, "text", true, null],
  ["playlist_tracks", "title", 5, "text", true, null],
  ["playlist_tracks", "thumbnail_url", 6, "text", true, null],
  ["playlist_tracks", "duration", 7, "text", true, null],
  ["playlist_tracks", "position", 8, "integer", false, "0"],
  [
    "playlist_tracks",
    "added_at",
    9,
    "timestamp with time zone",
    false,
    "now()",
  ],
];

const EXPECTED_CONSTRAINTS: readonly (readonly CatalogValue[])[] = [
  ["liked_tracks", "liked_tracks_pkey", "p", "primary key (id)"],
  [
    "liked_tracks",
    "liked_tracks_session_id_track_id_key",
    "u",
    "unique (session_id, track_id)",
  ],
  ["play_history", "play_history_pkey", "p", "primary key (id)"],
  ["playlist_tracks", "playlist_tracks_pkey", "p", "primary key (id)"],
  ["playlists", "playlists_pkey", "p", "primary key (id)"],
  [
    "track_search_cache",
    "track_search_cache_cache_key_key",
    "u",
    "unique (cache_key)",
  ],
  ["track_search_cache", "track_search_cache_pkey", "p", "primary key (id)"],
];

const EXPECTED_INDEXES: readonly (readonly CatalogValue[])[] = [
  [
    "liked_tracks",
    "liked_tracks_session_idx",
    "create index liked_tracks_session_idx on public.liked_tracks using btree (session_id)",
  ],
  [
    "play_history",
    "play_history_played_at_idx",
    "create index play_history_played_at_idx on public.play_history using btree (played_at)",
  ],
  [
    "play_history",
    "play_history_session_idx",
    "create index play_history_session_idx on public.play_history using btree (session_id)",
  ],
  [
    "playlist_tracks",
    "playlist_tracks_playlist_idx",
    "create index playlist_tracks_playlist_idx on public.playlist_tracks using btree (playlist_id)",
  ],
  [
    "playlists",
    "playlists_session_idx",
    "create index playlists_session_idx on public.playlists using btree (session_id)",
  ],
];

function normalizeDefault(value: string | null): string | null {
  if (value === null) return null;
  return value
    .replace(
      /nextval\('(?!(?:public)\.)([^']+)'::regclass\)/i,
      "nextval('public.$1'::regclass)",
    )
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeCatalogDefinition(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

async function loadLegacyCatalog(client: PoolClient): Promise<{
  readonly columns: readonly (readonly CatalogValue[])[];
  readonly constraints: readonly (readonly CatalogValue[])[];
  readonly indexes: readonly (readonly CatalogValue[])[];
  readonly ownership: readonly (readonly CatalogValue[])[];
}> {
  const tableNames = [...MANAGED_TABLES];
  const columns = await client.query<{
    table_name: string;
    column_name: string;
    ordinal_position: number;
    data_type: string;
    is_nullable: boolean | "YES" | "NO";
    column_default: string | null;
  }>(
    `/* tf_catalog_columns */
     select c.relname::text as table_name,
            a.attname::text as column_name,
            a.attnum as ordinal_position,
            format_type(a.atttypid, a.atttypmod) as data_type,
            not a.attnotnull as is_nullable,
            pg_get_expr(d.adbin, d.adrelid) as column_default
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     join pg_attribute a on a.attrelid = c.oid
     left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
     where n.nspname = 'public'
       and c.relname = any($1::text[])
       and c.relkind in ('r', 'p')
       and a.attnum > 0
       and not a.attisdropped
     order by array_position($1::text[], c.relname), a.attnum`,
    [tableNames],
  );
  const constraints = await client.query<{
    table_name: string;
    constraint_name: string;
    constraint_type: string;
    definition: string;
  }>(
    `/* tf_catalog_constraints */
     select c.relname::text as table_name,
            con.conname::text as constraint_name,
            con.contype::text as constraint_type,
            pg_get_constraintdef(con.oid, true)::text as definition
     from pg_constraint con
     join pg_class c on c.oid = con.conrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname = any($1::text[])
     order by c.relname, con.conname`,
    [tableNames],
  );
  const indexes = await client.query<{
    table_name: string;
    index_name: string;
    definition: string;
  }>(
    `/* tf_catalog_indexes */
     select t.relname::text as table_name,
            i.relname::text as index_name,
            pg_get_indexdef(i.oid)::text as definition
     from pg_index x
     join pg_class t on t.oid = x.indrelid
     join pg_namespace n on n.oid = t.relnamespace
     join pg_class i on i.oid = x.indexrelid
     left join pg_constraint con on con.conindid = i.oid
     where n.nspname = 'public'
       and t.relname = any($1::text[])
       and con.oid is null
     order by t.relname, i.relname`,
    [tableNames],
  );
  const ownership = await client.query<{
    table_name: string;
    owner: string;
  }>(
    `/* tf_catalog_ownership */
     select c.relname::text as table_name, r.rolname::text as owner
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     join pg_roles r on r.oid = c.relowner
     where n.nspname = 'public'
       and c.relname = any($1::text[])
       and c.relkind in ('r', 'p')
     order by c.relname`,
    [tableNames],
  );

  return {
    columns: columns.rows.map((row) => [
      row.table_name,
      row.column_name,
      Number(row.ordinal_position),
      row.data_type,
      row.is_nullable === true || row.is_nullable === "YES",
      normalizeDefault(row.column_default),
    ]),
    constraints: constraints.rows.map((row) => [
      row.table_name,
      row.constraint_name,
      row.constraint_type,
      normalizeCatalogDefinition(row.definition),
    ]),
    indexes: indexes.rows.map((row) => [
      row.table_name,
      row.index_name,
      normalizeCatalogDefinition(row.definition),
    ]),
    ownership: ownership.rows.map((row) => [row.table_name, row.owner]),
  };
}

function sameCatalog(
  actual: readonly (readonly CatalogValue[])[],
  expected: readonly (readonly CatalogValue[])[],
): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

async function requireBaselineSuperuser(client: PoolClient): Promise<void> {
  const role = await client.query<{
    current_role: string;
    is_superuser: boolean;
  }>(
    `/* current_database_role */
     select current_user as current_role,
            r.rolsuper as is_superuser
     from pg_roles r
     where r.rolname = current_user`,
  );
  const current = role.rows[0];
  if (!current || current.is_superuser !== true) {
    throw contractError(
      "migration_baseline_mismatch",
      "TF baseline requires the current PostgreSQL superuser",
    );
  }
}

async function validateBaselineCatalog(client: PoolClient): Promise<void> {
  const history = await client.query<{ exists: boolean }>(
    `/* tf_history_exists */
     select to_regclass('apollo_tf.schema_migrations') is not null as exists`,
  );
  if (history.rows[0]?.exists === true) {
    const rows = await loadHistory(client);
    if (rows.length !== 0) {
      throw contractError(
        "migration_baseline_mismatch",
        "TF baseline requires absent or empty migration history",
      );
    }
  }

  const catalog = await loadLegacyCatalog(client);
  if (
    !sameCatalog(catalog.columns, EXPECTED_COLUMNS) ||
    !sameCatalog(catalog.constraints, EXPECTED_CONSTRAINTS) ||
    !sameCatalog(catalog.indexes, EXPECTED_INDEXES) ||
    catalog.ownership.length !== MANAGED_TABLES.length
  ) {
    throw contractError(
      "migration_baseline_mismatch",
      "Legacy TF catalog does not exactly match migration 0001",
    );
  }
}

async function recordBaseline(
  client: PoolClient,
  first: LoadedMigration,
): Promise<void> {
  await inTransaction(client, async () => {
    try {
      await client.query(
        `lock table ${MANAGED_TABLES.map((table) => `public.${table}`).join(
          ", ",
        )} in access exclusive mode`,
      );
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "42P01"
      ) {
        throw contractError(
          "migration_baseline_mismatch",
          "Legacy TF catalog is missing a managed table",
        );
      }
      throw error;
    }
    await validateBaselineCatalog(client);
    await client.query("create schema if not exists apollo_tf");
    await client.query(`
      create table if not exists apollo_tf.schema_migrations (
        name text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )
    `);
    for (const table of MANAGED_TABLES) {
      await client.query(
        `alter table public.${table} owner to apollo_tf_migrator`,
      );
      await client.query(
        `alter sequence public.${table}_id_seq owner to apollo_tf_migrator`,
      );
    }
    await client.query("alter schema apollo_tf owner to apollo_tf_migrator");
    await client.query(
      "alter table apollo_tf.schema_migrations owner to apollo_tf_migrator",
    );
    await client.query(
      "insert into apollo_tf.schema_migrations (name, checksum) values ($1, $2)",
      [first.name, first.checksum],
    );
  });
}

export async function baselineTfStartupSchema(
  pool: Pool,
  directory = DEFAULT_MIGRATION_DIRECTORY,
  manifest: readonly MigrationManifestEntry[] = TF_MIGRATION_MANIFEST,
  options: MigrationRunnerOptions = {},
): Promise<MigrationResult> {
  if (
    manifest.length !== TF_MIGRATION_MANIFEST.length ||
    manifest.some(
      (entry, index) =>
        entry.name !== TF_MIGRATION_MANIFEST[index]?.name ||
        entry.checksum !== TF_MIGRATION_MANIFEST[index]?.checksum,
    )
  ) {
    throw contractError(
      "migration_baseline_mismatch",
      "TF baseline accepts only the canonical TF migration manifest",
    );
  }
  const migrations = await loadMigrations(directory, manifest);

  return executeWithLock(pool, options, async (client) => {
    await requireBaselineSuperuser(client);
    await recordBaseline(client, migrations[0]!);
    await applyMigration(client, migrations[1]!);
    return {
      applied: migrations.map(({ name }) => name),
      alreadyApplied: [],
    };
  });
}

export function createTfMigrationReadinessProbe(
  queryable: Queryable,
  manifest: readonly MigrationManifestEntry[] = TF_MIGRATION_MANIFEST,
): () => Promise<boolean> {
  return async () => {
    try {
      const rows = await loadHistory(queryable);
      requireHistoryPrefix(rows, manifest);
      return rows.length === manifest.length;
    } catch {
      return false;
    }
  };
}
