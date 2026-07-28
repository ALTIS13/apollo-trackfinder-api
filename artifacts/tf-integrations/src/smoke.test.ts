import { execFile } from "node:child_process";
import {
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { stringify } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { parseTfIntegrationsConfig } from "./config.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const rootComposePath = join(repositoryRoot, "docker-compose.yml");
const temporaryRoot = join(repositoryRoot, ".tmp");
const temporaryOwner = join(
  temporaryRoot,
  `tf-integrations-smoke-${process.pid}`,
);
const ownershipMarker = ".tf-integrations-smoke-owner";
const smokeAdminToken = "task-6-smoke-observer";
const forbiddenDockerSelectors = [
  "BUILDKIT_HOST",
  "BUILDX_BUILDER",
  "BUILDX_CONFIG",
  "BUILDX_BAKE_FILE",
  "BUILDX_BAKE_FILE_SEPARATOR",
  "BUILDX_BAKE_GIT_AUTH_HEADER",
  "BUILDX_BAKE_GIT_AUTH_TOKEN",
  "BUILDX_BAKE_GIT_SSH",
  "BUILDX_BAKE_ENTITLEMENTS_FS",
  "COMPOSE_BAKE",
  "DOCKER_CONFIG",
] as const;

interface CommandObservations {
  readonly providerOutageReadiness: boolean;
  readonly providerOutageReported: boolean;
  readonly replayRejected: boolean;
  readonly responseProjection: string;
  readonly tamperedRejected: boolean;
  readonly unsignedRejected: boolean;
  readonly unsupportedEncodingRejected: boolean;
  readonly validAccepted: boolean;
  readonly wrongKeyRejected: boolean;
}

interface SmokeObservations extends CommandObservations {
  readonly canarySurfacesScanned: number;
  readonly ciphertextAuthenticated: boolean;
  readonly ciphertextAtRest: boolean;
  readonly heartbeatHealthy: boolean;
  readonly heartbeatRecovered: boolean;
  readonly heartbeatUnknownAfterReset: boolean;
  readonly heartbeatVersion: string;
  readonly inspectLeastPrivilege: boolean;
  readonly inspectMigrationGating: boolean;
  readonly inspectNetworkIsolation: boolean;
  readonly inspectNoHostPorts: boolean;
  readonly inspectResourceLimits: boolean;
  readonly inspectSecretOwnership: boolean;
  readonly migrationExitCode: number;
  readonly providerAccountGenerationCas: boolean;
  readonly ready: boolean;
  readonly rolePrivilegesEnforced: boolean;
  readonly runtimeNodeMajor: number;
  readonly secretOwnershipEvidence:
    | "non-native-readonly-remap"
    | "native-linux-owner-mode";
  readonly secretTargetStatsVerified: boolean;
}

interface CleanupObservations {
  readonly containers: number;
  readonly images: number;
  readonly networks: number;
  readonly temporaryDirectories: number;
  readonly volumes: number;
}

interface SmokeResult {
  readonly cleanup: CleanupObservations;
  readonly observations: SmokeObservations;
  readonly project: string;
}

interface DockerResult {
  readonly stderr: string;
  readonly stdout: string;
}

interface LocalDockerRuntime {
  readonly environment: NodeJS.ProcessEnv;
  readonly nativeSecretOwnership: boolean;
}

interface PreparedSecrets {
  readonly allowedEntries: ReadonlySet<string>;
  readonly canaries: readonly string[];
  readonly directory: string;
  readonly key: Buffer;
  readonly marker: string;
  readonly secretNames: readonly string[];
  readonly token: string;
}

interface PrepareSecretsOptions {
  readonly nativeSecretOwnership?: boolean;
  readonly project?: string;
  readonly rootDirectory?: string;
  readonly write?: typeof writeSecret;
}

function generatedSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isContainedPath(candidate: string, root: string): boolean {
  const fromRoot = relative(resolve(root), resolve(candidate));
  return (
    fromRoot.length > 0 &&
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) &&
    resolve(root, fromRoot) === resolve(candidate)
  );
}

function assertContainedPath(candidate: string, root: string): string {
  if (!isContainedPath(candidate, root)) {
    throw new Error("Smoke path escaped its owner");
  }
  return resolve(candidate);
}

function isLocalDockerEndpoint(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith("npipe://") || normalized.startsWith("unix://");
}

function canonicalEnvironment(source: NodeJS.ProcessEnv): {
  readonly context: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly host: string;
} {
  const environment = { ...source };
  const readSelector = (name: string): string => {
    const entries = Object.entries(environment).filter(
      ([key]) => key.toUpperCase() === name,
    );
    const values = new Set(
      entries.map(([, value]) => String(value ?? "").trim()),
    );
    if (values.size > 1) {
      throw new Error("Conflicting Docker selector environment");
    }
    for (const [key] of entries) delete environment[key];
    return values.values().next().value ?? "";
  };

  for (const selector of forbiddenDockerSelectors) {
    if (readSelector(selector).length > 0) {
      throw new Error("Unsafe Docker build selector environment");
    }
  }

  const context = readSelector("DOCKER_CONTEXT");
  const host = readSelector("DOCKER_HOST");
  if (host.length > 0 && !isLocalDockerEndpoint(host)) {
    throw new Error("TF integrations smoke requires local Docker");
  }
  if (context.length > 0) environment.DOCKER_CONTEXT = context;
  else if (host.length > 0) environment.DOCKER_HOST = host;
  environment.COMPOSE_BAKE = "false";
  return { context, environment, host };
}

async function docker(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  timeout = 12 * 60_000,
): Promise<DockerResult> {
  const result = await execFileAsync("docker", [...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: environment,
    maxBuffer: 64 * 1024 * 1024,
    timeout,
    windowsHide: true,
  });
  return {
    stderr: String(result.stderr),
    stdout: String(result.stdout),
  };
}

async function describeLocalDocker(
  environment: NodeJS.ProcessEnv,
  endpoint: string,
): Promise<LocalDockerRuntime> {
  const info = await docker(
    ["info", "--format", "{{json .OperatingSystem}}"],
    environment,
    30_000,
  );
  const operatingSystem: unknown = JSON.parse(info.stdout.trim());
  if (typeof operatingSystem !== "string") {
    throw new Error("Local Docker operating system is unavailable");
  }
  return {
    environment,
    nativeSecretOwnership:
      process.platform === "linux" &&
      endpoint.toLowerCase().startsWith("unix://") &&
      !operatingSystem.toLowerCase().includes("docker desktop"),
  };
}

async function localDockerEnvironment(
  source: NodeJS.ProcessEnv,
): Promise<LocalDockerRuntime> {
  const selectors = canonicalEnvironment(source);
  if (selectors.context.length > 0) {
    const inspected = await docker(
      [
        "context",
        "inspect",
        selectors.context,
        "--format",
        "{{json .Endpoints.docker.Host}}",
      ],
      selectors.environment,
      30_000,
    );
    const endpoint: unknown = JSON.parse(inspected.stdout.trim());
    if (typeof endpoint !== "string" || !isLocalDockerEndpoint(endpoint)) {
      throw new Error("TF integrations smoke requires local Docker");
    }
    return describeLocalDocker(selectors.environment, endpoint);
  }
  if (selectors.host.length > 0) {
    return describeLocalDocker(selectors.environment, selectors.host);
  }

  const shown = await docker(
    ["context", "show"],
    selectors.environment,
    30_000,
  );
  const context = shown.stdout.trim();
  if (context.length === 0) {
    throw new Error("TF integrations smoke requires local Docker");
  }
  const environment = {
    ...selectors.environment,
    DOCKER_CONTEXT: context,
  };
  const inspected = await docker(
    [
      "context",
      "inspect",
      context,
      "--format",
      "{{json .Endpoints.docker.Host}}",
    ],
    environment,
    30_000,
  );
  const endpoint: unknown = JSON.parse(inspected.stdout.trim());
  if (typeof endpoint !== "string" || !isLocalDockerEndpoint(endpoint)) {
    throw new Error("TF integrations smoke requires local Docker");
  }
  return describeLocalDocker(environment, endpoint);
}

async function writeSecret(
  directory: string,
  name: string,
  value: string,
): Promise<void> {
  const path = assertContainedPath(join(directory, name), directory);
  await writeFile(path, value, { flag: "wx", mode: 0o600 });
  if (process.platform !== "win32") await chmod(path, 0o444);
}

async function removeEmptyDirectory(path: string): Promise<void> {
  await rmdir(path).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
      throw error;
    }
  });
}

async function provisionNativeSecretOwnership(
  environment: NodeJS.ProcessEnv,
  project: string,
  directory: string,
  owners: readonly {
    readonly gid: 999 | 10001 | 10002;
    readonly mode: 0o400 | 0o440;
    readonly name: string;
    readonly uid: 0 | 999 | 10001;
  }[],
): Promise<void> {
  const assignments = owners.map(
    ({ gid, mode, name, uid }) => `${name}:${uid}:${gid}:${mode.toString(8)}`,
  );
  await docker(
    [
      "run",
      "--rm",
      "--name",
      `${project}-secret-provisioner`,
      "--label",
      `com.docker.compose.project=${project}`,
      "--network",
      "none",
      "--read-only",
      "--mount",
      `type=bind,source=${directory},target=/secrets`,
      "postgres:17-bookworm",
      "sh",
      "-eu",
      "-c",
      'for assignment do name=${assignment%%:*}; rest=${assignment#*:}; uid=${rest%%:*}; rest=${rest#*:}; gid=${rest%%:*}; mode=${rest#*:}; chown "$uid:$gid" "/secrets/$name"; chmod "$mode" "/secrets/$name"; done',
      "secret-provisioner",
      ...assignments,
    ],
    environment,
    2 * 60_000,
  );
}

