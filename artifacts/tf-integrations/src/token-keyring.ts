import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { EncryptedTokenEnvelopeV1 } from "@workspace/tf-integrations-db";

const KEYRING_ERROR = "Provider token keyring is invalid";
const SECRET_ERROR = "Provider token secret is invalid";
const ENVELOPE_ERROR = "Provider token envelope is invalid";
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const MAX_TOKEN_LENGTH = 8_192;
const MAX_SECRET_BYTES = 24 * 1_024;
const MAX_ENCODED_CIPHERTEXT_LENGTH = Math.ceil((MAX_SECRET_BYTES * 4) / 3);

export type Provider = "spotify" | "yandex";

export type SpotifySecret = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
};

export type YandexSecret = {
  oauthToken: string;
};

export type ProviderSecret = SpotifySecret | YandexSecret;

export interface ProviderTokenKeyring {
  readonly activeKeyId: string;
  readonly keyIds: readonly string[];
}

const keyringMaterial = new WeakMap<
  ProviderTokenKeyring,
  ReadonlyMap<string, Buffer>
>();

function isPlainObject(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index])
  );
}

function decodeBase64Url(
  value: string,
  expectedLength?: number,
): Buffer | undefined {
  if (
    value.length === 0 ||
    value.includes("=") ||
    !BASE64URL_PATTERN.test(value)
  ) {
    return undefined;
  }

  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.toString("base64url") !== value ||
    (expectedLength !== undefined && decoded.length !== expectedLength)
  ) {
    return undefined;
  }
  return decoded;
}

function assertProviderContext(provider: Provider, accountId: string): void {
  if (
    (provider !== "spotify" && provider !== "yandex") ||
    !CANONICAL_UUID_PATTERN.test(accountId)
  ) {
    throw new Error(SECRET_ERROR);
  }
}

function validateBoundedToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_TOKEN_LENGTH
  );
}

function validateSecret(provider: Provider, value: unknown): ProviderSecret {
  if (!isPlainObject(value)) {
    throw new Error(SECRET_ERROR);
  }

  if (provider === "spotify") {
    if (
      !hasExactKeys(value, ["accessToken", "expiresAt", "refreshToken"]) ||
      !validateBoundedToken(value.accessToken) ||
      !validateBoundedToken(value.refreshToken) ||
      typeof value.expiresAt !== "string" ||
      value.expiresAt.length > 64 ||
      !ISO_TIMESTAMP_PATTERN.test(value.expiresAt) ||
      !Number.isFinite(Date.parse(value.expiresAt))
    ) {
      throw new Error(SECRET_ERROR);
    }

    return {
      accessToken: value.accessToken,
      refreshToken: value.refreshToken,
      expiresAt: value.expiresAt,
    };
  }

  if (
    !hasExactKeys(value, ["oauthToken"]) ||
    !validateBoundedToken(value.oauthToken)
  ) {
    throw new Error(SECRET_ERROR);
  }
  return { oauthToken: value.oauthToken };
}

function validateEnvelope(value: unknown): {
  envelope: EncryptedTokenEnvelopeV1;
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
} {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ["ciphertext", "keyId", "nonce", "tag", "version"]) ||
    value.version !== 1 ||
    typeof value.keyId !== "string" ||
    !KEY_ID_PATTERN.test(value.keyId) ||
    typeof value.nonce !== "string" ||
    typeof value.ciphertext !== "string" ||
    value.ciphertext.length > MAX_ENCODED_CIPHERTEXT_LENGTH ||
    typeof value.tag !== "string"
  ) {
    throw new Error(ENVELOPE_ERROR);
  }

  const nonce = decodeBase64Url(value.nonce, 12);
  const ciphertext = decodeBase64Url(value.ciphertext);
  const tag = decodeBase64Url(value.tag, 16);
  if (
    nonce === undefined ||
    ciphertext === undefined ||
    ciphertext.length > MAX_SECRET_BYTES ||
    tag === undefined
  ) {
    throw new Error(ENVELOPE_ERROR);
  }

  return {
    envelope: {
      version: 1,
      keyId: value.keyId,
      nonce: value.nonce,
      ciphertext: value.ciphertext,
      tag: value.tag,
    },
    nonce,
    ciphertext,
    tag,
  };
}

function associatedData(provider: Provider, accountId: string): Buffer {
  return Buffer.from(
    `apollo-tf-integrations-token:v1:${provider}:${accountId}`,
    "utf8",
  );
}

