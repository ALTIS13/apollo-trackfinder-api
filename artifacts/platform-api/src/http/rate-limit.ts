import { createHash } from "node:crypto";

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly retryAfterSeconds?: number;
}

export interface RateLimitStoreRequest {
  readonly keys: readonly [string, string];
  readonly limit: number;
  readonly windowMs: number;
}

export interface RateLimitStore {
  consume(input: RateLimitStoreRequest): Promise<RateLimitResult>;
}

export interface RateLimiter {
  consume(input: {
    readonly bucket: string;
    readonly identity: string;
    readonly ip: string;
  }): Promise<RateLimitResult>;
}

export interface RateLimitPolicy {
  readonly limit: number;
  readonly windowMs: number;
}

function hashBucketValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class SharedRateLimiter implements RateLimiter {
  constructor(
    private readonly store: RateLimitStore,
    private readonly policy: RateLimitPolicy,
  ) {}

  consume(input: {
    readonly bucket: string;
    readonly identity: string;
    readonly ip: string;
  }): Promise<RateLimitResult> {
    const prefix = `apollo:rate-limit:${input.bucket}`;
    return this.store.consume({
      keys: [
        `${prefix}:ip:${hashBucketValue(input.ip)}`,
        `${prefix}:identity:${hashBucketValue(input.identity)}`,
      ],
      limit: this.policy.limit,
      windowMs: this.policy.windowMs,
    });
  }
}

export interface RedisEvaluator {
  eval(
    script: string,
    numberOfKeys: number,
    ...args: string[]
  ): Promise<unknown>;
}

const ATOMIC_CONSUME_SCRIPT = `
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local allowed = 1
local retry_after_ms = 0
for index = 1, #KEYS do
  local count = redis.call("INCR", KEYS[index])
  if count == 1 then redis.call("PEXPIRE", KEYS[index], window) end
  if count > limit then
    allowed = 0
    local ttl = redis.call("PTTL", KEYS[index])
    if ttl > retry_after_ms then retry_after_ms = ttl end
  end
end
return { allowed, retry_after_ms }
`;

export class RedisRateLimitStore implements RateLimitStore {
  constructor(private readonly redis: RedisEvaluator) {}

  async consume(input: RateLimitStoreRequest): Promise<RateLimitResult> {
    const result = await this.redis.eval(
      ATOMIC_CONSUME_SCRIPT,
      input.keys.length,
      ...input.keys,
      String(input.limit),
      String(input.windowMs),
    );
    if (
      !Array.isArray(result) ||
      typeof result[0] !== "number" ||
      typeof result[1] !== "number"
    ) {
      throw new Error("Invalid Redis rate-limit response");
    }
    return result[0] === 1
      ? { allowed: true }
      : {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil(result[1] / 1_000)),
        };
  }
}
