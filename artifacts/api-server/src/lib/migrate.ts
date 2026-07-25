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

    CREATE TABLE IF NOT EXISTS play_history (
      id          SERIAL PRIMARY KEY,
      session_id  TEXT        NOT NULL,
      track_id    TEXT        NOT NULL,
      artist      TEXT,
      title       TEXT,
      played_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS play_history_session_idx ON play_history (session_id);
    CREATE INDEX IF NOT EXISTS play_history_played_at_idx ON play_history (played_at);

    CREATE TABLE IF NOT EXISTS liked_tracks (
      id            SERIAL PRIMARY KEY,
      session_id    TEXT        NOT NULL,
      track_id      TEXT        NOT NULL,
      artist        TEXT,
      title         TEXT,
      thumbnail_url TEXT,
      duration      TEXT,
      liked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (session_id, track_id)
    );

    CREATE INDEX IF NOT EXISTS liked_tracks_session_idx ON liked_tracks (session_id);

    CREATE TABLE IF NOT EXISTS playlists (
      id          SERIAL PRIMARY KEY,
      session_id  TEXT        NOT NULL,
      name        TEXT        NOT NULL,
      description TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS playlists_session_idx ON playlists (session_id);

    CREATE TABLE IF NOT EXISTS playlist_tracks (
      id            SERIAL PRIMARY KEY,
      playlist_id   INTEGER     NOT NULL,
      track_id      TEXT        NOT NULL,
      artist        TEXT,
      title         TEXT,
      thumbnail_url TEXT,
      duration      TEXT,
      position      INTEGER     NOT NULL DEFAULT 0,
      added_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS playlist_tracks_playlist_idx ON playlist_tracks (playlist_id);
  `);

  logger.info("Migrations complete");
}
