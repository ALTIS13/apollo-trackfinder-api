import { Buffer } from "node:buffer";
import { createSignedBodySignature } from "@workspace/module-runtime-contract";
import { describe, expect, it } from "vitest";
import {
  HmacInternalRequestAuthenticator,
  type InternalAuthenticationInput,
} from "./internal-auth.js";

const secret = "s".repeat(32);
const body = Buffer.from('{"schemaVersion":1}', "utf8");
const nonce = "A".repeat(43);

function signedInput(
  overrides: Partial<InternalAuthenticationInput> = {},
): InternalAuthenticationInput {
  const input = {
    method: "POST",
    path: "/v1/search",
    timestamp: "1000",
    nonce,
    rawBody: body,
    ...overrides,
  };
  return {
    ...input,
    signature:
      overrides.signature ??
      createSignedBodySignature({
        method: input.method,
        path: input.path,
        timestamp: input.timestamp ?? "",
        nonce: input.nonce ?? "",
        rawBody: input.rawBody,
        secret,
      }),
  };
}

function authenticator(now = 1_000_000, monotonicNow = now) {
  return new HmacInternalRequestAuthenticator({
    secret,
    now: () => now,
    monotonicNow: () => monotonicNow,
  });
}

describe("internal command authentication", () => {
  it("accepts an exactly signed raw request", () => {
    expect(authenticator().authenticate(signedInput())).toBe(true);
  });

  it.each([
    ["method", { method: "PUT" }],
    ["path", { path: "/v1/suggestions" }],
    ["timestamp", { timestamp: "1001" }],
    ["nonce", { nonce: "B".repeat(43) }],
    ["body", { rawBody: Buffer.from('{"schemaVersion":2}', "utf8") }],
    ["signature", { signature: "v1=" + "0".repeat(64) }],
  ] as const)("rejects a mutated signed %s field", (_field, mutation) => {
    const original = signedInput();
    expect(authenticator().authenticate({ ...original, ...mutation })).toBe(false);
  });

  it.each(["939", "1061", "not-a-timestamp", "1000.5", "-1000"])
  ("rejects timestamp %s even with a matching HMAC", (timestamp) => {
    expect(authenticator().authenticate(signedInput({ timestamp }))).toBe(false);
  });

  it.each(["A".repeat(42), "A".repeat(42) + "+", "A".repeat(42) + "B"])
  ("rejects malformed nonce %s", (invalidNonce) => {
    expect(authenticator().authenticate(signedInput({ nonce: invalidNonce }))).toBe(false);
  });

  it("rejects replay until the five-minute nonce window expires", () => {
    let now = 1_000_000;
    let monotonicNow = 1_000_000;
    const auth = new HmacInternalRequestAuthenticator({
      secret,
      now: () => now,
      monotonicNow: () => monotonicNow,
    });
    expect(auth.authenticate(signedInput())).toBe(true);
    expect(auth.authenticate(signedInput())).toBe(false);

    now += 300_001;
    monotonicNow += 300_001;
    expect(
      auth.authenticate(
        signedInput({ timestamp: String(Math.floor(now / 1_000)) }),
      ),
    ).toBe(true);
  });

  it("fails closed when 256 nonces are live", () => {
    const auth = authenticator();
    for (let index = 0; index < 256; index += 1) {
      const uniqueNonce = Buffer.from(
        Array.from({ length: 32 }, (_, byte) => (index + byte) % 256),
      ).toString("base64url");
      expect(auth.authenticate(signedInput({ nonce: uniqueNonce }))).toBe(true);
    }
    expect(auth.authenticate(signedInput({ nonce: "B".repeat(43) }))).toBe(false);
  });

  it("does not make a nonce valid for a different endpoint path", () => {
    const auth = authenticator();
    expect(auth.authenticate(signedInput())).toBe(true);
    expect(
      auth.authenticate(
        signedInput({ path: "/v1/suggestions", signature: signedInput().signature }),
      ),
    ).toBe(false);
  });
});
