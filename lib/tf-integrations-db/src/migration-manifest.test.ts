import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { INTEGRATIONS_MIGRATION_MANIFEST } from "./index.js";

describe("integrations migration manifest", () => {
  it("creates only integrations migration history and encrypted provider account tables", async () => {
    const sql = await readFile(
      new URL("../migrations/0001_integrations.sql", import.meta.url),
      "utf8",
    );

    expect(sql).toMatch(
      /create table apollo_tf_integrations\.provider_accounts/i,
    );
    expect(sql).toMatch(/account_id uuid not null/i);
    expect(sql).toMatch(/provider text not null/i);
    expect(sql).toMatch(/provider in \('spotify', 'yandex'\)/i);
    expect(sql).toMatch(/token_envelope jsonb not null/i);
    expect(sql).toMatch(/provider_user_id varchar\(512\) not null/i);
    expect(sql).toMatch(/display_name varchar\(500\) not null/i);
    expect(sql).toMatch(/primary key \(account_id, provider\)/i);
    expect(sql).toMatch(/created_at timestamptz not null default now\(\)/i);
    expect(sql).toMatch(/updated_at timestamptz not null default now\(\)/i);
    expect(sql).not.toMatch(
      /\b(access_token|refresh_token|oauth_token|client_secret)\b/i,
    );

    const createdTables = [
      ...sql.matchAll(/create table(?: if not exists)?\s+([a-z0-9_.]+)/gi),
    ].map((match) => match[1]);
    expect(createdTables).toEqual(["apollo_tf_integrations.provider_accounts"]);
  });

  it("checksums every immutable numbered migration in order", async () => {
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

    expect(INTEGRATIONS_MIGRATION_MANIFEST).toEqual(recomputed);
    expect(INTEGRATIONS_MIGRATION_MANIFEST.map(({ name }) => name)).toEqual([
      "0001_integrations.sql",
    ]);
  });
});
