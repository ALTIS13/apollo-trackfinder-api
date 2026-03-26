import { pool } from "@workspace/db";
import { logger } from "./logger.js";

export async function runMigrations(): Promise<void> {
  logger.info("Running startup migrations…");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS track_search_cache (
      id         SERIAL PRIMARY KEY,
      cache_key  TEXT        NOT NULL UNIQUE,
      results    JSONB       NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS spotify_tokens (
      id               SERIAL PRIMARY KEY,
      session_id       TEXT        NOT NULL UNIQUE,
      access_token     TEXT        NOT NULL,
      refresh_token    TEXT        NOT NULL,
      expires_at       TIMESTAMPTZ NOT NULL,
      spotify_user_id  TEXT,
      display_name     TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS yandex_tokens (
      id              SERIAL PRIMARY KEY,
      session_id      TEXT        NOT NULL UNIQUE,
      oauth_token     TEXT        NOT NULL,
      yandex_user_id  TEXT,
      display_name    TEXT,
      login           TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  logger.info("Migrations complete");
}
