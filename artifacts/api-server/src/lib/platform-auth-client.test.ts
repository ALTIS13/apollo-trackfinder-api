import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PlatformAuthClient,
  PlatformAuthUnavailableError,
  parseTfAuthRuntimeConfig,
} from "./platform-auth-client.js";

const ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";
const SESSION_ID = "20000000-0000-4000-8000-000000000002";
const INSTALLATION_ID = "30000000-0000-4000-8000-000000000003";
const CALLBACK_URL = "https://api.tf.apollot.ru/api/auth/callback";

const servers: Server[] = [];
const temporaryDirectories: string[] = [];

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function startServer(listener: RequestListener): Promise<string> {
  const server = createServer(listener);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function createPlatformFixture(
  options: {
    readonly tokenStatus?: number;
    readonly tokenContentType?: string;
    readonly tokenRedirect?: boolean;
    readonly tokenDelayMs?: number;
    readonly tokenBody?: string;
    readonly introspectionBody?: unknown;
    readonly introspectionContentType?: string;
    readonly assertion?: (issuer: string) => Promise<string>;
  } = {},
) {
  const activeKeyPair = await generateKeyPair("EdDSA");
  const activePublicJwk = await exportJWK(activeKeyPair.publicKey);
  const clientSecret = randomBytes(48).toString("base64url");
  const code = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const requests: Array<{
    readonly path: string;
    readonly method: string;
    readonly headers: Readonly<Record<string, string | string[] | undefined>>;
    readonly body: string;
  }> = [];
  let issuer = "";

  const issueAssertion =
    options.assertion ??
    (async (expectedIssuer: string) => {
      const now = Math.floor(Date.now() / 1_000);
      return new SignJWT({
        sid: SESSION_ID,
        installation_id: INSTALLATION_ID,
        nonce,
        account_status: "active",
        entitlements: ["tf.search", "tf.downloads"],
      })
        .setProtectedHeader({
          alg: "EdDSA",
          kid: "active-platform-key",
          typ: "JWT",
        })
        .setIssuer(expectedIssuer)
        .setAudience("apollo-tf")
        .setSubject(ACCOUNT_ID)
        .setJti(randomUUID())
        .setIssuedAt(now)
        .setNotBefore(now)
        .setExpirationTime(now + 300)
        .sign(activeKeyPair.privateKey);
    });

  issuer = await startServer(async (request, response) => {
    const path = new URL(request.url ?? "/", issuer || "http://127.0.0.1")
      .pathname;
    const body = await readRequestBody(request);
    requests.push({
      path,
      method: request.method ?? "",
      headers: request.headers,
      body,
    });

    if (path === "/.well-known/jwks.json") {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          keys: [
            {
              ...activePublicJwk,
              alg: "EdDSA",
              use: "sig",
              kid: "active-platform-key",
            },
          ],
        }),
      );
      return;
    }

    if (path === "/v1/oauth/token") {
      if (options.tokenDelayMs !== undefined) {
        await new Promise((resolve) =>
          setTimeout(resolve, options.tokenDelayMs),
        );
      }
      if (options.tokenRedirect === true) {
        response.statusCode = 302;
        response.setHeader("Location", `${issuer}/redirect-target`);
        response.end();
        return;
      }
      response.statusCode = options.tokenStatus ?? 200;
      response.setHeader(
        "Content-Type",
        options.tokenContentType ?? "application/json; charset=utf-8",
      );
      response.end(
        options.tokenBody ??
          JSON.stringify({
            access_token: await issueAssertion(issuer),
            token_type: "Bearer",
            expires_in: 300,
          }),
      );
      return;
    }

    if (path === "/v1/oauth/introspect") {
      response.setHeader(
        "Content-Type",
        options.introspectionContentType ?? "application/json",
      );
      response.end(
        JSON.stringify(
          options.introspectionBody ?? {
            active: true,
            accountId: ACCOUNT_ID,
            sessionId: SESSION_ID,
            installationId: INSTALLATION_ID,
            accountStatus: "active",
            entitlements: ["tf.downloads", "tf.search"],
            expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
          },
        ),
      );
      return;
    }

    response.statusCode = 404;
    response.end();
  });

  return {
    issuer,
    clientSecret,
    code,
    verifier,
    nonce,
    requests,
    activeKeyPair,
  };
}

