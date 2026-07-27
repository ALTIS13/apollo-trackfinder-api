import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

import {
  baselineTfStartupSchema,
  createTfMigrationReadinessProbe,
  runTfMigrations,
} from "./migrations.js";
import { createTfPool } from "./pool.js";

const urls = {
  admin: process.env["TF_TEST_ADMIN_DATABASE_URL"],
  migrator: process.env["TF_TEST_MIGRATOR_DATABASE_URL"],
  runtime: process.env["TF_TEST_RUNTIME_DATABASE_URL"],
};
const integrationEnabled = Object.values(urls).every(
  (value) => typeof value === "string" && value.length > 0,
);
const legacySchemaSql = await readFile(
  fileURLToPath(
    new URL("../migrations/0001_tf_core_collections.sql", import.meta.url),
  ),
  "utf8",
);
const migrationNames = [
  "0001_tf_core_collections.sql",
  "0002_tf_runtime_privileges.sql",
] as const;
const exactHistory = [
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
] as const;
const disabledRuntimeRole = "apollo_tf_runtime_task5_disabled";

let adminPool: Pool | undefined;
let migratorPool: Pool | undefined;
let runtimePool: Pool | undefined;

function requireUrl(value: string | undefined): string {
  if (!value) throw new Error("TF PostgreSQL integration URL is unavailable");
  return value;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

async function expectContractError(
  operation: () => Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    expect((error as Error & { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`Expected contract error ${code}`);
}

async function expectPermissionDenied(sql: string): Promise<void> {
  try {
    await runtimePool!.query(sql);
  } catch (error) {
    expect(errorCode(error)).toBe("42501");
    return;
  }
  throw new Error("Expected PostgreSQL permission denial");
}

async function ensureRuntimeRoleName(): Promise<void> {
  const roles = await adminPool!.query<{ rolname: string }>(
    `select rolname
     from pg_roles
     where rolname in ('apollo_tf_runtime', $1)
     order by rolname`,
    [disabledRuntimeRole],
  );
  if (
    roles.rows.length === 1 &&
    roles.rows[0]?.rolname === disabledRuntimeRole
  ) {
    await adminPool!.query(
      `alter role ${disabledRuntimeRole} rename to apollo_tf_runtime`,
    );
  }
}

async function resetTfState(): Promise<void> {
  await ensureRuntimeRoleName();
  await adminPool!.query(`
    drop schema if exists apollo_tf cascade;
    drop table if exists
      public.playlist_tracks,
      public.playlists,
      public.liked_tracks,
      public.play_history,
      public.track_search_cache,
      public.runtime_canary,
      public.spotify_tokens,
      public.yandex_tokens
    cascade;
    revoke all privileges on schema public
      from apollo_tf_migrator, apollo_tf_runtime;
    grant usage, create on schema public to apollo_tf_migrator;
    grant usage on schema public to apollo_tf_runtime;
  `);
}

async function loadHistory(): Promise<
  Array<{ name: string; checksum: string }>
> {
  const result = await adminPool!.query<{ name: string; checksum: string }>(
    `select name, checksum
     from apollo_tf.schema_migrations
     order by name`,
  );
  return result.rows;
}

async function expectExactHistory(
  expected: readonly { name: string; checksum: string }[],
): Promise<void> {
  const history = await loadHistory();
  expect(history.map(({ name }) => name)).toEqual(
    expected.map(({ name }) => name),
  );
  expect(
    history.map(
      ({ checksum }, index) => checksum === expected[index]?.checksum,
    ),
  ).toEqual(expected.map(() => true));
}

async function expectNoHistoryRows(): Promise<void> {
  const relation = await adminPool!.query<{ name: string | null }>(
    "select to_regclass('apollo_tf.schema_migrations')::text as name",
  );
  if (relation.rows[0]?.name === null) return;
  const history = await adminPool!.query<{ count: number }>(
    "select count(*)::integer as count from apollo_tf.schema_migrations",
  );
  expect(history.rows[0]?.count).toBe(0);
}

async function createLegacySchema(pool: Pool = adminPool!): Promise<void> {
  await pool.query(legacySchemaSql);
}

async function recreateRuntimePool(): Promise<void> {
  await runtimePool?.end();
  runtimePool = createTfPool(requireUrl(urls.runtime), "runtime");
}

describe
  .skipIf(!integrationEnabled)
  .sequential("TF PostgreSQL 16 migration integration", () => {
    beforeAll(async () => {
      adminPool = createTfPool(requireUrl(urls.admin), "migration");
      migratorPool = createTfPool(requireUrl(urls.migrator), "migration");
      runtimePool = createTfPool(requireUrl(urls.runtime), "runtime");

      const version = await adminPool.query<{ server_version_num: number }>(
        "select current_setting('server_version_num')::integer as server_version_num",
      );
      expect(version.rows[0]?.server_version_num).toBeGreaterThanOrEqual(
        160_000,
      );
      expect(version.rows[0]?.server_version_num).toBeLessThan(170_000);

      const roles = await adminPool.query<{
        rolbypassrls: boolean;
        rolcanlogin: boolean;
        rolconnlimit: number;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolinherit: boolean;
        rolname: string;
        rolreplication: boolean;
        rolsuper: boolean;
        valid_until: string;
      }>(`
        select
          rolname,
          rolcanlogin,
          rolsuper,
          rolcreatedb,
          rolcreaterole,
          rolinherit,
          rolreplication,
          rolbypassrls,
          rolconnlimit,
          coalesce(rolvaliduntil::text, 'infinity') as valid_until
        from pg_roles
        where rolname in ('apollo_tf_migrator', 'apollo_tf_runtime')
        order by rolname
      `);
      expect(roles.rows).toEqual([
        {
          rolbypassrls: false,
          rolcanlogin: true,
          rolconnlimit: -1,
          rolcreatedb: false,
          rolcreaterole: false,
          rolinherit: false,
          rolname: "apollo_tf_migrator",
          rolreplication: false,
          rolsuper: false,
          valid_until: "infinity",
        },
        {
          rolbypassrls: false,
          rolcanlogin: true,
          rolconnlimit: -1,
          rolcreatedb: false,
          rolcreaterole: false,
          rolinherit: false,
          rolname: "apollo_tf_runtime",
          rolreplication: false,
          rolsuper: false,
          valid_until: "infinity",
        },
      ]);
    });

    beforeEach(async () => {
      await resetTfState();
    });

    afterAll(async () => {
      if (adminPool) {
        await resetTfState();
      }
      await Promise.allSettled([
        runtimePool?.end(),
        migratorPool?.end(),
        adminPool?.end(),
      ]);
    });

    test("applies the exact manifest once and reports both migrations on repeat", async () => {
      await expect(runTfMigrations(migratorPool!)).resolves.toEqual({
        applied: [...migrationNames],
        alreadyApplied: [],
      });
      await expect(runTfMigrations(migratorPool!)).resolves.toEqual({
        applied: [],
        alreadyApplied: [...migrationNames],
      });
      await expectExactHistory(exactHistory);
    });

    test("reports exact readiness and allows runtime CRUD on all five active tables", async () => {
      await runTfMigrations(migratorPool!);
      await expect(
        createTfMigrationReadinessProbe(runtimePool!)(),
      ).resolves.toBe(true);

      const cases = [
        {
          insert:
            "insert into public.track_search_cache (cache_key, results, expires_at) values ('task5-cache', '[]'::jsonb, now() + interval '1 hour') returning id",
          select:
            "select cache_key as value from public.track_search_cache where id = $1",
          expected: "task5-cache",
          update:
            "update public.track_search_cache set cache_key = 'task5-cache-updated' where id = $1",
          remove: "delete from public.track_search_cache where id = $1",
        },
        {
          insert:
            "insert into public.play_history (session_id, track_id) values ('task5-session', 'task5-history') returning id",
          select:
            "select track_id as value from public.play_history where id = $1",
          expected: "task5-history",
          update:
            "update public.play_history set track_id = 'task5-history-updated' where id = $1",
          remove: "delete from public.play_history where id = $1",
        },
        {
          insert:
            "insert into public.liked_tracks (session_id, track_id) values ('task5-session', 'task5-liked') returning id",
          select:
            "select track_id as value from public.liked_tracks where id = $1",
          expected: "task5-liked",
          update:
            "update public.liked_tracks set track_id = 'task5-liked-updated' where id = $1",
          remove: "delete from public.liked_tracks where id = $1",
        },
        {
          insert:
            "insert into public.playlists (session_id, name) values ('task5-session', 'task5-playlist') returning id",
          select: "select name as value from public.playlists where id = $1",
          expected: "task5-playlist",
          update:
            "update public.playlists set name = 'task5-playlist-updated' where id = $1",
          remove: "delete from public.playlists where id = $1",
        },
        {
          insert:
            "insert into public.playlist_tracks (playlist_id, track_id) values (1, 'task5-track') returning id",
          select:
            "select track_id as value from public.playlist_tracks where id = $1",
          expected: "task5-track",
          update:
            "update public.playlist_tracks set track_id = 'task5-track-updated' where id = $1",
          remove: "delete from public.playlist_tracks where id = $1",
        },
      ] as const;

      for (const entry of cases) {
        const inserted = await runtimePool!.query<{ id: number }>(entry.insert);
        const id = inserted.rows[0]?.id;
        const selected = await runtimePool!.query<{ value: string }>(
          entry.select,
          [id],
        );
        expect(selected.rows).toEqual([{ value: entry.expected }]);
        await expect(
          runtimePool!.query(entry.update, [id]),
        ).resolves.toMatchObject({ rowCount: 1 });
        await expect(
          runtimePool!.query(entry.remove, [id]),
        ).resolves.toMatchObject({ rowCount: 1 });
      }
    });

    test("denies runtime DDL, truncate, history mutation, canary access, and setval", async () => {
      await runTfMigrations(migratorPool!);
      await adminPool!.query(
        "create table public.runtime_canary (id integer primary key)",
      );

      for (const statement of [
        "create table public.runtime_ddl_probe (id integer)",
        "alter table public.track_search_cache add column forbidden integer",
        "drop table public.track_search_cache",
        "truncate table public.track_search_cache",
        "insert into apollo_tf.schema_migrations (name, checksum) values ('9999_forbidden.sql', repeat('0', 64))",
        "update apollo_tf.schema_migrations set checksum = repeat('0', 64)",
        "delete from apollo_tf.schema_migrations",
        "select * from public.runtime_canary",
        "select setval('public.track_search_cache_id_seq', 100, true)",
      ]) {
        await expectPermissionDenied(statement);
      }
      await expectExactHistory(exactHistory);
    });

    test("rejects extra and checksum-drifted history", async () => {
      await runTfMigrations(migratorPool!);
      await adminPool!.query(
        "update apollo_tf.schema_migrations set checksum = repeat('0', 64) where name = $1",
        [migrationNames[0]],
      );
      await expectContractError(
        () => runTfMigrations(migratorPool!),
        "migration_history_mismatch",
      );
      await expect(
        createTfMigrationReadinessProbe(runtimePool!)(),
      ).resolves.toBe(false);

      await resetTfState();
      await runTfMigrations(migratorPool!);
      await adminPool!.query(
        "insert into apollo_tf.schema_migrations (name, checksum) values ('9999_extra.sql', repeat('f', 64))",
      );
      await expectContractError(
        () => runTfMigrations(migratorPool!),
        "migration_history_mismatch",
      );
      await expect(
        createTfMigrationReadinessProbe(runtimePool!)(),
      ).resolves.toBe(false);
    });

    test("rejects unmanaged managed tables without recording history", async () => {
      await adminPool!.query(
        "create table public.track_search_cache (id serial primary key)",
      );
      await expectContractError(
        () => runTfMigrations(migratorPool!),
        "migration_history_mismatch",
      );
      await expectNoHistoryRows();
    });

    test("requires a superuser for exact legacy adoption and transfers every managed owner", async () => {
      await createLegacySchema(migratorPool!);
      await expectContractError(
        () => baselineTfStartupSchema(migratorPool!),
        "migration_baseline_mismatch",
      );

      await resetTfState();
      await createLegacySchema();
      await expect(baselineTfStartupSchema(adminPool!)).resolves.toEqual({
        applied: [...migrationNames],
        alreadyApplied: [],
      });

      const owners = await adminPool!.query<{
        kind: string;
        name: string;
        owner: string;
      }>(`
        select 'schema'::text as kind, n.nspname::text as name, r.rolname::text as owner
        from pg_namespace n
        join pg_roles r on r.oid = n.nspowner
        where n.nspname = 'apollo_tf'
        union all
        select
          case when c.relkind = 'S' then 'sequence' else 'table' end,
          n.nspname || '.' || c.relname,
          r.rolname
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_roles r on r.oid = c.relowner
        where (n.nspname = 'public' and c.relname in (
          'track_search_cache',
          'track_search_cache_id_seq',
          'play_history',
          'play_history_id_seq',
          'liked_tracks',
          'liked_tracks_id_seq',
          'playlists',
          'playlists_id_seq',
          'playlist_tracks',
          'playlist_tracks_id_seq'
        ))
        or (n.nspname = 'apollo_tf' and c.relname = 'schema_migrations')
        order by kind, name
      `);
      expect(owners.rows).toHaveLength(12);
      expect(
        owners.rows.every((entry) => entry.owner === "apollo_tf_migrator"),
      ).toBe(true);
      await expect(runTfMigrations(migratorPool!)).resolves.toEqual({
        applied: [],
        alreadyApplied: [...migrationNames],
      });
      await expectExactHistory(exactHistory);
    });

    test("preserves exact 0001 adoption when 0002 fails and resumes normally", async () => {
      await createLegacySchema();
      await runtimePool!.end();
      runtimePool = undefined;
      await adminPool!.query(
        `alter role apollo_tf_runtime rename to ${disabledRuntimeRole}`,
      );

      try {
        await expect(baselineTfStartupSchema(adminPool!)).rejects.toMatchObject(
          {
            code: "42704",
          },
        );
        await expectExactHistory([exactHistory[0]]);

        const owners = await adminPool!.query<{ owner: string }>(`
          select r.rolname::text as owner
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          join pg_roles r on r.oid = c.relowner
          where (
            n.nspname = 'public'
            and c.relname in (
              'track_search_cache',
              'track_search_cache_id_seq',
              'play_history',
              'play_history_id_seq',
              'liked_tracks',
              'liked_tracks_id_seq',
              'playlists',
              'playlists_id_seq',
              'playlist_tracks',
              'playlist_tracks_id_seq'
            )
          )
          or (n.nspname = 'apollo_tf' and c.relname = 'schema_migrations')
        `);
        expect(owners.rows).toHaveLength(11);
        expect(
          owners.rows.every((entry) => entry.owner === "apollo_tf_migrator"),
        ).toBe(true);
      } finally {
        await ensureRuntimeRoleName();
        await recreateRuntimePool();
      }

      await expect(runTfMigrations(migratorPool!)).resolves.toEqual({
        applied: [migrationNames[1]],
        alreadyApplied: [migrationNames[0]],
      });
      await expectExactHistory(exactHistory);
    });

    test("rejects every malformed legacy catalog without recording history", async () => {
      const mutations = [
        "drop table public.playlist_tracks",
        "alter table public.liked_tracks drop column title",
        "alter table public.playlists add column unexpected text",
        "alter table public.track_search_cache alter column results type text using results::text",
        "alter table public.playlist_tracks alter column position set default 1",
        "alter table public.liked_tracks drop constraint liked_tracks_session_id_track_id_key",
        "alter table public.play_history add constraint play_history_track_nonempty check (track_id <> '')",
        "drop index public.playlists_session_idx",
        "create index playlists_created_at_extra_idx on public.playlists (created_at)",
        "drop index public.playlists_session_idx; create index playlists_session_idx on public.playlists (created_at)",
      ] as const;

      for (const mutation of mutations) {
        await resetTfState();
        await createLegacySchema();
        await adminPool!.query(mutation);
        await expectContractError(
          () => baselineTfStartupSchema(adminPool!),
          "migration_baseline_mismatch",
        );
        await expectNoHistoryRows();
      }
    });

    test("creates no provider-token table or runtime grant", async () => {
      await runTfMigrations(migratorPool!);
      const result = await adminPool!.query<{
        provider_table_count: number;
        runtime_grant_count: number;
      }>(`
        select
          (
            select count(*)::integer
            from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
            where n.nspname in ('public', 'apollo_tf')
              and c.relname in ('spotify_tokens', 'yandex_tokens')
          ) as provider_table_count,
          (
            select count(*)::integer
            from information_schema.role_table_grants
            where grantee = 'apollo_tf_runtime'
              and table_name in ('spotify_tokens', 'yandex_tokens')
          ) as runtime_grant_count
      `);
      expect(result.rows).toEqual([
        { provider_table_count: 0, runtime_grant_count: 0 },
      ]);
    });
  });