async function prepareSecrets(
  environment: NodeJS.ProcessEnv,
  options: PrepareSecretsOptions = {},
): Promise<PreparedSecrets> {
  const rootDirectory = options.rootDirectory ?? temporaryRoot;
  const ownerDirectory = join(
    rootDirectory,
    `tf-integrations-smoke-${process.pid}`,
  );
  const write = options.write ?? writeSecret;
  let directory: string | undefined;
  let canaries: readonly string[] = [];

  try {
    await mkdir(rootDirectory, { recursive: true });
    await mkdir(ownerDirectory, { recursive: true });
    directory = assertContainedPath(
      await mkdtemp(join(ownerDirectory, "run-")),
      ownerDirectory,
    );
    if (process.platform !== "win32") await chmod(directory, 0o700);
    const marker = generatedSecret();
    const tfAdminPassword = generatedSecret();
    const tfMigratorPassword = generatedSecret();
    const tfRuntimePassword = generatedSecret();
    const clientSecret = generatedSecret();
    const searchCommandSecret = generatedSecret();
    const searchHeartbeatSecret = generatedSecret();
    const integrationAdminPassword = generatedSecret();
    const integrationMigratorPassword = generatedSecret();
    const integrationRuntimePassword = generatedSecret();
    const integrationCommandSecret = generatedSecret();
    const integrationHeartbeatSecret = generatedSecret();
    const downloadQueuePassword = generatedSecret();
    const downloadInternalAuthSecret = generatedSecret();
    const downloadHeartbeatSecret = generatedSecret();
    const spotifyClientId = generatedSecret();
    const spotifyClientSecret = generatedSecret();
    const key = randomBytes(32);
    const token = generatedSecret(48);

    const tfAdminDatabaseUrl =
      `postgres://postgres:${encodeURIComponent(tfAdminPassword)}` +
      "@db:5432/apollo_trackfinder";
    const tfMigratorDatabaseUrl =
      `postgres://apollo_tf_migrator:${encodeURIComponent(tfMigratorPassword)}` +
      "@db:5432/apollo_trackfinder";
    const tfRuntimeDatabaseUrl =
      `postgres://apollo_tf_runtime:${encodeURIComponent(tfRuntimePassword)}` +
      "@db:5432/apollo_trackfinder";
    const integrationMigratorUrl =
      "postgres://apollo_tf_integrations_migrator:" +
      `${encodeURIComponent(integrationMigratorPassword)}` +
      "@tf-integrations-postgres:5432/apollo_tf_integrations";
    const integrationRuntimeUrl =
      "postgres://apollo_tf_integrations_runtime:" +
      `${encodeURIComponent(integrationRuntimePassword)}` +
      "@tf-integrations-postgres:5432/apollo_tf_integrations";
    const downloadQueueRedisUrl =
      `redis://default:${encodeURIComponent(downloadQueuePassword)}` +
      "@tf-download-redis:6379/0";
    const keyring = JSON.stringify({
      activeKeyId: "smoke-v1",
      keys: { "smoke-v1": key.toString("base64url") },
    });
    const heartbeatKeys = JSON.stringify({
      "account-integrations": integrationHeartbeatSecret,
      "download-worker": downloadHeartbeatSecret,
      "search-media": searchHeartbeatSecret,
    });
    const secrets = [
      ["tf_client_secret", clientSecret],
      ["tf_postgres_admin_password", tfAdminPassword],
      ["tf_admin_database_url", tfAdminDatabaseUrl],
      ["tf_migrator_password", tfMigratorPassword],
      ["tf_runtime_password", tfRuntimePassword],
      ["tf_migrator_database_url", tfMigratorDatabaseUrl],
      ["tf_runtime_database_url", tfRuntimeDatabaseUrl],
      ["tf_module_heartbeat_keys", heartbeatKeys],
      ["tf_search_heartbeat_secret", searchHeartbeatSecret],
      ["tf_search_internal_auth_secret", searchCommandSecret],
      ["tf_integrations_postgres_admin_password", integrationAdminPassword],
      ["tf_integrations_migrator_password", integrationMigratorPassword],
      ["tf_integrations_runtime_password", integrationRuntimePassword],
      ["tf_integrations_migrator_database_url", integrationMigratorUrl],
      ["tf_integrations_runtime_database_url", integrationRuntimeUrl],
      ["tf_integrations_token_keyring", keyring],
      ["tf_integrations_spotify_client_id", spotifyClientId],
      ["tf_integrations_spotify_client_secret", spotifyClientSecret],
      ["tf_integrations_internal_auth_secret", integrationCommandSecret],
      ["tf_integrations_heartbeat_secret", integrationHeartbeatSecret],
      ["tf_integrations_smoke_token", token],
      ["tf_download_queue_password", downloadQueuePassword],
      ["tf_download_queue_redis_url", downloadQueueRedisUrl],
      ["tf_download_internal_auth_secret", downloadInternalAuthSecret],
      ["tf_download_heartbeat_secret", downloadHeartbeatSecret],
    ] as const;
    const postgresOwned = new Set([
      "tf_postgres_admin_password",
      "tf_migrator_password",
      "tf_runtime_password",
      "tf_integrations_postgres_admin_password",
      "tf_integrations_migrator_password",
      "tf_integrations_runtime_password",
      "tf_download_queue_password",
    ]);
    const owners = secrets.map(([name]) =>
      name === "tf_admin_database_url"
        ? { gid: 10002, mode: 0o440, name, uid: 0 }
        : {
            gid: postgresOwned.has(name) ? 999 : 10001,
            mode: 0o400,
            name,
            uid: postgresOwned.has(name) ? 999 : 10001,
          },
    ) as readonly {
      readonly gid: 999 | 10001 | 10002;
      readonly mode: 0o400 | 0o440;
      readonly name: string;
      readonly uid: 0 | 999 | 10001;
    }[];
    canaries = [
      marker,
      ...secrets.flatMap(([, value]) => [value, digest(value)]),
      key.toString("base64url"),
      digest(key.toString("base64url")),
    ];

    await write(directory, ownershipMarker, marker);
    for (const [name, value] of secrets) {
      await write(directory, name, value);
    }
    if (options.nativeSecretOwnership === true) {
      if (options.project === undefined) {
        throw new Error("Native secret provisioning requires a project");
      }
      await provisionNativeSecretOwnership(
        environment,
        options.project,
        directory,
        owners,
      );
    }
    if (process.platform !== "win32") {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    }
    if (options.nativeSecretOwnership === true) {
      for (const { gid, mode, name, uid } of owners) {
        const current = await stat(join(directory, name));
        if (
          current.uid !== uid ||
          current.gid !== gid ||
          (current.mode & 0o777) !== mode
        ) {
          throw new Error("Native secret ownership provisioning failed");
        }
      }
    }

    environment.TF_SECRET_DIRECTORY = directory;
    return {
      allowedEntries: new Set([
        ownershipMarker,
        "compose.smoke.yml",
        ...secrets.map(([name]) => name),
      ]),
      canaries,
      directory,
      key,
      marker,
      secretNames: secrets.map(([name]) => name),
      token,
    };
  } catch (error) {
    try {
      if (directory !== undefined) {
        await rm(assertContainedPath(directory, ownerDirectory), {
          force: true,
          recursive: true,
        });
      }
      await removeEmptyDirectory(ownerDirectory);
      await removeEmptyDirectory(rootDirectory);
    } catch {
      throw new Error("TF integrations partial secret cleanup failed");
    }
    throw sanitizeError(error, canaries);
  }
}

async function removePreparedSecrets(prepared: PreparedSecrets): Promise<void> {
  const directory = assertContainedPath(prepared.directory, temporaryOwner);
  const directoryStats = await lstat(directory);
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new Error("Smoke directory ownership changed");
  }
  const physicalDirectory = await realpath(directory);
  const physicalOwner = await realpath(temporaryOwner);
  if (!isContainedPath(physicalDirectory, physicalOwner)) {
    throw new Error("Smoke directory physical ownership changed");
  }
  const marker = await readFile(join(directory, ownershipMarker), "utf8");
  if (
    marker.length !== prepared.marker.length ||
    !timingSafeEqual(Buffer.from(marker), Buffer.from(prepared.marker))
  ) {
    throw new Error("Smoke ownership marker changed");
  }
  const entries = await readdir(directory);
  if (entries.some((name) => !prepared.allowedEntries.has(name))) {
    throw new Error("Smoke directory contains an unowned entry");
  }
  await rm(directory, { force: true, recursive: true });
  await expect(access(directory)).rejects.toBeDefined();
  await rmdir(temporaryOwner).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
      throw error;
    }
  });
  await rmdir(temporaryRoot).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
      throw error;
    }
  });
}

async function reserveLoopbackPort(): Promise<number> {
  return new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Unable to reserve smoke port"));
        return;
      }
      const { port } = address;
      server.close((error) =>
        error === undefined ? resolvePort(port) : reject(error),
      );
    });
  });
}

async function writeOverride(prepared: PreparedSecrets): Promise<string> {
  const path = join(prepared.directory, "compose.smoke.yml");
  await writeFile(
    path,
    stringify({
      services: {
        api: {
          environment: {
            ADMIN_DASHBOARD_TOKEN: smokeAdminToken,
          },
          secrets: [
            {
              gid: "10001",
              mode: "0400",
              source: "tf_integrations_smoke_token",
              target: "tf_integrations_smoke_token",
              uid: "10001",
            },
          ],
        },
        "tf-integrations": {
          environment: {
            APOLLO_API_VERSION: "task-6-smoke",
            NODE_ENV: "test",
            TF_INTEGRATIONS_SMOKE_FIXTURES: "true",
          },
        },
        "tf-search": {
          environment: {
            APOLLO_API_VERSION: "task-6-search-smoke",
            NODE_ENV: "test",
            TF_SEARCH_SMOKE_FIXTURES: "true",
          },
        },
      },
      secrets: {
        tf_integrations_smoke_token: {
          file: join(prepared.directory, "tf_integrations_smoke_token"),
        },
      },
    }),
    { flag: "wx", mode: 0o600 },
  );
  if (process.platform !== "win32") await chmod(path, 0o444);
  return path;
}

function composeArguments(
  overridePath: string,
  project: string,
  args: readonly string[],
): readonly string[] {
  return [
    "compose",
    "-f",
    rootComposePath,
    "-f",
    overridePath,
    "-p",
    project,
    ...args,
  ];
}

function assertCanaryFree(
  value: string,
  canaries: readonly string[],
  label: string,
): void {
  if (canaries.some((canary) => canary.length > 0 && value.includes(canary))) {
    throw new Error(`${label} contains sensitive smoke canary`);
  }
}

