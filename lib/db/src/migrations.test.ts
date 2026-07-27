import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Pool, QueryResult } from "pg";
import { afterEach, describe, expect, test } from "vitest";

import {
  baselineTfStartupSchema,
  createTfMigrationReadinessProbe,
  runTfMigrations,
  TF_MIGRATION_MANIFEST,
} from "./migrations.js";
import type {
  MigrationManifestEntry,
  MigrationRunnerOptions,
} from "./migrations.js";
import { createTfPool } from "./pool.js";

type RecordedQuery = {
  text: string;
  queryTimeout?: number;
  values?: readonly unknown[];
};

type QueryInput =
  | string
  | {
      readonly query_timeout?: number;
      readonly text: string;
      readonly values?: readonly unknown[];
    };

type CatalogFixture = {
  columns: unknown[];
  constraints: unknown[];
  indexes: unknown[];
  ownership: unknown[];
};

const canonicalMigrationDirectory = fileURLToPath(
  new URL("../migrations", import.meta.url),
);

const exactCatalog: CatalogFixture = {
  columns: [
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
    [
      "play_history",
      "played_at",
      6,
      "timestamp with time zone",
      false,
      "now()",
    ],
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
  ],
  constraints: [
    ["liked_tracks", "liked_tracks_pkey", "p", ["id"], "PRIMARY KEY (id)"],
    [
      "liked_tracks",
      "liked_tracks_session_id_track_id_key",
      "u",
      ["session_id", "track_id"],
      "UNIQUE (session_id, track_id)",
    ],
    ["play_history", "play_history_pkey", "p", ["id"], "PRIMARY KEY (id)"],
    [
      "playlist_tracks",
      "playlist_tracks_pkey",
      "p",
      ["id"],
      "PRIMARY KEY (id)",
    ],
    ["playlists", "playlists_pkey", "p", ["id"], "PRIMARY KEY (id)"],
    [
      "track_search_cache",
      "track_search_cache_cache_key_key",
      "u",
      ["cache_key"],
      "UNIQUE (cache_key)",
    ],
    [
      "track_search_cache",
      "track_search_cache_pkey",
      "p",
      ["id"],
      "PRIMARY KEY (id)",
    ],
  ],
  indexes: [
    [
      "liked_tracks",
      "liked_tracks_session_idx",
      false,
      "btree",
      ["session_id"],
      "CREATE INDEX liked_tracks_session_idx ON public.liked_tracks USING btree (session_id)",
    ],
    [
      "play_history",
      "play_history_played_at_idx",
      false,
      "btree",
      ["played_at"],
      "CREATE INDEX play_history_played_at_idx ON public.play_history USING btree (played_at)",
    ],
    [
      "play_history",
      "play_history_session_idx",
      false,
      "btree",
      ["session_id"],
      "CREATE INDEX play_history_session_idx ON public.play_history USING btree (session_id)",
    ],
    [
      "playlist_tracks",
      "playlist_tracks_playlist_idx",
      false,
      "btree",
      ["playlist_id"],
      "CREATE INDEX playlist_tracks_playlist_idx ON public.playlist_tracks USING btree (playlist_id)",
    ],
    [
      "playlists",
      "playlists_session_idx",
      false,
      "btree",
      ["session_id"],
      "CREATE INDEX playlists_session_idx ON public.playlists USING btree (session_id)",
    ],
  ],
  ownership: [
    ["liked_tracks", "legacy_owner"],
    ["play_history", "legacy_owner"],
    ["playlist_tracks", "legacy_owner"],
    ["playlists", "legacy_owner"],
    ["track_search_cache", "legacy_owner"],
  ],
};

