import { pgTable, text, timestamp, serial, index } from "drizzle-orm/pg-core";

export const playHistoryTable = pgTable("play_history", {
  id: serial("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  trackId: text("track_id").notNull(),
  artist: text("artist"),
  title: text("title"),
  playedAt: timestamp("played_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("play_history_session_idx").on(t.sessionId),
  index("play_history_played_at_idx").on(t.playedAt),
]);

export type PlayHistory = typeof playHistoryTable.$inferSelect;
