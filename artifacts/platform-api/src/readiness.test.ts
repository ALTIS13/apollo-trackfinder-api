import { describe, expect, it, vi } from "vitest";

import { PLATFORM_MIGRATION_MANIFEST } from "@workspace/platform-db";

import { createMigrationReadinessProbe } from "./readiness.js";

describe("migration readiness", () => {
  it("requires every immutable migration name and checksum", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: PLATFORM_MIGRATION_MANIFEST.map(({ name, checksum }) => ({
        name,
        checksum,
      })),
    });
    await expect(
      createMigrationReadinessProbe({ query }, PLATFORM_MIGRATION_MANIFEST)(),
    ).resolves.toBe(true);

    query.mockResolvedValueOnce({
      rows: [
        {
          name: PLATFORM_MIGRATION_MANIFEST[0]?.name,
          checksum: PLATFORM_MIGRATION_MANIFEST[0]?.checksum,
        },
      ],
    });
    await expect(
      createMigrationReadinessProbe({ query }, PLATFORM_MIGRATION_MANIFEST)(),
    ).resolves.toBe(false);

    query.mockResolvedValueOnce({
      rows: PLATFORM_MIGRATION_MANIFEST.map(({ name }) => ({
        name,
        checksum: "wrong-checksum",
      })),
    });
    await expect(
      createMigrationReadinessProbe({ query }, PLATFORM_MIGRATION_MANIFEST)(),
    ).resolves.toBe(false);
  });
});
