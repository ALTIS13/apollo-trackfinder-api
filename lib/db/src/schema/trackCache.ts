import { pgTable, text, jsonb, timestamp, serial } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const trackSearchCacheTable = pgTable("track_search_cache", {
  id: serial("id").primaryKey(),
  cacheKey: text("cache_key").notNull().unique(),
  results: jsonb("results").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const insertTrackSearchCacheSchema = createInsertSchema(trackSearchCacheTable).omit({ id: true, createdAt: true });
export type InsertTrackSearchCache = z.infer<typeof insertTrackSearchCacheSchema>;
export type TrackSearchCache = typeof trackSearchCacheTable.$inferSelect;
