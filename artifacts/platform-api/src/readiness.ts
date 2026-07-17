import type { MigrationManifestEntry } from "@workspace/platform-db";

export interface MigrationReadinessQueryable {
  query<T extends { readonly name: string; readonly checksum: string }>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly T[] }>;
}

export function createMigrationReadinessProbe(
  queryable: MigrationReadinessQueryable,
  manifest: readonly MigrationManifestEntry[],
): () => Promise<boolean> {
  const expected = new Map(
    manifest.map(({ name, checksum }) => [name, checksum]),
  );
  return async () => {
    try {
      const result = await queryable.query<{ name: string; checksum: string }>(
        "select name, checksum from apollo_platform.schema_migrations",
        [],
      );
      if (result.rows.length !== expected.size) return false;
      return result.rows.every(
        ({ name, checksum }) => expected.get(name) === checksum,
      );
    } catch {
      return false;
    }
  };
}
