import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalNonceSchema,
  createSignedBodySignature,
  hasMatchingSignedBodySignature,
} from "./index";

const rawBody = Buffer.from('{"schemaVersion":1}', "utf8");
const signatureInput = {
  method: "post",
  path: "/v1/search",
  timestamp: "1784916000",
  nonce: "A".repeat(43),
  rawBody,
  secret: "s".repeat(32),
} as const;

describe("module runtime contract", () => {
  it("creates the exact canonical signed-body HMAC", () => {
    const signature = createSignedBodySignature(signatureInput);

    expect(signature).toMatch(/^v1=[a-f0-9]{64}$/);
    expect(signature).toBe(
      createHmac("sha256", "s".repeat(32))
        .update(
          [
            "POST",
            "/v1/search",
            "1784916000",
            "A".repeat(43),
            createHash("sha256").update(rawBody).digest("hex"),
          ].join("\n"),
        )
        .digest("hex")
        .replace(/^/, "v1="),
    );
  });

  it.each([
    ["method", { method: "get" }],
    ["path", { path: "/v1/suggestions" }],
    ["timestamp", { timestamp: "1784916001" }],
    ["nonce", { nonce: "B".repeat(43) }],
    ["body", { rawBody: Buffer.from('{"schemaVersion":2}', "utf8") }],
    ["secret", { secret: "t".repeat(32) }],
  ] as const)("changes the signature when the %s changes", (_field, mutation) => {
    expect(createSignedBodySignature({ ...signatureInput, ...mutation })).not.toBe(
      createSignedBodySignature(signatureInput),
    );
  });

  it("matches only the exact full signature", () => {
    const expected = createSignedBodySignature(signatureInput);

    expect(hasMatchingSignedBodySignature(expected, expected)).toBe(true);
    expect(hasMatchingSignedBodySignature(undefined, expected)).toBe(false);
    expect(hasMatchingSignedBodySignature(`${expected}0`, expected)).toBe(false);
    expect(hasMatchingSignedBodySignature(expected.replace("v1=", "v2="), expected)).toBe(false);
  });

  it("accepts only canonical 32-byte base64url nonces", () => {
    const zeroBytesNonce = Buffer.alloc(32).toString("base64url");
    const fullBytesNonce = Buffer.alloc(32, 0xff).toString("base64url");
    const nonCanonicalZeroBytesAlias = `${zeroBytesNonce.slice(0, -1)}B`;

    expect(Buffer.from(zeroBytesNonce, "base64url")).toHaveLength(32);
    expect(Buffer.from(zeroBytesNonce, "base64url").toString("base64url")).toBe(
      zeroBytesNonce,
    );
    expect(canonicalNonceSchema.safeParse(zeroBytesNonce).success).toBe(true);
    expect(Buffer.from(fullBytesNonce, "base64url")).toHaveLength(32);
    expect(Buffer.from(fullBytesNonce, "base64url").toString("base64url")).toBe(
      fullBytesNonce,
    );
    expect(canonicalNonceSchema.safeParse(fullBytesNonce).success).toBe(true);

    expect(Buffer.from(nonCanonicalZeroBytesAlias, "base64url")).toHaveLength(32);
    expect(
      Buffer.from(nonCanonicalZeroBytesAlias, "base64url").toString("base64url"),
    ).toBe(zeroBytesNonce);
    expect(canonicalNonceSchema.safeParse(nonCanonicalZeroBytesAlias).success).toBe(false);

    expect(canonicalNonceSchema.safeParse("A".repeat(42)).success).toBe(false);
    expect(canonicalNonceSchema.safeParse("A".repeat(43) + "=").success).toBe(false);
    expect(canonicalNonceSchema.safeParse("A".repeat(42) + "+").success).toBe(false);
  });
});