function sanitizeError(error: unknown, canaries: readonly string[]): Error {
  const message = error instanceof Error ? error.message : "Unknown error";
  const sanitizedMessage = canaries.some(
    (canary) => canary.length > 0 && message.includes(canary),
  )
    ? "TF integrations smoke suppressed a sensitive smoke canary"
    : error instanceof Error
      ? message
      : "TF integrations smoke failed";
  return new Error(sanitizedMessage);
}

async function waitFor<T>(
  label: string,
  probe: () => Promise<T | false | undefined>,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await probe();
      if (result !== false && result !== undefined) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(
    `${label} deadline exceeded${
      lastError instanceof Error ? ` (${lastError.name})` : ""
    }`,
  );
}

async function fetchJson(
  url: string,
  init: RequestInit = {},
): Promise<{
  readonly body: unknown;
  readonly response: Response;
  readonly text: string;
}> {
  const response = await fetch(url, { redirect: "error", ...init });
  const text = await response.text();
  let body: unknown;
  try {
    body = text.length === 0 ? null : (JSON.parse(text) as unknown);
  } catch {
    body = null;
  }
  return { body, response, text };
}

function commandProbeSource(): string {
  return String.raw`
const { createHash, createHmac, randomBytes, randomUUID } = require("node:crypto");
const { readFileSync } = require("node:fs");
const origin = "http://tf-integrations:8080";
const path = "/v1/commands";
const secret = readFileSync("/run/secrets/tf_integrations_internal_auth_secret", "utf8").trim();
const token = readFileSync("/run/secrets/tf_integrations_smoke_token", "utf8").trim();
const accountId = randomUUID();
const responses = [];
const nonce = () => randomBytes(32).toString("base64url");
const sign = (rawBody, timestamp, requestNonce, key = secret) => {
  const bodyHash = createHash("sha256").update(rawBody).digest("hex");
  const canonical = ["POST", path, timestamp, requestNonce, bodyHash].join("\n");
  return "v1=" + createHmac("sha256", key).update(canonical).digest("hex");
};
const send = async (rawBody, options = {}) => {
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const requestNonce = options.nonce ?? nonce();
  const headers = { "content-type": "application/json", ...(options.headers ?? {}) };
  if (!options.unsigned) {
    headers["x-apollo-internal-timestamp"] = timestamp;
    headers["x-apollo-internal-nonce"] = requestNonce;
    headers["x-apollo-internal-signature"] =
      options.signature ?? sign(rawBody, timestamp, requestNonce, options.key);
  }
  const response = await fetch(origin + path, {
    method: "POST",
    redirect: "error",
    headers,
    body: rawBody,
  });
  const text = await response.text();
  responses.push(text);
  let body = null;
  try { body = text.length === 0 ? null : JSON.parse(text); } catch {}
  return { body, response, text, timestamp, requestNonce };
};
(async () => {
  const command = {
    schemaVersion: 1,
    requestId: randomUUID(),
    accountId,
    operation: "yandex.token.upsert",
    input: { token },
  };
  const raw = JSON.stringify(command);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const requestNonce = nonce();
  const signature = sign(raw, timestamp, requestNonce);
  const valid = await send(raw, { timestamp, nonce: requestNonce, signature });
  const replay = await send(raw, { timestamp, nonce: requestNonce, signature });
  const tamperedTimestamp = String(Math.floor(Date.now() / 1000));
  const tamperedNonce = nonce();
  const tamperedSignature = sign(raw, tamperedTimestamp, tamperedNonce);
  const tampered = await send(
    JSON.stringify({ ...command, requestId: randomUUID() }),
    {
      timestamp: tamperedTimestamp,
      nonce: tamperedNonce,
      signature: tamperedSignature,
    },
  );
  const wrong = await send(raw, { key: randomBytes(32).toString("base64url") });
  const unsupported = await send(raw, {
    headers: { "content-encoding": "gzip" },
  });
  const unsigned = await send(raw, { unsigned: true });
  const outageRaw = JSON.stringify({
    schemaVersion: 1,
    requestId: randomUUID(),
    accountId,
    operation: "yandex.playlists.list",
    input: {},
  });
  const outage = await send(outageRaw);
  const ready = await fetch(origin + "/readyz", { redirect: "error" });
  process.stdout.write(JSON.stringify({
    validAccepted:
      valid.response.status === 200 &&
      valid.body?.operation === "yandex.token.upsert" &&
      valid.body?.result?.account?.provider === "yandex" &&
      valid.body?.result?.account?.connected === true,
    replayRejected: replay.response.status === 401,
    tamperedRejected: tampered.response.status === 401,
    wrongKeyRejected: wrong.response.status === 401,
    unsupportedEncodingRejected: unsupported.response.status === 401,
    unsignedRejected: unsigned.response.status === 401,
    providerOutageReported:
      outage.response.status === 200 &&
      outage.body?.error?.code === "provider_unavailable",
    providerOutageReadiness: ready.status === 200,
    responseProjection: responses.join("\n"),
  }));
})().catch(() => {
  process.stderr.write("command probe failed\n");
  process.exitCode = 1;
});
`;
}

async function commandObservations(
  compose: (args: readonly string[]) => Promise<DockerResult>,
): Promise<CommandObservations> {
  const result = await compose([
    "exec",
    "-T",
    "api",
    "node",
    "-e",
    commandProbeSource(),
  ]);
  if (result.stderr.trim().length > 0) {
    throw new Error("Command probe wrote stderr");
  }
  return JSON.parse(result.stdout) as CommandObservations;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function ciphertextObservations(
  compose: (args: readonly string[]) => Promise<DockerResult>,
  prepared: PreparedSecrets,
): Promise<{
  readonly authenticated: boolean;
  readonly atRest: boolean;
  readonly projection: string;
}> {
  const query = [
    "select json_build_object(",
    "'provider', provider,",
    "'accountId', account_id::text,",
    "'tokenEnvelope', token_envelope,",
    "'providerUserId', provider_user_id,",
    "'displayName', display_name",
    ")::text",
    "from apollo_tf_integrations.provider_accounts",
    "where provider = 'yandex'",
    "limit 1",
  ].join(" ");
  const result = await compose([
    "exec",
    "-T",
    "tf-integrations-postgres",
    "psql",
    "-XAt",
    "-U",
    "postgres",
    "-d",
    "apollo_tf_integrations",
    "-c",
    query,
  ]);
  const projection = result.stdout.trim();
  const row: unknown = JSON.parse(projection);
  if (!isRecord(row) || !isRecord(row.tokenEnvelope)) {
    throw new Error("Ciphertext projection is malformed");
  }
  const envelope = row.tokenEnvelope;
  if (
    envelope.version !== 1 ||
    envelope.keyId !== "smoke-v1" ||
    typeof envelope.nonce !== "string" ||
    typeof envelope.ciphertext !== "string" ||
    typeof envelope.tag !== "string" ||
    typeof row.accountId !== "string"
  ) {
    throw new Error("Ciphertext envelope is malformed");
  }

  let plaintext: Buffer | undefined;
  let authenticated = false;
  let tamperRejected = false;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      prepared.key,
      Buffer.from(envelope.nonce, "base64url"),
      { authTagLength: 16 },
    );
    decipher.setAAD(
      Buffer.from(
        `apollo-tf-integrations-token:v1:yandex:${row.accountId}`,
        "utf8",
      ),
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]);
    const parsed: unknown = JSON.parse(plaintext.toString("utf8"));
    if (isRecord(parsed) && typeof parsed.oauthToken === "string") {
      const actual = Buffer.from(parsed.oauthToken);
      const expected = Buffer.from(prepared.token);
      authenticated =
        actual.length === expected.length && timingSafeEqual(actual, expected);
    }

    const corrupted = Buffer.from(envelope.ciphertext, "base64url");
    corrupted[0] = (corrupted[0] ?? 0) ^ 1;
    try {
      const tampered = createDecipheriv(
        "aes-256-gcm",
        prepared.key,
        Buffer.from(envelope.nonce, "base64url"),
        { authTagLength: 16 },
      );
      tampered.setAAD(
        Buffer.from(
          `apollo-tf-integrations-token:v1:yandex:${row.accountId}`,
          "utf8",
        ),
      );
      tampered.setAuthTag(Buffer.from(envelope.tag, "base64url"));
      tampered.update(corrupted);
      tampered.final();
    } catch {
      tamperRejected = true;
    } finally {
      corrupted.fill(0);
    }
  } finally {
    plaintext?.fill(0);
  }

  return {
    authenticated: authenticated && tamperRejected,
    atRest:
      !projection.includes(prepared.token) && envelope.ciphertext.length > 0,
    projection,
  };
}

async function providerAccountGenerationCasObservation(
  compose: (args: readonly string[]) => Promise<DockerResult>,
): Promise<boolean> {
  const statement = `
DO $generation_cas$
DECLARE
  target_account uuid;
  old_generation uuid;
  replacement_generation uuid := gen_random_uuid();
  stale_updates bigint;
BEGIN
  SELECT account_id, generation
    INTO STRICT target_account, old_generation
    FROM apollo_tf_integrations.provider_accounts
    WHERE provider = 'yandex'
    LIMIT 1;

  UPDATE apollo_tf_integrations.provider_accounts
    SET generation = replacement_generation
    WHERE provider = 'yandex'
      AND account_id = target_account
      AND generation = old_generation;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'generation replacement failed';
  END IF;

  UPDATE apollo_tf_integrations.provider_accounts
    SET updated_at = updated_at
    WHERE provider = 'yandex'
      AND account_id = target_account
      AND generation = old_generation;
  GET DIAGNOSTICS stale_updates = ROW_COUNT;
  IF stale_updates <> 0 THEN
    RAISE EXCEPTION 'stale generation update succeeded';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM apollo_tf_integrations.provider_accounts
      WHERE provider = 'yandex'
        AND account_id = target_account
        AND generation = replacement_generation
  ) THEN
    RAISE EXCEPTION 'replacement generation was not retained';
  END IF;
END
$generation_cas$;
`;
  const result = await compose([
    "exec",
    "-T",
    "tf-integrations-postgres",
    "psql",
    "-X",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "postgres",
    "-d",
    "apollo_tf_integrations",
    "-c",
    statement,
  ]);
  return result.stderr.trim().length === 0 && result.stdout.trim() === "DO";
}

