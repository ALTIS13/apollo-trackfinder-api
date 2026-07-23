import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool, QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  PLATFORM_MIGRATION_MANIFEST,
  createPlatformPool,
  runPlatformMigrations,
  setAccountContext,
  withPlatformTransaction,
} from "./index.js";

const migratorConnectionString = process.env.PLATFORM_TEST_DATABASE_URL;
const runtimeConnectionString = process.env.PLATFORM_TEST_RUNTIME_DATABASE_URL;
const describePostgres =
  migratorConnectionString && runtimeConnectionString
    ? describe.sequential
    : describe.skip;

const APPROVED_TABLES = [
  "account_module_entitlements",
  "accounts",
  "audit_events",
  "auth_sessions",
  "authorization_codes",
  "changelog_entries",
  "client_installations",
  "credentials",
  "email_verification_tokens",
  "invitation_module_grants",
  "invitations",
  "modules",
  "operator_roles",
  "password_reset_tokens",
  "project_releases",
  "projects",
  "registration_settings",
] as const;

const ACCOUNT_OWNED_TABLES = [
  "account_module_entitlements",
  "accounts",
  "auth_sessions",
  "authorization_codes",
  "client_installations",
  "credentials",
  "email_verification_tokens",
  "operator_roles",
  "password_reset_tokens",
] as const;

const SEEDED_MODULE_KEYS = [
  "tf.collections",
  "tf.downloads",
  "tf.integrations",
  "tf.search",
] as const;

const firstAccountId = "6ae06f36-58b5-466b-aad6-daf29be056f7";
const secondAccountId = "f307fae9-d0d9-4ddd-8cb7-44f1deff0f48";

async function scalar(
  pool: Pool,
  text: string,
  values?: unknown[],
): Promise<string> {
  const result = await pool.query<{ value: string }>(text, values);
  return result.rows[0]?.value ?? "";
}

async function column<R extends QueryResultRow>(
  pool: Pool,
  text: string,
  columnName: keyof R & string,
): Promise<unknown[]> {
  const result = await pool.query<R>(text);
  return result.rows.map((row) => row[columnName]);
}

