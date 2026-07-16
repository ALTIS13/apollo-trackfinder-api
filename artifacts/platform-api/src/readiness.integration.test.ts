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