class MigrationClientDouble {
  readonly events: string[] = [];
  readonly history = new Map<string, string>();
  readonly queries: RecordedQuery[] = [];
  readonly failures = new Map<string, Error>();
  lockAnswers: (boolean | Error)[] = [true];
  lockProbe?: (
    query: RecordedQuery,
  ) => boolean | Error | Promise<boolean | Error>;
  catalog: CatalogFixture = structuredClone(exactCatalog);
  historyTableExists = false;
  managedTables: string[] = [];
  tableLockFailure?: Error;
  databaseRole = {
    current_role: "legacy_owner",
    is_superuser: true,
    is_database_owner: true,
  };
  releaseError?: Error;
  readonly releaseArguments: (Error | boolean | undefined)[] = [];

  async query(
    input: QueryInput,
    values?: readonly unknown[],
  ): Promise<QueryResult> {
    const text = typeof input === "string" ? input : input.text;
    const queryValues = typeof input === "string" ? values : input.values;
    const query: RecordedQuery = {
      text,
      ...(typeof input === "string" || input.query_timeout === undefined
        ? {}
        : { queryTimeout: input.query_timeout }),
      ...(queryValues === undefined ? {} : { values: queryValues }),
    };
    this.events.push(text);
    this.queries.push(query);
    const exactFailure = this.failures.get(text);
    if (exactFailure) throw exactFailure;

    if (text.includes("pg_try_advisory_lock")) {
      const answer =
        (await this.lockProbe?.(query)) ?? this.lockAnswers.shift() ?? false;
      if (answer instanceof Error) throw answer;
      return result([{ acquired: answer }]);
    }
    if (text.includes("pg_advisory_unlock"))
      return result([{ unlocked: true }]);
    if (
      this.tableLockFailure &&
      /lock table[\s\S]*access exclusive mode/i.test(text)
    ) {
      throw this.tableLockFailure;
    }
    if (text.includes("select name, checksum")) {
      return result(
        [...this.history].map(([name, checksum]) => ({ name, checksum })),
      );
    }
    if (text.includes("insert into apollo_tf.schema_migrations")) {
      const [name, checksum] = queryValues ?? [];
      this.history.set(String(name), String(checksum));
      this.historyTableExists = true;
    }
    if (text.includes("tf_catalog_columns")) {
      return result(
        this.catalog.columns.map(
          ([
            table_name,
            column_name,
            ordinal_position,
            data_type,
            is_nullable,
            column_default,
          ]) => ({
            table_name,
            column_name,
            ordinal_position,
            data_type,
            is_nullable,
            column_default,
          }),
        ),
      );
    }
    if (text.includes("tf_catalog_constraints")) {
      const constraints = text.includes("con.contype in ('p', 'u')")
        ? this.catalog.constraints.filter(
            (constraint) => constraint[2] === "p" || constraint[2] === "u",
          )
        : this.catalog.constraints;
      return result(
        constraints.map(
          ([
            table_name,
            constraint_name,
            constraint_type,
            columns,
            definition,
          ]) => ({
            table_name,
            constraint_name,
            constraint_type,
            columns,
            definition,
          }),
        ),
      );
    }
    if (text.includes("tf_catalog_indexes")) {
      return result(
        this.catalog.indexes.map(
          ([
            table_name,
            index_name,
            is_unique,
            method,
            expressions,
            definition,
          ]) => ({
            table_name,
            index_name,
            is_unique,
            method,
            expressions,
            definition,
          }),
        ),
      );
    }
    if (text.includes("tf_catalog_ownership")) {
      return result(
        this.catalog.ownership.map(([table_name, owner]) => ({
          table_name,
          owner,
        })),
      );
    }
    if (text.includes("current_database_role")) {
      return result([this.databaseRole]);
    }
    if (text.includes("tf_history_exists")) {
      return result([{ exists: this.historyTableExists }]);
    }
    if (text.includes("tf_managed_tables")) {
      return result(this.managedTables.map((table_name) => ({ table_name })));
    }
    return result([]);
  }

  release(error?: Error | boolean): void {
    this.events.push("release");
    this.releaseArguments.push(error);
    if (this.releaseError) throw this.releaseError;
  }
}

