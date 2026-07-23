import { generateKeyPairSync } from "node:crypto";

import {
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
  type JWK,
} from "jose";
import { describe, expect, it } from "vitest";

import { PlatformAssertionSigner } from "./assertions.js";

const issuer = "https://api.apollot.ru";
const now = new Date("2026-07-24T12:00:00.000Z");
const accountId = "11111111-1111-4111-8111-111111111111";
const sessionId = "20000000-0000-4000-8000-000000000002";
const installationId = "10000000-0000-4000-8000-000000000001";

function keyPair(kid: string): {
  readonly privateJwk: JWK;
  readonly publicJwk: JWK;
} {
  const pair = generateKeyPairSync("ed25519");
  const privateJwk = pair.privateKey.export({ format: "jwk" });
  const publicJwk = pair.publicKey.export({ format: "jwk" });
  return {
    privateJwk: {
      ...privateJwk,
      alg: "EdDSA",
      use: "sig",
      kid,
    },
    publicJwk: {
      ...publicJwk,
      alg: "EdDSA",
      use: "sig",
      kid,
    },
  };
}

function signingInput() {
  return {
    accountId,
    sessionId,
    installationId,
    nonce: "n".repeat(43),
    audience: "apollo-tf" as const,
    entitlements: ["tf.downloads", "tf.search"] as const,
  };
}

describe("PlatformAssertionSigner", () => {
  it("signs exact five-minute Ed25519 assertions with the active key ID", async () => {
    const active = keyPair("active-2026-07");
    const previous = keyPair("previous-2026-06");
    const signer = new PlatformAssertionSigner({
      issuer,
      activePrivateJwk: active.privateJwk,
      publicJwks: [active.publicJwk, previous.publicJwk],
      clock: () => now,
    });

    const result = await signer.sign(signingInput());
    const activePublicKey = await importJWK(active.publicJwk, "EdDSA");
    const verified = await jwtVerify(result.assertion, activePublicKey, {
      algorithms: ["EdDSA"],
      issuer,
      audience: "apollo-tf",
      currentDate: now,
    });
    const nowSeconds = Math.floor(now.getTime() / 1_000);

    expect(decodeProtectedHeader(result.assertion)).toEqual({
      alg: "EdDSA",
      kid: "active-2026-07",
      typ: "JWT",
    });
    expect(result.claims).toEqual(verified.payload);
    expect(result.claims).toMatchObject({
      iss: issuer,
      aud: "apollo-tf",
      sub: accountId,
      sid: sessionId,
      installation_id: installationId,
      nonce: "n".repeat(43),
      account_status: "active",
      entitlements: ["tf.downloads", "tf.search"],
      iat: nowSeconds,
      nbf: nowSeconds - 5,
      exp: nowSeconds + 300,
    });
    expect(result.claims.jti).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("publishes a deeply frozen overlapping public JWKS without private material", () => {
    const active = keyPair("active");
    const previous = keyPair("previous");
    const signer = new PlatformAssertionSigner({
      issuer,
      activePrivateJwk: active.privateJwk,
      publicJwks: [previous.publicJwk, active.publicJwk],
      clock: () => now,
    });

    const jwks = signer.publicJwks();
    expect(jwks).toEqual({
      keys: [previous.publicJwk, active.publicJwk],
    });
    expect(JSON.stringify(jwks)).not.toContain("\"d\"");
    expect(Object.isFrozen(jwks)).toBe(true);
    expect(Object.isFrozen(jwks.keys)).toBe(true);
    expect(jwks.keys.every(Object.isFrozen)).toBe(true);
    expect(() => {
      (jwks.keys as JWK[]).push(previous.publicJwk);
    }).toThrow(TypeError);
  });

  it("rejects malformed, private, duplicate, or mismatched key sets", () => {
    const active = keyPair("active");
    const previous = keyPair("previous");
    const create = (
      activePrivateJwk: JWK,
      publicJwks: readonly JWK[],
    ) =>
      new PlatformAssertionSigner({
        issuer,
        activePrivateJwk,
        publicJwks,
        clock: () => now,
      });

    expect(() => create(active.privateJwk, [])).toThrow();
    expect(() =>
      create(active.privateJwk, [
        active.publicJwk,
        { ...previous.publicJwk, kid: "active" },
      ]),
    ).toThrow();
    expect(() =>
      create(active.privateJwk, [
        { ...active.publicJwk, x: previous.publicJwk.x },
      ]),
    ).toThrow();
    expect(() =>
      create(active.privateJwk, [active.privateJwk]),
    ).toThrow();
    expect(() =>
      create(
        { ...active.privateJwk, alg: "RS256" },
        [active.publicJwk],
      ),
    ).toThrow();
    expect(() =>
      create(
        {
          ...active.privateJwk,
          internalKey: "not-allowed",
        } as JWK,
        [active.publicJwk],
      ),
    ).toThrow();
  });

  it("rejects malformed signing input and non-finite clocks", async () => {
    const active = keyPair("active");
    const signer = new PlatformAssertionSigner({
      issuer,
      activePrivateJwk: active.privateJwk,
      publicJwks: [active.publicJwk],
      clock: () => new Date(Number.NaN),
    });

    await expect(signer.sign(signingInput())).rejects.toMatchObject({
      code: "policy_unavailable",
    });

    const validClockSigner = new PlatformAssertionSigner({
      issuer,
      activePrivateJwk: active.privateJwk,
      publicJwks: [active.publicJwk],
      clock: () => now,
    });
    await expect(
      validClockSigner.sign({
        ...signingInput(),
        entitlements: ["tf.search", "tf.search"],
      }),
    ).rejects.toMatchObject({ code: "policy_unavailable" });
    await expect(
      validClockSigner.sign({
        ...signingInput(),
        nonce: "short",
      }),
    ).rejects.toMatchObject({ code: "policy_unavailable" });
  });
});
