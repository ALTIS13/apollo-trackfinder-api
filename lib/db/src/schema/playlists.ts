import { pgTable, text, timestamp, serial, integer, index } from "drizzle-orm/pg-core";

export const playlistsTable = pgTable("playlists", {
  id: serial("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("playlists_session_idx").on(t.sessionId),
]);

export const playlistTracksTable = pgTable("playlist_tracks", {
  id: serial("id").primaryKey(),
  playlistId: integer("playlist_id").notNull(),
  trackId: text("track_id").notNull(),
  artist: text("artist"),
  title: text("title"),
  thumbnailUrl: text("thumbnail_url"),
  duration: text("duration"),
  position: integer("position").notNull().default(0),
  addedAt: timestamp("added_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("playlist_tracks_playlist_idx").on(t.playlistId),
]);

export type Playlist = typeof playlistsTable.$inferSelect;
export type PlaylistTrack = typeof playlistTracksTable.$inferSelect;
