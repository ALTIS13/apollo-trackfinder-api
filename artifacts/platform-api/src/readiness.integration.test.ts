import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  PLATFORM_MIGRATION_MANIFEST,
  createPlatformPool,
  runPlatformMigrations,
} from "@workspace/platform-db";

import { createMigrationReadinessProbe } from "./readiness.js";

const migratorConnectionString = process.env.PLATFORM_TEST_DATABASE_URL;
const runtimeConnectionString = process.env.PLATFORM_TEST_RUNTIME_DATABASE_URL;
const describePostgres =
  migratorConnectionString && runtimeConnectionString
    ? describe.sequential
    : describe.skip;

describePostgres("runtime migration readiness", () => {
  const migrator = createPlatformPool(migratorConnectionString!);
  const runtime = createPlatformPool(runtimeConnectionString!);

  beforeAll(async () => {
    await runPlatformMigrations(migrator);
  });

  afterAll(async () => {
    await Promise.all([migrator.end(), runtime.end()]);
  });

  test("allows the runtime role to verify exact immutable migration history", async () => {
    await expect(
      createMigrationReadinessProbe(runtime, PLATFORM_MIGRATION_MANIFEST)(),
    ).resolves.toBe(true);
  });

  test("rejects an extra persisted migration row and recovers after cleanup", async () => {
    const client = await migrator.connect();
    let lockAcquired = false;
    let rowInserted = false;
    try {
      await client.query("select pg_advisory_lock(hashtext($1))", [
        "apollo_platform_migrations",
      ]);
      lockAcquired = true;
      await client.query(
        "insert into apollo_platform.schema_migrations (name, checksum) values ($1, $2)",
        ["9999_untrusted.sql", "extra"],
      );
      rowInserted = true;
      await expect(
        createMigrationReadinessProbe(runtime, PLATFORM_MIGRATION_MANIFEST)(),
      ).resolves.toBe(false);
    } finally {
      try {
        if (rowInserted) {
          await client.query(
            "delete from apollo_platform.schema_migrations where name = $1",
            ["9999_untrusted.sql"],
          );
        }
      } finally {
        try {
          if (lockAcquired) {
            await client.query("select pg_advisory_unlock(hashtext($1))", [
              "apollo_platform_migrations",
            ]);
          }
        } finally {
          client.release();
        }
      }
    }
    await expect(
      createMigrationReadinessProbe(runtime, PLATFORM_MIGRATION_MANIFEST)(),
    ).resolves.toBe(true);
  });

  test("keeps migration history owned and immutable to the runtime role", async () => {
    await expect(
      migrator.query<{ tableowner: string }>(`
        select tableowner
        from pg_tables
        where schemaname = 'apollo_platform'
          and tablename = 'schema_migrations'
      `),
    ).resolves.toMatchObject({
      rows: [{ tableowner: "apollo_platform_migrator" }],
    });
    await expect(
      migrator.query<{ rolbypassrls: boolean }>(`
        select rolbypassrls
        from pg_roles
        where rolname = 'apollo_platform_runtime'
      `),
    ).resolves.toMatchObject({ rows: [{ rolbypassrls: false }] });

    await expect(
      runtime.query(
        "insert into apollo_platform.schema_migrations (name, checksum) values ('evil.sql', 'evil')",
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      runtime.query(
        "update apollo_platform.schema_migrations set checksum = checksum",
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      runtime.query("delete from apollo_platform.schema_migrations"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      runtime.query("truncate apollo_platform.schema_migrations"),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
