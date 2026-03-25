import { pgTable, text, timestamp, integer, serial } from "drizzle-orm/pg-core";

export const spotifyTokensTable = pgTable("spotify_tokens", {
  id: serial("id").primaryKey(),
  sessionId: text("session_id").notNull().unique(),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  spotifyUserId: text("spotify_user_id"),
  displayName: text("display_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type SpotifyTokens = typeof spotifyTokensTable.$inferSelect;
