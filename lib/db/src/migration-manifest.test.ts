import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { TF_MIGRATION_MANIFEST } from "./migrations.js";

const migrationDirectory = fileURLToPath(
  new URL("../migrations", import.meta.url),
);

describe("TF immutable migration manifest", () => {
  test("matches the exact sorted migration filesystem and byte checksums", async () => {
    const names = (await readdir(migrationDirectory))
      .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
      .sort();
    const recomputed = await Promise.all(
      names.map(async (name) => ({
        name,
        checksum: createHash("sha256")
          .update(await readFile(`${migrationDirectory}/${name}`))
          .digest("hex"),
      })),
    );

    expect(TF_MIGRATION_MANIFEST.map(({ name }) => name)).toEqual([
      "0001_tf_core_collections.sql",
      "0002_tf_runtime_privileges.sql",
    ]);
    expect(recomputed).toEqual(TF_MIGRATION_MANIFEST);
  });

  test("keeps provider credentials out of TF core migrations", async () => {
    const sql = (
      await Promise.all(
        TF_MIGRATION_MANIFEST.map(({ name }) =>
          readFile(`${migrationDirectory}/${name}`, "utf8"),
        ),
      )
    ).join("\n");

    expect(sql).not.toMatch(/spotify_tokens|yandex_tokens/i);
  });

  test("uses plain qualified DDL and least-privilege runtime grants", async () => {
    const first = await readFile(
      `${migrationDirectory}/0001_tf_core_collections.sql`,
      "utf8",
    );
    const second = await readFile(
      `${migrationDirectory}/0002_tf_runtime_privileges.sql`,
      "utf8",
    );

    for (const table of [
      "track_search_cache",
      "play_history",
      "liked_tracks",
      "playlists",
      "playlist_tracks",
    ]) {
      expect(first).toMatch(new RegExp(`create table public\\.${table}`, "i"));
      expect(second).toMatch(new RegExp(`public\\.${table}`, "i"));
    }
    expect(first).not.toMatch(/if not exists/i);
    expect(second).toMatch(
      /grant usage on schema apollo_tf to apollo_tf_runtime/i,
    );
    expect(second).toMatch(
      /grant select on apollo_tf\.schema_migrations to apollo_tf_runtime/i,
    );
    expect(second).toMatch(/grant usage on sequence/i);
    expect(second).not.toMatch(
      /grant\s+(?:[\s\S]*,\s*)?update\s+on\s+sequence/i,
    );
    expect(second).not.toMatch(/grant usage on schema public/i);
  });
});