class MigrationPoolDouble {
  readonly client = new MigrationClientDouble();
  async connect(): Promise<MigrationClientDouble> {
    return this.client;
  }
}

function result(rows: unknown[]): QueryResult {
  return { rows, rowCount: rows.length } as QueryResult;
}

function asPool(pool: MigrationPoolDouble): Pool {
  return pool as unknown as Pool;
}

const temporaryDirectories: string[] = [];

async function fixtureDirectory(
  files: Record<string, string>,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "apollo-tf-migrations-"));
  temporaryDirectories.push(directory);
  await Promise.all(
    Object.entries(files).map(([name, sql]) =>
      writeFile(join(directory, name), sql, "utf8"),
    ),
  );
  return directory;
}

async function fixtureManifest(
  directory: string,
  names: readonly string[],
): Promise<readonly MigrationManifestEntry[]> {
  return Promise.all(
    names.map(async (name) => ({
      name,
      checksum: createHash("sha256")
        .update(await readFile(join(directory, name)))
        .digest("hex"),
    })),
  );
}

function zeroDelayOptions(): MigrationRunnerOptions {
  let clock = 0;
  return {
    now: () => clock,
    sleep: async (milliseconds) => {
      clock += milliseconds;
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("TF migration pool profiles", () => {
  test("uses exact bounded runtime and migration settings", async () => {
    const runtime = createTfPool("postgres://runtime:secret@db/tf", "runtime");
    const migration = createTfPool(
      "postgres://migrator:secret@db/tf",
      "migration",
    );

    expect(runtime.options).toMatchObject({
      connectionTimeoutMillis: 5_000,
      query_timeout: 10_000,
      statement_timeout: 10_000,
      lock_timeout: 3_000,
      idle_in_transaction_session_timeout: 10_000,
      idleTimeoutMillis: 30_000,
      max: 10,
    });
    expect(migration.options).toMatchObject({
      connectionTimeoutMillis: 10_000,
      query_timeout: 120_000,
      statement_timeout: 120_000,
      lock_timeout: 10_000,
      idle_in_transaction_session_timeout: 30_000,
      idleTimeoutMillis: 30_000,
      max: 2,
    });
    await Promise.all([runtime.end(), migration.end()]);
  });
});

describe("runTfMigrations", () => {
  test("rejects filesystem or checksum drift before connecting", async () => {
    const directory = await fixtureDirectory({
      "0001_first.sql": "select 1;",
      "0002_extra.sql": "select 2;",
    });
    const manifest = await fixtureManifest(directory, ["0001_first.sql"]);
    const pool = new MigrationPoolDouble();

    await expect(
      runTfMigrations(asPool(pool), directory, manifest),
    ).rejects.toMatchObject({ code: "migration_manifest_mismatch" });
    expect(pool.client.queries).toEqual([]);
  });

  test("polls the advisory lock every 250ms and times out at 10s", async () => {
    const directory = await fixtureDirectory({ "0001_first.sql": "select 1;" });
    const manifest = await fixtureManifest(directory, ["0001_first.sql"]);
    const pool = new MigrationPoolDouble();
    pool.client.lockAnswers = Array.from({ length: 41 }, () => false);
    const sleeps: number[] = [];
    let clock = 0;

    await expect(
      runTfMigrations(asPool(pool), directory, manifest, {
        now: () => clock,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
          clock += milliseconds;
        },
      }),
    ).rejects.toMatchObject({ code: "migration_lock_timeout" });
    expect(sleeps).toEqual(Array.from({ length: 40 }, () => 250));
    expect(
      pool.client.queries.filter(({ text }) =>
        text.includes("pg_try_advisory_lock"),
      ),
    ).toHaveLength(40);
    expect(
      pool.client.queries
        .filter(({ text }) => text.includes("pg_try_advisory_lock"))
        .map(({ queryTimeout }) => queryTimeout),
    ).toEqual(Array.from({ length: 40 }, (_, index) => 10_000 - index * 250));
  });

  test("rejects a lock acquired only after its probe consumes the remaining budget", async () => {
    const directory = await fixtureDirectory({ "0001_first.sql": "select 1;" });
    const manifest = await fixtureManifest(directory, ["0001_first.sql"]);
    const pool = new MigrationPoolDouble();
    const sleeps: number[] = [];
    let clock = 0;
    pool.client.lockProbe = ({ queryTimeout }) => {
      clock += queryTimeout ?? 0;
      return true;
    };

    await expect(
      runTfMigrations(asPool(pool), directory, manifest, {
        now: () => clock,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
          clock += milliseconds;
        },
      }),
    ).rejects.toMatchObject({ code: "migration_lock_timeout" });
    expect(
      pool.client.queries.filter(({ text }) =>
        text.includes("pg_try_advisory_lock"),
      ),
    ).toEqual([
      {
        queryTimeout: 10_000,
        text: "select pg_try_advisory_lock(hashtext($1)) as acquired",
        values: ["apollo_tf_migrations"],
      },
    ]);
    expect(sleeps).toEqual([]);
    expect(pool.client.events).toContain(
      "select pg_advisory_unlock(hashtext($1)) as unlocked",
    );
    expect(pool.client.releaseArguments).toEqual([undefined]);
  });

  test("caps retry sleep at the remaining lock budget", async () => {
    const directory = await fixtureDirectory({ "0001_first.sql": "select 1;" });
    const manifest = await fixtureManifest(directory, ["0001_first.sql"]);
    const pool = new MigrationPoolDouble();
    const sleeps: number[] = [];
    let clock = 0;
    pool.client.lockProbe = () => {
      clock += 9_900;
      return false;
    };

    await expect(
      runTfMigrations(asPool(pool), directory, manifest, {
        now: () => clock,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
          clock += milliseconds;
        },
      }),
    ).rejects.toMatchObject({ code: "migration_lock_timeout" });
    expect(sleeps).toEqual([100]);
    expect(
      pool.client.queries.filter(({ text }) =>
        text.includes("pg_try_advisory_lock"),
      ),
    ).toEqual([
      {
        queryTimeout: 10_000,
        text: "select pg_try_advisory_lock(hashtext($1)) as acquired",
        values: ["apollo_tf_migrations"],
      },
    ]);
    expect(pool.client.releaseArguments).toEqual([undefined]);
  });

  test("preserves lock timeout and poisons the client after a probe read timeout", async () => {
    const directory = await fixtureDirectory({ "0001_first.sql": "select 1;" });
    const manifest = await fixtureManifest(directory, ["0001_first.sql"]);
    const pool = new MigrationPoolDouble();
    const readTimeout = new Error("Query read timeout");
    const sleeps: number[] = [];
    let clock = 0;
    pool.client.lockProbe = ({ queryTimeout }) => {
      clock += queryTimeout ?? 0;
      return readTimeout;
    };

    await expect(
      runTfMigrations(asPool(pool), directory, manifest, {
        now: () => clock,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
          clock += milliseconds;
        },
      }),
    ).rejects.toMatchObject({ code: "migration_lock_timeout" });
    expect(sleeps).toEqual([]);
    expect(
      pool.client.queries.filter(({ text }) =>
        text.includes("pg_try_advisory_lock"),
      )[0],
    ).toMatchObject({ queryTimeout: 10_000 });
    expect(pool.client.events).not.toContain(
      "select pg_advisory_unlock(hashtext($1)) as unlocked",
    );
    expect(pool.client.releaseArguments).toEqual([readTimeout]);
  });

  test("requires persisted history to be an exact manifest prefix", async () => {
    const directory = await fixtureDirectory({
      "0001_first.sql": "select 1;",
      "0002_second.sql": "select 2;",
    });
    const manifest = await fixtureManifest(directory, [
      "0001_first.sql",
      "0002_second.sql",
    ]);

    for (const history of [
      [["9999_unknown.sql", "x"]],
      [["0002_second.sql", manifest[1]!.checksum]],
      [["0001_first.sql", "drift"]],
    ] as const) {
      const pool = new MigrationPoolDouble();
      for (const [name, checksum] of history) {
        pool.client.history.set(name, checksum);
      }
      await expect(
        runTfMigrations(asPool(pool), directory, manifest, zeroDelayOptions()),
      ).rejects.toMatchObject({ code: "migration_history_mismatch" });
    }
  });

  test("applies each migration transactionally and is idempotent", async () => {
    const directory = await fixtureDirectory({
      "0001_first.sql": "select 1;",
      "0002_second.sql": "select 2;",
    });
    const manifest = await fixtureManifest(directory, [
      "0001_first.sql",
      "0002_second.sql",
    ]);
    const pool = new MigrationPoolDouble();

    await expect(
      runTfMigrations(asPool(pool), directory, manifest, zeroDelayOptions()),
    ).resolves.toEqual({
      applied: ["0001_first.sql", "0002_second.sql"],
      alreadyApplied: [],
    });
    pool.client.queries.length = 0;
    pool.client.lockAnswers = [true];
    await expect(
      runTfMigrations(asPool(pool), directory, manifest, zeroDelayOptions()),
    ).resolves.toEqual({
      applied: [],
      alreadyApplied: ["0001_first.sql", "0002_second.sql"],
    });
    expect(
      pool.client.queries.filter(({ text }) => /^BEGIN$/i.test(text)),
    ).toHaveLength(1);
  });

  test("rejects unmanaged managed tables before applying migration SQL", async () => {
    const directory = await fixtureDirectory({ "0001_first.sql": "select 1;" });
    const manifest = await fixtureManifest(directory, ["0001_first.sql"]);
    const pool = new MigrationPoolDouble();
    pool.client.managedTables = ["playlists"];

    await expect(
      runTfMigrations(asPool(pool), directory, manifest, zeroDelayOptions()),
    ).rejects.toMatchObject({ code: "migration_history_mismatch" });
    expect(pool.client.queries.some(({ text }) => text === "select 1;")).toBe(
      false,
    );
  });

  test("preserves a SQL failure and destroys the client after rollback failure", async () => {
    const sql = "select broken;";
    const directory = await fixtureDirectory({ "0001_broken.sql": sql });
    const manifest = await fixtureManifest(directory, ["0001_broken.sql"]);
    const pool = new MigrationPoolDouble();
    const primary = new Error("primary");
    const rollback = new Error("rollback");
    pool.client.failures.set(sql, primary);
    pool.client.failures.set("ROLLBACK", rollback);

    await expect(
      runTfMigrations(asPool(pool), directory, manifest, zeroDelayOptions()),
    ).rejects.toBe(primary);
    expect(pool.client.releaseArguments).toEqual([rollback]);
  });

  test("preserves primary failures across unlock and release failures", async () => {
    const sql = "select broken;";
    const directory = await fixtureDirectory({ "0001_broken.sql": sql });
    const manifest = await fixtureManifest(directory, ["0001_broken.sql"]);
    const pool = new MigrationPoolDouble();
    const primary = new Error("primary");
    const unlock = new Error("unlock");
    pool.client.failures.set(sql, primary);
    pool.client.failures.set(
      "select pg_advisory_unlock(hashtext($1)) as unlocked",
      unlock,
    );
    pool.client.releaseError = new Error("release");

    await expect(
      runTfMigrations(asPool(pool), directory, manifest, zeroDelayOptions()),
    ).rejects.toBe(primary);
    expect(pool.client.releaseArguments).toEqual([unlock]);
  });

  test("destroys a client when lock state becomes uncertain", async () => {
    const directory = await fixtureDirectory({ "0001_first.sql": "select 1;" });
    const manifest = await fixtureManifest(directory, ["0001_first.sql"]);
    const pool = new MigrationPoolDouble();
    const failure = new Error("lock query failed");
    pool.client.lockAnswers = [failure];

    await expect(
      runTfMigrations(asPool(pool), directory, manifest, zeroDelayOptions()),
    ).rejects.toBe(failure);
    expect(pool.client.releaseArguments).toEqual([failure]);
  });
});

