import { createCipheriv, randomBytes, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ProviderTokenVault,
  parseProviderTokenKeyring,
} from "./token-keyring.js";

const accountId = "5d8b0f1c-31cc-4c12-a826-65b922719af5";
const otherAccountId = "a40594ce-951f-4acf-82c3-816372e2c17d";

function encodedKey(): string {
  return randomBytes(32).toString("base64url");
}

function rawKeyring(
  activeKeyId: string,
  keys: Readonly<Record<string, string>>,
): string {
  return JSON.stringify({ activeKeyId, keys });
}

function replaceBase64UrlByte(value: string): string {
  const bytes = Buffer.from(value, "base64url");
  bytes[0] = bytes[0]! ^ 1;
  return bytes.toString("base64url");
}

function independentlyEncryptMalformedSpotifySecret(
  keyId: string,
  encodedEncryptionKey: string,
  plaintext: string,
) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(encodedEncryptionKey, "base64url"),
    nonce,
    { authTagLength: 16 },
  );
  cipher.setAAD(
    Buffer.from(`apollo-tf-integrations-token:v1:spotify:${accountId}`, "utf8"),
  );
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  return {
    version: 1 as const,
    keyId,
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

describe("provider token keyring and vault", () => {
  it("loads one to four strict 32-byte base64url keys and one active key", () => {
    const singleKey = encodedKey();
    const single = parseProviderTokenKeyring(
      rawKeyring("2026-07", { "2026-07": singleKey }),
    );

    expect(single.activeKeyId).toBe("2026-07");
    expect(single.keyIds).toEqual(["2026-07"]);

    const fourKeys = Object.fromEntries(
      ["2026-04", "2026-05", "2026-06", "2026-07"].map((keyId) => [
        keyId,
        encodedKey(),
      ]),
    );
    const rotating = parseProviderTokenKeyring(rawKeyring("2026-07", fourKeys));

    expect(rotating.keyIds).toEqual(Object.keys(fourKeys));
    expect(rotating.activeKeyId).toBe("2026-07");
  });

  it("rejects duplicate, unknown, oversized, padded, or missing key material", () => {
    const duplicate = encodedKey();
    const valid = encodedKey();
    const invalidKeyrings = [
      rawKeyring("current", { current: duplicate, previous: duplicate }),
      JSON.stringify({
        activeKeyId: "current",
        keys: { current: valid },
        unexpected: true,
      }),
      rawKeyring("missing", { current: valid }),
      rawKeyring("current", {}),
      rawKeyring("current", {
        one: encodedKey(),
        two: encodedKey(),
        three: encodedKey(),
        four: encodedKey(),
        current: valid,
      }),
      rawKeyring("current", { current: `${valid}=` }),
      rawKeyring("current", { current: encodedKey().slice(1) }),
      rawKeyring("current", {
        current: `${encodedKey()}A`,
      }),
      rawKeyring("current", { current: "" }),
      rawKeyring("", { current: valid }),
      rawKeyring("../current", { "../current": valid }),
      "not-json",
    ];

    for (const raw of invalidKeyrings) {
      expect(() => parseProviderTokenKeyring(raw)).toThrow(
        "Provider token keyring is invalid",
      );
    }
  });

  it("encrypts with a fresh 96-bit nonce and decrypts for the same provider account", () => {
    const tokenCanary = `access-${randomUUID()}`;
    const vault = new ProviderTokenVault(
      parseProviderTokenKeyring(rawKeyring("active", { active: encodedKey() })),
    );
    const secret = {
      accessToken: tokenCanary,
      refreshToken: `refresh-${randomUUID()}`,
      expiresAt: "2026-07-25T12:00:00.000Z",
    };

    const first = vault.encrypt("spotify", accountId, secret);
    const second = vault.encrypt("spotify", accountId, secret);

    expect(first).toMatchObject({ version: 1, keyId: "active" });
    expect(first.nonce).not.toBe(second.nonce);
    expect(Buffer.from(first.nonce, "base64url")).toHaveLength(12);
    expect(Buffer.from(first.tag, "base64url")).toHaveLength(16);
    expect(first.nonce).not.toContain("=");
    expect(first.ciphertext).not.toContain("=");
    expect(first.tag).not.toContain("=");
    expect(JSON.stringify(first)).not.toContain(tokenCanary);
    expect(vault.decrypt("spotify", accountId, first)).toEqual(secret);

    const yandexSecret = { oauthToken: `oauth-${randomUUID()}` };
    const yandexEnvelope = vault.encrypt(
      "yandex",
      otherAccountId,
      yandexSecret,
    );
    expect(vault.decrypt("yandex", otherAccountId, yandexEnvelope)).toEqual(
      yandexSecret,
    );
  });

  it("rejects ciphertext tampering, provider substitution, account substitution, and unknown keys", () => {
    const vault = new ProviderTokenVault(
      parseProviderTokenKeyring(rawKeyring("active", { active: encodedKey() })),
    );
    const envelope = vault.encrypt("yandex", accountId, {
      oauthToken: `oauth-${randomUUID()}`,
    });

    const attempts = [
      () =>
        vault.decrypt("yandex", accountId, {
          ...envelope,
          ciphertext: replaceBase64UrlByte(envelope.ciphertext),
        }),
      () => vault.decrypt("spotify", accountId, envelope),
      () => vault.decrypt("yandex", otherAccountId, envelope),
      () =>
        vault.decrypt("yandex", accountId, {
          ...envelope,
          keyId: "retired",
        }),
      () =>
        vault.decrypt("yandex", accountId, {
          ...envelope,
          nonce: `${envelope.nonce}=`,
        }),
      () =>
        vault.decrypt("yandex", accountId, {
          ...envelope,
          ciphertext: "A".repeat(50_000),
        }),
    ];

    for (const attempt of attempts) {
      expect(attempt).toThrow("Provider token envelope is invalid");
    }
  });

  it("reads an old-key envelope and rewrites with the active key", () => {
    const oldKey = encodedKey();
    const activeKey = encodedKey();
    const oldVault = new ProviderTokenVault(
      parseProviderTokenKeyring(rawKeyring("old", { old: oldKey })),
    );
    const rotatingVault = new ProviderTokenVault(
      parseProviderTokenKeyring(
        rawKeyring("active", { old: oldKey, active: activeKey }),
      ),
    );
    const secret = {
      accessToken: `access-${randomUUID()}`,
      refreshToken: `refresh-${randomUUID()}`,
      expiresAt: "2026-07-25T12:00:00.000Z",
    };
    const oldEnvelope = oldVault.encrypt("spotify", accountId, secret);

    const decrypted = rotatingVault.decrypt("spotify", accountId, oldEnvelope);
    const rewritten = rotatingVault.encrypt("spotify", accountId, decrypted);

    expect(oldEnvelope.keyId).toBe("old");
    expect(rewritten.keyId).toBe("active");
    expect(rotatingVault.decrypt("spotify", accountId, rewritten)).toEqual(
      secret,
    );
  });

  it("never exposes plaintext tokens or key bytes through thrown errors", () => {
    const keyCanary = encodedKey();
    const tokenCanary = `token-${randomUUID()}`;
    const vault = new ProviderTokenVault(
      parseProviderTokenKeyring(rawKeyring("active", { active: keyCanary })),
    );
    const malformedPlaintext = JSON.stringify({
      accessToken: tokenCanary,
      refreshToken: `refresh-${randomUUID()}`,
      expiresAt: "2026-07-25T12:00:00.000Z",
      unexpected: true,
    });
    const malformedEnvelope = independentlyEncryptMalformedSpotifySecret(
      "active",
      keyCanary,
      malformedPlaintext,
    );

    let errorText = "";
    try {
      vault.decrypt("spotify", accountId, malformedEnvelope);
    } catch (error) {
      errorText = String(error);
    }

    expect(errorText).toContain("Provider token envelope is invalid");
    expect(errorText).not.toContain(tokenCanary);
    expect(errorText).not.toContain(keyCanary);
    expect(errorText).not.toContain(malformedPlaintext);

    expect(() =>
      vault.encrypt("yandex", accountId, {
        oauthToken: tokenCanary,
        unexpected: keyCanary,
      } as never),
    ).toThrow("Provider token secret is invalid");
    try {
      vault.encrypt("yandex", accountId, {
        oauthToken: tokenCanary,
        unexpected: keyCanary,
      } as never);
    } catch (error) {
      expect(String(error)).not.toContain(tokenCanary);
      expect(String(error)).not.toContain(keyCanary);
    }
  });
});
