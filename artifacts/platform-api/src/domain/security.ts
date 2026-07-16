import { createHash, randomBytes } from "node:crypto";

import {
  argon2id,
  hash as argonHash,
  needsRehash as argonNeedsRehash,
  verify as argonVerify,
} from "argon2";

export const ARGON2ID_PROFILE = Object.freeze({
  type: argon2id,
  version: 19,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 4,
  hashLength: 32,
});

export interface IssuedOpaqueToken {
  readonly raw: string;
  readonly digest: string;
}

export interface PasswordVerificationResult {
  readonly valid: boolean;
  readonly needsRehash: boolean;
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeModuleKey(value: string): string {
  return value.trim().toLowerCase();
}

export function digestOpaqueToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function issueOpaqueToken(bytes = 32): IssuedOpaqueToken {
  const raw = randomBytes(bytes).toString("base64url");
  return { raw, digest: digestOpaqueToken(raw) };
}

export function hashPassword(password: string): Promise<string> {
  return argonHash(password, ARGON2ID_PROFILE);
}

function hasCurrentAlgorithmAndHashLength(hash: string): boolean {
  const fields = hash.split("$");
  const algorithm = fields[1];
  const encodedHash = fields[5];
  return (
    algorithm === "argon2id" &&
    encodedHash !== undefined &&
    Buffer.from(encodedHash, "base64").length === ARGON2ID_PROFILE.hashLength
  );
}

export async function verifyPassword(
  hash: string,
  password: string,
): Promise<PasswordVerificationResult> {
  try {
    const valid = await argonVerify(hash, password);
    if (!valid) {
      return { valid: false, needsRehash: false };
    }

    return {
      valid: true,
      needsRehash:
        argonNeedsRehash(hash, ARGON2ID_PROFILE) ||
        !hasCurrentAlgorithmAndHashLength(hash),
    };
  } catch {
    return { valid: false, needsRehash: false };
  }
}
