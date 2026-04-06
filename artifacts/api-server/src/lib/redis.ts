import Redis from "ioredis";
import { logger } from "./logger.js";

let _redis: Redis | null = null;
let _available = false;

export function getRedis(): Redis | null {
  if (_redis) return _redis;

  const url = process.env["REDIS_URL"];
  if (!url) return null;

  try {
    _redis = new Redis(url, {
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
      lazyConnect: true,
      enableOfflineQueue: false,
    });

    _redis.on("connect", () => {
      _available = true;
      logger.info("Redis connected");
    });

    _redis.on("error", (err) => {
      if (_available) {
        logger.warn({ err: (err as Error).message }, "Redis error — falling back to PostgreSQL cache");
      }
      _available = false;
    });

    _redis.on("close", () => {
      _available = false;
    });

    _redis.connect().catch(() => {});
    return _redis;
  } catch {
    logger.warn("Failed to initialize Redis client — using PostgreSQL cache only");
    return null;
  }
}

export function isRedisAvailable(): boolean {
  return _available;
}

export async function redisGet(key: string): Promise<string | null> {
  const r = getRedis();
  if (!r || !_available) return null;
  try {
    return await r.get(key);
  } catch {
    return null;
  }
}

export async function redisSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  const r = getRedis();
  if (!r || !_available) return;
  try {
    await r.set(key, value, "EX", ttlSeconds);
  } catch {
  }
}

export async function redisDel(key: string): Promise<void> {
  const r = getRedis();
  if (!r || !_available) return;
  try {
    await r.del(key);
  } catch {
  }
}
