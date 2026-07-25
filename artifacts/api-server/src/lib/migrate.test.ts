import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());

vi.mock("@workspace/db", () => ({
  pool: { query },
}));

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn() },
}));

import { runMigrations } from "./migrate.js";

const providerTokenIdentifiers = [
  ["spotify", "tokens"].join("_"),
  ["yandex", "tokens"].join("_"),
  ["oauth", "token"].join("_"),
  ["refresh", "token"].join("_"),
];

describe("API startup migrations", () => {
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue(undefined);
  });

  it("never creates, drops, reads, or writes provider token tables", async () => {
    await runMigrations();

    expect(query).toHaveBeenCalledOnce();
    const sql = String(query.mock.calls[0]?.[0]).toLowerCase();
    for (const identifier of providerTokenIdentifiers) {
      expect(sql).not.toContain(identifier);
    }
    expect(sql).toContain("create table if not exists track_search_cache");
    expect(sql).toContain("create table if not exists play_history");
  });
});