describe("baselineTfStartupSchema", () => {
  test("classifies only a missing relation during baseline locking as catalog mismatch", async () => {
    const missingRelation = Object.assign(
      new Error('relation "public.playlists" does not exist'),
      { code: "42P01" },
    );
    const missingPool = new MigrationPoolDouble();
    missingPool.client.tableLockFailure = missingRelation;

    await expect(
      baselineTfStartupSchema(
        asPool(missingPool),
        canonicalMigrationDirectory,
        TF_MIGRATION_MANIFEST,
        zeroDelayOptions(),
      ),
    ).rejects.toMatchObject({ code: "migration_baseline_mismatch" });
    expect(missingPool.client.events).toContain("ROLLBACK");
    expect(missingPool.client.releaseArguments).toEqual([undefined]);

    const unrelated = Object.assign(new Error("lock manager unavailable"), {
      code: "XX000",
    });
    const unrelatedPool = new MigrationPoolDouble();
    unrelatedPool.client.tableLockFailure = unrelated;

    await expect(
      baselineTfStartupSchema(
        asPool(unrelatedPool),
        canonicalMigrationDirectory,
        TF_MIGRATION_MANIFEST,
        zeroDelayOptions(),
      ),
    ).rejects.toBe(unrelated);
    expect(unrelatedPool.client.events).toContain("ROLLBACK");
    expect(unrelatedPool.client.releaseArguments).toEqual([undefined]);
  });

  test("rejects substituted SQL even when canonical filenames are retained", async () => {
    const directory = await fixtureDirectory({
      "0001_tf_core_collections.sql": "select 'substituted schema';",
      "0002_tf_runtime_privileges.sql": "select 'substituted grants';",
    });
    const substitutedManifest = await fixtureManifest(directory, [
      "0001_tf_core_collections.sql",
      "0002_tf_runtime_privileges.sql",
    ]);
    const pool = new MigrationPoolDouble();

    await expect(
      baselineTfStartupSchema(
        asPool(pool),
        directory,
        substitutedManifest,
        zeroDelayOptions(),
      ),
    ).rejects.toMatchObject({ code: "migration_baseline_mismatch" });
    expect(pool.client.queries).toEqual([]);
  });

  test("rejects a database owner that is not the current PostgreSQL superuser", async () => {
    const pool = new MigrationPoolDouble();
    pool.client.databaseRole = {
      current_role: "legacy_owner",
      is_superuser: false,
      is_database_owner: true,
    };

    await expect(
      baselineTfStartupSchema(
        asPool(pool),
        canonicalMigrationDirectory,
        TF_MIGRATION_MANIFEST,
        zeroDelayOptions(),
      ),
    ).rejects.toMatchObject({ code: "migration_baseline_mismatch" });
    expect(
      pool.client.queries.some(({ text }) =>
        text.includes("tf_catalog_columns"),
      ),
    ).toBe(false);
  });

  test("allows the current superuser to adopt legacy tables it does not own", async () => {
    const pool = new MigrationPoolDouble();
    pool.client.databaseRole = {
      current_role: "postgres",
      is_superuser: true,
      is_database_owner: false,
    };

    await expect(
      baselineTfStartupSchema(
        asPool(pool),
        canonicalMigrationDirectory,
        TF_MIGRATION_MANIFEST,
        zeroDelayOptions(),
      ),
    ).resolves.toMatchObject({
      applied: TF_MIGRATION_MANIFEST.map(({ name }) => name),
    });
  });

  test("rejects catalog drift without changing ownership or history", async () => {
    const pool = new MigrationPoolDouble();
    pool.client.catalog.columns = pool.client.catalog.columns.slice(1);

    await expect(
      baselineTfStartupSchema(
        asPool(pool),
        canonicalMigrationDirectory,
        TF_MIGRATION_MANIFEST,
        zeroDelayOptions(),
      ),
    ).rejects.toMatchObject({ code: "migration_baseline_mismatch" });
    expect(pool.client.history).toEqual(new Map());
    expect(pool.client.queries.some(({ text }) => /owner to/i.test(text))).toBe(
      false,
    );
    expect(
      pool.client.queries.some(({ text }) =>
        text.includes("tf_catalog_columns"),
      ),
    ).toBe(true);
    expect(pool.client.events).toContain("ROLLBACK");
  });

  test("rejects every extra constraint type by normalized definition", async () => {
    for (const constraint of [
      [
        "playlists",
        "playlists_name_check",
        "c",
        ["name"],
        "CHECK ((char_length(name) > 0))",
      ],
      [
        "playlist_tracks",
        "playlist_tracks_playlist_fk",
        "f",
        ["playlist_id"],
        "FOREIGN KEY (playlist_id) REFERENCES playlists(id)",
      ],
      [
        "play_history",
        "play_history_session_exclusion",
        "x",
        ["session_id"],
        "EXCLUDE USING gist (session_id WITH =)",
      ],
    ]) {
      const pool = new MigrationPoolDouble();
      pool.client.catalog.constraints.push(constraint);

      await expect(
        baselineTfStartupSchema(
          asPool(pool),
          canonicalMigrationDirectory,
          TF_MIGRATION_MANIFEST,
          zeroDelayOptions(),
        ),
      ).rejects.toMatchObject({ code: "migration_baseline_mismatch" });
    }
  });

  test("rejects predicate, include, collation, or opclass index drift from the full definition", async () => {
    for (const changedDefinition of [
      "CREATE INDEX liked_tracks_session_idx ON public.liked_tracks USING btree (session_id) WHERE (track_id IS NOT NULL)",
      "CREATE INDEX liked_tracks_session_idx ON public.liked_tracks USING btree (session_id) INCLUDE (track_id)",
      'CREATE INDEX liked_tracks_session_idx ON public.liked_tracks USING btree (session_id COLLATE "C")',
      "CREATE INDEX liked_tracks_session_idx ON public.liked_tracks USING btree (session_id text_pattern_ops)",
    ]) {
      const pool = new MigrationPoolDouble();
      pool.client.catalog.indexes[0]![5] = changedDefinition;

      await expect(
        baselineTfStartupSchema(
          asPool(pool),
          canonicalMigrationDirectory,
          TF_MIGRATION_MANIFEST,
          zeroDelayOptions(),
        ),
      ).rejects.toMatchObject({ code: "migration_baseline_mismatch" });
    }
  });

  test("adopts exact legacy objects then applies the privilege migration", async () => {
    const first = await readFile(
      join(canonicalMigrationDirectory, TF_MIGRATION_MANIFEST[0]!.name),
      "utf8",
    );
    const second = await readFile(
      join(canonicalMigrationDirectory, TF_MIGRATION_MANIFEST[1]!.name),
      "utf8",
    );
    const pool = new MigrationPoolDouble();

    await expect(
      baselineTfStartupSchema(
        asPool(pool),
        canonicalMigrationDirectory,
        TF_MIGRATION_MANIFEST,
        zeroDelayOptions(),
      ),
    ).resolves.toEqual({
      applied: [
        "0001_tf_core_collections.sql",
        "0002_tf_runtime_privileges.sql",
      ],
      alreadyApplied: [],
    });
    expect(pool.client.queries.some(({ text }) => text === first)).toBe(false);
    expect(pool.client.queries.some(({ text }) => text === second)).toBe(true);
    expect(
      pool.client.queries.filter(({ text }) => /owner to/i.test(text)),
    ).toHaveLength(12);

    const statements = pool.client.queries.map(({ text }) => text);
    const begins = statements
      .map((text, index) => (text === "BEGIN" ? index : -1))
      .filter((index) => index >= 0);
    const commits = statements
      .map((text, index) => (text === "COMMIT" ? index : -1))
      .filter((index) => index >= 0);
    const baselineBegin = begins[0]!;
    const lock = statements.findIndex((text) =>
      /lock table[\s\S]*access exclusive mode/i.test(text),
    );
    const catalog = statements.findIndex((text) =>
      text.includes("tf_catalog_columns"),
    );
    const owner = statements.findIndex((text) => /owner to/i.test(text));
    const historyInsert = statements.findIndex((text) =>
      text.includes("insert into apollo_tf.schema_migrations"),
    );

    expect(begins).toHaveLength(2);
    expect(commits).toHaveLength(2);
    expect(lock).toBeGreaterThan(baselineBegin);
    expect(catalog).toBeGreaterThan(lock);
    expect(owner).toBeGreaterThan(catalog);
    expect(historyInsert).toBeGreaterThan(owner);
    expect(commits[0]).toBeGreaterThan(historyInsert);
    expect(begins[1]).toBeGreaterThan(commits[0]!);
    expect(statements[lock]).toMatch(
      /track_search_cache[\s\S]*play_history[\s\S]*liked_tracks[\s\S]*playlists[\s\S]*playlist_tracks/i,
    );

    const constraintQuery = statements.find((text) =>
      text.includes("tf_catalog_constraints"),
    );
    expect(constraintQuery).toMatch(/pg_get_constraintdef/i);
    expect(constraintQuery).not.toMatch(/array_agg\s*\(\s*a\.attname/i);
    const indexQuery = statements.find((text) =>
      text.includes("tf_catalog_indexes"),
    );
    expect(indexQuery).toMatch(/pg_get_indexdef\s*\(\s*i\.oid\s*\)/i);
  });

  test("leaves an exact 0001 prefix when the privilege migration fails", async () => {
    const second = await readFile(
      join(canonicalMigrationDirectory, TF_MIGRATION_MANIFEST[1]!.name),
      "utf8",
    );
    const pool = new MigrationPoolDouble();
    const failure = new Error("grant failed");
    pool.client.failures.set(second, failure);

    await expect(
      baselineTfStartupSchema(
        asPool(pool),
        canonicalMigrationDirectory,
        TF_MIGRATION_MANIFEST,
        zeroDelayOptions(),
      ),
    ).rejects.toBe(failure);
    expect([...pool.client.history]).toEqual([
      ["0001_tf_core_collections.sql", TF_MIGRATION_MANIFEST[0]!.checksum],
    ]);
  });
});

describe("TF migration readiness", () => {
  test("requires the exact complete history and returns false on errors", async () => {
    const manifest: readonly MigrationManifestEntry[] = [
      { name: "0001_first.sql", checksum: "a" },
      { name: "0002_second.sql", checksum: "b" },
    ];
    const query = async () =>
      result([
        { name: "0001_first.sql", checksum: "a" },
        { name: "0002_second.sql", checksum: "b" },
      ]);
    await expect(
      createTfMigrationReadinessProbe({ query }, manifest)(),
    ).resolves.toBe(true);
    await expect(
      createTfMigrationReadinessProbe(
        {
          query: async () =>
            result([{ name: "0002_second.sql", checksum: "b" }]),
        },
        manifest,
      )(),
    ).resolves.toBe(false);
    await expect(
      createTfMigrationReadinessProbe(
        { query: async () => Promise.reject(new Error("offline")) },
        manifest,
      )(),
    ).resolves.toBe(false);
  });
});