function createClient(
  fixture: Awaited<ReturnType<typeof createPlatformFixture>>,
  overrides: Partial<ConstructorParameters<typeof PlatformAuthClient>[0]> = {},
) {
  return new PlatformAuthClient({
    issuer: fixture.issuer,
    clientId: "apollo-tf-api",
    redirectUri: CALLBACK_URL,
    clientSecret: fixture.clientSecret,
    timeoutMs: 500,
    jwksTimeoutMs: 500,
    maxResponseBytes: 4_096,
    ...overrides,
  });
}

function authorizationInput() {
  return {
    codeChallenge: randomBytes(32).toString("base64url"),
    state: randomBytes(32).toString("base64url"),
    nonce: randomBytes(32).toString("base64url"),
    installationId: INSTALLATION_ID,
    installationLabel: "Apollo TF Web",
  };
}

describe("PlatformAuthClient", () => {
  it("builds the exact Platform authorization URL in the required order", async () => {
    const fixture = await createPlatformFixture();
    const input = authorizationInput();
    const client = createClient(fixture);

    const url = client.createAuthorizationUrl(input);

    expect(url).toBe(
      `${fixture.issuer}/v1/oauth/authorize?` +
        `client_id=apollo-tf-api&` +
        `redirect_uri=${encodeURIComponent(CALLBACK_URL)}&` +
        `response_type=code&` +
        `code_challenge=${input.codeChallenge}&` +
        `code_challenge_method=S256&` +
        `state=${input.state}&` +
        `nonce=${input.nonce}&` +
        `installation_id=${INSTALLATION_ID}&` +
        `installation_label=Apollo+TF+Web`,
    );
  });

  it("exchanges an exact bounded form and verifies the signed assertion", async () => {
    const fixture = await createPlatformFixture();
    const client = createClient(fixture);

    const result = await client.exchangeCode({
      code: fixture.code,
      codeVerifier: fixture.verifier,
      expectedNonce: fixture.nonce,
    });

    expect(result.claims).toMatchObject({
      iss: fixture.issuer,
      aud: "apollo-tf",
      sub: ACCOUNT_ID,
      sid: SESSION_ID,
      installation_id: INSTALLATION_ID,
      nonce: fixture.nonce,
      account_status: "active",
      entitlements: ["tf.search", "tf.downloads"],
    });
    const request = fixture.requests.find(
      (candidate) => candidate.path === "/v1/oauth/token",
    );
    expect(request).toBeDefined();
    expect(request?.method).toBe("POST");
    expect(request?.headers["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(request?.headers.authorization).toBe(
      `Basic ${Buffer.from(
        `apollo-tf-api:${fixture.clientSecret}`,
        "utf8",
      ).toString("base64")}`,
    );
    expect([...new URLSearchParams(request?.body).entries()]).toEqual([
      ["grant_type", "authorization_code"],
      ["code", fixture.code],
      ["redirect_uri", CALLBACK_URL],
      ["code_verifier", fixture.verifier],
    ]);
  });

  it.each([
    ["wrong issuer", { issuer: "https://wrong-issuer.example" }],
    ["wrong audience", { audience: "wrong-audience" }],
    ["wrong nonce", { nonce: randomBytes(32).toString("base64url") }],
    ["expired time", { expired: true }],
    ["future issued-at", { futureIssuedAt: true }],
    ["stale issued-at", { staleIssuedAt: true }],
    ["malformed claims", { extra: true }],
    ["unknown kid", { unknownKid: true }],
  ] as const)(
    "collapses %s assertion rejection into one sanitized error",
    async (_label, mutation) => {
      const fixture = await createPlatformFixture({
        assertion: async (issuer) => {
          const signingPair =
            "unknownKid" in mutation
              ? await generateKeyPair("EdDSA")
              : undefined;
          const now = Math.floor(Date.now() / 1_000);
          const issuedAt =
            "expired" in mutation || "staleIssuedAt" in mutation
              ? now - 600
              : "futureIssuedAt" in mutation
                ? now + 3_600
                : now;
          const notBefore = "futureIssuedAt" in mutation ? now - 5 : issuedAt;
          const expiration =
            "expired" in mutation || "staleIssuedAt" in mutation
              ? now - 300
              : issuedAt + 300;
          const payload: Record<string, unknown> = {
            sid: SESSION_ID,
            installation_id: INSTALLATION_ID,
            nonce: "nonce" in mutation ? mutation.nonce : fixture.nonce,
            account_status: "active",
            entitlements: ["tf.search"],
          };
          if ("extra" in mutation) payload.extra = "not-allowed";
          return new SignJWT(payload)
            .setProtectedHeader({
              alg: "EdDSA",
              kid:
                "unknownKid" in mutation
                  ? "unknown-platform-key"
                  : "active-platform-key",
            })
            .setIssuer("issuer" in mutation ? mutation.issuer : issuer)
            .setAudience(
              "audience" in mutation ? mutation.audience : "apollo-tf",
            )
            .setSubject(ACCOUNT_ID)
            .setJti(randomUUID())
            .setIssuedAt(issuedAt)
            .setNotBefore(notBefore)
            .setExpirationTime(expiration)
            .sign(signingPair?.privateKey ?? fixture.activeKeyPair.privateKey);
        },
      });
      const client = createClient(fixture);

      let error: unknown;
      try {
        await client.exchangeCode({
          code: fixture.code,
          codeVerifier: fixture.verifier,
          expectedNonce: fixture.nonce,
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(PlatformAuthUnavailableError);
      expect((error as Error).message).toBe(
        "Platform authentication unavailable",
      );
      expect(JSON.stringify(error)).not.toContain(fixture.code);
      expect(JSON.stringify(error)).not.toContain(fixture.verifier);
      expect(JSON.stringify(error)).not.toContain(fixture.nonce);
      expect(JSON.stringify(error)).not.toContain(fixture.clientSecret);
    },
  );

  it("sends exact introspection JSON and accepts only the shared strict response", async () => {
    const fixture = await createPlatformFixture();
    const client = createClient(fixture);

    const result = await client.introspect({
      accountId: ACCOUNT_ID,
      sessionId: SESSION_ID,
      installationId: INSTALLATION_ID,
      audience: "apollo-tf",
    });

    expect(result).toMatchObject({
      active: true,
      accountId: ACCOUNT_ID,
      sessionId: SESSION_ID,
      installationId: INSTALLATION_ID,
    });
    const request = fixture.requests.find(
      (candidate) => candidate.path === "/v1/oauth/introspect",
    );
    expect(request?.method).toBe("POST");
    expect(request?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(request?.body ?? "")).toEqual({
      accountId: ACCOUNT_ID,
      sessionId: SESSION_ID,
      installationId: INSTALLATION_ID,
      audience: "apollo-tf",
    });
  });

  it.each([
    ["redirect", { tokenRedirect: true }],
    ["wrong content type", { tokenContentType: "text/plain" }],
    [
      "oversized body",
      { tokenBody: JSON.stringify({ body: "x".repeat(5_000) }) },
    ],
    ["non-success status", { tokenStatus: 502 }],
  ])(
    "rejects a %s without exposing the upstream response",
    async (_label, options) => {
      const fixture = await createPlatformFixture(options);
      const client = createClient(fixture, { maxResponseBytes: 1_024 });

      await expect(
        client.exchangeCode({
          code: fixture.code,
          codeVerifier: fixture.verifier,
          expectedNonce: fixture.nonce,
        }),
      ).rejects.toThrow("Platform authentication unavailable");
    },
  );

  it("aborts a token response that exceeds the bounded timeout", async () => {
    const fixture = await createPlatformFixture({ tokenDelayMs: 100 });
    const client = createClient(fixture, { timeoutMs: 20 });

    await expect(
      client.exchangeCode({
        code: fixture.code,
        codeVerifier: fixture.verifier,
        expectedNonce: fixture.nonce,
      }),
    ).rejects.toThrow("Platform authentication unavailable");
  });

  it("rejects unknown introspection fields and wrong content type", async () => {
    const unknownField = await createPlatformFixture({
      introspectionBody: { active: false, upstreamBody: "not-allowed" },
    });
    await expect(
      createClient(unknownField).introspect({
        accountId: ACCOUNT_ID,
        sessionId: SESSION_ID,
        installationId: INSTALLATION_ID,
        audience: "apollo-tf",
      }),
    ).rejects.toThrow("Platform authentication unavailable");

    const wrongContentType = await createPlatformFixture({
      introspectionContentType: "text/html",
    });
    await expect(
      createClient(wrongContentType).introspect({
        accountId: ACCOUNT_ID,
        sessionId: SESSION_ID,
        installationId: INSTALLATION_ID,
        audience: "apollo-tf",
      }),
    ).rejects.toThrow("Platform authentication unavailable");
  });
});

async function runtimeEnvironment(
  nodeEnv: "development" | "production" | "test" = "production",
) {
  const directory = await mkdtemp(join(tmpdir(), "apollo-tf-auth-"));
  temporaryDirectories.push(directory);
  const secretPath = join(directory, "apollo_tf_client_secret");
  const secret = randomBytes(48).toString("base64url");
  await writeFile(secretPath, secret, "utf8");
  const production = nodeEnv === "production";
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: nodeEnv,
    APOLLO_PLATFORM_ISSUER: production
      ? "https://api.apollot.ru"
      : "http://127.0.0.1:18081",
    APOLLO_TF_CLIENT_ID: "apollo-tf-api",
    APOLLO_TF_CALLBACK_URL: production
      ? CALLBACK_URL
      : "http://127.0.0.1:18082/api/auth/callback",
    APOLLO_TF_WEB_ORIGIN: production
      ? "https://tf.apollot.ru"
      : "http://127.0.0.1:18083",
    APOLLO_TF_CLIENT_SECRET_FILE: secretPath,
    APOLLO_TF_AUTH_REDIS_URL: "redis://127.0.0.1:16379/7",
  };
  return {
    secret,
    secretPath,
    environment,
  };
}

describe("TF auth runtime configuration", () => {
  it("loads the bounded raw client secret and exact production values", async () => {
    const fixture = await runtimeEnvironment();

    const config = await parseTfAuthRuntimeConfig(fixture.environment);

    expect(config).toEqual({
      nodeEnv: "production",
      issuer: "https://api.apollot.ru",
      apiOrigin: "https://api.apollot.ru",
      allowPrivateHttpTransport: false,
      clientId: "apollo-tf-api",
      callbackUrl: CALLBACK_URL,
      webOrigin: "https://tf.apollot.ru",
      clientSecret: fixture.secret,
      authRedisUrl: "redis://127.0.0.1:16379/7",
      bridgePkceVerifier: undefined,
    });
  });

  it("rejects a secret that grows beyond the byte limit after stat", async () => {
    const fixture = await runtimeEnvironment();
    const grownSecret = Buffer.from("é".repeat(2_049), "utf8");
    let position = 0;
    let largestRead = 0;
    const close = vi.fn(async () => {});

    await expect(
      parseTfAuthRuntimeConfig(fixture.environment, {
        openSecretFile: async () => ({
          stat: async () => ({
            isFile: () => true,
            size: 1,
          }),
          read: async (buffer: Uint8Array, offset: number, length: number) => {
            largestRead = Math.max(largestRead, length);
            const bytesRead = Math.min(length, grownSecret.length - position);
            buffer.set(
              grownSecret.subarray(position, position + bytesRead),
              offset,
            );
            position += bytesRead;
            return { bytesRead, buffer };
          },
          close,
        }),
      }),
    ).rejects.toThrow("TF authentication configuration is invalid");
    expect(largestRead).toBeLessThanOrEqual(4_097);
    expect(close).toHaveBeenCalledOnce();
  });

  it("allows exact loopback HTTP only outside production", async () => {
    const development = await runtimeEnvironment("development");
    await expect(
      parseTfAuthRuntimeConfig(development.environment),
    ).resolves.toMatchObject({
      issuer: "http://127.0.0.1:18081",
      callbackUrl: "http://127.0.0.1:18082/api/auth/callback",
      webOrigin: "http://127.0.0.1:18083",
    });

    const production = await runtimeEnvironment();
    production.environment.APOLLO_PLATFORM_ISSUER = "http://127.0.0.1:18081";
    await expect(
      parseTfAuthRuntimeConfig(production.environment),
    ).rejects.toThrow("TF authentication configuration is invalid");
  });

  it("splits the public issuer from an explicit bridge-only API transport", async () => {
    const development = await runtimeEnvironment("development");
    development.environment.APOLLO_PLATFORM_API_ORIGIN =
      "http://platform-api:8080";
    development.environment.APOLLO_TF_BRIDGE_ALLOW_INTERNAL_HTTP = "true";

    await expect(
      parseTfAuthRuntimeConfig(development.environment),
    ).resolves.toMatchObject({
      issuer: "http://127.0.0.1:18081",
      apiOrigin: "http://platform-api:8080",
      allowPrivateHttpTransport: true,
    });

    for (const apiOrigin of [
      "http://platform-api",
      "http://platform-api:8081",
      "http://platform-api.internal:8080",
      "http://tf-api:8080",
      "http://user@platform-api:8080",
      "http://platform-api:8080/path",
    ]) {
      const invalid = await runtimeEnvironment("development");
      invalid.environment.APOLLO_PLATFORM_API_ORIGIN = apiOrigin;
      invalid.environment.APOLLO_TF_BRIDGE_ALLOW_INTERNAL_HTTP = "true";
      await expect(
        parseTfAuthRuntimeConfig(invalid.environment),
      ).rejects.toThrow("TF authentication configuration is invalid");
    }

    const production = await runtimeEnvironment("production");
    production.environment.APOLLO_PLATFORM_API_ORIGIN =
      "http://platform-api:8080";
    production.environment.APOLLO_TF_BRIDGE_ALLOW_INTERNAL_HTTP = "true";
    await expect(
      parseTfAuthRuntimeConfig(production.environment),
    ).rejects.toThrow("TF authentication configuration is invalid");
  });

  it("accepts a file-backed fixed PKCE verifier only in explicit bridge mode", async () => {
    const development = await runtimeEnvironment("development");
    const verifierPath = join(
      temporaryDirectories.at(-1)!,
      "tf_bridge_pkce_verifier",
    );
    const verifier = "V".repeat(64);
    await writeFile(verifierPath, verifier, "utf8");
    development.environment.APOLLO_PLATFORM_API_ORIGIN =
      "http://platform-api:8080";
    development.environment.APOLLO_TF_BRIDGE_ALLOW_INTERNAL_HTTP = "true";
    development.environment.APOLLO_TF_BRIDGE_PKCE_VERIFIER_FILE = verifierPath;

    await expect(
      parseTfAuthRuntimeConfig(development.environment),
    ).resolves.toMatchObject({ bridgePkceVerifier: verifier });

    const production = await runtimeEnvironment("production");
    production.environment.APOLLO_TF_BRIDGE_PKCE_VERIFIER_FILE = verifierPath;
    await expect(
      parseTfAuthRuntimeConfig(production.environment),
    ).rejects.toThrow("TF authentication configuration is invalid");
  });

  it.each([
    ["missing", "missing"],
    ["directory", "directory"],
    ["empty", "empty"],
    ["whitespace", "whitespace"],
    ["oversized", "oversized"],
    ["multiline", "multiline"],
    ["control", "control"],
    ["invalid UTF-8", "invalid-utf8"],
  ])("rejects a %s secret file generically", async (_label, mutation) => {
    const fixture = await runtimeEnvironment();
    if (mutation === "missing") {
      fixture.environment.APOLLO_TF_CLIENT_SECRET_FILE = join(
        fixture.secretPath,
        "missing",
      );
    } else if (mutation === "directory") {
      fixture.environment.APOLLO_TF_CLIENT_SECRET_FILE =
        temporaryDirectories.at(-1)!;
    } else if (mutation === "empty") {
      await writeFile(fixture.secretPath, "", "utf8");
    } else if (mutation === "whitespace") {
      await writeFile(fixture.secretPath, "   ", "utf8");
    } else if (mutation === "oversized") {
      await writeFile(fixture.secretPath, "x".repeat(4_097), "utf8");
    } else if (mutation === "multiline") {
      await writeFile(fixture.secretPath, `${fixture.secret}\nsecond`, "utf8");
    } else if (mutation === "control") {
      await writeFile(fixture.secretPath, `${fixture.secret}\u0000`, "utf8");
    } else {
      await writeFile(fixture.secretPath, Buffer.from([0xc3, 0x28, 0xff]));
    }

    let error: unknown;
    try {
      await parseTfAuthRuntimeConfig(fixture.environment);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "TF authentication configuration is invalid",
    );
    expect(JSON.stringify(error)).not.toContain(fixture.secret);
    expect(JSON.stringify(error)).not.toContain(fixture.secretPath);
  });

  it.each([
    ["issuer path", { APOLLO_PLATFORM_ISSUER: "https://api.apollot.ru/path" }],
    [
      "issuer credentials",
      { APOLLO_PLATFORM_ISSUER: "https://user@api.apollot.ru" },
    ],
    ["callback query", { APOLLO_TF_CALLBACK_URL: `${CALLBACK_URL}?next=bad` }],
    [
      "callback path",
      { APOLLO_TF_CALLBACK_URL: "https://api.tf.apollot.ru/not-callback" },
    ],
    ["web path", { APOLLO_TF_WEB_ORIGIN: "https://tf.apollot.ru/path" }],
    ["missing client", { APOLLO_TF_CLIENT_ID: undefined }],
    ["invalid Redis", { APOLLO_TF_AUTH_REDIS_URL: "https://redis.example" }],
  ])("rejects %s generically", async (_label, overrides) => {
    const fixture = await runtimeEnvironment();
    Object.assign(fixture.environment, overrides);

    await expect(parseTfAuthRuntimeConfig(fixture.environment)).rejects.toThrow(
      "TF authentication configuration is invalid",
    );
  });
});
