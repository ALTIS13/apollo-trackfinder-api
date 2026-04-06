import { redisGet, redisSet, redisDel } from "./redis.js";

const STREAM_URL_TTL = 5 * 60;

export async function getCachedStreamUrl(trackId: string): Promise<{ url: string; mimeType: string } | null> {
  const raw = await redisGet(`stream:${trackId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as { url: string; mimeType: string };
  } catch {
    return null;
  }
}

export async function setCachedStreamUrl(trackId: string, url: string, mimeType: string): Promise<void> {
  await redisSet(`stream:${trackId}`, JSON.stringify({ url, mimeType }), STREAM_URL_TTL);
}

export async function invalidateCachedStreamUrl(trackId: string): Promise<void> {
  await redisDel(`stream:${trackId}`);
}
