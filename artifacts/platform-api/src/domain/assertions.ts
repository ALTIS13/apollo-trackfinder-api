import { randomUUID } from "node:crypto";

import {
  PLATFORM_MODULE_KEYS,
  platformAssertionClaimsSchema,
  type PlatformAssertionClaims,
} from "@workspace/platform-contract";
import { importJWK, SignJWT, type JWK } from "jose";
import { z } from "zod";

import { platformDomainError } from "./errors.js";
import type { Clock } from "./registration.js";

const baseKeyFields = {
  kty: z.literal("OKP"),
  crv: z.literal("Ed25519"),
  alg: z.literal("EdDSA"),
  use: z.literal("sig"),
  kid: z.string().min(1).max(128),
  x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
};

const privateJwkSchema = z
  .object({
    ...baseKeyFields,
    d: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();
const publicJwkSchema = z.object(baseKeyFields).strict();
const publicJwksSchema = z.array(publicJwkSchema).min(1).max(3);
const signerConfigSchema = z
  .object({
    issuer: z.string().url().max(2048),
    activePrivateJwk: privateJwkSchema,
    publicJwks: publicJwksSchema,
    clock: z.custom<Clock>((value) => typeof value === "function"),
  })
  .strict();
const signingInputSchema = z
  .object({
    accountId: z.string().uuid(),
    sessionId: z.string().uuid(),
    installationId: z.string().uuid(),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    audience: z.literal("apollo-tf"),
    entitlements: z.array(z.enum(PLATFORM_MODULE_KEYS)).max(
      PLATFORM_MODULE_KEYS.length,
    ),
  })
  .strict()
  .superRefine(({ entitlements }, context) => {
    const sorted = [...entitlements].sort();
    if (
      new Set(entitlements).size !== entitlements.length ||
      sorted.some((value, index) => value !== entitlements[index])
    ) {
      context.addIssue({
        code: "custom",
        message: "Entitlements must be sorted and unique",
      });
    }
  });

export interface PlatformAssertionSigningInput {
  readonly accountId: string;
  readonly sessionId: string;
  readonly installationId: string;
  readonly nonce: string;
  readonly audience: "apollo-tf";
  readonly entitlements: readonly (typeof PLATFORM_MODULE_KEYS)[number][];
}

export interface SignedPlatformAssertion {
  readonly assertion: string;
  readonly claims: PlatformAssertionClaims;
}

export interface PlatformAssertionSignerConfig {
  readonly issuer: string;
  readonly activePrivateJwk: JWK;
  readonly publicJwks: readonly JWK[];
  readonly clock: Clock;
}

function deepFrozenPublicJwks(
  keys: readonly z.infer<typeof publicJwkSchema>[],
): Readonly<{ readonly keys: readonly JWK[] }> {
  const clonedKeys = keys.map((key) => Object.freeze({ ...key }));
  return Object.freeze({ keys: Object.freeze(clonedKeys) });
}

function policyUnavailable(): never {
  throw platformDomainError("policy_unavailable");
}

export class PlatformAssertionSigner {
  readonly #issuer: string;
  readonly #kid: string;
  readonly #clock: Clock;
  readonly #privateKey: ReturnType<typeof importJWK>;
  readonly #publicJwks: Readonly<{ readonly keys: readonly JWK[] }>;

  constructor(config: PlatformAssertionSignerConfig) {
    const parsed = signerConfigSchema.parse(config);
    const kids = parsed.publicJwks.map(({ kid }) => kid);
    if (new Set(kids).size !== kids.length) {
      throw new TypeError("Duplicate assertion key ID");
    }
    const activePublicJwk = parsed.publicJwks.find(
      ({ kid }) => kid === parsed.activePrivateJwk.kid,
    );
    if (
      activePublicJwk === undefined ||
      activePublicJwk.x !== parsed.activePrivateJwk.x
    ) {
      throw new TypeError("Active assertion public key does not match");
    }

    this.#issuer = parsed.issuer;
    this.#kid = parsed.activePrivateJwk.kid;
    this.#clock = parsed.clock;
    this.#privateKey = importJWK(parsed.activePrivateJwk, "EdDSA");
    this.#publicJwks = deepFrozenPublicJwks(parsed.publicJwks);
  }

  publicJwks(): Readonly<{ readonly keys: readonly JWK[] }> {
    return this.#publicJwks;
  }

  async sign(
    input: PlatformAssertionSigningInput,
  ): Promise<SignedPlatformAssertion> {
    const parsed = signingInputSchema.safeParse(input);
    const now = this.#clock();
    if (!parsed.success || !Number.isFinite(now.getTime())) {
      policyUnavailable();
    }
    const iat = Math.floor(now.getTime() / 1_000);
    const jti = randomUUID();
    const claims = platformAssertionClaimsSchema.parse({
      iss: this.#issuer,
      aud: parsed.data.audience,
      sub: parsed.data.accountId,
      sid: parsed.data.sessionId,
      installation_id: parsed.data.installationId,
      nonce: parsed.data.nonce,
      account_status: "active",
      entitlements: parsed.data.entitlements,
      jti,
      iat,
      nbf: iat - 5,
      exp: iat + 300,
    });

    try {
      const assertion = await new SignJWT({
        sid: claims.sid,
        installation_id: claims.installation_id,
        nonce: claims.nonce,
        account_status: claims.account_status,
        entitlements: claims.entitlements,
      })
        .setProtectedHeader({ alg: "EdDSA", kid: this.#kid, typ: "JWT" })
        .setIssuer(claims.iss)
        .setAudience(claims.aud)
        .setSubject(claims.sub)
        .setIssuedAt(claims.iat)
        .setNotBefore(claims.nbf)
        .setExpirationTime(claims.exp)
        .setJti(claims.jti)
        .sign(await this.#privateKey);
      return { assertion, claims };
    } catch {
      policyUnavailable();
    }
  }
}
