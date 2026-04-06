import { pgTable, text, timestamp, serial, index, unique } from "drizzle-orm/pg-core";

export const likedTracksTable = pgTable("liked_tracks", {
  id: serial("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  trackId: text("track_id").notNull(),
  artist: text("artist"),
  title: text("title"),
  thumbnailUrl: text("thumbnail_url"),
  duration: text("duration"),
  likedAt: timestamp("liked_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  unique("liked_tracks_session_track_uniq").on(t.sessionId, t.trackId),
  index("liked_tracks_session_idx").on(t.sessionId),
]);

export type LikedTrack = typeof likedTracksTable.$inferSelect;
