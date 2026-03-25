import { db } from "@workspace/db";
import { trackSearchCacheTable } from "@workspace/db/schema";
import { eq, lt } from "drizzle-orm";

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function buildCacheKey(artist: string, title: string): string {
  return `${artist.toLowerCase().trim()}::${title.toLowerCase().trim()}`;
}

export async function getCached<T>(artist: string, title: string): Promise<T[] | null> {
  const key = buildCacheKey(artist, title);
  const now = new Date();

  const rows = await db
    .select()
    .from(trackSearchCacheTable)
    .where(eq(trackSearchCacheTable.cacheKey, key))
    .limit(1);

  if (rows.length === 0) return null;
  const row = rows[0]!;
  if (row.expiresAt < now) {
    await db.delete(trackSearchCacheTable).where(eq(trackSearchCacheTable.cacheKey, key));
    return null;
  }

  return row.results as T[];
}

export async function setCached<T>(artist: string, title: string, results: T[]): Promise<void> {
  const key = buildCacheKey(artist, title);
  const expiresAt = new Date(Date.now() + CACHE_TTL_MS);

  await db
    .insert(trackSearchCacheTable)
    .values({ cacheKey: key, results, expiresAt })
    .onConflictDoUpdate({
      target: trackSearchCacheTable.cacheKey,
      set: { results, expiresAt },
    });
}

export async function purgeStaleCaches(): Promise<void> {
  await db
    .delete(trackSearchCacheTable)
    .where(lt(trackSearchCacheTable.expiresAt, new Date()));
}
