import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  RedisConnectionReadiness,
  combineRuntimeReadiness,
} from "./runtime-readiness.js";
import { RedisRateLimitStore, SharedRateLimiter } from "./http/rate-limit.js";

class RedisDouble extends EventEmitter {
  status = "wait";
  readonly connect = vi.fn(async () => undefined);
  readonly disconnect = vi.fn();
  readonly eval = vi.fn().mockResolvedValue([1, 0]);
}

describe("RedisConnectionReadiness", () => {
  it("connects without blocking startup and gates readiness until Redis recovers", async () => {
    const redis = new RedisDouble();
    const logger = { error: vi.fn() };
    const databaseReady = vi.fn().mockResolvedValue(true);
    const redisReadiness = new RedisConnectionReadiness(redis, logger);
    const readiness = combineRuntimeReadiness(redisReadiness, databaseReady);

    redisReadiness.start();
    expect(redis.connect).toHaveBeenCalledOnce();
    await expect(readiness()).resolves.toBe(false);
    expect(databaseReady).not.toHaveBeenCalled();

    redis.status = "ready";
    redis.emit("ready");
    await expect(readiness()).resolves.toBe(true);
    await expect(
      new SharedRateLimiter(new RedisRateLimitStore(redis), {
        limit: 1,
        windowMs: 60_000,
      }).consume({
        bucket: "login",
        identity: "member@example.test",
        ip: "198.51.100.1",
      }),
    ).resolves.toEqual({ allowed: true });
    expect(redis.eval).toHaveBeenCalledOnce();
  });

  it("keeps failures fail-closed, logs no Redis error details, and recovers", async () => {
    const redis = new RedisDouble();
    const logger = { error: vi.fn() };
    let now = 0;
    redis.connect.mockRejectedValueOnce(new Error("redis://secret@host:6379"));
    const readiness = new RedisConnectionReadiness(redis, logger, () => now);

    readiness.start();
    await Promise.resolve();
    redis.emit("error", new Error("redis://secret@host:6379"));
    redis.emit("error", new Error("redis://secret@host:6379"));
    expect(readiness.isReady()).toBe(false);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("secret");
    expect(logger.error).toHaveBeenCalledTimes(1);

    now = 30_000;
    redis.status = "ready";
    redis.emit("ready");
    expect(readiness.isReady()).toBe(true);
    readiness.stop();
    expect(redis.disconnect).toHaveBeenCalledOnce();
  });
});
