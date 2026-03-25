import { pgTable, text, timestamp, serial } from "drizzle-orm/pg-core";

export const yandexTokensTable = pgTable("yandex_tokens", {
  id: serial("id").primaryKey(),
  sessionId: text("session_id").notNull().unique(),
  oauthToken: text("oauth_token").notNull(),
  yandexUserId: text("yandex_user_id"),
  displayName: text("display_name"),
  login: text("login"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type YandexTokens = typeof yandexTokensTable.$inferSelect;
