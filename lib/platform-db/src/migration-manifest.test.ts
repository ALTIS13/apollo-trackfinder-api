import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { PLATFORM_MIGRATION_MANIFEST } from "./index.js";

describe("PLATFORM_MIGRATION_MANIFEST", () => {
  it("includes the immutable authorization code binding migration", () => {
    expect(PLATFORM_MIGRATION_MANIFEST.map(({ name }) => name)).toEqual([
      "0001_platform_identity.sql",
      "0002_operator_bootstrap_guard.sql",
      "0003_runtime_migration_history_read.sql",
      "0004_authorization_code_binding.sql",
    ]);
  });

  it("matches every immutable migration file name and checksum", async () => {
    const migrationDirectory = new URL("../migrations/", import.meta.url);
    const names = (await readdir(migrationDirectory))
      .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
      .sort();
    const recomputed = await Promise.all(
      names.map(async (name) => ({
        name,
        checksum: createHash("sha256")
          .update(await readFile(new URL(name, migrationDirectory)))
          .digest("hex"),
      })),
    );

    expect(PLATFORM_MIGRATION_MANIFEST).toEqual(recomputed);
  });
});
