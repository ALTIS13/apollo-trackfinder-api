import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

import type { JWK } from "jose";
import { z } from "zod";

import { PlatformAssertionSigner } from "./domain/assertions.js";
import { OAuthClientRegistry } from "./domain/oauth-clients.js";

export const MAX_PLATFORM_SECRET_FILE_BYTES = 64 * 1_024;

const publicJwksFileSchema = z
  .object({ keys: z.array(z.unknown()).min(1).max(3) })
  .strict();

export interface PlatformRuntimeConfig {
  readonly allowedOrigins: readonly string[];
  readonly assertionPrivateJwk: JWK;
  readonly assertionPublicJwks: readonly JWK[];
  readonly databaseUrl: string;
  readonly developmentTokenEcho: boolean;
  readonly introspectionClientId: string;
  readonly issuer: string;
  readonly nodeEnv: string;
  readonly oauthClients: OAuthClientRegistry;
  readonly operatorBootstrapToken: string;
  readonly port: number;
  readonly redisUrl: string;
  readonly trustProxyHops: number;
}

function requiredEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must be configured`);
  }
  return value;
}

function configuredOrigins(value: string): readonly string[] {
  const origins = value
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  if (origins.length === 0) {
    throw new Error("APOLLO_ALLOWED_ORIGINS must not be empty");
  }
  for (const origin of origins) {
    try {
      if (new URL(origin).origin !== origin) {
        throw new Error();
      }
    } catch {
      throw new Error("APOLLO_ALLOWED_ORIGINS entries must be exact origins");
    }
  }
  return Object.freeze([...new Set(origins)]);
}

function configuredPort(environment: NodeJS.ProcessEnv): number {
  const value = environment.PORT ?? "3000";
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be a valid TCP port");
  }
  return port;
}

function configuredTrustProxyHops(environment: NodeJS.ProcessEnv): number {
  const value = environment.APOLLO_TRUST_PROXY_HOPS ?? "0";
  const hops = Number(value);
  if (!Number.isInteger(hops) || hops < 0 || hops > 2) {
    throw new Error("APOLLO_TRUST_PROXY_HOPS must be an integer from 0 to 2");
  }
  return hops;
}

function configuredNodeEnvironment(environment: NodeJS.ProcessEnv): string {
  const nodeEnv = environment.NODE_ENV ?? "development";
  if (!["development", "test", "production"].includes(nodeEnv)) {
    throw new Error("NODE_ENV is not supported");
  }
  return nodeEnv;
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

function configuredIssuer(value: string, nodeEnv: string): string {
  let issuer: URL;
  try {
    issuer = new URL(value);
  } catch {
    throw new Error("APOLLO_ISSUER must be an exact issuer origin");
  }
  const exactOrigin =
    issuer.origin === value &&
    issuer.username.length === 0 &&
    issuer.password.length === 0 &&
    issuer.search.length === 0 &&
    issuer.hash.length === 0;
  const productionIssuer =
    nodeEnv === "production" &&
    issuer.protocol === "https:" &&
    !isLoopbackHostname(issuer.hostname);
  const developmentIssuer =
    nodeEnv === "development" &&
    issuer.protocol === "http:" &&
    isLoopbackHostname(issuer.hostname);
  const secureNonProductionIssuer =
    nodeEnv !== "production" && issuer.protocol === "https:";
  if (
    !exactOrigin ||
    (!productionIssuer && !developmentIssuer && !secureNonProductionIssuer)
  ) {
    throw new Error("APOLLO_ISSUER must be an exact allowed issuer origin");
  }
  return value;
}

class DuplicateAwareJsonScanner {
  private index = 0;

  constructor(private readonly source: string) {}

  scan(): void {
    this.skipWhitespace();
    this.scanValue();
    this.skipWhitespace();
    if (this.index !== this.source.length) this.invalid();
  }

  private scanValue(): void {
    this.skipWhitespace();
    const character = this.source[this.index];
    if (character === "{") {
      this.scanObject();
    } else if (character === "[") {
      this.scanArray();
    } else if (character === '"') {
      this.scanString();
    } else if (character === "t") {
      this.scanLiteral("true");
    } else if (character === "f") {
      this.scanLiteral("false");
    } else if (character === "n") {
      this.scanLiteral("null");
    } else {
      this.scanNumber();
    }
  }

  private scanObject(): void {
    this.index += 1;
    this.skipWhitespace();
    if (this.source[this.index] === "}") {
      this.index += 1;
      return;
    }
    const keys = new Set<string>();
    for (;;) {
      this.skipWhitespace();
      if (this.source[this.index] !== '"') this.invalid();
      const key = this.scanString();
      if (keys.has(key)) this.invalid();
      keys.add(key);
      this.skipWhitespace();
      if (this.source[this.index] !== ":") this.invalid();
      this.index += 1;
      this.scanValue();
      this.skipWhitespace();
      const separator = this.source[this.index];
      if (separator === "}") {
        this.index += 1;
        return;
      }
      if (separator !== ",") this.invalid();
      this.index += 1;
    }
  }

  private scanArray(): void {
    this.index += 1;
    this.skipWhitespace();
    if (this.source[this.index] === "]") {
      this.index += 1;
      return;
    }
    for (;;) {
      this.scanValue();
      this.skipWhitespace();
      const separator = this.source[this.index];
      if (separator === "]") {
        this.index += 1;
        return;
      }
      if (separator !== ",") this.invalid();
      this.index += 1;
    }
  }

  private scanString(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.source.length) {
      const character = this.source[this.index]!;
      if (character === '"') {
        this.index += 1;
        return JSON.parse(this.source.slice(start, this.index)) as string;
      }
      if (character.charCodeAt(0) < 0x20) this.invalid();
      if (character === "\\") {
        this.index += 1;
        const escape = this.source[this.index];
        if (escape === "u") {
          if (
            !/^[0-9a-fA-F]{4}$/.test(
              this.source.slice(this.index + 1, this.index + 5),
            )
          ) {
            this.invalid();
          }
          this.index += 5;
          continue;
        }
        if (
          escape === undefined ||
          !['"', "\\", "/", "b", "f", "n", "r", "t"].includes(escape)
        ) {
          this.invalid();
        }
      }
      this.index += 1;
    }
    this.invalid();
  }

  private scanLiteral(literal: string): void {
    if (
      this.source.slice(this.index, this.index + literal.length) !== literal
    ) {
      this.invalid();
    }
    this.index += literal.length;
  }

  private scanNumber(): void {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      this.source.slice(this.index),
    );
    if (match === null) this.invalid();
    this.index += match[0].length;
  }

  private skipWhitespace(): void {
    while (
      this.index < this.source.length &&
      /[\t\n\r ]/.test(this.source[this.index]!)
    ) {
      this.index += 1;
    }
  }

  private invalid(): never {
    throw new SyntaxError("Invalid JSON");
  }
}

export function assertDuplicateFreeJson(source: string): void {
  new DuplicateAwareJsonScanner(source).scan();
}

function parseDuplicateAwareJson(source: string): unknown {
  assertDuplicateFreeJson(source);
  return JSON.parse(source) as unknown;
}

async function readSecretJson(
  environment: NodeJS.ProcessEnv,
  variableName: string,
): Promise<unknown> {
  const path = requiredEnvironment(environment, variableName);
  if (!isAbsolute(path)) {
    throw new Error(`${variableName} is invalid`);
  }
  try {
    const handle = await open(path, "r");
    try {
      const metadata = await handle.stat();
      if (
        !metadata.isFile() ||
        metadata.size < 1 ||
        metadata.size > MAX_PLATFORM_SECRET_FILE_BYTES
      ) {
        throw new Error();
      }
      const content = await handle.readFile();
      if (
        content.byteLength < 1 ||
        content.byteLength > MAX_PLATFORM_SECRET_FILE_BYTES
      ) {
        throw new Error();
      }
      const source = new TextDecoder("utf-8", { fatal: true }).decode(content);
      if (source.trim().length === 0) throw new Error();
      return parseDuplicateAwareJson(source);
    } finally {
      await handle.close();
    }
  } catch {
    throw new Error(`${variableName} is invalid`);
  }
}

export async function parsePlatformRuntimeConfig(
  environment: NodeJS.ProcessEnv,
): Promise<PlatformRuntimeConfig> {
  const nodeEnv = configuredNodeEnvironment(environment);
  const developmentTokenEcho =
    environment.APOLLO_DEVELOPMENT_TOKEN_ECHO === "true";
  if (nodeEnv === "production" && developmentTokenEcho) {
    throw new Error(
      "APOLLO_DEVELOPMENT_TOKEN_ECHO is prohibited in production",
    );
  }
  const issuer = configuredIssuer(
    requiredEnvironment(environment, "APOLLO_ISSUER"),
    nodeEnv,
  );
  const introspectionClientId = requiredEnvironment(
    environment,
    "APOLLO_INTROSPECTION_CLIENT_ID",
  );

  let assertionPrivateJwk: JWK;
  let assertionPublicJwks: readonly JWK[];
  let oauthClients: OAuthClientRegistry;
  try {
    const [privateSource, publicSource, clientSource] = await Promise.all([
      readSecretJson(environment, "APOLLO_ASSERTION_PRIVATE_JWK_FILE"),
      readSecretJson(environment, "APOLLO_ASSERTION_PUBLIC_JWKS_FILE"),
      readSecretJson(environment, "APOLLO_OAUTH_CLIENTS_FILE"),
    ]);
    const publicFile = publicJwksFileSchema.parse(publicSource);
    assertionPrivateJwk = Object.freeze({
      ...(privateSource as JWK),
    });
    assertionPublicJwks = Object.freeze(
      publicFile.keys.map((key) => Object.freeze({ ...(key as JWK) })),
    );
    oauthClients = OAuthClientRegistry.parse(clientSource, nodeEnv);
    const assertionSigner = new PlatformAssertionSigner({
      issuer,
      activePrivateJwk: assertionPrivateJwk,
      publicJwks: assertionPublicJwks,
      clock: () => new Date(),
    });
    await assertionSigner.ready();
  } catch {
    throw new Error("Platform OAuth secret configuration is invalid");
  }
  const introspectionClient = oauthClients.get(introspectionClientId);
  if (
    introspectionClient === null ||
    introspectionClient.audience !== "apollo-tf"
  ) {
    throw new Error("APOLLO_INTROSPECTION_CLIENT_ID is invalid");
  }

  return Object.freeze({
    allowedOrigins: configuredOrigins(
      requiredEnvironment(environment, "APOLLO_ALLOWED_ORIGINS"),
    ),
    assertionPrivateJwk,
    assertionPublicJwks,
    databaseUrl: requiredEnvironment(environment, "DATABASE_URL"),
    developmentTokenEcho,
    introspectionClientId,
    issuer,
    nodeEnv,
    oauthClients,
    operatorBootstrapToken: requiredEnvironment(
      environment,
      "APOLLO_OPERATOR_BOOTSTRAP_TOKEN",
    ),
    port: configuredPort(environment),
    redisUrl: requiredEnvironment(environment, "APOLLO_REDIS_URL"),
    trustProxyHops: configuredTrustProxyHops(environment),
  });
}
