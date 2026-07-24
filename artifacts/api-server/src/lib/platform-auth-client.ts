import { timingSafeEqual } from "node:crypto";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

import {
  authorizationCodeExchangeSchema,
  authorizationRequestSchema,
  platformAssertionClaimsSchema,
  policyIntrospectionRequestSchema,
  policyIntrospectionResponseSchema,
  type PlatformAssertionClaims,
  type PolicyIntrospectionRequest,
  type PolicyIntrospectionResponse,
} from "@workspace/platform-contract";
import {
  createRemoteJWKSet,
  customFetch,
  decodeProtectedHeader,
  jwtVerify,
} from "jose";
import { z } from "zod";

const AUTHORIZATION_PATH = "/v1/oauth/authorize";
const TOKEN_PATH = "/v1/oauth/token";
const INTROSPECTION_PATH = "/v1/oauth/introspect";
const JWKS_PATH = "/.well-known/jwks.json";
const ASSERTION_AUDIENCE = "apollo-tf";
const MAX_SECRET_FILE_BYTES = 4_096;
const MAX_CLIENT_SECRET_CHARACTERS = 512;
const BASIC_AUTHORIZATION_HEADER_MAX_BYTES = 2_048;
const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_JWKS_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1_024;
const JSON_CONTENT_TYPE_PATTERN =
  /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
const BASE64URL_32_BYTE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const tokenResponseSchema = z
  .object({
    access_token: z.string().min(1).max(8_192),
    token_type: z.literal("Bearer"),
    expires_in: z.number().int().positive().max(300),
  })
  .strict();

const exchangeInputSchema = z
  .object({
    code: z.string().min(32).max(512),
    codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
    expectedNonce: z.string().regex(BASE64URL_32_BYTE_PATTERN),
  })
  .strict();

const authorizationInputSchema = authorizationRequestSchema.omit({
  clientId: true,
  redirectUri: true,
  responseType: true,
  codeChallengeMethod: true,
});

export class PlatformAuthUnavailableError extends Error {
  constructor() {
    super("Platform authentication unavailable");
    this.name = "PlatformAuthUnavailableError";
  }
}

export interface PlatformAuthClientOptions {
  readonly issuer: string;
  readonly apiOrigin?: string;
  readonly allowPrivateHttpTransport?: boolean;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly clientSecret: string;
  readonly timeoutMs?: number;
  readonly jwksTimeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly fetch?: typeof fetch;
}

export interface PlatformCodeExchangeResult {
  readonly assertion: string;
  readonly claims: PlatformAssertionClaims;
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

function parseExactOrigin(value: string, nodeEnv?: string): URL {
  const url = new URL(value);
  const exact =
    url.origin === value &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.search.length === 0 &&
    url.hash.length === 0;
  const secure = url.protocol === "https:";
  const developmentLoopback =
    nodeEnv !== "production" &&
    url.protocol === "http:" &&
    isLoopbackHostname(url.hostname);
  if (!exact || (!secure && !developmentLoopback)) {
    throw new Error("invalid origin");
  }
  return url;
}

function parseApiOrigin(
  value: string,
  issuer: URL,
  allowPrivateHttpTransport: boolean,
): URL {
  const url = new URL(value);
  const exact =
    url.origin === value &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.pathname === "/" &&
    url.search.length === 0 &&
    url.hash.length === 0;
  if (!exact) throw new Error("invalid API origin");
  if (url.protocol === "https:") return url;
  if (
    url.origin === issuer.origin &&
    url.protocol === "http:" &&
    isLoopbackHostname(url.hostname)
  ) {
    return url;
  }
  if (
    allowPrivateHttpTransport &&
    url.protocol === "http:" &&
    url.hostname === "platform-api" &&
    url.port === "8080"
  ) {
    return url;
  }
  throw new Error("invalid API origin");
}

function parseExactCallback(value: string, nodeEnv?: string): URL {
  const url = new URL(value);
  const secure = url.protocol === "https:";
  const developmentLoopback =
    nodeEnv !== "production" &&
    url.protocol === "http:" &&
    isLoopbackHostname(url.hostname);
  if (
    url.href !== value ||
    url.username.length !== 0 ||
    url.password.length !== 0 ||
    url.search.length !== 0 ||
    url.hash.length !== 0 ||
    url.pathname !== "/api/auth/callback" ||
    (!secure && !developmentLoopback)
  ) {
    throw new Error("invalid callback");
  }
  return url;
}

function positiveBoundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new Error("invalid bound");
  }
  return resolved;
}