describePostgres("apollo_platform PostgreSQL migration", () => {
  let migrator: Pool;
  let runtime: Pool;

  beforeAll(() => {
    migrator = createPlatformPool(migratorConnectionString!);
    runtime = createPlatformPool(runtimeConnectionString!);
  });

  afterAll(async () => {
    try {
      await migrator?.query("drop schema if exists apollo_platform cascade");
      if (migrator !== undefined) {
        await runPlatformMigrations(migrator);
      }
    } finally {
      await Promise.all([migrator?.end(), runtime?.end()]);
    }
  });

  test("installs the approved schema once with closed registration and exact seed modules", async () => {
    await expect(runPlatformMigrations(migrator)).resolves.toEqual({
      applied: PLATFORM_MIGRATION_MANIFEST.map(({ name }) => name),
      alreadyApplied: [],
    });
    await expect(runPlatformMigrations(migrator)).resolves.toEqual({
      applied: [],
      alreadyApplied: PLATFORM_MIGRATION_MANIFEST.map(({ name }) => name),
    });

    await expect(
      column<{ table_name: string }>(
        migrator,
        `
          select table_name
          from information_schema.tables
          where table_schema = 'apollo_platform'
            and table_type = 'BASE TABLE'
            and table_name <> 'schema_migrations'
          order by table_name
        `,
        "table_name",
      ),
    ).resolves.toEqual(APPROVED_TABLES);
    await expect(
      scalar(
        migrator,
        "select mode::text as value from apollo_platform.registration_settings",
      ),
    ).resolves.toBe("closed");
    await expect(
      column<{ module_key: string }>(
        migrator,
        "select module_key from apollo_platform.modules order by module_key",
        "module_key",
      ),
    ).resolves.toEqual(SEEDED_MODULE_KEYS);
  });

  test("binds authorization codes to an account installation and session", async () => {
    await expect(
      column<{ column_name: string }>(
        migrator,
        `
          select column_name
          from information_schema.columns
          where table_schema = 'apollo_platform'
            and table_name = 'authorization_codes'
            and column_name in ('auth_session_id', 'installation_id', 'state_digest')
          order by column_name
        `,
        "column_name",
      ),
    ).resolves.toEqual(["auth_session_id", "installation_id", "state_digest"]);
    await expect(
      scalar(
        migrator,
        `
          select count(*)::text as value
          from pg_constraint
          where conrelid = 'apollo_platform.authorization_codes'::regclass
            and conname in (
              'authorization_codes_session_fkey',
              'authorization_codes_installation_fkey',
              'authorization_codes_state_digest_check'
            )
        `,
      ),
    ).resolves.toBe("3");
  });

  test("rejects an authorization code bound to another account's session", async () => {
    const firstAccountId = "1836c9a4-d410-4ad5-87e3-b424a4ed1175";
    const secondAccountId = "6901e0d0-b6c0-4dfa-bb67-24755f3ae37a";
    const installationId = "1d2d513f-f747-4245-b86b-6a2b96e4763a";
    const sessionId = "bbb87883-6c75-4722-bddb-088152cb12cc";

    await withPlatformTransaction(migrator, async (client) => {
      await setAccountContext(client, firstAccountId);
      await client.query(
        `
          insert into apollo_platform.accounts (id, email, display_name)
          values ($1, 'cross-account-code-first@example.com', 'First Account')
        `,
        [firstAccountId],
      );
      await client.query(
        `
          insert into apollo_platform.client_installations
            (id, account_id, label)
          values ($1, $2, 'cross-account authorization-code installation')
        `,
        [installationId, firstAccountId],
      );
    });
    await withPlatformTransaction(migrator, async (client) => {
      await setAccountContext(client, secondAccountId);
      await client.query(
        `
          insert into apollo_platform.accounts (id, email, display_name)
          values ($1, 'cross-account-code-second@example.com', 'Second Account')
        `,
        [secondAccountId],
      );
      await client.query(
        `
          insert into apollo_platform.auth_sessions
            (id, account_id, session_digest, audience, expires_at)
          values ($1, $2, 'sha256:cross-account-code-session', 'product',
                  now() + interval '1 hour')
        `,
        [sessionId, secondAccountId],
      );
    });

    await expect(
      withPlatformTransaction(migrator, async (client) => {
        await setAccountContext(client, firstAccountId);
        await client.query(
          `
            insert into apollo_platform.authorization_codes
              (account_id, auth_session_id, installation_id, code_digest,
               state_digest, client_id, redirect_uri, pkce_challenge, nonce,
               expires_at)
            values
              ($1, $2, $3, 'sha256:cross-account-code', '${"b".repeat(64)}',
               'test-client', 'https://client.example/callback',
               'test-pkce-challenge', 'test-nonce', now() + interval '1 hour')
          `,
          [firstAccountId, sessionId, installationId],
        );
      }),
    ).rejects.toMatchObject({ code: "23503" });
  });

  test("revokes default PUBLIC execute for future migrator functions", async () => {
    await expect(
      scalar(
        migrator,
        `
          select count(*)::text as value
          from pg_default_acl d
          where d.defaclrole = 'apollo_platform_migrator'::regrole
            and d.defaclnamespace = 0
            and d.defaclobjtype = 'f'
            and not exists (
              select 1
              from aclexplode(d.defaclacl) acl
              where acl.grantee = 0
                and acl.privilege_type = 'EXECUTE'
            )
        `,
      ),
    ).resolves.toBe("1");
  });

  test("adds all-or-none operator bootstrap metadata and a non-public trigger function", async () => {
    await expect(
      column<{ column_name: string }>(
        migrator,
        `
          select column_name
          from information_schema.columns
          where table_schema = 'apollo_platform'
            and table_name = 'registration_settings'
            and column_name like 'operator_bootstrap_%'
          order by column_name
        `,
        "column_name",
      ),
    ).resolves.toEqual([
      "operator_bootstrap_account_id",
      "operator_bootstrap_completed_at",
    ]);
    await expect(
      scalar(
        migrator,
        `
          select (
            operator_bootstrap_account_id is null
            and operator_bootstrap_completed_at is null
          )::text as value
          from apollo_platform.registration_settings
        `,
      ),
    ).resolves.toBe("true");
    await expect(
      scalar(
        migrator,
        `
          select has_function_privilege(
            'public',
            'apollo_platform.record_operator_bootstrap()',
            'EXECUTE'
          )::text as value
        `,
      ),
    ).resolves.toBe("false");
    await expect(
      migrator.query(`
        update apollo_platform.registration_settings
        set operator_bootstrap_account_id = gen_random_uuid(),
            operator_bootstrap_completed_at = null,
            revision = revision + 1
      `),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      runtime.query(`
        update apollo_platform.registration_settings
        set operator_bootstrap_account_id = gen_random_uuid(),
            operator_bootstrap_completed_at = now(),
            revision = revision + 1
      `),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      runtime.query(`
        update apollo_platform.registration_settings
        set mode = mode,
            revision = revision + 1,
            updated_at = now()
      `),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  test("enforces normalized unique keys, bounded invitation use, and digest-only secrets", async () => {
    await withPlatformTransaction(migrator, async (client) => {
      await setAccountContext(client, firstAccountId);
      await client.query(
        `
          insert into apollo_platform.accounts (id, email, display_name)
          values ($1, 'person@example.com', 'First Person')
        `,
        [firstAccountId],
      );
    });

    await expect(
      withPlatformTransaction(migrator, async (client) => {
        await setAccountContext(client, secondAccountId);
        await client.query(
          `
            insert into apollo_platform.accounts (id, email, display_name)
            values ($1, 'PERSON@example.com', 'Uppercase Person')
          `,
          [secondAccountId],
        );
      }),
    ).rejects.toBeDefined();
    await expect(
      withPlatformTransaction(migrator, async (client) => {
        await setAccountContext(client, secondAccountId);
        await client.query(
          `
            insert into apollo_platform.accounts (id, email, display_name)
            values ($1, 'person@example.com', 'Duplicate Person')
          `,
          [secondAccountId],
        );
      }),
    ).rejects.toBeDefined();
    await withPlatformTransaction(migrator, async (client) => {
      await setAccountContext(client, secondAccountId);
      await client.query(
        `
          insert into apollo_platform.accounts (id, email, display_name)
          values ($1, 'second@example.com', 'Second Person')
        `,
        [secondAccountId],
      );
    });

    await expect(
      migrator.query(
        `
          insert into apollo_platform.modules
            (module_key, product, display_name, state, description)
          values ('TF.SEARCH', 'trackfinder', 'Invalid', 'active', 'Invalid key')
        `,
      ),
    ).rejects.toBeDefined();
    await expect(
      migrator.query(
        `
          insert into apollo_platform.modules
            (module_key, product, display_name, state, description)
          values ('tf.search', 'trackfinder', 'Duplicate', 'active', 'Duplicate key')
        `,
      ),
    ).rejects.toBeDefined();
    await expect(
      migrator.query(
        `
          insert into apollo_platform.invitations
            (token_digest, expires_at, uses_limit, uses_count, reason)
          values ('sha256:test-digest', now() + interval '1 hour', 1, 2, 'test')
        `,
      ),
    ).rejects.toBeDefined();

    await expect(
      column<{ column_name: string }>(
        migrator,
        `
          select column_name
          from information_schema.columns
          where table_schema = 'apollo_platform'
            and column_name in (
              'password', 'token', 'session_token', 'refresh_token',
              'authorization_code', 'invitation_token'
            )
          order by column_name
        `,
        "column_name",
      ),
    ).resolves.toEqual([]);
    await expect(
      scalar(
        migrator,
        `
          select count(*)::text as value
          from information_schema.columns
          where table_schema = 'apollo_platform'
            and data_type = 'timestamp without time zone'
        `,
      ),
    ).resolves.toBe("0");
  });

  test.each([
    [
      "email verification token",
      `
        insert into apollo_platform.email_verification_tokens
          (account_id, token_digest, expires_at, consumed_at)
        values
          ($1, 'sha256:verification-after-expiry',
           now() + interval '1 hour', now() + interval '2 hours')
      `,
    ],
    [
      "password reset token",
      `
        insert into apollo_platform.password_reset_tokens
          (account_id, token_digest, expires_at, consumed_at)
        values
          ($1, 'sha256:reset-after-expiry',
           now() + interval '1 hour', now() + interval '2 hours')
      `,
    ],
    [
      "authorization code",
      `
        with installation as (
          insert into apollo_platform.client_installations (account_id, label)
          values ($1, 'authorization-code-expiry')
          returning id
        ), session as (
          insert into apollo_platform.auth_sessions
            (account_id, installation_id, session_digest, audience, expires_at)
          select $1, installation.id, 'sha256:code-expiry-session', 'product',
                 now() + interval '1 hour'
          from installation
          returning id
        )
        insert into apollo_platform.authorization_codes
          (account_id, auth_session_id, installation_id, code_digest, state_digest,
           client_id, redirect_uri, pkce_challenge, nonce, expires_at, consumed_at)
        select $1, session.id, installation.id,
               'sha256:code-after-expiry', '${"a".repeat(64)}', 'test-client',
               'https://client.example/callback', 'test-pkce-challenge', 'test-nonce',
               now() + interval '1 hour', now() + interval '2 hours'
        from installation cross join session
      `,
    ],
  ])("rejects a consumed %s after expiry", async (_name, sql) => {
    await expect(
      withPlatformTransaction(migrator, async (client) => {
        await setAccountContext(client, firstAccountId);
        await client.query(sql, [firstAccountId]);
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  test("default-denies account rows and gives runtime no ownership or bypass", async () => {
    await expect(
      scalar(
        runtime,
        "select count(*)::text as value from apollo_platform.accounts",
      ),
    ).resolves.toBe("0");
    await expect(
      runtime.query("select * from apollo_platform.auth_sessions"),
    ).resolves.toMatchObject({ rowCount: 0 });

    await expect(
      withPlatformTransaction(runtime, async (client) => {
        await setAccountContext(client, firstAccountId);
        const result = await client.query<{ id: string }>(
          "select id from apollo_platform.accounts order by id",
        );
        return result.rows.map(({ id }) => id);
      }),
    ).resolves.toEqual([firstAccountId]);

    const rls = await migrator.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'apollo_platform'
        and c.relname = any(array[${ACCOUNT_OWNED_TABLES.map((name) => `'${name}'`).join(", ")}])
      order by c.relname
    `);
    expect(rls.rows).toEqual(
      ACCOUNT_OWNED_TABLES.map((relname) => ({
        relname,
        relrowsecurity: true,
        relforcerowsecurity: true,
      })),
    );

    await expect(
      scalar(
        migrator,
        `
          select count(*)::text as value
          from pg_tables
          where schemaname = 'apollo_platform'
            and tableowner <> 'apollo_platform_migrator'
        `,
      ),
    ).resolves.toBe("0");
    await expect(
      scalar(
        migrator,
        `
          select (nspowner = 'apollo_platform_migrator'::regrole)::text as value
          from pg_namespace
          where nspname = 'apollo_platform'
        `,
      ),
    ).resolves.toBe("true");
    await expect(
      scalar(
        migrator,
        `
          select rolbypassrls::text as value
          from pg_roles
          where rolname = 'apollo_platform_runtime'
        `,
      ),
    ).resolves.toBe("false");
    await expect(
      scalar(
        migrator,
        `
          select has_schema_privilege(
            'apollo_platform_runtime', 'apollo_platform', 'CREATE'
          )::text as value
        `,
      ),
    ).resolves.toBe("false");
    await expect(
      runtime.query(
        "alter table apollo_platform.accounts disable row level security",
      ),
    ).rejects.toBeDefined();
    await expect(
      runtime.query("delete from apollo_platform.audit_events"),
    ).rejects.toBeDefined();
  });

  test("blocks runtime cross-account inserts with RLS WITH CHECK", async () => {
    await expect(
      withPlatformTransaction(runtime, async (client) => {
        await setAccountContext(client, firstAccountId);
        await client.query(
          `
            insert into apollo_platform.auth_sessions
              (account_id, session_digest, audience, expires_at)
            values
              ($1, 'sha256:cross-account-insert', 'product',
               now() + interval '1 hour')
          `,
          [secondAccountId],
        );
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });

  test("blocks runtime account-id changes with RLS WITH CHECK", async () => {
    await withPlatformTransaction(runtime, async (client) => {
      await setAccountContext(client, firstAccountId);
      await client.query(
        `
          insert into apollo_platform.auth_sessions
            (account_id, session_digest, audience, expires_at)
          values
            ($1, 'sha256:account-id-update', 'product',
             now() + interval '1 hour')
        `,
        [firstAccountId],
      );
    });

    await expect(
      withPlatformTransaction(runtime, async (client) => {
        await setAccountContext(client, firstAccountId);
        await client.query(
          `
            update apollo_platform.auth_sessions
            set account_id = $1
            where session_digest = 'sha256:account-id-update'
          `,
          [secondAccountId],
        );
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });

  test("keeps registration revisions increasing and audit/release evidence immutable", async () => {
    await expect(
      migrator.query(
        `
          update apollo_platform.registration_settings
          set revision = revision
        `,
      ),
    ).rejects.toBeDefined();
    await expect(
      migrator.query(
        `
          update apollo_platform.registration_settings
          set mode = 'invite_only', revision = revision + 1, updated_at = now()
        `,
      ),
    ).resolves.toMatchObject({ rowCount: 1 });

    const audit = await migrator.query<{ id: string }>(`
      insert into apollo_platform.audit_events
        (actor_account_id, target_type, target_id, action, correlation_id, reason,
         previous_value, new_value)
      values
        ('${firstAccountId}', 'registration_settings', 'singleton',
         'registration_mode_changed', gen_random_uuid(), 'integration test',
         '{"mode":"closed"}'::jsonb, '{"mode":"invite_only"}'::jsonb)
      returning id
    `);
    await expect(
      migrator.query(
        "update apollo_platform.audit_events set reason = 'changed' where id = $1",
        [audit.rows[0]!.id],
      ),
    ).rejects.toBeDefined();
    await expect(
      migrator.query("delete from apollo_platform.audit_events where id = $1", [
        audit.rows[0]!.id,
      ]),
    ).rejects.toBeDefined();

    const project = await migrator.query<{ id: string }>(`
      insert into apollo_platform.projects
        (project_key, display_name, state, description)
      values ('apollo.test', 'Apollo Test', 'active', 'Integration test project')
      returning id
    `);
    const release = await migrator.query<{ id: string }>(
      `
        insert into apollo_platform.project_releases
          (project_id, version, released_at)
        values ($1, '1.0.0', now())
        returning id
      `,
      [project.rows[0]!.id],
    );
    await expect(
      migrator.query(
        "update apollo_platform.project_releases set version = '1.0.1' where id = $1",
        [release.rows[0]!.id],
      ),
    ).rejects.toBeDefined();
  });

  test("rejects truncating audit evidence as the migrator", async () => {
    await expect(
      migrator.query("truncate table apollo_platform.audit_events"),
    ).rejects.toMatchObject({ code: "55000" });
  });

  test("rejects truncating release evidence as the migrator", async () => {
    await expect(
      migrator.query("truncate table apollo_platform.project_releases cascade"),
    ).rejects.toMatchObject({ code: "55000" });
  });

  test("rejects persisted migration history outside the immutable manifest", async () => {
    await migrator.query(
      "insert into apollo_platform.schema_migrations (name, checksum) values ($1, $2)",
      ["9999_untrusted.sql", "extra"],
    );
    try {
      await expect(runPlatformMigrations(migrator)).rejects.toMatchObject({
        code: "migration_history_mismatch",
      });
    } finally {
      await migrator.query(
        "delete from apollo_platform.schema_migrations where name = $1",
        ["9999_untrusted.sql"],
      );
    }
  });

  test("applies 0002 after 0001 and backfills an existing live operator role", async () => {
    const firstMigrationDirectory = await mkdtemp(
      join(tmpdir(), "apollo-platform-0001-"),
    );
    try {
      await migrator.query("drop schema if exists apollo_platform cascade");
      await copyFile(
        new URL("../migrations/0001_platform_identity.sql", import.meta.url),
        join(firstMigrationDirectory, "0001_platform_identity.sql"),
      );
      await expect(
        runPlatformMigrations(
          migrator,
          firstMigrationDirectory,
          PLATFORM_MIGRATION_MANIFEST.slice(0, 1),
        ),
      ).resolves.toEqual({
        applied: ["0001_platform_identity.sql"],
        alreadyApplied: [],
      });

      const existingRole = await withPlatformTransaction(
        migrator,
        async (client) => {
          await setAccountContext(client, firstAccountId);
          await client.query(
            `insert into apollo_platform.accounts
               (id, email, display_name, status, email_verified_at, activated_at)
             values ($1, 'bootstrap-existing@example.com',
                     'Existing Operator', 'active', now(), now())`,
            [firstAccountId],
          );
          await client.query(
            `insert into apollo_platform.authorization_codes
               (account_id, code_digest, client_id, redirect_uri, pkce_challenge,
                nonce, expires_at)
             values ($1, 'sha256:pre-0004-authorization-code', 'test-client',
                     'https://client.example/callback', 'test-pkce-challenge',
                     'test-nonce', now() + interval '1 hour')`,
            [firstAccountId],
          );
          const result = await client.query<{
            id: string;
            account_id: string;
            capability: string;
            granted_at: Date;
            revoked_at: Date | null;
          }>(
            `insert into apollo_platform.operator_roles
               (account_id, capability, reason)
             values ($1, 'platform.accounts.manage', 'existing operator')
             returning id, account_id, capability, granted_at, revoked_at`,
            [firstAccountId],
          );
          return result.rows[0]!;
        },
      );

      await expect(runPlatformMigrations(migrator)).resolves.toEqual({
        applied: [
          "0002_operator_bootstrap_guard.sql",
          "0003_runtime_migration_history_read.sql",
          "0004_authorization_code_binding.sql",
        ],
        alreadyApplied: ["0001_platform_identity.sql"],
      });
      await expect(
        scalar(
          migrator,
          "select count(*)::text as value from apollo_platform.authorization_codes",
        ),
      ).resolves.toBe("0");

      const marker = await migrator.query<{
        operator_bootstrap_account_id: string;
        operator_bootstrap_completed_at: Date;
      }>(`
        select operator_bootstrap_account_id, operator_bootstrap_completed_at
        from apollo_platform.registration_settings
      `);
      const preservedRole = await withPlatformTransaction(
        migrator,
        async (client) => {
          await setAccountContext(client, firstAccountId);
          const result = await client.query<{
            id: string;
            account_id: string;
            capability: string;
            granted_at: Date;
            revoked_at: Date | null;
          }>(`
            select id, account_id, capability, granted_at, revoked_at
            from apollo_platform.operator_roles
          `);
          return result.rows[0]!;
        },
      );
      const operatorRoleSecurity = await migrator.query<{
        tableowner: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(`
        select tableowner, relrowsecurity, relforcerowsecurity
        from pg_tables
        join pg_class on relname = tablename
        join pg_namespace on pg_namespace.oid = pg_class.relnamespace
        where schemaname = 'apollo_platform'
          and tablename = 'operator_roles'
          and nspname = schemaname
      `);

      expect(marker.rows[0]).toEqual({
        operator_bootstrap_account_id: firstAccountId,
        operator_bootstrap_completed_at: existingRole.granted_at,
      });
      expect(preservedRole).toEqual(existingRole);
      expect(operatorRoleSecurity.rows).toEqual([
        {
          tableowner: "apollo_platform_migrator",
          relrowsecurity: true,
          relforcerowsecurity: true,
        },
      ]);
      await expect(
        scalar(
          migrator,
          `select rolbypassrls::text as value
           from pg_roles
           where rolname = 'apollo_platform_runtime'`,
        ),
      ).resolves.toBe("false");
      await expect(
        scalar(
          runtime,
          `select count(*)::text as value
           from apollo_platform.operator_roles`,
        ),
      ).resolves.toBe("0");
    } finally {
      await rm(firstMigrationDirectory, { recursive: true, force: true });
    }
  });
});
