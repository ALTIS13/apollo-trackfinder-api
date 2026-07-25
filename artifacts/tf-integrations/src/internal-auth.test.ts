import { Buffer } from "node:buffer";

import { createSignedBodySignature } from "@workspace/module-runtime-contract";
import { describe, expect, it } from "vitest";

import {
  HmacInternalRequestAuthenticator,
  type InternalAuthenticationInput,
} from "./internal-auth.js";

const secret = "c".repeat(32);
const rawBody = Buffer.from(
  '{"schemaVersion":1,"requestId":"10000000-0000-4000-8000-000000000001"}',
  "utf8",
);
const nonce = "A".repeat(43);

function signedInput(
  overrides: Partial<InternalAuthenticationInput> = {},
): InternalAuthenticationInput {
  const input = {
    method: "POST",
    path: "/v1/commands",
    timestamp: "1000",
    nonce,
    rawBody,
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

function authenticator(now = 1_000_000) {
  return new HmacInternalRequestAuthenticator({
    secret,
    now: () => now,
    monotonicNow: () => now,
  });
}

describe("TF integrations internal authentication", () => {
  it("accepts a valid signed raw JSON body once within 60 seconds", () => {
    const auth = authenticator(1_060_000);

    expect(auth.authenticate(signedInput())).toBe(true);
    expect(auth.authenticate(signedInput())).toBe(false);
  });

  it("rejects replay, stale/future time, malformed nonce/signature, wrong path, and modified body", () => {
    expect(authenticator(1_060_001).authenticate(signedInput())).toBe(false);
    expect(
      authenticator(939_999).authenticate(signedInput({ timestamp: "1000" })),
    ).toBe(false);
    expect(
      authenticator().authenticate(signedInput({ nonce: "A".repeat(42) })),
    ).toBe(false);
    expect(
      authenticator().authenticate(
        signedInput({ signature: `v1=${"0".repeat(63)}` }),
      ),
    ).toBe(false);

    const original = signedInput();
    expect(
      authenticator().authenticate({
        ...original,
        path: "/v1/commands/",
      }),
    ).toBe(false);
    expect(
      authenticator().authenticate({
        ...original,
        rawBody: Buffer.from(`${rawBody.toString("utf8")} `, "utf8"),
      }),
    ).toBe(false);

    const full = authenticator();
    for (let index = 0; index < 256; index += 1) {
      const uniqueNonce = Buffer.from(
        Array.from({ length: 32 }, (_, byte) => (index + byte) % 256),
      ).toString("base64url");
      expect(full.authenticate(signedInput({ nonce: uniqueNonce }))).toBe(true);
    }
    expect(full.authenticate(signedInput({ nonce: "B".repeat(43) }))).toBe(
      false,
    );
  });
});