function rolePrivilegeProbeSource(): string {
  return `
import { readFileSync } from "node:fs";
import { Pool } from "pg";

const connectionString = readFileSync(
  "/run/secrets/tf_integrations_runtime_database_url",
  "utf8",
).trim();
const pool = new Pool({ connectionString, max: 1 });

const denied = async (statement) => {
  const client = await pool.connect();
  let permissionDenied = false;
  try {
    await client.query("BEGIN");
    try {
      await client.query(statement);
    } catch (error) {
      permissionDenied = error?.code === "42501";
    }
    return permissionDenied;
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
};

try {
  const grants = await pool.query(
    "select table_name, privilege_type " +
      "from information_schema.role_table_grants " +
      "where grantee = current_user " +
      "and table_schema = 'apollo_tf_integrations' " +
      "order by table_name, privilege_type",
  );
  const grantsByTable = {};
  for (const row of grants.rows) {
    (grantsByTable[row.table_name] ??= []).push(row.privilege_type);
  }
  const owners = await pool.query(
    "select tablename, tableowner from pg_tables " +
      "where schemaname = 'apollo_tf_integrations' " +
      "and tablename in ('provider_accounts', 'schema_migrations') " +
      "order by tablename",
  );
  const schema = await pool.query(
    "select " +
      "has_schema_privilege(current_user, 'apollo_tf_integrations', 'USAGE') as usage, " +
      "has_schema_privilege(current_user, 'apollo_tf_integrations', 'CREATE') as create",
  );
  const deniedWrites = await Promise.all([
    denied(
      "insert into apollo_tf_integrations.schema_migrations " +
        "(name, checksum) values ('9999_preseed.sql', 'preseed')",
    ),
    denied(
      "update apollo_tf_integrations.schema_migrations " +
        "set checksum = checksum where name = '0001_integrations.sql'",
    ),
    denied(
      "delete from apollo_tf_integrations.schema_migrations " +
        "where name = '0001_integrations.sql'",
    ),
    denied("truncate apollo_tf_integrations.schema_migrations"),
  ]);
  const preseed = await pool.query(
    "select count(*)::int as count " +
      "from apollo_tf_integrations.schema_migrations " +
      "where name = '9999_preseed.sql'",
  );
  const enforced =
    JSON.stringify(grantsByTable) ===
      JSON.stringify({
        provider_accounts: ["DELETE", "INSERT", "SELECT", "UPDATE"],
        schema_migrations: ["SELECT"],
      }) &&
    JSON.stringify(owners.rows) ===
      JSON.stringify([
        {
          tablename: "provider_accounts",
          tableowner: "apollo_tf_integrations_migrator",
        },
        {
          tablename: "schema_migrations",
          tableowner: "apollo_tf_integrations_migrator",
        },
      ]) &&
    schema.rows[0]?.usage === true &&
    schema.rows[0]?.create === false &&
    deniedWrites.every(Boolean) &&
    preseed.rows[0]?.count === 0;
  process.stdout.write(
    JSON.stringify({
      enforced,
      nodeMajor: Number(process.versions.node.split(".")[0]),
    }),
  );
} catch {
  process.stderr.write("role privilege probe failed\\n");
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
`;
}

async function rolePrivilegeObservations(
  compose: (args: readonly string[]) => Promise<DockerResult>,
): Promise<{
  readonly enforced: boolean;
  readonly nodeMajor: number;
}> {
  const result = await compose([
    "exec",
    "-T",
    "--user",
    "10001:10001",
    "tf-integrations",
    "node",
    "--input-type=module",
    "-e",
    rolePrivilegeProbeSource(),
  ]);
  if (result.stderr.trim().length > 0) {
    throw new Error("Role privilege probe wrote stderr");
  }
  const parsed: unknown = JSON.parse(result.stdout);
  if (
    !isRecord(parsed) ||
    typeof parsed.enforced !== "boolean" ||
    typeof parsed.nodeMajor !== "number"
  ) {
    throw new Error("Role privilege probe result is malformed");
  }
  return {
    enforced: parsed.enforced,
    nodeMajor: parsed.nodeMajor,
  };
}

const assignedIntegrationSecrets = {
  api: [
    "tf_client_secret",
    "tf_download_internal_auth_secret",
    "tf_download_queue_redis_url",
    "tf_integrations_internal_auth_secret",
    "tf_integrations_smoke_token",
    "tf_module_heartbeat_keys",
    "tf_runtime_database_url",
    "tf_search_internal_auth_secret",
  ],
  db: [
    "tf_migrator_password",
    "tf_postgres_admin_password",
    "tf_runtime_password",
  ],
  "tf-download-redis": ["tf_download_queue_password"],
  "tf-download-worker": [
    "tf_download_heartbeat_secret",
    "tf_download_internal_auth_secret",
    "tf_download_queue_redis_url",
  ],
  "tf-migrate": ["tf_migrator_database_url"],
  "tf-integrations": [
    "tf_integrations_heartbeat_secret",
    "tf_integrations_internal_auth_secret",
    "tf_integrations_runtime_database_url",
    "tf_integrations_spotify_client_id",
    "tf_integrations_spotify_client_secret",
    "tf_integrations_token_keyring",
  ],
  "tf-integrations-migrate": ["tf_integrations_migrator_database_url"],
  "tf-integrations-postgres": [
    "tf_integrations_migrator_password",
    "tf_integrations_postgres_admin_password",
    "tf_integrations_runtime_password",
  ],
} as const;

async function secretTargetStatObservations(
  compose: (args: readonly string[]) => Promise<DockerResult>,
  nativeSecretOwnership: boolean,
): Promise<{
  readonly evidence: "native-linux-owner-mode" | "non-native-readonly-remap";
  readonly verified: boolean;
}> {
  const script =
    'for path do test -f "$path"; test -r "$path"; test ! -w "$path"; ' +
    'stat -c "%u:%g:%a:%F" "$path"; done';
  const assignments = [
    {
      names: assignedIntegrationSecrets.api,
      service: "api",
      uid: 10001,
    },
    {
      names: assignedIntegrationSecrets["tf-integrations"],
      service: "tf-integrations",
      uid: 10001,
    },
    {
      names: assignedIntegrationSecrets["tf-integrations-postgres"],
      service: "tf-integrations-postgres",
      uid: 999,
    },
    {
      names: assignedIntegrationSecrets.db,
      service: "db",
      uid: 999,
    },
    {
      names: assignedIntegrationSecrets["tf-download-redis"],
      service: "tf-download-redis",
      uid: 999,
    },
    {
      names: assignedIntegrationSecrets["tf-download-worker"],
      service: "tf-download-worker",
      uid: 10001,
    },
  ] as const;
  const results: Array<{
    readonly names: readonly string[];
    readonly output: DockerResult;
    readonly service: string;
    readonly uid: number;
  }> = [];

  for (const { names, service, uid } of assignments) {
    results.push({
      names,
      output: await compose([
        "exec",
        "-T",
        "--user",
        `${uid}:${uid}`,
        service,
        "sh",
        "-eu",
        "-c",
        script,
        "secret-stat",
        ...names.map((name) => `/run/secrets/${name}`),
      ]),
      service,
      uid,
    });
  }
  results.push({
    names: assignedIntegrationSecrets["tf-migrate"],
    output: await compose([
      "--progress",
      "quiet",
      "run",
      "--rm",
      "--no-deps",
      "--user",
      "10001:10001",
      "--entrypoint",
      "sh",
      "tf-migrate",
      "-eu",
      "-c",
      script,
      "secret-stat",
      ...assignedIntegrationSecrets["tf-migrate"].map(
        (name) => `/run/secrets/${name}`,
      ),
    ]),
    service: "tf-migrate",
    uid: 10001,
  });
  results.push({
    names: assignedIntegrationSecrets["tf-integrations-migrate"],
    output: await compose([
      "--progress",
      "quiet",
      "run",
      "--rm",
      "--no-deps",
      "--user",
      "10001:10001",
      "--entrypoint",
      "sh",
      "tf-integrations-migrate",
      "-eu",
      "-c",
      script,
      "secret-stat",
      ...assignedIntegrationSecrets["tf-integrations-migrate"].map(
        (name) => `/run/secrets/${name}`,
      ),
    ]),
    service: "tf-integrations-migrate",
    uid: 10001,
  });

  for (const { names, output, service, uid } of results) {
    const stderrLines = output.stderr.trim().split(/\r?\n/).filter(Boolean);
    const unsupportedMetadataWarning =
      /^time="[^"]+" level=warning msg="secrets `uid`, `gid` and `mode` are not supported, they will be ignored"$/;
    if (
      stderrLines.some(
        (line) =>
          (service !== "tf-integrations-migrate" && service !== "tf-migrate") ||
          !unsupportedMetadataWarning.test(line),
      )
    ) {
      throw new Error(
        `Secret stat probe wrote unexpected stderr for ${service}`,
      );
    }
    const lines = output.stdout.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length !== names.length) {
      throw new Error("Secret stat probe count is malformed");
    }
    for (const line of lines) {
      const match = /^(\d+):(\d+):(\d+):regular file$/.exec(line);
      if (match === null) {
        throw new Error("Secret stat probe result is malformed");
      }
      if (
        nativeSecretOwnership &&
        (Number(match[1]) !== uid ||
          Number(match[2]) !== uid ||
          match[3] !== "400")
      ) {
        throw new Error("Native secret owner/mode contract failed");
      }
    }
  }

  return {
    evidence: nativeSecretOwnership
      ? "native-linux-owner-mode"
      : "non-native-readonly-remap",
    verified: true,
  };
}

async function dashboardModule(
  apiOrigin: string,
  status: "healthy",
): Promise<Record<string, unknown>> {
  return waitFor(
    `account-integrations heartbeat ${status}`,
    async () => {
      const result = await fetchJson(`${apiOrigin}/api/admin/dashboard`, {
        headers: { "x-admin-dashboard-token": smokeAdminToken },
      });
      if (!result.response.ok || !isRecord(result.body)) return false;
      const modules = result.body.modules;
      if (!Array.isArray(modules)) return false;
      const module = modules.find(
        (candidate) =>
          isRecord(candidate) &&
          candidate.id === "account-integrations" &&
          candidate.status === status,
      );
      return isRecord(module) ? module : false;
    },
    45_000,
  );
}

