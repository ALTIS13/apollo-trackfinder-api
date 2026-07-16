import { createHash } from "node:crypto";

import { argon2i, argon2id, hash as argonHash } from "argon2";
import { describe, expect, it } from "vitest";

import {
  ARGON2ID_PROFILE,
  digestOpaqueToken,
  hashPassword,
  issueOpaqueToken,
  normalizeEmail,
  normalizeModuleKey,
  verifyPassword,
} from "./security.js";

describe("security primitives", () => {
  it("normalizes email addresses and module keys", () => {
    expect(normalizeEmail("  Operator@Example.COM\t")).toBe(
      "operator@example.com",
    );
    expect(normalizeModuleKey("  TF.Integrations\n")).toBe("tf.integrations");
  });

  it("exports one immutable Argon2id profile with the approved values", () => {
    expect(ARGON2ID_PROFILE).toEqual({
      type: argon2id,
      version: 19,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 4,
      hashLength: 32,
    });
    expect(Object.isFrozen(ARGON2ID_PROFILE)).toBe(true);
  });

  it("issues 32 random bytes as base64url and returns their SHA-256 digest", () => {
    const issued = issueOpaqueToken();

    expect(Buffer.from(issued.raw, "base64url")).toHaveLength(32);
    expect(issued.raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.digest).toBe(
      createHash("sha256").update(issued.raw).digest("hex"),
    );
    expect(issued.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("supports explicit token entropy and deterministic token digests", () => {
    expect(Buffer.from(issueOpaqueToken(48).raw, "base64url")).toHaveLength(48);
    expect(digestOpaqueToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes with the approved profile and a library-generated random salt", async () => {
    const password = "correct horse battery staple";
    const first = await hashPassword(password);
    const second = await hashPassword(password);

    expect(first).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=4\$/);
    expect(first).not.toContain(password);
    expect(second).not.toBe(first);
    expect(Buffer.from(first.split("$")[5] ?? "", "base64")).toHaveLength(32);
  });

  it("verifies a valid password without requesting a rehash", async () => {
    const hash = await hashPassword("apollo-operator-password");

    await expect(
      verifyPassword(hash, "apollo-operator-password"),
    ).resolves.toEqual({ valid: true, needsRehash: false });
  });

  it("returns a non-throwing invalid result for a wrong password or malformed hash", async () => {
    const hash = await hashPassword("apollo-operator-password");

    await expect(verifyPassword(hash, "wrong-password")).resolves.toEqual({
      valid: false,
      needsRehash: false,
    });
    await expect(
      verifyPassword("not-an-argon2-hash", "wrong-password"),
    ).resolves.toEqual({ valid: false, needsRehash: false });
  });

  it("reports rehashing only after valid verification with changed parameters", async () => {
    const password = "apollo-operator-password";
    const legacyHash = await argonHash(password, {
      ...ARGON2ID_PROFILE,
      timeCost: 2,
    });

    await expect(verifyPassword(legacyHash, password)).resolves.toEqual({
      valid: true,
      needsRehash: true,
    });
    await expect(verifyPassword(legacyHash, "wrong-password")).resolves.toEqual({
      valid: false,
      needsRehash: false,
    });
  });

  it("requests rehashing when the Argon2 variant or hash length is outdated", async () => {
    const password = "apollo-operator-password";
    const legacyHash = await argonHash(password, {
      ...ARGON2ID_PROFILE,
      type: argon2i,
      hashLength: 16,
    });

    await expect(verifyPassword(legacyHash, password)).resolves.toEqual({
      valid: true,
      needsRehash: true,
    });
  });
});
