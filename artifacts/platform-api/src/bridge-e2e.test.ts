import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import {
  access,
  chmod,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const composeFile = fileURLToPath(
  new URL("../docker-compose.bridge.yml", import.meta.url),
);
const smokeScript = fileURLToPath(
  new URL("../scripts/bridge-smoke.mjs", import.meta.url),
);
const BRIDGE_SMOKE_LIFECYCLE_MS = 15 * 60_000;
const BRIDGE_SMOKE_CLEANUP_GRACE_MS = 3 * 60_000;
const BRIDGE_SMOKE_CHILD_MS =
  BRIDGE_SMOKE_LIFECYCLE_MS + BRIDGE_SMOKE_CLEANUP_GRACE_MS;
const BRIDGE_SMOKE_TIMEOUTS = Object.freeze({
  childMs: BRIDGE_SMOKE_CHILD_MS,
  cleanupGraceMs: BRIDGE_SMOKE_CLEANUP_GRACE_MS,
  composeBuildMs: 5 * 60_000,
  lifecycleMs: BRIDGE_SMOKE_LIFECYCLE_MS,
  parentMs: BRIDGE_SMOKE_CHILD_MS + 30_000,
});
const platformDockerfile = fileURLToPath(
  new URL("../Dockerfile", import.meta.url),
);
const tfDockerfile = fileURLToPath(
  new URL("../../api-server/Dockerfile", import.meta.url),
);
const tfDownloadWorkerDockerfile = fileURLToPath(
  new URL("../../tf-download-worker/Dockerfile", import.meta.url),
);
const expectedServices = Object.freeze([
  "platform-api",
  "platform-migrate",
  "platform-postgres",
  "platform-redis",
  "tf-api",
  "tf-download-redis",
  "tf-migrate",
  "tf-postgres",
  "tf-redis",
]);
const expectedBaselineServices = Object.freeze(
  [...expectedServices, "tf-baseline", "tf-role-bootstrap"].sort(),
);
const secretFileNames = Object.freeze([
  "platform_assertion_private_jwk",
  "platform_assertion_public_jwks",
  "platform_migrator_database_url",
  "platform_migrator_password",
  "platform_oauth_clients",
  "platform_operator_bootstrap_token",
  "platform_postgres_admin_password",
  "platform_runtime_database_url",
  "platform_runtime_password",
  "tf_admin_database_url",
  "tf_client_secret",
  "tf_download_internal_auth_secret",
  "tf_download_queue_password",
  "tf_download_queue_redis_url",
  "tf_integrations_internal_auth_secret",
  "tf_migrator_database_url",
  "tf_migrator_password",
  "tf_module_heartbeat_keys",
  "tf_pkce_verifier",
  "tf_postgres_admin_password",
  "tf_runtime_database_url",
  "tf_runtime_password",
  "tf_search_internal_auth_secret",
]);
const contractCanaries = Object.freeze({
  platformDatabase:
    "postgres://apollo_platform_runtime:platform-runtime-canary@platform-postgres:5432/apollo_platform",
  platformPrivateKey: randomBytes(32).toString("base64url"),
  platformClientSecret: randomBytes(32).toString("base64url"),
  tfAdminDatabase:
    "postgres://postgres:tf-admin-canary@tf-postgres:5432/apollo_tf",
  tfMigratorDatabase:
    "postgres://apollo_tf_migrator:tf-migrator-canary@tf-postgres:5432/apollo_tf",
  tfRuntimeDatabase:
    "postgres://apollo_tf_runtime:tf-runtime-canary@tf-postgres:5432/apollo_tf",
  tfAccountHeartbeat: randomBytes(32).toString("base64url"),
  tfDownloadHeartbeat: randomBytes(32).toString("base64url"),
  tfSearchHeartbeat: randomBytes(32).toString("base64url"),
  tfDownloadInternalAuth: randomBytes(32).toString("base64url"),
  tfDownloadQueuePassword: randomBytes(32).toString("base64url"),
  tfIntegrationsInternalAuth: randomBytes(32).toString("base64url"),
  tfSearchInternalAuth: randomBytes(32).toString("base64url"),
});

type ComposeService = Record<string, unknown>;
type ComposeConfig = {
  services: Record<string, ComposeService>;
  networks: Record<string, Record<string, unknown>>;
  volumes: Record<string, Record<string, unknown>>;
  secrets: Record<string, Record<string, unknown>>;
};

type SmokeModule = {
  BRIDGE_SMOKE_TIMEOUTS?: {
    childMs: number;
    cleanupGraceMs: number;
    composeBuildMs: number;
    lifecycleMs: number;
    parentMs: number;
  };
  prepareSecretDirectory?: (
    environment: NodeJS.ProcessEnv,
    tfPublicOrigin: string,
  ) => Promise<{ directory: string; rawSecrets: string[] }>;
  projectResponseForSecretScan?: (
    response: {
      status: number;
      headers: Record<string, string | string[] | undefined>;
      rawHeaders?: string[];
      bodyBytes?: Buffer;
      text: string;
      json: unknown;
    },
    options?: {
      bodyFields?: readonly string[];
      cookieNames?: readonly string[];
      locationQueryParameters?: readonly string[];
      redactExactRedirectBody?: boolean;
    },
  ) => {
    status: number;
    headers: Record<string, string | string[] | undefined>;
    rawHeaders: string[];
    rawBody: Buffer;
    body: string;
  };
  recordResponseBeforeStatus?: (
    state: { projections: unknown[]; rawSecrets?: string[] },
    response: {
      status: number;
      headers: Record<string, string | string[] | undefined>;
      rawHeaders?: string[];
      bodyBytes?: Buffer;
      text: string;
      json: unknown;
    },
    options: {
      expectedStatus: number;
      label: string;
      bodyFields?: readonly string[];
      cookieNames?: readonly string[];
      locationQueryParameters?: readonly string[];
      redactExactRedirectBody?: boolean;
    },
  ) => unknown;
  rejectedWebSocketStatus?: (
    url: string,
    ca: Buffer,
    state?: { projections: unknown[]; rawSecrets?: string[] },
  ) => Promise<{ status: number; bytes: number }>;
  validateTfCallbackLocation?: (location: string, tfOrigin: string) => URL;
  waitForReadiness?: (
    state: {
      ca: Buffer;
      platformOrigin: string;
      tfOrigin: string;
      projections: unknown[];
      rawSecrets: string[];
    },
    signal?: AbortSignal,
    dependencies?: {
      request(
        ca: Buffer,
        origin: string,
        path: string,
        options: { signal?: AbortSignal },
      ): Promise<{
        status: number;
        headers: Record<string, string | string[] | undefined>;
        rawHeaders: string[];
        bodyBytes: Buffer;
        text: string;
        json: unknown;
      }>;
    },
  ) => Promise<void>;
  closeTlsProxyServer?: (
    server: {
      close(callback: () => void): void;
      closeAllConnections?(): void;
    },
    sockets: Set<{ destroy(): void }>,
    options?: {
      timeoutMs?: number;
      timers?: {
        clearTimeout(handle: unknown): void;
        setTimeout(callback: () => void, timeoutMs: number): unknown;
      };
    },
  ) => Promise<void>;
  createSmokeDownloadFixture?: () => {
    trackId: string;
    request: {
      tracks: Array<{
        trackId: string;
        artist: string;
        title: string;
        quality: "320";
      }>;
    };
  };
  retainSocket?: <
    Socket extends { once(event: "close", listener: () => void): unknown },
  >(
    sockets: Set<Socket>,
    socket: Socket,
  ) => Socket;
  removeVerifiedDirectory?: (
    directory: string,
    operations?: {
      access(path: string): Promise<void>;
      rm(
        path: string,
        options: { force: boolean; recursive: boolean },
      ): Promise<void>;
    },
  ) => Promise<void>;
  runBoundedCommand?: (
    executable: string,
    args: readonly string[],
    options: { timeoutMs: number },
  ) => Promise<unknown>;
  runBridgeLifecycle?: (
    dependencies: LifecycleDependencies,
    options?: { signal?: AbortSignal },
  ) => Promise<void>;
  sanitizedDiagnostic?: (error: unknown, secrets: string[]) => string;
  runWithLifecycleDeadline?: (
    operation: (signal: AbortSignal) => Promise<void>,
    timeoutMs: number,
    timers?: {
      clearTimeout(handle: unknown): void;
      setTimeout(callback: () => void, timeoutMs: number): unknown;
    },
  ) => Promise<void>;
  validateRenderedBridgeConfig?: (
    output: string,
    secrets: string[],
    secretDirectory: string,
  ) => void;
};

async function loadSmokeModule(): Promise<SmokeModule> {
  return import(
    new URL("../scripts/bridge-smoke.mjs", import.meta.url).href
  ) as Promise<SmokeModule>;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function secretEnvironment(directory: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    BRIDGE_SECRET_DIRECTORY: directory,
    COMPOSE_PROJECT_NAME: "apollo-bridge-contract",
    PLATFORM_ALLOWED_ORIGINS: "https://127.0.0.1:18443,https://127.0.0.1:18444",
    PLATFORM_API_PORT: "18081",
    PLATFORM_PUBLIC_ORIGIN: "https://127.0.0.1:18443",
    TF_API_PORT: "18082",
    TF_PUBLIC_ORIGIN: "https://127.0.0.1:18444",
  };
}

async function withContractSecrets<T>(
  run: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "apollo-bridge-contract-"));
  try {
    await Promise.all(
      secretFileNames.map((name) => {
        let value = `${name}-contract`;
        if (name === "platform_assertion_private_jwk") {
          value = JSON.stringify({
            alg: "EdDSA",
            crv: "Ed25519",
            d: contractCanaries.platformPrivateKey,
            kid: "bridge-contract",
            kty: "OKP",
            use: "sig",
            x: randomBytes(32).toString("base64url"),
          });
        } else if (name === "platform_assertion_public_jwks") {
          value = JSON.stringify({ keys: [] });
        } else if (name === "platform_oauth_clients") {
          value = JSON.stringify([
            {
              audience: "apollo-tf",
              clientId: "apollo-tf-api",
              clientSecretDigest: createHash("sha256")
                .update(contractCanaries.platformClientSecret)
                .digest("hex"),
              redirectUris: ["http://127.0.0.1:18082/api/auth/callback"],
            },
          ]);
        } else if (name === "platform_runtime_database_url") {
          value = contractCanaries.platformDatabase;
        } else if (name === "tf_admin_database_url") {
          value = contractCanaries.tfAdminDatabase;
        } else if (name === "tf_migrator_database_url") {
          value = contractCanaries.tfMigratorDatabase;
        } else if (name === "tf_runtime_database_url") {
          value = contractCanaries.tfRuntimeDatabase;
        } else if (name === "tf_client_secret") {
          value = contractCanaries.platformClientSecret;
        } else if (name === "tf_download_internal_auth_secret") {
          value = contractCanaries.tfDownloadInternalAuth;
        } else if (name === "tf_download_queue_password") {
          value = contractCanaries.tfDownloadQueuePassword;
        } else if (name === "tf_download_queue_redis_url") {
          value =
            `redis://default:${encodeURIComponent(contractCanaries.tfDownloadQueuePassword)}` +
            "@tf-download-redis:6379/0";
        } else if (name === "tf_integrations_internal_auth_secret") {
          value = contractCanaries.tfIntegrationsInternalAuth;
        } else if (name === "tf_module_heartbeat_keys") {
          value = JSON.stringify({
            "account-integrations": contractCanaries.tfAccountHeartbeat,
            "download-worker": contractCanaries.tfDownloadHeartbeat,
            "search-media": contractCanaries.tfSearchHeartbeat,
          });
        } else if (name === "tf_search_internal_auth_secret") {
          value = contractCanaries.tfSearchInternalAuth;
        }
        return writeFile(join(directory, name), value, "utf8");
      }),
    );
    return await run(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function renderedBridgeCompose(
  profiles: readonly string[] = [],
): Promise<{
  config: ComposeConfig;
  secretDirectory: string;
}> {
  return withContractSecrets(async (directory) => {
    const { stdout, stderr } = await execFileAsync(
      "docker",
      [
        "compose",
        "--project-directory",
        repositoryRoot,
        "-f",
        composeFile,
        "-p",
        "apollo-bridge-contract",
        ...profiles.flatMap((profile) => ["--profile", profile]),
        "config",
        "--format",
        "json",
      ],
      {
        cwd: repositoryRoot,
        env: secretEnvironment(directory),
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    expect(stderr).toBe("");
    for (const canary of Object.values(contractCanaries)) {
      expect(stdout).not.toContain(canary);
      expect(stdout).not.toContain(
        createHash("sha256").update(canary).digest("hex"),
      );
    }
    return {
      config: JSON.parse(stdout) as ComposeConfig,
      secretDirectory: directory,
    };
  });
}

function service(config: ComposeConfig, name: string): ComposeService {
  const value = config.services[name];
  if (value === undefined) throw new Error(`missing service ${name}`);
  return value;
}

function attachedNetworks(current: ComposeService): string[] {
  const networks = current.networks;
  if (Array.isArray(networks)) return [...networks].sort();
  if (networks && typeof networks === "object") {
    return Object.keys(networks as Record<string, unknown>).sort();
  }
  return [];
}

function secretSources(current: ComposeService): string[] {
  const secrets = (current.secrets ?? []) as Array<
    string | Record<string, unknown>
  >;
  return secrets
    .map((entry) =>
      typeof entry === "string" ? entry : String(entry.source ?? ""),
    )
    .sort();
}

function secretMount(
  current: ComposeService,
  source: string,
): Record<string, unknown> {
  const secrets = (current.secrets ?? []) as Array<
    string | Record<string, unknown>
  >;
  const mount = secrets.find(
    (entry) => typeof entry !== "string" && entry.source === source,
  );
  if (typeof mount === "string" || mount === undefined) {
    throw new Error(`missing long-syntax secret mount ${source}`);
  }
  return mount;
}

function assertLoopbackPort(current: ComposeService, published: string): void {
  expect(current.ports).toEqual([
    expect.objectContaining({
      host_ip: "127.0.0.1",
      published,
      target: 8080,
    }),
  ]);
}

describe("Platform-TF bridge container contract", () => {
  test("renders the exact data planes and readiness ordering", async () => {
    const { config } = await renderedBridgeCompose();
    expect(Object.keys(config.services).sort()).toEqual(expectedServices);
    for (const name of [
      "platform-api",
      "platform-migrate",
      "tf-api",
      "tf-download-redis",
      "tf-migrate",
    ]) {
      expect(
        resolve(
          (service(config, name).build as { context?: string } | undefined)
            ?.context ?? "",
        ),
      ).toBe(resolve(repositoryRoot));
    }

    for (const name of [
      "platform-postgres",
      "platform-redis",
      "platform-migrate",
      "tf-download-redis",
      "tf-postgres",
      "tf-redis",
    ]) {
      expect(service(config, name).ports).toBeUndefined();
    }
    assertLoopbackPort(service(config, "platform-api"), "18081");
    assertLoopbackPort(service(config, "tf-api"), "18082");
    expect(service(config, "platform-migrate").depends_on).toMatchObject({
      "platform-postgres": { condition: "service_healthy" },
    });
    expect(service(config, "platform-api").depends_on).toMatchObject({
      "platform-migrate": { condition: "service_completed_successfully" },
      "platform-redis": { condition: "service_healthy" },
    });
    expect(service(config, "tf-api").depends_on).toMatchObject({
      "platform-api": { condition: "service_healthy" },
      "tf-download-redis": { condition: "service_healthy" },
      "tf-migrate": { condition: "service_completed_successfully" },
      "tf-redis": { condition: "service_healthy" },
    });
    expect(service(config, "tf-migrate").depends_on).toEqual({
      "tf-postgres": {
        condition: "service_healthy",
        required: true,
      },
    });
    expect(attachedNetworks(service(config, "tf-migrate"))).toEqual([
      "tf-data",
    ]);
    expect(attachedNetworks(service(config, "platform-migrate"))).toEqual([
      "platform-data",
    ]);
  }, 20_000);

  test("keeps Platform and TF data planes separate", async () => {
    const { config } = await renderedBridgeCompose();
    expect(Object.keys(config.networks).sort()).toEqual([
      "bridge-edge",
      "platform-data",
      "platform-tf-control",
      "tf-data",
      "tf-download-queue",
    ]);
    expect(attachedNetworks(service(config, "platform-postgres"))).toEqual([
      "platform-data",
    ]);
    expect(attachedNetworks(service(config, "platform-redis"))).toEqual([
      "platform-data",
    ]);
    expect(attachedNetworks(service(config, "tf-postgres"))).toEqual([
      "tf-data",
    ]);
    expect(attachedNetworks(service(config, "tf-redis"))).toEqual(["tf-data"]);
    expect(attachedNetworks(service(config, "tf-download-redis"))).toEqual([
      "tf-download-queue",
    ]);
    expect(attachedNetworks(service(config, "tf-migrate"))).toEqual([
      "tf-data",
    ]);
    expect(attachedNetworks(service(config, "platform-api"))).toEqual([
      "bridge-edge",
      "platform-data",
      "platform-tf-control",
    ]);
    expect(attachedNetworks(service(config, "tf-api"))).toEqual([
      "bridge-edge",
      "platform-tf-control",
      "tf-data",
      "tf-download-queue",
    ]);
    expect(config.networks["bridge-edge"]?.internal).not.toBe(true);
    expect(config.networks["platform-data"]?.internal).toBe(true);
    expect(config.networks["platform-tf-control"]?.internal).toBe(true);
    expect(config.networks["tf-data"]?.internal).toBe(true);
    expect(config.networks["tf-download-queue"]?.internal).toBe(true);
    expect(Object.keys(config.volumes).sort()).toEqual([
      "platform-postgres-data",
      "platform-redis-data",
      "tf-download-redis-data",
      "tf-postgres-data",
      "tf-redis-data",
    ]);
  }, 20_000);

  test("uses distinct file-backed credentials without crossing trust boundaries", async () => {
    const { config } = await renderedBridgeCompose();
    const platformApi = service(config, "platform-api");
    const platformMigrate = service(config, "platform-migrate");
    const tfApi = service(config, "tf-api");
    const tfDownloadRedis = service(config, "tf-download-redis");
    const tfMigrate = service(config, "tf-migrate");
    const tfPostgres = service(config, "tf-postgres");

    expect(Object.keys(config.secrets).sort()).toEqual(
      secretFileNames.filter((name) => name !== "tf_admin_database_url"),
    );
    expect(secretSources(platformApi)).toEqual([
      "platform_assertion_private_jwk",
      "platform_assertion_public_jwks",
      "platform_oauth_clients",
      "platform_operator_bootstrap_token",
      "platform_runtime_database_url",
    ]);
    expect(secretSources(platformMigrate)).toEqual([
      "platform_migrator_database_url",
    ]);
    expect(secretSources(tfApi)).toEqual([
      "tf_client_secret",
      "tf_download_internal_auth_secret",
      "tf_download_queue_redis_url",
      "tf_integrations_internal_auth_secret",
      "tf_module_heartbeat_keys",
      "tf_pkce_verifier",
      "tf_runtime_database_url",
      "tf_search_internal_auth_secret",
    ]);
    expect(secretSources(tfDownloadRedis)).toEqual([
      "tf_download_queue_password",
    ]);
    expect(secretSources(tfMigrate)).toEqual(["tf_migrator_database_url"]);
    expect(secretSources(tfPostgres)).toEqual([
      "tf_migrator_password",
      "tf_postgres_admin_password",
      "tf_runtime_password",
    ]);
    expect(platformApi.environment).not.toHaveProperty(
      "APOLLO_TF_CLIENT_SECRET",
    );
    expect(platformApi.environment).not.toHaveProperty("DATABASE_URL");
    expect(tfApi.environment).not.toHaveProperty(
      "APOLLO_ASSERTION_PRIVATE_JWK",
    );
    expect(
      (tfApi.environment as Record<string, unknown>)
        .APOLLO_MODULE_HEARTBEAT_KEYS_FILE,
    ).toBe("/run/secrets/tf_module_heartbeat_keys");
    for (const name of Object.keys(config.services).filter(
      (name) => name !== "tf-api",
    )) {
      expect(
        (service(config, name).environment as
          | Record<string, unknown>
          | undefined) ?? {},
      ).not.toHaveProperty("APOLLO_MODULE_HEARTBEAT_KEYS_FILE");
    }
    expect(tfApi.environment).not.toHaveProperty("DATABASE_URL");
    const tfApiSecretFiles = [
      "tf_download_internal_auth_secret",
      "tf_download_queue_redis_url",
      "tf_integrations_internal_auth_secret",
      "tf_module_heartbeat_keys",
      "tf_search_internal_auth_secret",
    ];
    for (const name of tfApiSecretFiles) {
      expect(secretMount(tfApi, name)).toMatchObject({
        target: name,
        uid: "10001",
        gid: "10001",
        mode: "0400",
      });
    }
    expect(
      secretMount(tfDownloadRedis, "tf_download_queue_password"),
    ).toMatchObject({
      target: "tf_download_queue_password",
      uid: "999",
      gid: "999",
      mode: "0400",
    });
    const tfApiEnvironment = tfApi.environment as Record<string, unknown>;
    expect(tfApiEnvironment).toMatchObject({
      TF_INTEGRATIONS_ALLOW_INSECURE_HTTP: "true",
      TF_INTEGRATIONS_INTERNAL_AUTH_SECRET_FILE:
        "/run/secrets/tf_integrations_internal_auth_secret",
      TF_INTEGRATIONS_ORIGIN: "http://tf-integrations:8080",
      TF_SEARCH_ALLOW_INSECURE_HTTP: "true",
      TF_SEARCH_INTERNAL_AUTH_SECRET_FILE:
        "/run/secrets/tf_search_internal_auth_secret",
      TF_SEARCH_ORIGIN: "http://tf-search:8080",
      TF_DOWNLOAD_WORKER_ALLOW_INSECURE_HTTP: "true",
      TF_DOWNLOAD_WORKER_INTERNAL_AUTH_SECRET_FILE:
        "/run/secrets/tf_download_internal_auth_secret",
      TF_DOWNLOAD_WORKER_ORIGIN: "http://tf-download-worker:8080",
      TF_DOWNLOAD_QUEUE_ALLOW_INSECURE_REDIS: "true",
      TF_DOWNLOAD_QUEUE_REDIS_URL_FILE:
        "/run/secrets/tf_download_queue_redis_url",
    });
    expect(tfDownloadRedis.environment).toEqual({
      TF_DOWNLOAD_QUEUE_PASSWORD_FILE:
        "/run/secrets/tf_download_queue_password",
    });
    const tfOnlyEnvironment = Object.keys(tfApiEnvironment).filter((name) =>
      name.startsWith("TF_"),
    );
    for (const name of Object.keys(config.services).filter(
      (name) => name !== "tf-api",
    )) {
      const environment =
        (service(config, name).environment as
          | Record<string, unknown>
          | undefined) ?? {};
      for (const variable of tfOnlyEnvironment) {
        expect(environment).not.toHaveProperty(variable);
      }
    }
    for (const name of Object.keys(config.services).filter((name) =>
      name.startsWith("platform-"),
    )) {
      expect(JSON.stringify(service(config, name))).not.toMatch(
        /tf_(?:admin|migrator|postgres|runtime)_database_url|tf_(?:migrator|postgres_admin|runtime)_password/,
      );
    }
    expect(JSON.stringify(tfApi)).not.toContain(
      "platform_runtime_database_url",
    );
    expect(JSON.stringify(tfApi)).not.toContain("tf_download_queue_password");
    expect(JSON.stringify(tfDownloadRedis)).not.toMatch(
      /tf_(?:admin|client|download_internal_auth|download_queue_redis_url|integrations_internal_auth|migrator|module_heartbeat|pkce|postgres|runtime|search_internal_auth)/,
    );
    expect(JSON.stringify(service(config, "platform-postgres"))).not.toContain(
      "tf_postgres_admin_password",
    );
    expect(JSON.stringify(service(config, "tf-postgres"))).not.toContain(
      "platform_postgres_admin_password",
    );
    expect(JSON.stringify(config)).not.toMatch(
      /tf_database_url|tf_postgres_password/,
    );
  }, 20_000);

  test("keeps role bootstrap and baseline manual-only with exact secret scopes", async () => {
    const { config } = await renderedBridgeCompose(["baseline"]);
    expect(Object.keys(config.services).sort()).toEqual(
      expectedBaselineServices,
    );

    const roleBootstrap = service(config, "tf-role-bootstrap");
    expect(roleBootstrap.profiles).toEqual(["baseline"]);
    expect(roleBootstrap.build).toMatchObject({
      dockerfile: "artifacts/api-server/Dockerfile",
      target: "postgres-role-init",
    });
    expect(roleBootstrap.image).toBe("apollo-tf-postgres:bridge");
    expect(roleBootstrap.user).toBe("999:999");
    expect(roleBootstrap.group_add).toEqual(["10002"]);
    expect(roleBootstrap.entrypoint).toEqual([
      "/usr/local/bin/bootstrap-tf-roles.sh",
    ]);
    expect(roleBootstrap.depends_on).toMatchObject({
      "tf-postgres": { condition: "service_healthy" },
    });
    expect(secretSources(roleBootstrap)).toEqual([
      "tf_admin_database_url",
      "tf_migrator_password",
      "tf_runtime_password",
    ]);
    expect(secretMount(roleBootstrap, "tf_admin_database_url")).toMatchObject({
      target: "tf_admin_database_url",
      uid: "0",
      gid: "10002",
      mode: "0440",
    });
    for (const name of ["tf_migrator_password", "tf_runtime_password"]) {
      expect(secretMount(roleBootstrap, name)).toMatchObject({
        target: name,
        uid: "999",
        gid: "999",
        mode: "0400",
      });
    }

    const baseline = service(config, "tf-baseline");
    expect(baseline.profiles).toEqual(["baseline"]);
    expect(baseline.build).toMatchObject({
      dockerfile: "artifacts/api-server/Dockerfile",
      target: "runner",
    });
    expect(baseline.image).toBe("apollo-tf-api:bridge");
    expect(baseline.user).toBe("10001:10001");
    expect(baseline.group_add).toEqual(["10002"]);
    expect(baseline.entrypoint).toEqual([
      "node",
      "artifacts/api-server/dist/migrate.mjs",
      "--baseline-existing-startup-schema",
    ]);
    expect(baseline.depends_on).toEqual({
      "tf-role-bootstrap": {
        condition: "service_completed_successfully",
        required: true,
      },
    });
    expect(secretSources(baseline)).toEqual(["tf_admin_database_url"]);
    expect(secretMount(baseline, "tf_admin_database_url")).toMatchObject({
      target: "tf_admin_database_url",
      uid: "0",
      gid: "10002",
      mode: "0440",
    });

    for (const name of ["tf-role-bootstrap", "tf-baseline"]) {
      expect(service(config, name).ports).toBeUndefined();
      expect(attachedNetworks(service(config, name))).toEqual(["tf-data"]);
      expect(service(config, name).read_only).toBe(true);
      expect(service(config, name).security_opt).toContain(
        "no-new-privileges:true",
      );
      expect(service(config, name).cap_drop).toContain("ALL");
    }
  }, 20_000);

  test("hardens runtime containers and denies host control access", async () => {
    const { config } = await renderedBridgeCompose();
    for (const [name, current] of Object.entries(config.services)) {
      const serialized = JSON.stringify(current);
      expect(serialized).not.toContain("docker.sock");
      expect(serialized).not.toContain(".ops-private");
      expect(current.privileged).not.toBe(true);
      expect(current.network_mode).not.toBe("host");
      expect(current.pid).not.toBe("host");
      expect(current.ipc).not.toBe("host");
      expect(current.cap_add ?? []).toEqual([]);
      const volumes = (current.volumes ?? []) as Array<Record<string, unknown>>;
      expect(volumes).not.toContainEqual(
        expect.objectContaining({ type: "bind" }),
      );
      if (
        name.endsWith("-api") ||
        name === "platform-migrate" ||
        name === "tf-migrate"
      ) {
        expect(current.user).toBe("10001:10001");
        expect(current.read_only).toBe(true);
        expect(current.tmpfs).toBeInstanceOf(Array);
        expect(current.security_opt).toContain("no-new-privileges:true");
        expect(current.cap_drop).toContain("ALL");
      }
    }
    const queueRedis = service(config, "tf-download-redis");

    expect(queueRedis.build).toMatchObject({
      dockerfile: "artifacts/tf-download-worker/Dockerfile",
      target: "queue-redis",
    });
    expect(
      resolve(
        (queueRedis.build as { context?: string } | undefined)?.context ?? "",
      ),
    ).toBe(resolve(repositoryRoot));
    expect(queueRedis.image).toBe("apollo-tf-download-redis:bridge");
    expect(queueRedis.user).toBe("999:999");
    expect(queueRedis.read_only).toBe(true);
    expect(queueRedis.init).toBe(true);
    expect(queueRedis.tmpfs).toEqual(["/tmp:rw,noexec,nosuid,size=16m"]);
    expect(queueRedis.networks).toEqual({
      "tf-download-queue": null,
    });
    expect(queueRedis.security_opt).toEqual(["no-new-privileges:true"]);
    expect(queueRedis.cap_drop).toEqual(["ALL"]);
    expect(queueRedis.pids_limit).toBe(128);
    expect(queueRedis.stop_grace_period).toBe("20s");
    expect(queueRedis.deploy).toEqual({
      placement: {},
      resources: {
        limits: { cpus: 0.5, memory: "268435456", pids: 128 },
        reservations: { cpus: 0.1, memory: "67108864" },
      },
    });
    expect(queueRedis.healthcheck).toEqual({
      test: ["CMD", "/usr/local/bin/queue-redis-health.sh"],
      interval: "5s",
      timeout: "3s",
      retries: 20,
      start_period: "5s",
    });
    expect(queueRedis.ports).toBeUndefined();
    expect(queueRedis.volumes).toEqual([
      {
        type: "volume",
        source: "tf-download-redis-data",
        target: "/data",
        volume: {},
      },
    ]);

    const dockerfile = await readFile(tfDownloadWorkerDockerfile, "utf8");
    expect(dockerfile).toContain("AS queue-redis");
    expect(dockerfile).toContain("/usr/local/bin/queue-redis-health.sh");
  }, 20_000);

  test("builds immutable non-root API images without copying secrets", async () => {
    const [platform, tf, tfEntrypoint] = await Promise.all([
      readFile(platformDockerfile, "utf8"),
      readFile(tfDockerfile, "utf8"),
      readFile(
        new URL("../../api-server/container/start-tf.sh", import.meta.url),
        "utf8",
      ),
    ]);
    for (const dockerfile of [platform, tf]) {
      expect(dockerfile).toMatch(/USER 10001:10001/);
      expect(dockerfile).not.toMatch(/COPY .*\.env/i);
      expect(dockerfile).not.toMatch(
        /COPY\s+.*(?:\.ops-private|\/run\/secrets|secrets?\/)/i,
      );
      expect(dockerfile).not.toContain("/var/run/docker.sock");
    }
    expect(platform).toContain("/app/bin/start-api.sh");
    expect(tf).toContain("/app/bin/start-tf.sh");
    expect(tf).toContain(
      "COPY --from=builder /app/artifacts/api-server/dist ./artifacts/api-server/dist",
    );
    expect(tf).toContain('CMD ["node", "artifacts/api-server/dist/index.mjs"]');
    expect(tfEntrypoint).toContain("DATABASE_URL_FILE");
    expect(tfEntrypoint).not.toMatch(/echo|printf/);
  });

  test("keeps the fixed PKCE verifier bridge-only and file-backed", async () => {
    const [compose, runtimeConfig, authRoute] = await Promise.all([
      readFile(composeFile, "utf8"),
      readFile(
        new URL(
          "../../api-server/src/lib/platform-auth-client.ts",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL("../../api-server/src/routes/auth.ts", import.meta.url),
        "utf8",
      ),
    ]);
    expect(compose).toContain("tf_pkce_verifier");
    expect(compose).toContain(
      "APOLLO_TF_BRIDGE_PKCE_VERIFIER_FILE: /run/secrets/tf_pkce_verifier",
    );
    expect(runtimeConfig).toContain("APOLLO_TF_BRIDGE_PKCE_VERIFIER_FILE");
    expect(runtimeConfig).toContain("APOLLO_TF_BRIDGE_ALLOW_INTERNAL_HTTP");
    expect(authRoute).toContain("pkceVerifier");
  });

  test("keeps upgraded TLS tunnels alive for the server revocation check", async () => {
    const smoke = await readFile(smokeScript, "utf8");
    expect(smoke).toContain("upstream.setTimeout(0);");
  });

  test("redacts the TF CSRF token and sends it on browser mutations", async () => {
    const smoke = await readFile(smokeScript, "utf8");
    expect(smoke).toMatch(
      /label:\s*"tf-session",[\s\S]{0,120}redact:\s*\["csrfToken"\]/,
    );
    expect(smoke).toMatch(
      /const tfCsrfToken = me\.json\.csrfToken;[\s\S]{0,160}state\.rawSecrets\.push\(tfCsrfToken\)/,
    );
    expect(smoke.match(/headers:\s*protectedTfHeaders\(state\)/g)).toHaveLength(
      1,
    );
    expect(smoke.match(/\.\.\.protectedTfHeaders\(state\)/g)).toHaveLength(1);

    const smokeModule = await loadSmokeModule();
    expect(smokeModule.createSmokeDownloadFixture).toBeTypeOf("function");
    const sourceUrl = "https://www.youtube.com/watch?v=apollo_bridge_download";
    const trackId = `yt_${Buffer.from(sourceUrl, "utf8").toString("base64url")}`;
    expect(smokeModule.createSmokeDownloadFixture!()).toEqual({
      trackId,
      request: {
        tracks: [
          {
            trackId,
            artist: "Bridge Artist",
            title: "Bridge Track",
            quality: "320",
          },
        ],
      },
    });
  });

  test("keeps root and TF deployment templates loopback-bound and secret-backed", async () => {
    const [rootCompose, tfCompose] = await Promise.all([
      readFile(new URL("../../../docker-compose.yml", import.meta.url), "utf8"),
      readFile(
        new URL("../../api-server/docker-compose.yml", import.meta.url),
        "utf8",
      ),
    ]);
    for (const source of [rootCompose, tfCompose]) {
      expect(source).not.toMatch(/["']?8080:8080/);
      expect(source).not.toMatch(
        /postgres:\/\/(?:trackfinder:trackfinder|apollo:apollo_secret)/,
      );
      expect(source).toContain("127.0.0.1:");
      expect(source).toContain("DATABASE_URL_FILE");
      expect(source).not.toContain("/var/run/docker.sock");
    }
  });

  test("uses fixed disposable image names that inherited variables cannot replace", async () => {
    const source = await readFile(composeFile, "utf8");
    expect(source).not.toContain("${PLATFORM_POSTGRES_IMAGE");
    expect(source).not.toContain("${PLATFORM_API_IMAGE");
    expect(source).not.toContain("${TF_API_IMAGE");
    expect(source).not.toContain("${TF_DOWNLOAD_REDIS_IMAGE");

    const { config } = await renderedBridgeCompose();
    expect(service(config, "platform-postgres").image).toBe(
      "apollo-platform-postgres:bridge",
    );
    expect(service(config, "platform-migrate").image).toBe(
      "apollo-platform-api:bridge",
    );
    expect(service(config, "platform-api").image).toBe(
      "apollo-platform-api:bridge",
    );
    expect(service(config, "tf-api").image).toBe("apollo-tf-api:bridge");
    expect(service(config, "tf-download-redis").image).toBe(
      "apollo-tf-download-redis:bridge",
    );
    expect(service(config, "tf-migrate").image).toBe("apollo-tf-api:bridge");
    expect(service(config, "tf-postgres").image).toBe(
      "apollo-tf-postgres:bridge",
    );
  });

  test("binds distinct generated TF command and queue secrets into raw canary scans", async () => {
    const smokeModule = await loadSmokeModule();
    expect(smokeModule.prepareSecretDirectory).toBeTypeOf("function");
    const environment = {} as NodeJS.ProcessEnv;
    let directory: string | undefined;
    try {
      const fixture = await smokeModule.prepareSecretDirectory!(
        environment,
        "https://127.0.0.1:18444",
      );
      directory = fixture.directory;
      expect(environment.BRIDGE_SECRET_DIRECTORY).toBe(directory);
      const heartbeat = JSON.parse(
        await readFile(join(directory, "tf_module_heartbeat_keys"), "utf8"),
      ) as Record<string, unknown>;
      expect(Object.keys(heartbeat).sort()).toEqual([
        "account-integrations",
        "download-worker",
        "search-media",
      ]);
      const values = Object.values(heartbeat);
      expect(values.every((value) => typeof value === "string")).toBe(true);
      expect(new Set(values).size).toBe(3);
      expect(
        values.every(
          (value) =>
            Buffer.byteLength(value as string, "utf8") >= 32 &&
            Buffer.byteLength(value as string, "utf8") <= 512,
        ),
      ).toBe(true);
      expect(
        values.every((value) => fixture.rawSecrets.includes(value as string)),
      ).toBe(true);
      const commandSecretNames = [
        "tf_integrations_internal_auth_secret",
        "tf_search_internal_auth_secret",
        "tf_download_internal_auth_secret",
      ];
      const commandSecrets = await Promise.all(
        commandSecretNames.map((name) =>
          readFile(join(directory!, name), "utf8"),
        ),
      );
      const queuePassword = await readFile(
        join(directory, "tf_download_queue_password"),
        "utf8",
      );
      const queueUrl = await readFile(
        join(directory, "tf_download_queue_redis_url"),
        "utf8",
      );
      const oauthClientSecret = await readFile(
        join(directory, "tf_client_secret"),
        "utf8",
      );
      const pkceVerifier = await readFile(
        join(directory, "tf_pkce_verifier"),
        "utf8",
      );
      const generatedCommandAndAuthValues = [
        ...commandSecrets,
        queuePassword,
        oauthClientSecret,
        pkceVerifier,
        ...values.map(String),
      ];
      expect(new Set(generatedCommandAndAuthValues).size).toBe(
        generatedCommandAndAuthValues.length,
      );
      for (const value of [...commandSecrets, queuePassword]) {
        expect(Buffer.byteLength(value, "utf8")).toBeGreaterThanOrEqual(32);
        expect(Buffer.byteLength(value, "utf8")).toBeLessThanOrEqual(512);
        expect(fixture.rawSecrets).toContain(value);
      }
      expect(queueUrl).toBe(
        `redis://default:${encodeURIComponent(queuePassword)}` +
          "@tf-download-redis:6379/0",
      );
      expect(fixture.rawSecrets).toContain(queueUrl);
      for (const name of commandSecretNames) {
        const metadata = await stat(join(directory, name));
        if (process.platform === "win32") {
          expect(metadata.mode & 0o777).toBe(0o444);
        } else {
          expect(metadata.mode & 0o777).toBe(0o400);
          expect(metadata.uid).toBe(10001);
          expect(metadata.gid).toBe(10001);
        }
      }
      const queuePasswordMetadata = await stat(
        join(directory, "tf_download_queue_password"),
      );
      if (process.platform === "win32") {
        expect(queuePasswordMetadata.mode & 0o777).toBe(0o444);
      } else {
        expect(queuePasswordMetadata.mode & 0o777).toBe(0o400);
        expect(queuePasswordMetadata.uid).toBe(999);
        expect(queuePasswordMetadata.gid).toBe(999);
      }
      const queueUrlMetadata = await stat(
        join(directory, "tf_download_queue_redis_url"),
      );
      if (process.platform === "win32") {
        expect(queueUrlMetadata.mode & 0o777).toBe(0o444);
      } else {
        expect(queueUrlMetadata.mode & 0o777).toBe(0o400);
        expect(queueUrlMetadata.uid).toBe(10001);
        expect(queueUrlMetadata.gid).toBe(10001);
      }
    } finally {
      if (directory !== undefined) {
        await rm(directory, { force: true, recursive: true });
      }
    }
  });

  test("documents creation and ownership of every required TF secret file", async () => {
    const modules = await readFile(
      new URL("../../../MODULES.md", import.meta.url),
      "utf8",
    );
    const startup = modules.slice(
      modules.indexOf("### Запуск на своём сервере"),
    );
    expect(startup).toContain("TF_SECRET_DIRECTORY=");
    expect(startup).toContain("tf_client_secret");
    for (const name of [
      "tf_postgres_admin_password",
      "tf_admin_database_url",
      "tf_migrator_password",
      "tf_runtime_password",
      "tf_migrator_database_url",
      "tf_runtime_database_url",
    ]) {
      expect(startup).toContain(name);
    }
    expect(startup).toContain("root:10002");
    expect(startup).toContain("10001:10001");
    expect(startup).toContain("999:999");
    expect(startup).toMatch(/(?:mkdir|install)[^\n]+TF_SECRET_DIRECTORY/);
    expect(startup).toMatch(
      /(?:install[^\n]+-m (?:700|0700)|chmod[^\n]+(?:700|0700))/,
    );
    expect(startup).toMatch(/chmod[^\n]+(?:400|0400|440|0440|444|0444)/);
  });
});

type LifecycleDependencies = {
  compose(
    args: readonly string[],
    options?: { signal?: AbortSignal },
  ): Promise<{ stdout: string; stderr: string }>;
  validateConfig(output: string): void;
  waitForReadiness(signal?: AbortSignal): Promise<void>;
  runFlow(signal?: AbortSignal): Promise<void>;
  scanLogs(output: string): void;
};

describe("bridge smoke orchestration", () => {
  test("excludes the public installation identifier from cookie credentials", async () => {
    const smokeModule = (await import(
      new URL("../scripts/bridge-smoke.mjs", import.meta.url).href
    )) as {
      CookieJar?: new () => {
        ingest(response: { headers: { "set-cookie": string[] } }): void;
        secretValues(publicNames: readonly string[]): string[];
      };
    };
    expect(smokeModule.CookieJar).toBeTypeOf("function");
    const cookies = new smokeModule.CookieJar!();
    cookies.ingest({
      headers: {
        "set-cookie": [
          "__Host-apollo_tf_installation=public-installation; Secure; HttpOnly",
          "__Host-apollo_tf=secret-session; Secure; HttpOnly",
        ],
      },
    });
    expect(cookies.secretValues(["__Host-apollo_tf_installation"])).toEqual([
      "secret-session",
    ]);
  });

  test("runs config/build/up/readiness/flow/log scan/down in order", async () => {
    const smokeModule = (await import(
      new URL("../scripts/bridge-smoke.mjs", import.meta.url).href
    )) as {
      runBridgeLifecycle?: (
        dependencies: LifecycleDependencies,
      ) => Promise<void>;
      sanitizedDiagnostic?: (error: unknown, secrets: string[]) => string;
    };
    expect(smokeModule.runBridgeLifecycle).toBeTypeOf("function");
    const order: string[] = [];
    await smokeModule.runBridgeLifecycle!({
      compose: async (args) => {
        const stage =
          ["config", "build", "up", "logs", "down"].find((candidate) =>
            args.includes(candidate),
          ) ?? "unknown";
        order.push(stage);
        return {
          stdout: stage === "config" ? '{"services":{}}' : "",
          stderr: "",
        };
      },
      validateConfig: () => order.push("validate-config"),
      waitForReadiness: async () => {
        order.push("readiness");
      },
      runFlow: async () => {
        order.push("flow");
      },
      scanLogs: () => order.push("log-scan"),
    });
    expect(order).toEqual([
      "config",
      "validate-config",
      "build",
      "up",
      "readiness",
      "flow",
      "logs",
      "log-scan",
      "down",
    ]);

    expect(smokeModule.sanitizedDiagnostic).toBeTypeOf("function");
    const diagnosticSecret = randomBytes(32).toString("base64url");
    const diagnostic = smokeModule.sanitizedDiagnostic!(
      new Error(
        `${"compose progress\n".repeat(1_000)}` +
          `tf-api-1 | TF API startup failed ${diagnosticSecret}`,
      ),
      [diagnosticSecret],
    );
    expect(diagnostic).toContain("tf-api-1 | TF API startup failed");
    expect(diagnostic).not.toContain(diagnosticSecret);
    expect(diagnostic).toContain("<redacted>");
    expect(Buffer.byteLength(diagnostic, "utf8")).toBeLessThanOrEqual(8_192);
  });

  test("unwinds lifecycle and caller cleanup after the in-process deadline", async () => {
    const smokeModule = await loadSmokeModule();
    expect(smokeModule.runBridgeLifecycle).toBeTypeOf("function");
    expect(smokeModule.runWithLifecycleDeadline).toBeTypeOf("function");
    const order: string[] = [];
    let fireWatchdog: (() => void) | undefined;
    const timers = {
      setTimeout(callback: () => void): number {
        fireWatchdog = callback;
        return 1;
      },
      clearTimeout(): void {
        order.push("watchdog-cleared");
      },
    };

    const execution = (async () => {
      try {
        await smokeModule.runWithLifecycleDeadline!(
          (signal) =>
            smokeModule.runBridgeLifecycle!(
              {
                compose: async (args) => {
                  const stage =
                    ["config", "build", "down"].find((candidate) =>
                      args.includes(candidate),
                    ) ?? "unexpected";
                  order.push(stage);
                  if (stage === "build") {
                    return new Promise((_, reject) => {
                      signal.addEventListener(
                        "abort",
                        () => reject(signal.reason),
                        { once: true },
                      );
                      fireWatchdog!();
                    });
                  }
                  return {
                    stdout: stage === "config" ? '{"services":{}}' : "",
                    stderr: "",
                  };
                },
                validateConfig: () => undefined,
                waitForReadiness: async () => undefined,
                runFlow: async () => undefined,
                scanLogs: () => undefined,
              },
              { signal },
            ),
          100,
          timers,
        );
      } finally {
        order.push("caller-cleanup");
      }
    })();

    await expect(execution).rejects.toThrow(
      "Bridge smoke lifecycle deadline exceeded",
    );
    expect(order).toEqual([
      "config",
      "build",
      "down",
      "watchdog-cleared",
      "caller-cleanup",
    ]);
    const source = await readFile(smokeScript, "utf8");
    expect(source).toMatch(
      /runWithLifecycleDeadline\([\s\S]+runBridgeLifecycle\([\s\S]+BRIDGE_SMOKE_TIMEOUTS\.lifecycleMs/,
    );
  });

  test("bounds every external command and terminates a hung subprocess", async () => {
    const smoke = await readFile(smokeScript, "utf8");
    const smokeModule = await loadSmokeModule();
    expect(smokeModule.runBoundedCommand).toBeTypeOf("function");

    const startedAt = Date.now();
    await expect(
      smokeModule.runBoundedCommand!(
        process.execPath,
        ["-e", "setInterval(() => {}, 10_000)"],
        { timeoutMs: 100 },
      ),
    ).rejects.toMatchObject({ killed: true });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(smoke.match(/\bexecFileAsync\(/g)).toHaveLength(1);
  });

  test("rejects WebSocket handshake errors within an explicit deadline", async () => {
    const smokeModule = await loadSmokeModule();
    expect(smokeModule.rejectedWebSocketStatus).toBeTypeOf("function");
    const port = await (async () => {
      const server = await import("node:net").then(({ createServer }) =>
        createServer(),
      );
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(0, "127.0.0.1", resolveListen);
      });
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("loopback fixture did not bind");
      }
      await new Promise<void>((resolveClose) =>
        server.close(() => resolveClose()),
      );
      return address.port;
    })();

    await expect(
      Promise.race([
        smokeModule.rejectedWebSocketStatus!(
          `ws://127.0.0.1:${port}`,
          Buffer.alloc(0),
        ),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("WebSocket helper did not settle")),
            1_000,
          ),
        ),
      ]),
    ).rejects.toThrow(/WebSocket replay (?:failed|deadline exceeded)/);
  });

  test.each([
    {
      label: "headers",
      response: {
        headers: { "x-readiness-secret": "known-readiness-secret" },
        rawHeaders: ["X-Readiness-Secret", "known-readiness-secret"],
        bodyBytes: Buffer.alloc(0),
        text: "",
      },
    },
    {
      label: "body",
      response: {
        headers: {},
        rawHeaders: [],
        bodyBytes: Buffer.from("known-readiness-secret", "utf8"),
        text: "known-readiness-secret",
      },
    },
  ])(
    "rejects a known secret in readiness response $label",
    async ({ response }) => {
      const smokeModule = await loadSmokeModule();
      expect(smokeModule.waitForReadiness).toBeTypeOf("function");
      const cleanResponse = {
        status: 200,
        headers: {},
        rawHeaders: [],
        bodyBytes: Buffer.alloc(0),
        text: "",
        json: null,
      };
      const state = {
        ca: Buffer.alloc(0),
        platformOrigin: "https://127.0.0.1:18443",
        tfOrigin: "https://127.0.0.1:18444",
        projections: [],
        rawSecrets: ["known-readiness-secret"],
      };

      await expect(
        smokeModule.waitForReadiness!(state, undefined, {
          request: async (_ca, _origin, path) => ({
            status: 200,
            json: null,
            ...(path === "/readyz" ? response : cleanResponse),
          }),
        }),
      ).rejects.toThrow(/contains secret material/i);
      expect(state.projections).toHaveLength(1);
    },
  );

  test.each([
    { label: "headers", header: "known-websocket-secret", body: "" },
    { label: "body", header: "", body: "known-websocket-secret" },
  ])(
    "rejects a known secret in rejected WebSocket response $label",
    async ({ header, body }) => {
      const smokeModule = await loadSmokeModule();
      expect(smokeModule.rejectedWebSocketStatus).toBeTypeOf("function");
      const server = createServer();
      server.on("upgrade", (_request, socket) => {
        const headerLines = [
          "HTTP/1.1 401 Unauthorized",
          ...(header.length > 0 ? [`X-WebSocket-Secret: ${header}`] : []),
          `Content-Length: ${Buffer.byteLength(body)}`,
          "Connection: close",
          "",
          body,
        ];
        socket.end(headerLines.join("\r\n"));
      });
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(0, "127.0.0.1", resolveListen);
      });
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("WebSocket fixture did not bind");
      }
      const state = {
        projections: [],
        rawSecrets: ["known-websocket-secret"],
      };
      try {
        await expect(
          smokeModule.rejectedWebSocketStatus!(
            `ws://127.0.0.1:${address.port}`,
            Buffer.alloc(0),
            state,
          ),
        ).rejects.toThrow(/contains secret material/i);
        expect(state.projections).toHaveLength(1);
      } finally {
        await new Promise<void>((resolveClose) =>
          server.close(() => resolveClose()),
        );
      }
    },
  );

  test.each([
    {
      label: "an extra key",
      query: "code=code-value&state=state-value&extra=callback-secret",
    },
    { label: "a missing key", query: "code=callback-secret" },
    {
      label: "a duplicate key",
      query: "code=callback-secret&code=other&state=state-value",
    },
  ])("rejects a callback with $label", async ({ query }) => {
    const smokeModule = await loadSmokeModule();
    expect(smokeModule.validateTfCallbackLocation).toBeTypeOf("function");
    let thrown: unknown;
    try {
      smokeModule.validateTfCallbackLocation!(
        `https://127.0.0.1:18444/api/auth/callback?${query}`,
        "https://127.0.0.1:18444",
      );
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown)).toContain("TF callback query is invalid");
    expect(String(thrown)).not.toContain("callback-secret");
  });

  test("forces retained TLS proxy connections closed at its injected deadline", async () => {
    const smokeModule = await loadSmokeModule();
    expect(smokeModule.closeTlsProxyServer).toBeTypeOf("function");
    let fireDeadline: (() => void) | undefined;
    let closeAllCalls = 0;
    let destroyed = 0;
    const closing = smokeModule.closeTlsProxyServer!(
      {
        close: () => undefined,
        closeAllConnections: () => {
          closeAllCalls += 1;
        },
      },
      new Set([
        {
          destroy: () => {
            destroyed += 1;
          },
        },
      ]),
      {
        timeoutMs: 1,
        timers: {
          clearTimeout: () => undefined,
          setTimeout: (callback) => {
            fireDeadline = callback;
            return 1;
          },
        },
      },
    );
    expect(fireDeadline).toBeTypeOf("function");
    fireDeadline!();
    await closing;
    expect(closeAllCalls).toBeGreaterThan(0);
    expect(destroyed).toBe(1);
  });

  test("retains a reused TLS proxy socket with one close listener", async () => {
    const smokeModule = await loadSmokeModule();
    expect(smokeModule.retainSocket).toBeTypeOf("function");
    const closeListeners: Array<() => void> = [];
    let destroyed = 0;
    const socket = {
      destroy: () => {
        destroyed += 1;
      },
      once: (_event: "close", listener: () => void) => {
        closeListeners.push(listener);
      },
    };
    const sockets = new Set<typeof socket>();

    for (let registration = 0; registration < 11; registration += 1) {
      expect(smokeModule.retainSocket!(sockets, socket)).toBe(socket);
    }

    expect(closeListeners).toHaveLength(1);
    expect(sockets).toContain(socket);
    closeListeners[0]!();
    expect(sockets).not.toContain(socket);
    socket.destroy();
    expect(destroyed).toBe(1);
  });

  test("uses the live structured validator as the exact pre-build safety gate", async () => {
    const smokeModule = await loadSmokeModule();
    expect(smokeModule.validateRenderedBridgeConfig).toBeTypeOf("function");
    const { config, secretDirectory } = await renderedBridgeCompose();
    expect(() =>
      smokeModule.validateRenderedBridgeConfig!(
        JSON.stringify(config),
        [],
        secretDirectory,
      ),
    ).not.toThrow();

    const mutations: Array<(candidate: ComposeConfig) => void> = [
      (candidate) => {
        candidate.networks["tf-data"]!.internal = false;
      },
      (candidate) => {
        service(candidate, "platform-migrate").networks = [
          "platform-data",
          "platform-tf-control",
        ];
      },
      (candidate) => {
        (
          service(candidate, "tf-api").secrets as Array<Record<string, unknown>>
        ).push({
          source: "platform_assertion_private_jwk",
          target: "platform_assertion_private_jwk",
        });
      },
      (candidate) => {
        (
          service(candidate, "tf-api").build as Record<string, unknown>
        ).context = resolve(repositoryRoot, "..");
      },
      (candidate) => {
        service(candidate, "platform-api").user = "0:0";
      },
      (candidate) => {
        service(candidate, "tf-api").read_only = false;
      },
      (candidate) => {
        service(candidate, "platform-migrate").tmpfs = [];
      },
      (candidate) => {
        secretMount(
          service(candidate, "tf-migrate"),
          "tf_migrator_database_url",
        ).mode = "0444";
      },
      (candidate) => {
        secretMount(
          service(candidate, "tf-api"),
          "tf_module_heartbeat_keys",
        ).mode = "0444";
      },
      (candidate) => {
        (
          service(candidate, "platform-api").environment as Record<
            string,
            unknown
          >
        ).APOLLO_MODULE_HEARTBEAT_KEYS_FILE =
          "/run/secrets/tf_module_heartbeat_keys";
      },
      (candidate) => {
        (
          service(candidate, "platform-api").environment as Record<
            string,
            unknown
          >
        ).TF_SEARCH_ORIGIN = "http://tf-search:8080";
      },
      (candidate) => {
        (
          service(candidate, "platform-api").secrets as Array<
            Record<string, unknown>
          >
        ).push({
          source: "tf_search_internal_auth_secret",
          target: "tf_search_internal_auth_secret",
        });
      },
      (candidate) => {
        (
          service(candidate, "tf-api").secrets as Array<Record<string, unknown>>
        ).push({
          source: "tf_download_queue_password",
          target: "tf_download_queue_password",
        });
      },
      (candidate) => {
        (
          service(candidate, "tf-download-redis").secrets as Array<
            Record<string, unknown>
          >
        ).push({
          source: "tf_download_queue_redis_url",
          target: "tf_download_queue_redis_url",
        });
      },
      (candidate) => {
        service(candidate, "tf-download-redis").networks = [
          "tf-download-queue",
          "tf-data",
        ];
      },
      (candidate) => {
        service(candidate, "tf-redis").networks = [
          "tf-data",
          "tf-download-queue",
        ];
      },
      (candidate) => {
        service(candidate, "tf-api").cap_drop = [];
      },
      (candidate) => {
        service(candidate, "platform-api").depends_on = {};
      },
      (candidate) => {
        service(candidate, "tf-api").volumes = [
          {
            type: "bind",
            source: repositoryRoot,
            target: "/host",
          },
        ];
      },
      (candidate) => {
        service(candidate, "tf-api").volumes = [
          {
            type: "volume",
            source: "platform-postgres-data",
            target: "/platform-data",
          },
        ];
      },
      (candidate) => {
        candidate.secrets["tf_client_secret"]!.file = join(
          secretDirectory,
          "platform_runtime_password",
        );
      },
      (candidate) => {
        service(candidate, "tf-redis").image = "redis:latest";
      },
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(config);
      mutate(candidate);
      expect(() =>
        smokeModule.validateRenderedBridgeConfig!(
          JSON.stringify(candidate),
          [],
          secretDirectory,
        ),
      ).toThrow();
    }
  }, 20_000);

  test("removes a partially prepared secret directory when handoff fails", async () => {
    const smokeModule = await loadSmokeModule();
    expect(smokeModule.prepareSecretDirectory).toBeTypeOf("function");
    const prefix = "apollo-platform-tf-bridge-secrets-";
    const before = new Set(
      (await readdir(tmpdir())).filter((name) => name.startsWith(prefix)),
    );

    await expect(
      smokeModule.prepareSecretDirectory!(
        Object.freeze({}) as NodeJS.ProcessEnv,
        "https://127.0.0.1:18444",
      ),
    ).rejects.toBeDefined();

    const after = (await readdir(tmpdir())).filter(
      (name) => name.startsWith(prefix) && !before.has(name),
    );
    expect(after).toEqual([]);
  });

  test("propagates deletion failures and verifies exact directory absence", async () => {
    const smokeModule = await loadSmokeModule();
    expect(smokeModule.removeVerifiedDirectory).toBeTypeOf("function");
    const directory = await mkdtemp(join(tmpdir(), "apollo-cleanup-contract-"));
    try {
      await expect(
        smokeModule.removeVerifiedDirectory!(directory, {
          rm: async () => undefined,
          access: async () => undefined,
        }),
      ).rejects.toThrow(/cleanup incomplete/);
      await expect(
        smokeModule.removeVerifiedDirectory!(directory, {
          rm: async () => {
            throw new Error("deletion denied");
          },
          access,
        }),
      ).rejects.toThrow("deletion denied");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("projects raw bodies and headers while redacting only permitted slots", async () => {
    const smokeModule = await loadSmokeModule();
    expect(smokeModule.projectResponseForSecretScan).toBeTypeOf("function");
    const permitted = "permitted-secret-value";
    const bodyLeak = "non-json-body-secret";
    const headerLeak = "unexpected-header-secret";
    const redirectLeak = "unexpected-redirect-secret";
    const location = new URL("https://127.0.0.1:18444/callback");
    location.searchParams.set("state", permitted);
    location.searchParams.set("unexpected", redirectLeak);

    const projection = smokeModule.projectResponseForSecretScan!(
      {
        status: 303,
        headers: {
          "content-type": "text/plain",
          "set-cookie": [
            `__Host-apollo_tf=${permitted}; Path=/; Secure; HttpOnly`,
            `unapproved=${headerLeak}; Path=/; Secure`,
          ],
          location: location.toString(),
          "x-unexpected-secret": headerLeak,
        },
        rawHeaders: [
          "Content-Type",
          "text/plain",
          "Set-Cookie",
          `__Host-apollo_tf=${permitted}; Path=/; Secure; HttpOnly`,
          "Set-Cookie",
          `unapproved=${headerLeak}; Path=/; Secure`,
          "X-Unexpected-Secret",
          "first-value",
          "X-Unexpected-Secret",
          headerLeak,
          "Location",
          location.toString(),
        ],
        bodyBytes: Buffer.from(`plain response ${bodyLeak}`, "utf8"),
        text: `plain response ${bodyLeak}`,
        json: null,
      },
      {
        cookieNames: ["__Host-apollo_tf"],
        locationQueryParameters: ["state"],
      },
    );
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain(permitted);
    expect(serialized).toContain(bodyLeak);
    expect(serialized).toContain(headerLeak);
    expect(serialized).toContain(redirectLeak);
    expect(projection.rawHeaders).toContain("first-value");
    expect(projection.rawHeaders).toContain(headerLeak);
    expect(projection.rawBody.equals(Buffer.from(projection.body))).toBe(true);

    const rawJson = Buffer.from(
      `{\n  "csrfToken": "${permitted}",\n  "retained": "${bodyLeak}"\n}`,
      "utf8",
    );
    const jsonProjection = smokeModule.projectResponseForSecretScan!(
      {
        status: 200,
        headers: { "content-type": "application/json" },
        rawHeaders: ["Content-Type", "application/json"],
        bodyBytes: rawJson,
        text: rawJson.toString("utf8"),
        json: { csrfToken: permitted, retained: bodyLeak },
      },
      { bodyFields: ["csrfToken"] },
    );
    expect(jsonProjection.body).not.toContain(permitted);
    expect(jsonProjection.body).toContain(bodyLeak);
    expect(jsonProjection.rawBody.toString("utf8")).toBe(
      `{\n  "csrfToken": "<redacted>",\n  "retained": "${bodyLeak}"\n}`,
    );
  });

  test("rejects duplicate permitted JSON fields instead of hiding raw bytes", async () => {
    const smokeModule = await loadSmokeModule();
    const duplicateBody =
      '{"ticket":"permitted-secret","ticket":"unexpected-secret"}';
    expect(() =>
      smokeModule.projectResponseForSecretScan!(
        {
          status: 201,
          headers: { "content-type": "application/json" },
          rawHeaders: ["Content-Type", "application/json"],
          bodyBytes: Buffer.from(duplicateBody, "utf8"),
          text: duplicateBody,
          json: { ticket: "unexpected-secret" },
        },
        { bodyFields: ["ticket"] },
      ),
    ).toThrow(/duplicate permitted JSON field/i);
  });

  test.each(["code", "state"])(
    "rejects duplicate permitted redirect parameter %s without leaking it",
    async (parameter) => {
      const smokeModule = await loadSmokeModule();
      const injectedSecret = `duplicate-${parameter}-secret`;
      const location = new URL("https://127.0.0.1:18444/callback");
      location.searchParams.append(parameter, injectedSecret);
      location.searchParams.append(parameter, "attacker-controlled-duplicate");
      const response = {
        status: 303,
        headers: { location: location.toString() },
        rawHeaders: ["Location", location.toString()],
        bodyBytes: Buffer.alloc(0),
        text: "",
        json: null,
      };

      let thrown: unknown;
      try {
        smokeModule.projectResponseForSecretScan!(response, {
          locationQueryParameters: [parameter],
        });
      } catch (error) {
        thrown = error;
      }

      expect(String(thrown)).toContain(
        "Redirect parameter must occur exactly once",
      );
      expect(String(thrown)).not.toContain(injectedSecret);
    },
  );

  test("redacts only the exact text duplicate of a single redirect location", async () => {
    const smokeModule = await loadSmokeModule();
    const redirectSecret = "redirect-state-secret";
    const location = `https://127.0.0.1:18444/callback?state=${redirectSecret}`;
    const body = `See Other. Redirecting to ${location}`;
    const response = {
      status: 303,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        location,
      },
      rawHeaders: [
        "Content-Type",
        "text/plain; charset=utf-8",
        "Location",
        location,
      ],
      bodyBytes: Buffer.from(body, "utf8"),
      text: body,
      json: null,
    };

    const projection = smokeModule.projectResponseForSecretScan!(response, {
      locationQueryParameters: ["state"],
      redactExactRedirectBody: true,
    });

    expect(JSON.stringify(projection)).not.toContain(redirectSecret);
    expect(projection.body).toBe(
      "See Other. Redirecting to <redacted-location>",
    );
    const emptyProjection = smokeModule.projectResponseForSecretScan!(
      {
        ...response,
        bodyBytes: Buffer.alloc(0),
        text: "",
      },
      {
        locationQueryParameters: ["state"],
        redactExactRedirectBody: true,
      },
    );
    expect(emptyProjection.body).toBe("");
    expect(() =>
      smokeModule.projectResponseForSecretScan!(
        {
          ...response,
          bodyBytes: Buffer.from(`${body}\nunexpected`, "utf8"),
          text: `${body}\nunexpected`,
        },
        {
          locationQueryParameters: ["state"],
          redactExactRedirectBody: true,
        },
      ),
    ).toThrow(/redirect response body is not an exact location duplicate/i);
    try {
      smokeModule.projectResponseForSecretScan!(
        {
          ...response,
          bodyBytes: Buffer.from(`${body}\nunexpected`, "utf8"),
          text: `${body}\nunexpected`,
        },
        {
          locationQueryParameters: ["state"],
          redactExactRedirectBody: true,
        },
      );
    } catch (error) {
      expect(String(error)).not.toContain(redirectSecret);
    }
    expect(() =>
      smokeModule.projectResponseForSecretScan!(
        {
          ...response,
          rawHeaders: [
            ...response.rawHeaders,
            "Location",
            `${location}&duplicate=1`,
          ],
        },
        {
          locationQueryParameters: ["state"],
          redactExactRedirectBody: true,
        },
      ),
    ).toThrow(/redirect response must contain one raw location header/i);
  });

  test("records unexpected responses before status validation throws", async () => {
    const smokeModule = await loadSmokeModule();
    expect(smokeModule.recordResponseBeforeStatus).toBeTypeOf("function");
    const state = { projections: [] };
    const response = {
      status: 500,
      headers: { "x-secret": "unexpected-header-secret" },
      rawHeaders: ["X-Secret", "unexpected-header-secret"],
      bodyBytes: Buffer.from("unexpected-body-secret", "utf8"),
      text: "unexpected-body-secret",
      json: null,
    };

    expect(() =>
      smokeModule.recordResponseBeforeStatus!(state, response, {
        expectedStatus: 200,
        label: "unexpected-response",
      }),
    ).toThrow(/unexpected-response status/);
    expect(JSON.stringify(state.projections)).toContain(
      "unexpected-header-secret",
    );
    expect(
      (
        state.projections[0] as {
          response: { rawBody: Buffer };
        }
      ).response.rawBody.toString("utf8"),
    ).toBe("unexpected-body-secret");
  });

  test("scans an unexpected response projection before status validation", async () => {
    const smokeModule = await loadSmokeModule();
    const knownSecret = "known-response-secret";
    const state = { projections: [], rawSecrets: [knownSecret] };
    const response = {
      status: 500,
      headers: { "x-duplicate": `safe, ${knownSecret}` },
      rawHeaders: ["X-Duplicate", "safe", "X-Duplicate", knownSecret],
      bodyBytes: Buffer.from(`failure ${knownSecret}`, "utf8"),
      text: `failure ${knownSecret}`,
      json: null,
    };

    expect(() =>
      smokeModule.recordResponseBeforeStatus!(state, response, {
        expectedStatus: 200,
        label: "unexpected-secret-response",
      }),
    ).toThrow(/sanitized raw response body.*contains secret material/i);
    expect(state.projections).toHaveLength(1);
  });

  test.each([
    {
      label: "body field",
      response: {
        status: 500,
        headers: { "content-type": "application/json" },
        rawHeaders: ["Content-Type", "application/json"],
        bodyBytes: Buffer.from(
          '{"ticket":"unexpected-permitted-secret"}',
          "utf8",
        ),
        text: '{"ticket":"unexpected-permitted-secret"}',
        json: { ticket: "unexpected-permitted-secret" },
      },
      allowances: { bodyFields: ["ticket"] },
    },
    {
      label: "cookie",
      response: {
        status: 500,
        headers: {
          "set-cookie": [
            "__Host-apollo_tf=unexpected-permitted-secret; Path=/; Secure; HttpOnly",
          ],
        },
        rawHeaders: [
          "Set-Cookie",
          "__Host-apollo_tf=unexpected-permitted-secret; Path=/; Secure; HttpOnly",
        ],
        bodyBytes: Buffer.from("{}", "utf8"),
        text: "{}",
        json: {},
      },
      allowances: { cookieNames: ["__Host-apollo_tf"] },
    },
    {
      label: "redirect parameter",
      response: {
        status: 500,
        headers: {
          location:
            "https://127.0.0.1/callback?state=unexpected-permitted-secret",
        },
        rawHeaders: [
          "Location",
          "https://127.0.0.1/callback?state=unexpected-permitted-secret",
        ],
        bodyBytes: Buffer.alloc(0),
        text: "",
        json: null,
      },
      allowances: { locationQueryParameters: ["state"] },
    },
  ])(
    "does not redact an allowed $label on an unexpected status",
    async ({ response, allowances }) => {
      const smokeModule = await loadSmokeModule();
      const state = {
        projections: [],
        rawSecrets: ["unexpected-permitted-secret"],
      };

      expect(() =>
        smokeModule.recordResponseBeforeStatus!(state, response, {
          expectedStatus: 201,
          label: "unexpected-allowed-slot",
          ...allowances,
        }),
      ).toThrow(/contains secret material/i);
      expect(JSON.stringify(state.projections)).toContain(
        "unexpected-permitted-secret",
      );
    },
  );

  test("gives the live lifecycle a bounded parent cleanup grace interval", async () => {
    const smokeModule = await loadSmokeModule();
    expect(smokeModule.BRIDGE_SMOKE_TIMEOUTS).toBeDefined();
    const budgets = smokeModule.BRIDGE_SMOKE_TIMEOUTS!;
    expect(budgets).toEqual(BRIDGE_SMOKE_TIMEOUTS);
    expect(budgets.lifecycleMs).toBeGreaterThan(budgets.composeBuildMs);
    expect(budgets.childMs).toBe(budgets.lifecycleMs + budgets.cleanupGraceMs);
    expect(budgets.parentMs).toBeGreaterThan(budgets.childMs);
    const source = await readFile(fileURLToPath(import.meta.url), "utf8");
    expect(source).toContain("timeout: BRIDGE_SMOKE_TIMEOUTS.childMs");
    expect(source).toContain("BRIDGE_SMOKE_TIMEOUTS.parentMs");
  });
});

type FakeDockerRecord = {
  args: string[];
  command: string;
  composeBake: string;
  dockerContext: string;
  dockerHost: string;
  project: string;
  inheritedProject: boolean;
  inheritedPorts: boolean;
  inheritedSecretDirectory: boolean;
};

async function fakeDockerExecutable(directory: string): Promise<void> {
  const executable = join(
    directory,
    process.platform === "win32" ? "docker.exe" : "docker",
  );
  try {
    await link(process.execPath, executable);
  } catch {
    await copyFile(process.execPath, executable);
  }
  if (process.platform !== "win32") await chmod(executable, 0o755);
}

async function runWithFakeDocker(overrides: NodeJS.ProcessEnv = {}): Promise<{
  records: FakeDockerRecord[];
  sentinelExists: boolean;
  leaked: boolean;
}> {
  const directory = await mkdtemp(join(tmpdir(), "apollo-bridge-hostile-"));
  const bin = join(directory, "bin");
  const log = join(directory, "docker.jsonl");
  const sentinel = join(directory, "existing-project");
  const leak = join(directory, "leak");
  const inheritedSecrets = join(directory, "hostile-secrets");
  const hook = join(directory, "fake-docker.cjs");
  await mkdir(bin);
  await fakeDockerExecutable(bin);
  await writeFile(sentinel, "do not remove", "utf8");
  await writeFile(
    hook,
    String.raw`
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(1);
args[0] = path.basename(args[0] ?? "");
if (!["context", "compose"].includes(args[0])) return;
const env = process.env;
function value(name) {
  const entry = Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1] ?? "";
}
const projectIndex = args.indexOf("-p");
const project = projectIndex < 0 ? value("COMPOSE_PROJECT_NAME") : args[projectIndex + 1] ?? "";
const command = args[0] === "context"
  ? "context"
  : ["config", "build", "up", "logs", "down"].find((name) => args.includes(name)) ?? "other";
fs.appendFileSync(env.FAKE_DOCKER_LOG, JSON.stringify({
  args,
  command,
  composeBake: value("COMPOSE_BAKE"),
  dockerContext: value("DOCKER_CONTEXT"),
  dockerHost: value("DOCKER_HOST"),
  project,
  inheritedProject: project === env.HOSTILE_PROJECT,
  inheritedPorts: value("PLATFORM_API_PORT") === env.HOSTILE_PLATFORM_PORT || value("TF_API_PORT") === env.HOSTILE_TF_PORT,
  inheritedSecretDirectory: value("BRIDGE_SECRET_DIRECTORY") === env.HOSTILE_SECRET_DIRECTORY,
}) + "\n");
if (args[0] === "context") {
  if (args.includes("show")) process.stdout.write("local-context");
  else process.stdout.write(JSON.stringify(args.includes("remote-context") ? "tcp://remote.example:2375" : "npipe:////./pipe/docker_engine"));
  process.exit(0);
}
if (["BUILDKIT_HOST","BUILDX_BUILDER","BUILDX_CONFIG","BUILDX_BAKE_FILE","DOCKER_CONFIG"].some((name) => value(name).length > 0)) {
  fs.writeFileSync(env.FAKE_LEAK, "unsafe selector reached compose");
}
if (command === "config") {
  const runtime = (networks, secrets) => ({
    user: "10001:10001",
    read_only: true,
    tmpfs: ["/tmp:rw,noexec,nosuid,size=16m"],
    networks,
    secrets,
    security_opt: ["no-new-privileges:true"],
    cap_drop: ["ALL"],
  });
  const services = {
    "platform-postgres": {
      build: { context: process.cwd(), dockerfile: "artifacts/platform-api/Dockerfile", target: "postgres-role-init" },
      image: "apollo-platform-postgres:bridge",
      environment: { POSTGRES_USER: "postgres" },
      networks: ["platform-data"],
      secrets: ["platform_postgres_admin_password","platform_migrator_password","platform_runtime_password"],
      volumes: [{ type: "volume", source: "platform-postgres-data", target: "/var/lib/postgresql/data" }],
    },
    "platform-redis": {
      image: "redis:7-bookworm",
      networks: ["platform-data"],
      volumes: [{ type: "volume", source: "platform-redis-data", target: "/data" }],
    },
    "platform-migrate": {
      ...runtime(["platform-data"], ["platform_migrator_database_url"]),
      build: { context: process.cwd(), dockerfile: "artifacts/platform-api/Dockerfile", target: "runtime" },
      image: "apollo-platform-api:bridge",
      depends_on: { "platform-postgres": { condition: "service_healthy" } },
    },
    "platform-api": {
      ...runtime(["bridge-edge","platform-data","platform-tf-control"], ["platform_assertion_private_jwk","platform_assertion_public_jwks","platform_oauth_clients","platform_operator_bootstrap_token","platform_runtime_database_url"]),
      build: { context: process.cwd(), dockerfile: "artifacts/platform-api/Dockerfile", target: "runtime" },
      image: "apollo-platform-api:bridge",
      ports: [{ host_ip: "127.0.0.1", published: value("PLATFORM_API_PORT"), target: 8080 }],
      depends_on: {
        "platform-migrate": { condition: "service_completed_successfully" },
        "platform-redis": { condition: "service_healthy" },
      },
    },
    "tf-postgres": {
      build: { context: process.cwd(), dockerfile: "artifacts/api-server/Dockerfile", target: "postgres-role-init" },
      image: "apollo-tf-postgres:bridge",
      environment: { POSTGRES_USER: "postgres" },
      networks: ["tf-data"],
      secrets: [
        { source: "tf_postgres_admin_password", target: "tf_postgres_admin_password", uid: "999", gid: "999", mode: "0400" },
        { source: "tf_migrator_password", target: "tf_migrator_password", uid: "999", gid: "999", mode: "0400" },
        { source: "tf_runtime_password", target: "tf_runtime_password", uid: "999", gid: "999", mode: "0400" },
      ],
      volumes: [{ type: "volume", source: "tf-postgres-data", target: "/var/lib/postgresql/data" }],
    },
    "tf-redis": {
      image: "redis:7-bookworm",
      networks: ["tf-data"],
      volumes: [{ type: "volume", source: "tf-redis-data", target: "/data" }],
    },
    "tf-download-redis": {
      build: { context: process.cwd(), dockerfile: "artifacts/tf-download-worker/Dockerfile", target: "queue-redis" },
      image: "apollo-tf-download-redis:bridge",
      user: "999:999",
      read_only: true,
      init: true,
      environment: { TF_DOWNLOAD_QUEUE_PASSWORD_FILE: "/run/secrets/tf_download_queue_password" },
      secrets: [{ source: "tf_download_queue_password", target: "tf_download_queue_password", uid: "999", gid: "999", mode: "0400" }],
      volumes: [{ type: "volume", source: "tf-download-redis-data", target: "/data" }],
      tmpfs: ["/tmp:rw,noexec,nosuid,size=16m"],
      networks: ["tf-download-queue"],
      security_opt: ["no-new-privileges:true"],
      cap_drop: ["ALL"],
      pids_limit: 128,
      stop_grace_period: "20s",
      deploy: {
        placement: {},
        resources: {
          limits: { cpus: 0.5, memory: "268435456", pids: 128 },
          reservations: { cpus: 0.1, memory: "67108864" },
        },
      },
      healthcheck: {
        test: ["CMD", "/usr/local/bin/queue-redis-health.sh"],
        interval: "5s",
        timeout: "3s",
        retries: 20,
        start_period: "5s",
      },
    },
    "tf-migrate": {
      ...runtime(["tf-data"], [{ source: "tf_migrator_database_url", target: "tf_migrator_database_url", uid: "10001", gid: "10001", mode: "0400" }]),
      build: { context: process.cwd(), dockerfile: "artifacts/api-server/Dockerfile", target: "runner" },
      image: "apollo-tf-api:bridge",
      entrypoint: ["node","artifacts/api-server/dist/migrate.mjs"],
      environment: { TF_MIGRATOR_DATABASE_URL_FILE: "/run/secrets/tf_migrator_database_url" },
      depends_on: { "tf-postgres": { condition: "service_healthy" } },
    },
    "tf-api": {
      ...runtime(["bridge-edge","platform-tf-control","tf-data","tf-download-queue"], ["tf_client_secret",{ source: "tf_download_internal_auth_secret", target: "tf_download_internal_auth_secret", uid: "10001", gid: "10001", mode: "0400" },{ source: "tf_download_queue_redis_url", target: "tf_download_queue_redis_url", uid: "10001", gid: "10001", mode: "0400" },{ source: "tf_integrations_internal_auth_secret", target: "tf_integrations_internal_auth_secret", uid: "10001", gid: "10001", mode: "0400" },{ source: "tf_module_heartbeat_keys", target: "tf_module_heartbeat_keys", uid: "10001", gid: "10001", mode: "0400" },"tf_pkce_verifier",{ source: "tf_runtime_database_url", target: "tf_runtime_database_url", uid: "10001", gid: "10001", mode: "0400" },{ source: "tf_search_internal_auth_secret", target: "tf_search_internal_auth_secret", uid: "10001", gid: "10001", mode: "0400" }]),
      build: { context: process.cwd(), dockerfile: "artifacts/api-server/Dockerfile", target: "runner" },
      image: "apollo-tf-api:bridge",
      environment: {
        APOLLO_MODULE_HEARTBEAT_KEYS_FILE: "/run/secrets/tf_module_heartbeat_keys",
        DATABASE_URL_FILE: "/run/secrets/tf_runtime_database_url",
        TF_INTEGRATIONS_ALLOW_INSECURE_HTTP: "true",
        TF_INTEGRATIONS_INTERNAL_AUTH_SECRET_FILE: "/run/secrets/tf_integrations_internal_auth_secret",
        TF_INTEGRATIONS_ORIGIN: "http://tf-integrations:8080",
        TF_SEARCH_ALLOW_INSECURE_HTTP: "true",
        TF_SEARCH_INTERNAL_AUTH_SECRET_FILE: "/run/secrets/tf_search_internal_auth_secret",
        TF_SEARCH_ORIGIN: "http://tf-search:8080",
        TF_DOWNLOAD_WORKER_ALLOW_INSECURE_HTTP: "true",
        TF_DOWNLOAD_WORKER_INTERNAL_AUTH_SECRET_FILE: "/run/secrets/tf_download_internal_auth_secret",
        TF_DOWNLOAD_WORKER_ORIGIN: "http://tf-download-worker:8080",
        TF_DOWNLOAD_QUEUE_ALLOW_INSECURE_REDIS: "true",
        TF_DOWNLOAD_QUEUE_REDIS_URL_FILE: "/run/secrets/tf_download_queue_redis_url",
      },
      ports: [{ host_ip: "127.0.0.1", published: value("TF_API_PORT"), target: 8080 }],
      depends_on: {
        "platform-api": { condition: "service_healthy" },
        "tf-download-redis": { condition: "service_healthy" },
        "tf-migrate": { condition: "service_completed_successfully" },
        "tf-postgres": { condition: "service_healthy" },
        "tf-redis": { condition: "service_healthy" },
      },
    },
  };
  const names = ["platform_assertion_private_jwk","platform_assertion_public_jwks","platform_migrator_database_url","platform_migrator_password","platform_oauth_clients","platform_operator_bootstrap_token","platform_postgres_admin_password","platform_runtime_database_url","platform_runtime_password","tf_client_secret","tf_download_internal_auth_secret","tf_download_queue_password","tf_download_queue_redis_url","tf_integrations_internal_auth_secret","tf_migrator_database_url","tf_migrator_password","tf_module_heartbeat_keys","tf_pkce_verifier","tf_postgres_admin_password","tf_runtime_database_url","tf_runtime_password","tf_search_internal_auth_secret"];
  process.stdout.write(JSON.stringify({
    services,
    networks: {
      "bridge-edge": {},
      "platform-data": { internal: true },
      "platform-tf-control": { internal: true },
      "tf-data": { internal: true },
      "tf-download-queue": { internal: true },
    },
    volumes: {
      "platform-postgres-data": {},
      "platform-redis-data": {},
      "tf-download-redis-data": {},
      "tf-postgres-data": {},
      "tf-redis-data": {},
    },
    secrets: Object.fromEntries(names.map((name) => [name, { file: path.join(value("BRIDGE_SECRET_DIRECTORY"), name) }])),
  }));
  process.exit(0);
}
if (command === "up") process.exit(42);
if (command === "down" && project === env.HOSTILE_PROJECT) fs.rmSync(env.FAKE_SENTINEL, { force: true });
process.exit(0);
`,
    "utf8",
  );
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    BRIDGE_SECRET_DIRECTORY: inheritedSecrets,
    COMPOSE_PROJECT_NAME: "existing-project",
    FAKE_DOCKER_LOG: log,
    FAKE_LEAK: leak,
    FAKE_SENTINEL: sentinel,
    HOSTILE_PLATFORM_PORT: "65501",
    HOSTILE_PROJECT: "existing-project",
    HOSTILE_SECRET_DIRECTORY: inheritedSecrets,
    HOSTILE_TF_PORT: "65502",
    NODE_OPTIONS: `--require=${hook}`,
    PLATFORM_API_PORT: "65501",
    TF_API_PORT: "65502",
  };
  for (const key of Object.keys(environment)) {
    if (["path", "docker_context", "docker_host"].includes(key.toLowerCase())) {
      delete environment[key];
    }
  }
  environment.PATH = `${bin}${delimiter}${process.env.PATH ?? process.env.Path ?? ""}`;
  environment.DOCKER_CONTEXT = "";
  environment.DOCKER_HOST = "";
  Object.assign(environment, overrides);

  try {
    await expect(
      execFileAsync(process.execPath, [smokeScript], {
        cwd: repositoryRoot,
        env: environment,
        timeout: 15_000,
      }),
    ).rejects.toBeDefined();
    const records = (await exists(log))
      ? (await readFile(log, "utf8"))
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line) as FakeDockerRecord)
      : [];
    return {
      records,
      sentinelExists: await exists(sentinel),
      leaked: await exists(leak),
    };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

describe("bridge smoke hostile Docker environment", () => {
  test("uses one fresh project and replaces inherited paths and ports", async () => {
    const result = await runWithFakeDocker();
    expect(result.sentinelExists).toBe(true);
    expect(result.leaked).toBe(false);
    const compose = result.records.filter(({ args }) => args[0] === "compose");
    expect(compose.map(({ command }) => command)).toEqual([
      "config",
      "build",
      "up",
      "down",
    ]);
    expect(new Set(compose.map(({ project }) => project)).size).toBe(1);
    for (const record of compose) {
      expect(record.project).toMatch(
        /^apollo-platform-tf-bridge-\d+-[a-f0-9]{8}$/,
      );
      expect(record.inheritedProject).toBe(false);
      expect(record.inheritedPorts).toBe(false);
      expect(record.inheritedSecretDirectory).toBe(false);
      expect(record.composeBake).toBe("false");
      expect(record.dockerContext).toBe("local-context");
      expect(record.dockerHost).toBe("");
    }
  }, 20_000);

  test("rejects remote and conflicting Docker selectors before Compose", async () => {
    const remoteHost = await runWithFakeDocker({
      DOCKER_HOST: "tcp://remote.example:2375",
    });
    expect(remoteHost.records).toEqual([]);
    expect(remoteHost.sentinelExists).toBe(true);

    const remoteContext = await runWithFakeDocker({
      DOCKER_CONTEXT: "remote-context",
      DOCKER_HOST: "npipe:////./pipe/docker_engine",
    });
    expect(remoteContext.records.map(({ command }) => command)).toEqual([
      "context",
    ]);
    expect(
      remoteContext.records.some(({ args }) => args[0] === "compose"),
    ).toBe(false);

    const runner = String.raw`
const module = await import(process.env.BRIDGE_SMOKE_MODULE);
try {
  module.canonicalizeDockerSelectors({
    DOCKER_CONTEXT: "local-context",
    Docker_Context: "remote-context",
  });
  process.exitCode = 2;
} catch (error) {
  process.stdout.write(error.message);
}
`;
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", runner],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          BRIDGE_SMOKE_MODULE: new URL(
            "../scripts/bridge-smoke.mjs",
            import.meta.url,
          ).href,
        },
      },
    );
    expect(stderr).toBe("");
    expect(stdout).toBe("Conflicting Docker selector environment");
  }, 20_000);

  test.each([
    ["BUILDKIT_HOST", "tcp://remote-builder.example:1234"],
    ["BUILDX_BUILDER", "remote-builder"],
    ["BUILDX_CONFIG", "/tmp/hostile-buildx"],
    ["BUILDX_BAKE_FILE", "https://attacker.example/build.hcl"],
    ["DOCKER_CONFIG", "/tmp/hostile-docker-config"],
  ])("rejects build selector %s before Docker", async (name, value) => {
    const result = await runWithFakeDocker({
      DOCKER_HOST: "npipe:////./pipe/docker_engine",
      [name]: value,
    });
    expect(result.records).toEqual([]);
    expect(result.leaked).toBe(false);
    expect(result.sentinelExists).toBe(true);
  });
});

const liveTest = process.env.APOLLO_BRIDGE_LIVE === "true" ? test : test.skip;

describe("live disposable Platform-TF bridge", () => {
  liveTest(
    "passes the complete PKCE, entitlement, revocation, and WebSocket flow",
    async () => {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [smokeScript],
        {
          cwd: repositoryRoot,
          env: process.env,
          timeout: BRIDGE_SMOKE_TIMEOUTS.childMs,
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      expect(stderr).toBe("");
      expect(stdout).toBe(
        "Bridge smoke passed: closed, portal, PKCE, replay, grant, revoke, WebSocket\n",
      );
    },
    BRIDGE_SMOKE_TIMEOUTS.parentMs,
  );
});
