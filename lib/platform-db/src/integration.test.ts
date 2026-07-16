import type { Pool, QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
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
    await Promise.all([migrator?.end(), runtime?.end()]);
  });

  test("installs the approved schema once with closed registration and exact seed modules", async () => {
    await expect(runPlatformMigrations(migrator)).resolves.toEqual({
      applied: ["0001_platform_identity.sql"],
      alreadyApplied: [],
    });
    await expect(runPlatformMigrations(migrator)).resolves.toEqual({
      applied: [],
      alreadyApplied: ["0001_platform_identity.sql"],
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
        insert into apollo_platform.authorization_codes
          (account_id, code_digest, client_id, redirect_uri, pkce_challenge,
           nonce, expires_at, consumed_at)
        values
          ($1, 'sha256:code-after-expiry', 'test-client',
           'https://client.example/callback', 'test-pkce-challenge', 'test-nonce',
           now() + interval '1 hour', now() + interval '2 hours')
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
});