async function waitForApi(apiOrigin: string): Promise<void> {
  await waitFor("TF API readiness", async () => {
    const result = await fetch(`${apiOrigin}/api/readyz`, {
      redirect: "error",
    });
    return result.ok;
  });
}

async function trackedFilesProjection(
  canaries: readonly string[],
): Promise<string> {
  const listed = await execFileAsync("git", ["ls-files", "-z"], {
    cwd: repositoryRoot,
    encoding: "buffer",
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  const paths = Buffer.from(listed.stdout)
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  for (const path of paths) {
    const bytes = await readFile(join(repositoryRoot, path));
    if (
      canaries.some((canary) => bytes.includes(Buffer.from(canary, "utf8")))
    ) {
      throw new Error("Tracked file contains sensitive smoke canary");
    }
  }
  return JSON.stringify({ trackedFilesScanned: paths.length });
}

async function inspectProject(
  environment: NodeJS.ProcessEnv,
  project: string,
): Promise<string> {
  const ids = await docker(
    [
      "ps",
      "-a",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${project}`,
    ],
    environment,
    30_000,
  );
  const containerIds = ids.stdout.split(/\r?\n/).filter(Boolean);
  if (containerIds.length === 0) {
    throw new Error("Smoke project has no inspectable containers");
  }
  const inspected = await docker(
    ["inspect", ...containerIds],
    environment,
    30_000,
  );
  return inspected.stdout;
}

function inspectRuntimeContract(
  projection: string,
  project: string,
): {
  readonly leastPrivilege: true;
  readonly migrationGating: true;
  readonly networkIsolation: true;
  readonly noHostPorts: true;
  readonly resourceLimits: true;
  readonly secretOwnership: true;
} {
  const parsed: unknown = JSON.parse(projection);
  if (!Array.isArray(parsed)) {
    throw new Error("Docker inspect projection is malformed");
  }
  const containers = parsed.filter(isRecord);
  const current = (name: string): Record<string, unknown> => {
    const match = containers.find((container) => {
      const config = container.Config;
      if (!isRecord(config) || !isRecord(config.Labels)) return false;
      return config.Labels["com.docker.compose.service"] === name;
    });
    if (match === undefined) {
      throw new Error("Docker inspect service is missing");
    }
    return match;
  };
  const config = (
    container: Record<string, unknown>,
  ): Record<string, unknown> =>
    isRecord(container.Config) ? container.Config : {};
  const host = (container: Record<string, unknown>): Record<string, unknown> =>
    isRecord(container.HostConfig) ? container.HostConfig : {};
  const state = (
    container: Record<string, unknown>,
  ): Record<string, unknown> =>
    isRecord(container.State) ? container.State : {};
  const attachedNetworks = (
    container: Record<string, unknown>,
  ): readonly string[] => {
    const networkSettings = isRecord(container.NetworkSettings)
      ? container.NetworkSettings
      : {};
    const networks = isRecord(networkSettings.Networks)
      ? networkSettings.Networks
      : {};
    return Object.keys(networks)
      .map((name) =>
        name.startsWith(`${project}_`)
          ? name.slice(`${project}_`.length)
          : name,
      )
      .sort();
  };
  const secretTargets = (
    container: Record<string, unknown>,
  ): readonly string[] => {
    if (!Array.isArray(container.Mounts)) return [];
    return container.Mounts.filter(isRecord)
      .filter(
        (mount) =>
          mount.Type === "bind" &&
          mount.RW === false &&
          typeof mount.Destination === "string" &&
          mount.Destination.startsWith("/run/secrets/"),
      )
      .map((mount) => String(mount.Destination).slice("/run/secrets/".length))
      .sort();
  };
  const noBindings = (container: Record<string, unknown>): boolean => {
    const bindings = host(container).PortBindings;
    if (!isRecord(bindings)) return true;
    return Object.values(bindings).every(
      (value) => value === null || (Array.isArray(value) && value.length === 0),
    );
  };
  const hardened = (container: Record<string, unknown>): boolean => {
    const currentConfig = config(container);
    const currentHost = host(container);
    const tmpfs = isRecord(currentHost.Tmpfs) ? currentHost.Tmpfs : {};
    return (
      currentConfig.User === "10001:10001" &&
      currentHost.ReadonlyRootfs === true &&
      currentHost.Init === true &&
      Array.isArray(currentHost.CapDrop) &&
      currentHost.CapDrop.includes("ALL") &&
      Array.isArray(currentHost.SecurityOpt) &&
      currentHost.SecurityOpt.includes("no-new-privileges:true") &&
      typeof currentHost.PidsLimit === "number" &&
      currentHost.PidsLimit > 0 &&
      typeof tmpfs["/tmp"] === "string" &&
      tmpfs["/tmp"].includes("size=16m")
    );
  };
  const hasLimits = (
    container: Record<string, unknown>,
    expected: {
      readonly memory: number;
      readonly nanoCpus: number;
      readonly pids: number;
    },
  ): boolean => {
    const currentHost = host(container);
    return (
      currentHost.Memory === expected.memory &&
      currentHost.NanoCpus === expected.nanoCpus &&
      currentHost.PidsLimit === expected.pids
    );
  };

  const api = current("api");
  const db = current("db");
  const tfMigrate = current("tf-migrate");
  const module = current("tf-integrations");
  const migrate = current("tf-integrations-migrate");
  const postgres = current("tf-integrations-postgres");
  const downloadRedis = current("tf-download-redis");
  const downloadWorker = current("tf-download-worker");
  if (!hardened(tfMigrate) || !hardened(module) || !hardened(migrate)) {
    throw new Error("Docker inspect least-privilege contract failed");
  }
  if (
    JSON.stringify(attachedNetworks(api)) !==
      JSON.stringify([
        "tf-data",
        "tf-download-control",
        "tf-download-queue",
        "tf-edge",
        "tf-integrations-control",
        "tf-search-control",
      ]) ||
    JSON.stringify(attachedNetworks(db)) !== JSON.stringify(["tf-data"]) ||
    JSON.stringify(attachedNetworks(tfMigrate)) !==
      JSON.stringify(["tf-data"]) ||
    JSON.stringify(attachedNetworks(module)) !==
      JSON.stringify([
        "tf-integrations-control",
        "tf-integrations-data",
        "tf-integrations-egress",
      ]) ||
    JSON.stringify(attachedNetworks(migrate)) !==
      JSON.stringify(["tf-integrations-data"]) ||
    JSON.stringify(attachedNetworks(postgres)) !==
      JSON.stringify(["tf-integrations-data"]) ||
    JSON.stringify(attachedNetworks(downloadRedis)) !==
      JSON.stringify(["tf-download-queue"]) ||
    JSON.stringify(attachedNetworks(downloadWorker)) !==
      JSON.stringify([
        "tf-download-control",
        "tf-download-egress",
        "tf-download-queue",
      ])
  ) {
    throw new Error("Docker inspect network-isolation contract failed");
  }
  if (
    !hasLimits(module, {
      memory: 512 * 1024 * 1024,
      nanoCpus: 1_000_000_000,
      pids: 128,
    }) ||
    !hasLimits(migrate, {
      memory: 256 * 1024 * 1024,
      nanoCpus: 500_000_000,
      pids: 64,
    }) ||
    !hasLimits(tfMigrate, {
      memory: 256 * 1024 * 1024,
      nanoCpus: 500_000_000,
      pids: 64,
    }) ||
    !hasLimits(downloadRedis, {
      memory: 256 * 1024 * 1024,
      nanoCpus: 500_000_000,
      pids: 128,
    }) ||
    !hasLimits(downloadWorker, {
      memory: 1024 * 1024 * 1024,
      nanoCpus: 2_000_000_000,
      pids: 256,
    })
  ) {
    throw new Error("Docker inspect resource-limit contract failed");
  }
  if (
    ![
      db,
      tfMigrate,
      module,
      migrate,
      postgres,
      downloadRedis,
      downloadWorker,
    ].every(noBindings)
  ) {
    throw new Error("Docker inspect host-port contract failed");
  }

  const expectedModuleSecrets = [
    "tf_integrations_heartbeat_secret",
    "tf_integrations_internal_auth_secret",
    "tf_integrations_runtime_database_url",
    "tf_integrations_spotify_client_id",
    "tf_integrations_spotify_client_secret",
    "tf_integrations_token_keyring",
  ];
  const expectedPostgresSecrets = [
    "tf_integrations_migrator_password",
    "tf_integrations_postgres_admin_password",
    "tf_integrations_runtime_password",
  ];
  if (
    JSON.stringify(secretTargets(module)) !==
      JSON.stringify(expectedModuleSecrets) ||
    JSON.stringify(secretTargets(migrate)) !==
      JSON.stringify(["tf_integrations_migrator_database_url"]) ||
    JSON.stringify(secretTargets(postgres)) !==
      JSON.stringify(expectedPostgresSecrets) ||
    JSON.stringify(secretTargets(db)) !==
      JSON.stringify(assignedIntegrationSecrets.db) ||
    JSON.stringify(secretTargets(tfMigrate)) !==
      JSON.stringify(assignedIntegrationSecrets["tf-migrate"]) ||
    JSON.stringify(secretTargets(api)) !==
      JSON.stringify(assignedIntegrationSecrets.api) ||
    JSON.stringify(secretTargets(downloadRedis)) !==
      JSON.stringify(assignedIntegrationSecrets["tf-download-redis"]) ||
    JSON.stringify(secretTargets(downloadWorker)) !==
      JSON.stringify(assignedIntegrationSecrets["tf-download-worker"])
  ) {
    throw new Error("Docker inspect secret-ownership contract failed");
  }

  const tfMigrationState = state(tfMigrate);
  const migrateState = state(migrate);
  const apiState = state(api);
  const moduleState = state(module);
  const postgresState = state(postgres);
  const downloadRedisState = state(downloadRedis);
  const downloadWorkerState = state(downloadWorker);
  const moduleHealth = isRecord(moduleState.Health)
    ? moduleState.Health.Status
    : undefined;
  const postgresHealth = isRecord(postgresState.Health)
    ? postgresState.Health.Status
    : undefined;
  const downloadRedisHealth = isRecord(downloadRedisState.Health)
    ? downloadRedisState.Health.Status
    : undefined;
  const downloadWorkerHealth = isRecord(downloadWorkerState.Health)
    ? downloadWorkerState.Health.Status
    : undefined;
  const migrationFinished =
    typeof migrateState.FinishedAt === "string"
      ? Date.parse(migrateState.FinishedAt)
      : Number.NaN;
  const moduleStarted =
    typeof moduleState.StartedAt === "string"
      ? Date.parse(moduleState.StartedAt)
      : Number.NaN;
  const tfMigrationFinished =
    typeof tfMigrationState.FinishedAt === "string"
      ? Date.parse(tfMigrationState.FinishedAt)
      : Number.NaN;
  const apiStarted =
    typeof apiState.StartedAt === "string"
      ? Date.parse(apiState.StartedAt)
      : Number.NaN;
  const downloadWorkerStarted =
    typeof downloadWorkerState.StartedAt === "string"
      ? Date.parse(downloadWorkerState.StartedAt)
      : Number.NaN;
  if (
    tfMigrationState.Status !== "exited" ||
    tfMigrationState.ExitCode !== 0 ||
    migrateState.Status !== "exited" ||
    migrateState.ExitCode !== 0 ||
    moduleHealth !== "healthy" ||
    postgresHealth !== "healthy" ||
    downloadRedisHealth !== "healthy" ||
    downloadWorkerHealth !== "healthy" ||
    !Number.isFinite(migrationFinished) ||
    !Number.isFinite(moduleStarted) ||
    !Number.isFinite(tfMigrationFinished) ||
    !Number.isFinite(apiStarted) ||
    !Number.isFinite(downloadWorkerStarted) ||
    moduleStarted < migrationFinished ||
    apiStarted < tfMigrationFinished ||
    apiStarted < downloadWorkerStarted
  ) {
    throw new Error("Docker inspect migration-gating contract failed");
  }

  return {
    leastPrivilege: true,
    migrationGating: true,
    networkIsolation: true,
    noHostPorts: true,
    resourceLimits: true,
    secretOwnership: true,
  };
}

async function removeProjectImages(
  environment: NodeJS.ProcessEnv,
  project: string,
): Promise<void> {
  const listed = await docker(
    ["image", "ls", "-q", "--filter", `reference=${project}-*`],
    environment,
    30_000,
  );
  const ids = [...new Set(listed.stdout.split(/\r?\n/).filter(Boolean))];
  if (ids.length > 0) {
    await docker(["image", "rm", ...ids], environment, 2 * 60_000);
  }
}

async function auditProject(
  environment: NodeJS.ProcessEnv,
  project: string,
  prepared?: PreparedSecrets,
): Promise<CleanupObservations> {
  const label = `label=com.docker.compose.project=${project}`;
  const [containers, networks, volumes, labeledImages, namedImages] =
    await Promise.all([
      docker(["ps", "-a", "-q", "--filter", label], environment, 30_000),
      docker(["network", "ls", "-q", "--filter", label], environment, 30_000),
      docker(["volume", "ls", "-q", "--filter", label], environment, 30_000),
      docker(["image", "ls", "-q", "--filter", label], environment, 30_000),
      docker(
        ["image", "ls", "-q", "--filter", `reference=${project}-*`],
        environment,
        30_000,
      ),
    ]);
  const lines = (value: string): readonly string[] =>
    value.split(/\r?\n/).filter(Boolean);
  let temporaryDirectories = 0;
  if (prepared !== undefined) {
    try {
      await access(prepared.directory);
      temporaryDirectories = 1;
    } catch {
      temporaryDirectories = 0;
    }
  }
  return {
    containers: lines(containers.stdout).length,
    images: new Set([
      ...lines(labeledImages.stdout),
      ...lines(namedImages.stdout),
    ]).size,
    networks: lines(networks.stdout).length,
    temporaryDirectories,
    volumes: lines(volumes.stdout).length,
  };
}

async function runDisposableSmoke(): Promise<SmokeResult> {
  const localDocker = await localDockerEnvironment(process.env);
  const environment = localDocker.environment;
  delete environment.COMPOSE_PROJECT_NAME;
  const project =
    `apollo-tf-integrations-smoke-${process.pid}-` +
    randomBytes(4).toString("hex");
  environment.COMPOSE_PROJECT_NAME = project;
  environment.TF_API_PORT = String(await reserveLoopbackPort());
  environment.TF_API_IMAGE = `${project}-api:smoke`;
  environment.TF_DOWNLOAD_REDIS_IMAGE = `${project}-tf-download-redis:smoke`;
  environment.TF_DOWNLOAD_WORKER_IMAGE = `${project}-tf-download-worker:smoke`;
  environment.TF_POSTGRES_IMAGE = `${project}-postgres:smoke`;
  environment.TF_INTEGRATIONS_IMAGE = `${project}-tf-integrations:smoke`;
  environment.TF_INTEGRATIONS_POSTGRES_IMAGE = `${project}-tf-integrations-postgres:smoke`;

  let prepared: PreparedSecrets | undefined;
  let overridePath: string | undefined;
  let compose: ((args: readonly string[]) => Promise<DockerResult>) | undefined;
  let observations: SmokeObservations | undefined;
  let lifecycleError: unknown;
  let cleanupError: unknown;
  let cleanup: CleanupObservations = {
    containers: -1,
    images: -1,
    networks: -1,
    temporaryDirectories: -1,
    volumes: -1,
  };

  try {
    prepared = await prepareSecrets(environment, {
      nativeSecretOwnership: localDocker.nativeSecretOwnership,
      project,
    });
    overridePath = await writeOverride(prepared);
    compose = (args) =>
      docker(composeArguments(overridePath!, project, args), environment);

    const rendered = await compose(["config"]);
    assertCanaryFree(
      `${rendered.stdout}\n${rendered.stderr}`,
      prepared.canaries,
      "Rendered config",
    );
    await compose([
      "up",
      "-d",
      "--build",
      "db",
      "tf-migrate",
      "redis",
      "tf-search",
      "tf-integrations-postgres",
      "tf-integrations-migrate",
      "tf-integrations",
      "tf-download-redis",
      "tf-download-worker",
      "api",
    ]);

    const apiOrigin = `http://127.0.0.1:${environment.TF_API_PORT}`;
    await waitForApi(apiOrigin);
    await waitFor("TF integrations readiness", async () => {
      const result = await compose!([
        "exec",
        "-T",
        "tf-integrations",
        "node",
        "-e",
        "fetch('http://127.0.0.1:8080/readyz').then(r=>process.exit(r.ok?0:1))",
      ]);
      return result.stderr.trim().length === 0;
    });
    const migrationContainer = await compose([
      "ps",
      "-a",
      "-q",
      "tf-integrations-migrate",
    ]);
    const migrationInspect = await docker(
      [
        "inspect",
        migrationContainer.stdout.trim(),
        "--format",
        "{{json .State.ExitCode}}",
      ],
      environment,
      30_000,
    );
    const migrationExitCode = JSON.parse(
      migrationInspect.stdout.trim(),
    ) as number;
    const commands = await commandObservations(compose);
    const ciphertext = await ciphertextObservations(compose, prepared);
    const providerAccountGenerationCas =
      await providerAccountGenerationCasObservation(compose);
    const rolePrivileges = await rolePrivilegeObservations(compose);
    const secretStats = await secretTargetStatObservations(
      compose,
      localDocker.nativeSecretOwnership,
    );
    const healthy = await dashboardModule(apiOrigin, "healthy");

    await compose(["restart", "api"]);
    await waitForApi(apiOrigin);
    const reset = await fetchJson(`${apiOrigin}/api/admin/dashboard`, {
      headers: { "x-admin-dashboard-token": smokeAdminToken },
    });
    const resetModules =
      isRecord(reset.body) && Array.isArray(reset.body.modules)
        ? reset.body.modules
        : [];
    const resetModule = resetModules.find(
      (candidate) =>
        isRecord(candidate) && candidate.id === "account-integrations",
    );
    const heartbeatUnknownAfterReset =
      isRecord(resetModule) && resetModule.status === "unknown";
    const recovered = await dashboardModule(apiOrigin, "healthy");

    const logs = await compose([
      "logs",
      "--no-color",
      "api",
      "db",
      "tf-migrate",
      "tf-integrations",
      "tf-integrations-migrate",
      "tf-integrations-postgres",
    ]);
    const inspect = await inspectProject(environment, project);
    assertCanaryFree(inspect, prepared.canaries, "Docker inspect");
    const inspectedContract = inspectRuntimeContract(inspect, project);
    const tracked = await trackedFilesProjection(prepared.canaries);
    const surfaces = [
      rendered.stdout,
      `${logs.stdout}\n${logs.stderr}`,
      commands.responseProjection,
      ciphertext.projection,
      inspect,
      tracked,
    ];
    for (const [index, surface] of surfaces.entries()) {
      assertCanaryFree(
        surface,
        prepared.canaries,
        `Smoke surface ${index + 1}`,
      );
    }

    observations = {
      ...commands,
      canarySurfacesScanned: surfaces.length,
      ciphertextAuthenticated: ciphertext.authenticated,
      ciphertextAtRest: ciphertext.atRest,
      heartbeatHealthy: healthy.status === "healthy",
      heartbeatRecovered: recovered.status === "healthy",
      heartbeatUnknownAfterReset,
      heartbeatVersion:
        typeof recovered.version === "string" ? recovered.version : "",
      inspectLeastPrivilege: inspectedContract.leastPrivilege,
      inspectMigrationGating: inspectedContract.migrationGating,
      inspectNetworkIsolation: inspectedContract.networkIsolation,
      inspectNoHostPorts: inspectedContract.noHostPorts,
      inspectResourceLimits: inspectedContract.resourceLimits,
      inspectSecretOwnership: inspectedContract.secretOwnership,
      migrationExitCode,
      providerAccountGenerationCas,
      ready: true,
      rolePrivilegesEnforced: rolePrivileges.enforced,
      runtimeNodeMajor: rolePrivileges.nodeMajor,
      secretOwnershipEvidence: secretStats.evidence,
      secretTargetStatsVerified: secretStats.verified,
    };
  } catch (error) {
    lifecycleError = error;
  } finally {
    if (prepared !== undefined && compose !== undefined) {
      try {
        const logs = await compose([
          "logs",
          "--no-color",
          "api",
          "tf-integrations",
          "tf-integrations-migrate",
          "tf-integrations-postgres",
        ]);
        assertCanaryFree(
          `${logs.stdout}\n${logs.stderr}`,
          prepared.canaries,
          "Failure logs",
        );
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (overridePath !== undefined) {
      try {
        await docker(
          composeArguments(overridePath, project, [
            "down",
            "-v",
            "--remove-orphans",
            "--rmi",
            "local",
          ]),
          environment,
        );
      } catch (error) {
        cleanupError ??= error;
      }
    }
    try {
      await removeProjectImages(environment, project);
    } catch (error) {
      cleanupError ??= error;
    }
    if (prepared !== undefined) {
      try {
        await removePreparedSecrets(prepared);
      } catch (error) {
        cleanupError ??= error;
      }
    }
    try {
      cleanup = await auditProject(environment, project, prepared);
      if (Object.values(cleanup).some((count) => count !== 0)) {
        throw new Error("Smoke cleanup left project resources");
      }
    } catch (error) {
      cleanupError ??= error;
    }
  }

  const canaries = prepared?.canaries ?? [];
  if (lifecycleError !== undefined) {
    throw sanitizeError(lifecycleError, canaries);
  }
  if (cleanupError !== undefined) {
    throw sanitizeError(cleanupError, canaries);
  }
  if (observations === undefined) {
    throw new Error("Smoke observations are missing");
  }
  return { cleanup, observations, project };
}

function fixtureConfigEnvironment(nodeEnv: string): {
  readonly environment: NodeJS.ProcessEnv;
  readonly secrets: Readonly<Record<string, string>>;
} {
  const key = Buffer.alloc(32, 7).toString("base64url");
  const secrets = {
    "/database": "postgres://runtime:password@database:5432/integrations",
    "/heartbeat": "h".repeat(48),
    "/internal": "i".repeat(48),
    "/keyring": JSON.stringify({
      activeKeyId: "test-v1",
      keys: { "test-v1": key },
    }),
    "/spotify-id": "fixture-client-id",
    "/spotify-secret": "fixture-client-secret",
  };
  return {
    environment: {
      APOLLO_API_VERSION: "test",
      NODE_ENV: nodeEnv,
      PORT: "8080",
      TF_INTEGRATIONS_DATABASE_URL_FILE: "/database",
      TF_INTEGRATIONS_HEARTBEAT_ALLOW_INSECURE_HTTP: "true",
      TF_INTEGRATIONS_HEARTBEAT_API_ORIGIN: "http://api:8080",
      TF_INTEGRATIONS_HEARTBEAT_SECRET_FILE: "/heartbeat",
      TF_INTEGRATIONS_INTERNAL_AUTH_SECRET_FILE: "/internal",
      TF_INTEGRATIONS_SMOKE_FIXTURES: "true",
      TF_INTEGRATIONS_SPOTIFY_CALLBACK_URI:
        "https://api.tf.example/api/spotify/callback",
      TF_INTEGRATIONS_SPOTIFY_CLIENT_ID_FILE: "/spotify-id",
      TF_INTEGRATIONS_SPOTIFY_CLIENT_SECRET_FILE: "/spotify-secret",
      TF_INTEGRATIONS_TOKEN_KEYRING_FILE: "/keyring",
    },
    secrets,
  };
}

describe("tf-integrations smoke fixture gate", () => {
  it("enables fixture providers only for an explicit test runtime", async () => {
    const fixture = fixtureConfigEnvironment("test");
    const config = await parseTfIntegrationsConfig(
      fixture.environment,
      async (path) => fixture.secrets[path] ?? "",
    );
    expect(config).toMatchObject({ smokeFixtures: true });

    const production = fixtureConfigEnvironment("production");
    await expect(
      parseTfIntegrationsConfig(
        production.environment,
        async (path) => production.secrets[path] ?? "",
      ),
    ).rejects.toThrow("invalid runtime configuration");
  });

  it("uses deterministic offline provider adapters without provider transport", async () => {
    const { createSmokeFixtureProviders } =
      await import("./providers/smoke-fixtures.js");
    const fixtures = createSmokeFixtureProviders();
    const authorizationUrl = new URL(
      fixtures.spotify.authorizationUrl({
        callbackUri: "https://api.tf.example/api/spotify/callback",
        state: "fixture-state",
      }),
    );
    expect(authorizationUrl.origin).toBe("https://accounts.spotify.com");
    expect(authorizationUrl.searchParams.get("state")).toBe("fixture-state");
    await expect(
      fixtures.spotify.exchangeCode({
        callbackUri: "https://api.tf.example/api/spotify/callback",
        code: "fixture-code",
      }),
    ).resolves.toMatchObject({
      account: {
        displayName: "Spotify Smoke Fixture",
        id: "spotify-smoke-fixture",
      },
    });
    await expect(
      fixtures.spotify.playlists({ accessToken: "fixture-access" }),
    ).rejects.toMatchObject({ code: "provider_unavailable" });
    await expect(
      fixtures.yandex.validateToken({ oauthToken: "fixture-token" }),
    ).resolves.toEqual({
      displayName: "Yandex Smoke Fixture",
      id: "424242",
      login: "yandex-smoke-fixture",
    });
    await expect(
      fixtures.yandex.playlists({
        oauthToken: "fixture-token",
        userId: "424242",
      }),
    ).rejects.toMatchObject({ code: "provider_unavailable" });
  });
});

describe("tf-integrations disposable smoke secret contract", () => {
  it("prepares the final API and download startup secret contract", async () => {
    const environment: NodeJS.ProcessEnv = {};
    let prepared: PreparedSecrets | undefined;

    try {
      prepared = await prepareSecrets(environment);

      expect([...prepared.secretNames].sort()).toEqual([
        "tf_admin_database_url",
        "tf_client_secret",
        "tf_download_heartbeat_secret",
        "tf_download_internal_auth_secret",
        "tf_download_queue_password",
        "tf_download_queue_redis_url",
        "tf_integrations_heartbeat_secret",
        "tf_integrations_internal_auth_secret",
        "tf_integrations_migrator_database_url",
        "tf_integrations_migrator_password",
        "tf_integrations_postgres_admin_password",
        "tf_integrations_runtime_database_url",
        "tf_integrations_runtime_password",
        "tf_integrations_smoke_token",
        "tf_integrations_spotify_client_id",
        "tf_integrations_spotify_client_secret",
        "tf_integrations_token_keyring",
        "tf_migrator_database_url",
        "tf_migrator_password",
        "tf_module_heartbeat_keys",
        "tf_postgres_admin_password",
        "tf_runtime_database_url",
        "tf_runtime_password",
        "tf_search_heartbeat_secret",
        "tf_search_internal_auth_secret",
      ]);
      expect(environment.TF_SECRET_DIRECTORY).toBe(prepared.directory);

      const integrationHeartbeatSecret = await readFile(
        join(prepared.directory, "tf_integrations_heartbeat_secret"),
        "utf8",
      );
      const searchHeartbeatSecret = await readFile(
        join(prepared.directory, "tf_search_heartbeat_secret"),
        "utf8",
      );
      const downloadHeartbeatSecret = await readFile(
        join(prepared.directory, "tf_download_heartbeat_secret"),
        "utf8",
      );
      const heartbeatMapText = await readFile(
        join(prepared.directory, "tf_module_heartbeat_keys"),
        "utf8",
      );
      expect(JSON.parse(heartbeatMapText)).toEqual({
        "account-integrations": integrationHeartbeatSecret,
        "download-worker": downloadHeartbeatSecret,
        "search-media": searchHeartbeatSecret,
      });
      expect(
        new Set([
          integrationHeartbeatSecret,
          searchHeartbeatSecret,
          downloadHeartbeatSecret,
        ]).size,
      ).toBe(3);

      const downloadQueuePassword = await readFile(
        join(prepared.directory, "tf_download_queue_password"),
        "utf8",
      );
      const downloadQueueUrl = await readFile(
        join(prepared.directory, "tf_download_queue_redis_url"),
        "utf8",
      );
      const downloadInternalAuthSecret = await readFile(
        join(prepared.directory, "tf_download_internal_auth_secret"),
        "utf8",
      );
      expect(downloadQueueUrl).toBe(
        `redis://default:${encodeURIComponent(downloadQueuePassword)}` +
          "@tf-download-redis:6379/0",
      );

      for (const value of [
        integrationHeartbeatSecret,
        searchHeartbeatSecret,
        downloadHeartbeatSecret,
        downloadQueuePassword,
        downloadQueueUrl,
        downloadInternalAuthSecret,
        heartbeatMapText,
      ]) {
        expect(prepared.canaries).toContain(value);
        expect(prepared.canaries).toContain(digest(value));
      }
    } finally {
      if (prepared !== undefined) await removePreparedSecrets(prepared);
    }
  });
});

describe("tf-integrations smoke failure redaction", () => {
  it("drops command output properties before propagating a failure", () => {
    const canary = generatedSecret();
    const original = Object.assign(new Error("Docker command failed"), {
      stderr: canary,
      stdout: canary,
    });

    const sanitized = sanitizeError(original, [canary]);

    expect(sanitized).not.toBe(original);
    expect(sanitized.message).toBe("Docker command failed");
    expect(sanitized).not.toHaveProperty("stderr");
    expect(sanitized).not.toHaveProperty("stdout");
    expect(`${sanitized.message}\n${sanitized.stack ?? ""}`).not.toContain(
      canary,
    );
  });

  it("removes every partial secret artifact when an injected write fails", async () => {
    const rootDirectory = join(
      temporaryRoot,
      `tf-integrations-injected-${randomBytes(8).toString("hex")}`,
    );
    let calls = 0;
    let capturedCanary = "";
    let original: Error | undefined;
    let caught: unknown;

    try {
      await prepareSecrets(
        {},
        {
          rootDirectory,
          write: async (directory, name, value) => {
            calls += 1;
            if (calls === 1) {
              await writeSecret(directory, name, value);
              return;
            }
            capturedCanary = value;
            original = Object.assign(
              new Error("Injected secret write failure"),
              {
                stderr: value,
                stdout: value,
              },
            );
            throw original;
          },
        },
      );
    } catch (error) {
      caught = error;
    }

    try {
      expect(calls).toBe(2);
      expect(caught instanceof Error).toBe(true);
      expect(caught === original).toBe(false);
      expect(
        caught instanceof Error &&
          (Object.hasOwn(caught, "stderr") || Object.hasOwn(caught, "stdout")),
      ).toBe(false);
      expect(
        caught instanceof Error &&
          `${caught.message}\n${caught.stack ?? ""}`.includes(capturedCanary),
      ).toBe(false);
      let rootExists = true;
      try {
        await access(rootDirectory);
      } catch {
        rootExists = false;
      }
      expect(rootExists).toBe(false);
    } finally {
      await rm(rootDirectory, { force: true, recursive: true });
    }
  });
});

function inspectContractFixture(
  project: string,
): Array<Record<string, unknown>> {
  const mounts = (names: readonly string[]) =>
    names.map((name) => ({
      Destination: `/run/secrets/${name}`,
      RW: false,
      Type: "bind",
    }));
  const networks = (names: readonly string[]) => ({
    Networks: Object.fromEntries(
      names.map((name) => [`${project}_${name}`, {}]),
    ),
  });
  const hardenedHost = (nanoCpus: number, memory: number, pids: number) => ({
    CapDrop: ["ALL"],
    Init: true,
    Memory: memory,
    NanoCpus: nanoCpus,
    PidsLimit: pids,
    PortBindings: {},
    ReadonlyRootfs: true,
    SecurityOpt: ["no-new-privileges:true"],
    Tmpfs: { "/tmp": "rw,noexec,nosuid,size=16m" },
  });
  const labels = (service: string) => ({
    Labels: { "com.docker.compose.service": service },
  });

  return [
    {
      Config: labels("api"),
      HostConfig: { PortBindings: {} },
      Mounts: mounts([
        "tf_client_secret",
        "tf_download_internal_auth_secret",
        "tf_download_queue_redis_url",
        "tf_integrations_internal_auth_secret",
        "tf_integrations_smoke_token",
        "tf_module_heartbeat_keys",
        "tf_runtime_database_url",
        "tf_search_internal_auth_secret",
      ]),
      NetworkSettings: networks([
        "tf-data",
        "tf-download-control",
        "tf-download-queue",
        "tf-edge",
        "tf-integrations-control",
        "tf-search-control",
      ]),
      State: { StartedAt: "2026-07-25T12:00:02.000Z" },
    },
    {
      Config: { ...labels("tf-download-redis"), User: "999:999" },
      HostConfig: hardenedHost(500_000_000, 256 * 1024 * 1024, 128),
      Mounts: mounts(["tf_download_queue_password"]),
      NetworkSettings: networks(["tf-download-queue"]),
      State: {
        Health: { Status: "healthy" },
        StartedAt: "2026-07-25T12:00:00.000Z",
      },
    },
    {
      Config: { ...labels("tf-download-worker"), User: "10001:10001" },
      HostConfig: hardenedHost(2_000_000_000, 1024 * 1024 * 1024, 256),
      Mounts: mounts([
        "tf_download_heartbeat_secret",
        "tf_download_internal_auth_secret",
        "tf_download_queue_redis_url",
      ]),
      NetworkSettings: networks([
        "tf-download-control",
        "tf-download-egress",
        "tf-download-queue",
      ]),
      State: {
        Health: { Status: "healthy" },
        StartedAt: "2026-07-25T12:00:01.000Z",
      },
    },
    {
      Config: { ...labels("tf-integrations"), User: "10001:10001" },
      HostConfig: hardenedHost(1_000_000_000, 512 * 1024 * 1024, 128),
      Mounts: mounts([
        "tf_integrations_heartbeat_secret",
        "tf_integrations_internal_auth_secret",
        "tf_integrations_runtime_database_url",
        "tf_integrations_spotify_client_id",
        "tf_integrations_spotify_client_secret",
        "tf_integrations_token_keyring",
      ]),
      NetworkSettings: networks([
        "tf-integrations-control",
        "tf-integrations-data",
        "tf-integrations-egress",
      ]),
      State: {
        Health: { Status: "healthy" },
        StartedAt: "2026-07-25T12:00:01.000Z",
      },
    },
    {
      Config: {
        ...labels("tf-integrations-migrate"),
        User: "10001:10001",
      },
      HostConfig: hardenedHost(500_000_000, 256 * 1024 * 1024, 64),
      Mounts: mounts(["tf_integrations_migrator_database_url"]),
      NetworkSettings: networks(["tf-integrations-data"]),
      State: {
        ExitCode: 0,
        FinishedAt: "2026-07-25T12:00:00.000Z",
        Status: "exited",
      },
    },
    {
      Config: labels("tf-integrations-postgres"),
      HostConfig: { PortBindings: {} },
      Mounts: mounts([
        "tf_integrations_migrator_password",
        "tf_integrations_postgres_admin_password",
        "tf_integrations_runtime_password",
      ]),
      NetworkSettings: networks(["tf-integrations-data"]),
      State: { Health: { Status: "healthy" } },
    },
    {
      Config: labels("db"),
      HostConfig: { PortBindings: {} },
      Mounts: mounts([
        "tf_migrator_password",
        "tf_postgres_admin_password",
        "tf_runtime_password",
      ]),
      NetworkSettings: networks(["tf-data"]),
      State: { Health: { Status: "healthy" } },
    },
    {
      Config: { ...labels("tf-migrate"), User: "10001:10001" },
      HostConfig: hardenedHost(500_000_000, 256 * 1024 * 1024, 64),
      Mounts: mounts(["tf_migrator_database_url"]),
      NetworkSettings: networks(["tf-data"]),
      State: {
        ExitCode: 0,
        FinishedAt: "2026-07-25T12:00:01.000Z",
        Status: "exited",
      },
    },
  ];
}

describe("tf-integrations Docker inspect validation", () => {
  it("rejects an accidental network even when its name is outside the integration prefix", () => {
    const project = "inspect-contract";
    const projection = inspectContractFixture(project);
    const module = projection[1]!;
    const networkSettings = module.NetworkSettings as {
      Networks: Record<string, unknown>;
    };
    networkSettings.Networks["unexpected-control-plane"] = {};

    expect(() =>
      inspectRuntimeContract(JSON.stringify(projection), project),
    ).toThrow("Docker inspect network-isolation contract failed");
  });

  it("rejects a missing live CPU or memory limit", () => {
    const project = "inspect-contract";
    const projection = inspectContractFixture(project);
    const migrate = projection[2]!;
    const hostConfig = migrate.HostConfig as Record<string, unknown>;
    hostConfig.Memory = 0;

    expect(() =>
      inspectRuntimeContract(JSON.stringify(projection), project),
    ).toThrow("Docker inspect resource-limit contract failed");
  });

  it("rejects an unassigned API secret even when its name is outside the integration prefix", () => {
    const project = "inspect-contract";
    const projection = inspectContractFixture(project);
    const api = projection[0]!;
    const mounts = api.Mounts as Array<Record<string, unknown>>;
    mounts.push({
      Destination: "/run/secrets/unexpected_control_plane_secret",
      RW: false,
      Type: "bind",
    });

    expect(() =>
      inspectRuntimeContract(JSON.stringify(projection), project),
    ).toThrow("Docker inspect secret-ownership contract failed");
  });
});

const realDockerEnabled = process.env.TF_INTEGRATIONS_SMOKE_REAL_DOCKER === "1";

describe.skipIf(!realDockerEnabled)(
  "tf-integrations disposable local Docker smoke",
  () => {
    let result: SmokeResult;

    beforeAll(async () => {
      result = await runDisposableSmoke();
    }, 15 * 60_000);

    it("becomes ready after one-shot migrations and accepts one valid signed command", () => {
      expect(result.observations.ready).toBe(true);
      expect(result.observations.migrationExitCode).toBe(0);
      expect(result.observations.validAccepted).toBe(true);
      expect(result.observations).toMatchObject({
        inspectLeastPrivilege: true,
        inspectMigrationGating: true,
        inspectNetworkIsolation: true,
        inspectNoHostPorts: true,
        inspectResourceLimits: true,
        inspectSecretOwnership: true,
        runtimeNodeMajor: 24,
      });
    });

    it("keeps migration history migrator-owned and read-only to runtime", () => {
      expect(result.observations.rolePrivilegesEnforced).toBe(true);
    });

    it("stats every assigned integration secret with platform-explicit evidence", () => {
      expect(result.observations.secretTargetStatsVerified).toBe(true);
      expect([
        "non-native-readonly-remap",
        "native-linux-owner-mode",
      ]).toContain(result.observations.secretOwnershipEvidence);
    });

    it("rejects replay, tampered body, wrong key, unsupported encoding, and unsigned command", () => {
      expect(result.observations).toMatchObject({
        replayRejected: true,
        tamperedRejected: true,
        unsignedRejected: true,
        unsupportedEncodingRejected: true,
        wrongKeyRejected: true,
      });
    });

    it("stores a provider-token fixture only as authenticated ciphertext", () => {
      expect(result.observations.ciphertextAtRest).toBe(true);
      expect(result.observations.ciphertextAuthenticated).toBe(true);
    });

    it("rejects a stale provider-account generation in real PostgreSQL", () => {
      expect(result.observations.providerAccountGenerationCas).toBe(true);
    });

    it("sends account-integrations heartbeat and recovers after API heartbeat state reset", () => {
      expect(result.observations.heartbeatHealthy).toBe(true);
      expect(result.observations.heartbeatUnknownAfterReset).toBe(true);
      expect(result.observations.heartbeatRecovered).toBe(true);
      expect(result.observations.heartbeatVersion).toBe("task-6-smoke");
    });

    it("keeps provider outage out of readiness", () => {
      expect(result.observations.providerOutageReported).toBe(true);
      expect(result.observations.providerOutageReadiness).toBe(true);
    });

    it("leaves no secret canary in config, logs, responses, inspect output, or tracked files", () => {
      expect(result.observations.canarySurfacesScanned).toBeGreaterThanOrEqual(
        6,
      );
    });

    it("removes all project containers, images, networks, volumes, and temporary directories", () => {
      expect(result.cleanup).toEqual({
        containers: 0,
        images: 0,
        networks: 0,
        temporaryDirectories: 0,
        volumes: 0,
      });
      expect(result.project).toMatch(
        /^apollo-tf-integrations-smoke-\d+-[a-f0-9]{8}$/,
      );
    });
  },
);
