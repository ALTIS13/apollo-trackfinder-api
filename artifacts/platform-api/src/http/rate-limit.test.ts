import { describe, expect, it } from "vitest";

import {
  SharedRateLimiter,
  type RateLimitStore,
  type RateLimitStoreRequest,
} from "./rate-limit.js";

class RecordingStore implements RateLimitStore {
  readonly calls: RateLimitStoreRequest[] = [];
  private readonly counts = new Map<string, number>();

  async consume(input: RateLimitStoreRequest) {
    this.calls.push(input);
    const counts = input.keys.map((key) => (this.counts.get(key) ?? 0) + 1);
    input.keys.forEach((key, index) =>
      this.counts.set(key, counts[index] ?? 0),
    );
    return {
      allowed: counts.every((count) => count <= input.limit),
      retryAfterSeconds: 60,
    };
  }
}

describe("SharedRateLimiter", () => {
  it("does not allow a changed IP to bypass an exhausted identity bucket", async () => {
    const store = new RecordingStore();
    const limiter = new SharedRateLimiter(store, {
      limit: 1,
      windowMs: 60_000,
    });

    await expect(
      limiter.consume({
        bucket: "login",
        identity: "member@example.test",
        ip: "198.51.100.1",
      }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      limiter.consume({
        bucket: "login",
        identity: "member@example.test",
        ip: "198.51.100.2",
      }),
    ).resolves.toMatchObject({ allowed: false });
  });

  it("does not allow a changed identity to bypass an exhausted IP bucket", async () => {
    const store = new RecordingStore();
    const limiter = new SharedRateLimiter(store, {
      limit: 1,
      windowMs: 60_000,
    });

    await limiter.consume({
      bucket: "registration",
      identity: "first@example.test",
      ip: "198.51.100.1",
    });
    await expect(
      limiter.consume({
        bucket: "registration",
        identity: "second@example.test",
        ip: "198.51.100.1",
      }),
    ).resolves.toMatchObject({ allowed: false });
  });

  it("hashes raw client values before passing bucket keys to the shared store", async () => {
    const store = new RecordingStore();
    const limiter = new SharedRateLimiter(store, {
      limit: 5,
      windowMs: 60_000,
    });

    await limiter.consume({
      bucket: "verification",
      identity: "verification-token-secret",
      ip: "198.51.100.1",
    });

    const serializedCalls = JSON.stringify(store.calls);
    expect(serializedCalls).not.toContain("verification-token-secret");
    expect(serializedCalls).not.toContain("198.51.100.1");
  });
});