async function readBoundedResponse(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > maximumBytes)
  ) {
    throw new Error("invalid response");
  }
  if (response.body === null) throw new Error("invalid response");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error("invalid response");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function strictJsonResponse(
  response: Response,
  maximumBytes: number,
): Promise<unknown> {
  if (!response.ok) throw new Error("invalid response");
  const contentType = response.headers.get("content-type")?.trim() ?? "";
  if (!JSON_CONTENT_TYPE_PATTERN.test(contentType)) {
    throw new Error("invalid response");
  }
  const source = await readBoundedResponse(response, maximumBytes);
  return JSON.parse(source) as unknown;
}

function fixedLengthEqual(left: string, right: string): boolean {
  if (
    !BASE64URL_32_BYTE_PATTERN.test(left) ||
    !BASE64URL_32_BYTE_PATTERN.test(right)
  ) {
    return false;
  }
  const leftBytes = Buffer.from(left, "base64url");
  const rightBytes = Buffer.from(right, "base64url");
  return (
    leftBytes.byteLength === 32 &&
    rightBytes.byteLength === 32 &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function validConfidentialClientCredentials(
  clientId: string,
  clientSecret: string,
): boolean {
  if (
    !/^[A-Za-z0-9._~-]{1,128}$/.test(clientId) ||
    clientSecret.length < 1 ||
    clientSecret.length > MAX_CLIENT_SECRET_CHARACTERS ||
    clientSecret.trim() !== clientSecret ||
    /[\u0000-\u001f\u007f]/u.test(clientSecret)
  ) {
    return false;
  }
  const encoded = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString(
    "base64",
  );
  return (
    Buffer.byteLength(`Basic ${encoded}`, "utf8") <=
    BASIC_AUTHORIZATION_HEADER_MAX_BYTES
  );
}

export class PlatformAuthClient {
  private readonly issuer: string;
  private readonly apiOrigin: string;
  private readonly clientId: string;
  private readonly redirectUri: string;
  private readonly clientSecret: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetchImplementation: typeof fetch;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(options: PlatformAuthClientOptions) {
    const issuer = parseExactOrigin(options.issuer);
    const apiOrigin = parseApiOrigin(
      options.apiOrigin ?? options.issuer,
      issuer,
      options.allowPrivateHttpTransport === true,
    );
    parseExactCallback(options.redirectUri);
    if (
      !validConfidentialClientCredentials(
        options.clientId,
        options.clientSecret,
      )
    ) {
      throw new Error("TF authentication configuration is invalid");
    }

    this.issuer = issuer.origin;
    this.apiOrigin = apiOrigin.origin;
    this.clientId = options.clientId;
    this.redirectUri = options.redirectUri;
    this.clientSecret = options.clientSecret;
    this.timeoutMs = positiveBoundedInteger(
      options.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      30_000,
    );
    const jwksTimeoutMs = positiveBoundedInteger(
      options.jwksTimeoutMs,
      DEFAULT_JWKS_TIMEOUT_MS,
      30_000,
    );
    this.maxResponseBytes = positiveBoundedInteger(
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      1024 * 1024,
    );
    this.fetchImplementation = options.fetch ?? fetch;

    const jwksUrl = new URL(JWKS_PATH, this.apiOrigin);
    this.jwks = createRemoteJWKSet(jwksUrl, {
      timeoutDuration: jwksTimeoutMs,
      cooldownDuration: 30_000,
      cacheMaxAge: 300_000,
      [customFetch]: async (url, requestOptions) => {
        if (url !== jwksUrl.href) throw new Error("invalid JWKS URL");
        const response = await this.fetchImplementation(url, {
          ...requestOptions,
          redirect: "manual",
        });
        const body = await strictJsonResponse(response, this.maxResponseBytes);
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
  }

  createAuthorizationUrl(
    input: z.input<typeof authorizationInputSchema>,
  ): string {
    const parsed = authorizationInputSchema.safeParse(input);
    if (!parsed.success) throw new PlatformAuthUnavailableError();
    const url = new URL(AUTHORIZATION_PATH, this.issuer);
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", parsed.data.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", parsed.data.state);
    url.searchParams.set("nonce", parsed.data.nonce);
    url.searchParams.set("installation_id", parsed.data.installationId);
    url.searchParams.set("installation_label", parsed.data.installationLabel);
    return url.toString();
  }

  async exchangeCode(
    input: z.input<typeof exchangeInputSchema>,
  ): Promise<PlatformCodeExchangeResult> {
    try {
      const parsed = exchangeInputSchema.parse(input);
      authorizationCodeExchangeSchema.parse({
        grantType: "authorization_code",
        clientId: this.clientId,
        code: parsed.code,
        redirectUri: this.redirectUri,
        codeVerifier: parsed.codeVerifier,
      });
      const body = new URLSearchParams();
      body.set("grant_type", "authorization_code");
      body.set("code", parsed.code);
      body.set("redirect_uri", this.redirectUri);
      body.set("code_verifier", parsed.codeVerifier);
      const token = tokenResponseSchema.parse(
        await this.requestJson(TOKEN_PATH, {
          headers: {
            Authorization: this.basicAuthorization(),
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: body.toString(),
        }),
      );

      const protectedHeader = decodeProtectedHeader(token.access_token);
      if (
        protectedHeader.alg !== "EdDSA" ||
        typeof protectedHeader.kid !== "string" ||
        protectedHeader.kid.length < 1 ||
        protectedHeader.kid.length > 128
      ) {
        throw new Error("invalid assertion");
      }
      const verified = await jwtVerify(token.access_token, this.jwks, {
        issuer: this.issuer,
        audience: ASSERTION_AUDIENCE,
        algorithms: ["EdDSA"],
        clockTolerance: 5,
        maxTokenAge: 300,
      });
      const claims = platformAssertionClaimsSchema.parse(verified.payload);
      if (!fixedLengthEqual(claims.nonce, parsed.expectedNonce)) {
        throw new Error("invalid assertion");
      }
      return { assertion: token.access_token, claims };
    } catch {
      throw new PlatformAuthUnavailableError();
    }
  }

  async introspect(
    input: PolicyIntrospectionRequest,
  ): Promise<PolicyIntrospectionResponse> {
    try {
      const parsed = policyIntrospectionRequestSchema.parse(input);
      return policyIntrospectionResponseSchema.parse(
        await this.requestJson(INTROSPECTION_PATH, {
          headers: {
            Authorization: this.basicAuthorization(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify(parsed),
        }),
      );
    } catch {
      throw new PlatformAuthUnavailableError();
    }
  }

  private basicAuthorization(): string {
    return `Basic ${Buffer.from(
      `${this.clientId}:${this.clientSecret}`,
      "utf8",
    ).toString("base64")}`;
  }

  private async requestJson(
    path: typeof TOKEN_PATH | typeof INTROSPECTION_PATH,
    options: {
      readonly headers: Readonly<Record<string, string>>;
      readonly body: string;
    },
  ): Promise<unknown> {
    const url = new URL(path, this.apiOrigin);
    const response = await this.fetchImplementation(url, {
      method: "POST",
      headers: options.headers,
      body: options.body,
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    return strictJsonResponse(response, this.maxResponseBytes);
  }
}

export interface TfAuthRuntimeConfig {
  readonly nodeEnv: "development" | "production" | "test";
  readonly issuer: string;
  readonly apiOrigin: string;
  readonly allowPrivateHttpTransport: boolean;
  readonly clientId: string;
  readonly callbackUrl: string;
  readonly webOrigin: string;
  readonly clientSecret: string;
  readonly authRedisUrl: string;
  readonly bridgePkceVerifier?: string;
}

function requiredEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name];
  if (value === undefined || value.length === 0 || value.trim() !== value) {
    throw new Error("invalid environment");
  }
  return value;
}

interface SecretFileHandle {
  stat(): Promise<{
    isFile(): boolean;
    readonly size: number;
  }>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: null,
  ): Promise<{ readonly bytesRead: number }>;
  close(): Promise<void>;
}

export interface TfAuthRuntimeDependencies {
  readonly openSecretFile?: (
    path: string,
    flags: "r",
  ) => Promise<SecretFileHandle>;
}

async function readClientSecret(
  path: string,
  openSecretFile: NonNullable<TfAuthRuntimeDependencies["openSecretFile"]>,
): Promise<string> {
  if (!isAbsolute(path)) throw new Error("invalid secret");
  const handle = await openSecretFile(path, "r");
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size < 1 ||
      metadata.size > MAX_SECRET_FILE_BYTES
    ) {
      throw new Error("invalid secret");
    }
    const buffer = new Uint8Array(MAX_SECRET_FILE_BYTES + 1);
    let total = 0;
    while (total < buffer.byteLength) {
      const { bytesRead } = await handle.read(
        buffer,
        total,
        buffer.byteLength - total,
        null,
      );
      if (
        !Number.isSafeInteger(bytesRead) ||
        bytesRead < 0 ||
        bytesRead > buffer.byteLength - total
      ) {
        throw new Error("invalid secret");
      }
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    const finalMetadata = await handle.stat();
    if (
      total < 1 ||
      total > MAX_SECRET_FILE_BYTES ||
      !finalMetadata.isFile() ||
      finalMetadata.size !== total
    ) {
      throw new Error("invalid secret");
    }
    const bytes = buffer.subarray(0, total);
    const secret = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (
      secret.length < 1 ||
      secret.length > MAX_SECRET_FILE_BYTES ||
      secret.trim() !== secret ||
      /[\u0000-\u001f\u007f]/u.test(secret)
    ) {
      throw new Error("invalid secret");
    }
    return secret;
  } finally {
    await handle.close();
  }
}

function parseRedisUrl(value: string): string {
  const url = new URL(value);
  if (
    !["redis:", "rediss:"].includes(url.protocol) ||
    url.hostname.length === 0 ||
    url.hash.length !== 0
  ) {
    throw new Error("invalid Redis URL");
  }
  return value;
}

export async function parseTfAuthRuntimeConfig(
  environment: NodeJS.ProcessEnv,
  dependencies: TfAuthRuntimeDependencies = {},
): Promise<TfAuthRuntimeConfig> {
  try {
    const nodeEnv = environment.NODE_ENV ?? "development";
    if (!["development", "production", "test"].includes(nodeEnv)) {
      throw new Error("invalid node environment");
    }
    const issuer = parseExactOrigin(
      requiredEnvironment(environment, "APOLLO_PLATFORM_ISSUER"),
      nodeEnv,
    );
    const bridgeFlag = environment.APOLLO_TF_BRIDGE_ALLOW_INTERNAL_HTTP;
    if (
      bridgeFlag !== undefined &&
      bridgeFlag !== "false" &&
      bridgeFlag !== "true"
    ) {
      throw new Error("invalid bridge flag");
    }
    const allowPrivateHttpTransport =
      bridgeFlag === "true" && nodeEnv === "development";
    if (bridgeFlag === "true" && !allowPrivateHttpTransport) {
      throw new Error("invalid bridge mode");
    }
    const apiOrigin = parseApiOrigin(
      environment.APOLLO_PLATFORM_API_ORIGIN ?? issuer.origin,
      issuer,
      allowPrivateHttpTransport,
    ).origin;
    const callbackUrl = parseExactCallback(
      requiredEnvironment(environment, "APOLLO_TF_CALLBACK_URL"),
      nodeEnv,
    ).href;
    const webOrigin = parseExactOrigin(
      requiredEnvironment(environment, "APOLLO_TF_WEB_ORIGIN"),
      nodeEnv,
    ).origin;
    const clientId = requiredEnvironment(environment, "APOLLO_TF_CLIENT_ID");
    if (!/^[A-Za-z0-9._~-]{1,128}$/.test(clientId)) {
      throw new Error("invalid client");
    }
    const authRedisUrl = parseRedisUrl(
      requiredEnvironment(environment, "APOLLO_TF_AUTH_REDIS_URL"),
    );
    const clientSecret = await readClientSecret(
      requiredEnvironment(environment, "APOLLO_TF_CLIENT_SECRET_FILE"),
      dependencies.openSecretFile ?? open,
    );
    if (!validConfidentialClientCredentials(clientId, clientSecret)) {
      throw new Error("invalid secret");
    }
    const verifierFile = environment.APOLLO_TF_BRIDGE_PKCE_VERIFIER_FILE;
    let bridgePkceVerifier: string | undefined;
    if (verifierFile !== undefined) {
      if (
        !allowPrivateHttpTransport ||
        apiOrigin !== "http://platform-api:8080"
      ) {
        throw new Error("invalid bridge verifier");
      }
      bridgePkceVerifier = await readClientSecret(
        verifierFile,
        dependencies.openSecretFile ?? open,
      );
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(bridgePkceVerifier)) {
        throw new Error("invalid bridge verifier");
      }
    }
    return {
      nodeEnv: nodeEnv as TfAuthRuntimeConfig["nodeEnv"],
      issuer: issuer.origin,
      apiOrigin,
      allowPrivateHttpTransport,
      clientId,
      callbackUrl,
      webOrigin,
      clientSecret,
      authRedisUrl,
      bridgePkceVerifier,
    };
  } catch {
    throw new Error("TF authentication configuration is invalid");
  }
}