export function parseProviderTokenKeyring(raw: string): ProviderTokenKeyring {
  try {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 4_096) {
      throw new Error(KEYRING_ERROR);
    }
    const parsed: unknown = JSON.parse(raw);
    if (
      !isPlainObject(parsed) ||
      !hasExactKeys(parsed, ["activeKeyId", "keys"]) ||
      typeof parsed.activeKeyId !== "string" ||
      !KEY_ID_PATTERN.test(parsed.activeKeyId) ||
      !isPlainObject(parsed.keys)
    ) {
      throw new Error(KEYRING_ERROR);
    }

    const entries = Object.entries(parsed.keys);
    if (entries.length < 1 || entries.length > 4) {
      throw new Error(KEYRING_ERROR);
    }

    const keys = new Map<string, Buffer>();
    const encodedValues = new Set<string>();
    for (const [keyId, encoded] of entries) {
      if (
        !KEY_ID_PATTERN.test(keyId) ||
        typeof encoded !== "string" ||
        encodedValues.has(encoded)
      ) {
        throw new Error(KEYRING_ERROR);
      }
      const key = decodeBase64Url(encoded, 32);
      if (key === undefined) {
        throw new Error(KEYRING_ERROR);
      }
      encodedValues.add(encoded);
      keys.set(keyId, key);
    }
    if (!keys.has(parsed.activeKeyId)) {
      throw new Error(KEYRING_ERROR);
    }

    const keyring = Object.freeze({
      activeKeyId: parsed.activeKeyId,
      keyIds: Object.freeze([...keys.keys()]),
    });
    keyringMaterial.set(keyring, keys);
    return keyring;
  } catch {
    throw new Error(KEYRING_ERROR);
  }
}

export class ProviderTokenVault {
  readonly #keyring: ProviderTokenKeyring;
  readonly #keys: ReadonlyMap<string, Buffer>;

  constructor(keyring: ProviderTokenKeyring) {
    const keys = keyringMaterial.get(keyring);
    if (keys === undefined) {
      throw new Error(KEYRING_ERROR);
    }
    this.#keyring = keyring;
    this.#keys = keys;
  }

  encrypt(
    provider: "spotify",
    accountId: string,
    secret: SpotifySecret,
  ): EncryptedTokenEnvelopeV1;
  encrypt(
    provider: "yandex",
    accountId: string,
    secret: YandexSecret,
  ): EncryptedTokenEnvelopeV1;
  encrypt(
    provider: Provider,
    accountId: string,
    secret: ProviderSecret,
  ): EncryptedTokenEnvelopeV1 {
    try {
      assertProviderContext(provider, accountId);
      const validatedSecret = validateSecret(provider, secret);
      const plaintext = Buffer.from(JSON.stringify(validatedSecret), "utf8");
      if (plaintext.length > MAX_SECRET_BYTES) {
        throw new Error(SECRET_ERROR);
      }

      const key = this.#keys.get(this.#keyring.activeKeyId);
      if (key === undefined) {
        throw new Error(KEYRING_ERROR);
      }
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce, {
        authTagLength: 16,
      });
      cipher.setAAD(associatedData(provider, accountId));
      const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      plaintext.fill(0);

      return Object.freeze({
        version: 1,
        keyId: this.#keyring.activeKeyId,
        nonce: nonce.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
        tag: tag.toString("base64url"),
      });
    } catch {
      throw new Error(SECRET_ERROR);
    }
  }

  decrypt(
    provider: "spotify",
    accountId: string,
    envelope: EncryptedTokenEnvelopeV1,
  ): SpotifySecret;
  decrypt(
    provider: "yandex",
    accountId: string,
    envelope: EncryptedTokenEnvelopeV1,
  ): YandexSecret;
  decrypt(
    provider: Provider,
    accountId: string,
    value: EncryptedTokenEnvelopeV1,
  ): ProviderSecret {
    try {
      assertProviderContext(provider, accountId);
      const { envelope, nonce, ciphertext, tag } = validateEnvelope(value);
      const key = this.#keys.get(envelope.keyId);
      if (key === undefined) {
        throw new Error(ENVELOPE_ERROR);
      }

      const decipher = createDecipheriv("aes-256-gcm", key, nonce, {
        authTagLength: 16,
      });
      decipher.setAAD(associatedData(provider, accountId));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      if (plaintext.length > MAX_SECRET_BYTES) {
        plaintext.fill(0);
        throw new Error(ENVELOPE_ERROR);
      }

      try {
        return validateSecret(
          provider,
          JSON.parse(plaintext.toString("utf8")) as unknown,
        );
      } finally {
        plaintext.fill(0);
      }
    } catch {
      throw new Error(ENVELOPE_ERROR);
    }
  }
}
