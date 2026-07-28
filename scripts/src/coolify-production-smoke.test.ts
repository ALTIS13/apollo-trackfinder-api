import { spawn } from "node:child_process";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const platformCompose = join(
  repositoryRoot,
  "deploy/coolify/apollo-platform.compose.yml",
);
const tfCompose = join(repositoryRoot, "deploy/coolify/apollo-tf.compose.yml");
const releaseExample = join(
  repositoryRoot,
  "deploy/coolify/release.env.example",
);
const caddyInclude = join(repositoryRoot, "deploy/caddy/apollo.caddyfile");
const registryImage =
  "docker.io/library/registry:2.8.3@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373";
const caddyImage =
  "docker.io/library/caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d";
const socatImage =
  "docker.io/alpine/socat:1.8.0.3@sha256:beb4a68d9e4fe6b0f21ea774a0fde6c31f580dde6368939ed70100c5385b015e";
const redisImage =
  "docker.io/library/redis:7-bookworm@sha256:595cc6f2bb3af6e03347b90deb6123c6aa2c81dea05ce08128de8a174b6ac67b";

const productionTargets: readonly {
  readonly dockerfile: string;
  readonly image: string;
  readonly target: string;
}[] = [
  {
    dockerfile: "artifacts/platform-api/Dockerfile",
    image: "platform-api",
    target: "runtime",
  },
  {
    dockerfile: "artifacts/platform-api/Dockerfile",
    image: "platform-postgres",
    target: "postgres-role-init",
  },
  {
    dockerfile: "artifacts/api-server/Dockerfile",
    image: "tf-api",
    target: "runner",
  },
  {
    dockerfile: "artifacts/api-server/Dockerfile",
    image: "tf-postgres",
    target: "postgres-role-init",
  },
  {
    dockerfile: "artifacts/music-player/Dockerfile",
    image: "tf-web",
    target: "runner",
  },
  {
    dockerfile: "artifacts/admin-dashboard/Dockerfile",
    image: "tf-admin",
    target: "default",
  },
  {
    dockerfile: "artifacts/tf-search/Dockerfile",
    image: "tf-search",
    target: "runner",
  },
  {
    dockerfile: "artifacts/tf-integrations/Dockerfile",
    image: "tf-integrations",
    target: "runner",
  },
  {
    dockerfile: "artifacts/tf-integrations/Dockerfile",
    image: "tf-integrations-postgres",
    target: "postgres-role-init",
  },
  {
    dockerfile: "artifacts/tf-download-worker/Dockerfile",
    image: "tf-download-worker",
    target: "runner",
  },
  {
    dockerfile: "artifacts/tf-download-worker/Dockerfile",
    image: "tf-download-redis",
    target: "queue-redis",
  },
];

const fixedNetworks = [
  "apollo-platform-bridge-v1",
  "apollo-platform-edge-v1",
  "apollo-platform-data-v1",
  "apollo-tf-data-v1",
  "apollo-tf-edge-v1",
  "apollo-tf-integrations-control-v1",
  "apollo-tf-integrations-data-v1",
  "apollo-tf-integrations-egress-v1",
  "apollo-tf-search-control-v1",
  "apollo-tf-search-egress-v1",
  "apollo-tf-download-queue-v1",
  "apollo-tf-download-control-v1",
  "apollo-tf-download-egress-v1",
] as const;
const fixedVolumes = [
  "apollo-platform-postgres-v1",
  "apollo-platform-redis-v1",
  "apollo-tf-postgres-v1",
  "apollo-tf-redis-v1",
  "apollo-tf-integrations-postgres-v1",
  "apollo-tf-download-redis-v1",
  "apollo-tf-downloads-v1",
] as const;
const platformLongRunning = [
  "platform-postgres",
  "platform-redis",
  "platform-api",
] as const;
const tfLongRunning = [
  "tf-postgres",
  "tf-redis",
  "tf-integrations-postgres",
  "tf-integrations",
  "tf-search",
  "tf-download-redis",
  "tf-download-worker",
  "tf-api",
  "tf-web",
  "tf-admin",
] as const;

type CommandResult = {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
};

type CommandOptions = {
  readonly allowNonZero?: boolean;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string;
  readonly timeoutMs?: number;
};

type CommandRunner = (
  executable: string,
  args: readonly string[],
  options?: CommandOptions,
) => Promise<CommandResult>;

type DockerCommand = (
  args: readonly string[],
  options?: Omit<CommandOptions, "env">,
) => Promise<CommandResult>;

async function command(
  executable: string,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd ?? repositoryRoot,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error, exitCode = 0) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) rejectCommand(error);
      else {
        resolveCommand({
          exitCode,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      }
    };
    const collect = (target: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024 * 1024) {
        child.kill();
        finish(new Error("local command output exceeded its bound"));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", () => finish(new Error("local command failed")));
    child.once("close", (code) => {
      const exitCode = code ?? -1;
      if (exitCode === 0 || options.allowNonZero === true) {
        finish(undefined, exitCode);
      } else {
        finish(new Error(`local command exited ${String(code)}`), exitCode);
      }
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
    const timer = setTimeout(
      () => {
        child.kill();
        finish(new Error("local command timed out"));
      },
      options.timeoutMs ?? 5 * 60_000,
    );
    timer.unref?.();
  });
}

function createDocker(
  environment: NodeJS.ProcessEnv,
  runner: CommandRunner = command,
): DockerCommand {
  return (args, options = {}) =>
    runner("docker", args, { ...options, env: environment });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function removeTaskCreatedParent(
  path: string,
  wasPresent: boolean,
): Promise<void> {
  if (!wasPresent) await rmdir(path);
}

function secret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function findSecretDisclosure(
  logs: string,
  groups: readonly {
    readonly id: string;
    readonly values: readonly string[];
  }[],
): string | undefined {
  for (const group of groups) {
    for (const [index, value] of group.values.entries()) {
      if (value.length > 0 && logs.includes(value)) {
        return `${group.id}-${index + 1}`;
      }
    }
  }
  return undefined;
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        rejectPort(new Error("loopback port allocation failed"));
        return;
      }
      server.close((error) =>
        error === undefined ? resolvePort(address.port) : rejectPort(error),
      );
    });
  });
}

async function waitFor(
  label: string,
  probe: () => Promise<boolean>,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await probe()) return;
    } catch {
      // Retry only within the explicit deadline.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`${label} deadline exceeded`);
}

function isLocalDockerEndpoint(value: string): boolean {
  const endpoint = value.trim().toLowerCase();
  return endpoint.startsWith("npipe://") || endpoint.startsWith("unix://");
}

async function assertLocalDocker(
  inherited: NodeJS.ProcessEnv = process.env,
  runner: CommandRunner = command,
): Promise<NodeJS.ProcessEnv> {
  const environment = { ...inherited };
  for (const name of [
    "BUILDKIT_HOST",
    "BUILDX_BUILDER",
    "BUILDX_CONFIG",
    "DOCKER_CONFIG",
  ]) {
    if (environment[name]?.trim()) {
      throw new Error("unsafe inherited Docker build selector");
    }
  }
  const inheritedHost = environment.DOCKER_HOST?.trim();
  if (inheritedHost && !isLocalDockerEndpoint(inheritedHost)) {
    throw new Error("production smoke requires local Docker");
  }
  delete environment.DOCKER_HOST;
  delete environment.DOCKER_CERT_PATH;
  delete environment.DOCKER_TLS_VERIFY;
  delete environment.COMPOSE_PROJECT_NAME;
  environment.COMPOSE_BAKE = "false";
  const docker = createDocker(environment, runner);
  const context = (await docker(["context", "show"])).stdout.trim();
  environment.DOCKER_CONTEXT = context;
  const endpoint = JSON.parse(
    (
      await docker([
        "context",
        "inspect",
        context,
        "--format",
        "{{json .Endpoints.docker.Host}}",
      ])
    ).stdout.trim(),
  ) as string;
  if (!isLocalDockerEndpoint(endpoint)) {
    throw new Error("production smoke requires local Docker");
  }
  return environment;
}

async function imagePresent(
  docker: DockerCommand,
  image: string,
): Promise<boolean> {
  const result = await docker(["image", "inspect", image], {
    allowNonZero: true,
  });
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw new Error("Docker image inventory returned an unexpected exit");
}

async function resourcePresent(
  docker: DockerCommand,
  kind: "network" | "volume",
  name: string,
): Promise<boolean> {
  const result = await docker([kind, "inspect", name], {
    allowNonZero: true,
  });
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw new Error("Docker resource inventory returned an unexpected exit");
}

async function removeExactRegistryReferences(
  docker: DockerCommand,
  registry: string | undefined,
): Promise<void> {
  const attempted = new Set<string>();
  while (true) {
    const inventory = await registryImageInventory(docker, registry);
    const reference = inventory
      .flatMap((image) => image.references)
      .find((candidate) => !attempted.has(candidate));
    if (reference === undefined) return;
    attempted.add(reference);
    await docker(["image", "rm", "-f", reference]);
  }
}

async function assertFixedResourcesAbsent(
  docker: DockerCommand,
): Promise<void> {
  for (const [kind, names] of [
    ["network", fixedNetworks],
    ["volume", fixedVolumes],
  ] as const) {
    for (const name of names) {
      if (await resourcePresent(docker, kind, name)) {
        throw new Error("production smoke fixed resource is already owned");
      }
    }
  }
  if (
    (
      await containerIdsForLabels(docker, [
        "com.docker.compose.project=apollo-platform",
        "com.docker.compose.project=apollo-tf",
      ])
    ).length > 0
  ) {
    throw new Error("production smoke Compose resources are already owned");
  }
}

async function writeSecretFile(
  directory: string,
  name: string,
  value: string,
): Promise<void> {
  if (value.includes("\n") || value.includes("\r")) {
    throw new Error("generated secret is not one safe line");
  }
  const path = join(directory, name);
  await writeFile(path, value, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o400);
}

async function prepareSecrets(root: string): Promise<{
  readonly adminPassword: string;
  readonly adminUser: string;
  readonly dashboardToken: string;
  readonly oauthClientSecret: string;
  readonly operatorBootstrapToken: string;
  readonly platformDirectory: string;
  readonly rawSecrets: readonly string[];
  readonly tfDirectory: string;
}> {
  const platformDirectory = join(root, "platform-secrets");
  const tfDirectory = join(root, "tf-secrets");
  await mkdir(platformDirectory);
  await mkdir(tfDirectory);
  await chmod(platformDirectory, 0o700);
  await chmod(tfDirectory, 0o700);

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateJwk = privateKey.export({ format: "jwk" });
  const publicJwk = publicKey.export({ format: "jwk" });
  const kid = `local-release-${randomBytes(8).toString("hex")}`;
  const platformAdmin = secret();
  const platformMigrator = secret();
  const platformRuntime = secret();
  const operatorBootstrapToken = secret();
  const oauthClientSecret = secret();
  const tfAdmin = secret();
  const tfMigrator = secret();
  const tfRuntime = secret();
  const integrationsAdmin = secret();
  const integrationsMigrator = secret();
  const integrationsRuntime = secret();
  const integrationKey = secret();
  const integrationsInternal = secret();
  const integrationsHeartbeat = secret();
  const searchInternal = secret();
  const searchHeartbeat = secret();
  const downloadInternal = secret();
  const downloadHeartbeat = secret();
  const queuePassword = secret();
  const dashboardToken = secret();
  const adminUser = `release-${randomBytes(6).toString("hex")}`;
  const adminPassword = secret(36);
  const spotifyClientId = secret();
  const spotifyClientSecret = secret();

  const platformFiles: Record<string, string> = {
    platform_assertion_private_jwk: JSON.stringify({
      alg: "EdDSA",
      crv: "Ed25519",
      d: privateJwk.d,
      kid,
      kty: "OKP",
      use: "sig",
      x: privateJwk.x,
    }),
    platform_assertion_public_jwks: JSON.stringify({
      keys: [
        {
          alg: "EdDSA",
          crv: "Ed25519",
          kid,
          kty: "OKP",
          use: "sig",
          x: publicJwk.x,
        },
      ],
    }),
    platform_migrator_database_url:
      `postgres://apollo_platform_migrator:${encodeURIComponent(platformMigrator)}` +
      "@platform-postgres:5432/apollo_platform",
    platform_migrator_password: platformMigrator,
    platform_oauth_clients: JSON.stringify([
      {
        audience: "apollo-tf",
        clientId: "apollo-tf-api",
        clientSecretDigest: sha256(oauthClientSecret),
        redirectUris: ["https://api.tf.apollot.ru/api/auth/callback"],
      },
    ]),
    platform_operator_bootstrap_token: operatorBootstrapToken,
    platform_postgres_admin_password: platformAdmin,
    platform_runtime_database_url:
      `postgres://apollo_platform_runtime:${encodeURIComponent(platformRuntime)}` +
      "@platform-postgres:5432/apollo_platform",
    platform_runtime_password: platformRuntime,
  };
  const queueUrl =
    `redis://default:${encodeURIComponent(queuePassword)}` +
    "@tf-download-redis:6379/0";
  const tfFiles: Record<string, string> = {
    admin_access_password: adminPassword,
    admin_access_user: adminUser,
    admin_dashboard_token: dashboardToken,
    tf_admin_database_url:
      `postgres://postgres:${encodeURIComponent(tfAdmin)}` +
      "@tf-postgres:5432/apollo_trackfinder",
    tf_client_secret: oauthClientSecret,
    tf_download_heartbeat_secret: downloadHeartbeat,
    tf_download_internal_auth_secret: downloadInternal,
    tf_download_queue_password: queuePassword,
    tf_download_queue_redis_url: queueUrl,
    tf_integrations_heartbeat_secret: integrationsHeartbeat,
    tf_integrations_internal_auth_secret: integrationsInternal,
    tf_integrations_migrator_database_url:
      `postgres://apollo_tf_integrations_migrator:${encodeURIComponent(integrationsMigrator)}` +
      "@tf-integrations-postgres:5432/apollo_tf_integrations",
    tf_integrations_migrator_password: integrationsMigrator,
    tf_integrations_postgres_admin_password: integrationsAdmin,
    tf_integrations_runtime_database_url:
      `postgres://apollo_tf_integrations_runtime:${encodeURIComponent(integrationsRuntime)}` +
      "@tf-integrations-postgres:5432/apollo_tf_integrations",
    tf_integrations_runtime_password: integrationsRuntime,
    tf_integrations_spotify_client_id: spotifyClientId,
    tf_integrations_spotify_client_secret: spotifyClientSecret,
    tf_integrations_token_keyring: JSON.stringify({
      activeKeyId: "local-release-v1",
      keys: { "local-release-v1": integrationKey },
    }),
    tf_migrator_database_url:
      `postgres://apollo_tf_migrator:${encodeURIComponent(tfMigrator)}` +
      "@tf-postgres:5432/apollo_trackfinder",
    tf_migrator_password: tfMigrator,
    tf_module_heartbeat_keys: JSON.stringify({
      "account-integrations": integrationsHeartbeat,
      "download-worker": downloadHeartbeat,
      "search-media": searchHeartbeat,
    }),
    tf_postgres_admin_password: tfAdmin,
    tf_runtime_database_url:
      `postgres://apollo_tf_runtime:${encodeURIComponent(tfRuntime)}` +
      "@tf-postgres:5432/apollo_trackfinder",
    tf_runtime_password: tfRuntime,
    tf_search_heartbeat_secret: searchHeartbeat,
    tf_search_internal_auth_secret: searchInternal,
  };
  await Promise.all(
    Object.entries(platformFiles).map(([name, value]) =>
      writeSecretFile(platformDirectory, name, value),
    ),
  );
  await Promise.all(
    Object.entries(tfFiles).map(([name, value]) =>
      writeSecretFile(tfDirectory, name, value),
    ),
  );
  return {
    adminPassword,
    adminUser,
    dashboardToken,
    oauthClientSecret,
    operatorBootstrapToken,
    platformDirectory,
    rawSecrets: [
      ...Object.values(platformFiles),
      ...Object.values(tfFiles),
      String(privateJwk.d),
      sha256(oauthClientSecret),
    ],
    tfDirectory,
  };
}

function parseEnv(source: string): Map<string, string> {
  return new Map(
    source
      .split(/\r?\n/)
      .filter((line) => line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

async function writeReleaseEnvironment(
  path: string,
  registry: string,
  digests: Readonly<Record<string, string>>,
  sourceCommit: string,
  secrets: Awaited<ReturnType<typeof prepareSecrets>>,
): Promise<void> {
  const values = parseEnv(await readFile(releaseExample, "utf8"));
  values.set(
    "PLATFORM_SECRET_DIRECTORY",
    secrets.platformDirectory.replaceAll("\\", "/"),
  );
  values.set("TF_SECRET_DIRECTORY", secrets.tfDirectory.replaceAll("\\", "/"));
  for (const name of [
    "PLATFORM_API_VERSION",
    "TF_API_VERSION",
    "TF_SEARCH_VERSION",
    "TF_INTEGRATIONS_VERSION",
    "TF_DOWNLOAD_VERSION",
  ]) {
    values.set(name, `local-${sourceCommit.slice(0, 12)}`);
  }
  const imageVariables: Readonly<Record<string, string>> = {
    PLATFORM_API_IMAGE: "platform-api",
    PLATFORM_POSTGRES_IMAGE: "platform-postgres",
    PLATFORM_REDIS_IMAGE: "redis",
    TF_ADMIN_IMAGE: "tf-admin",
    TF_API_IMAGE: "tf-api",
    TF_DOWNLOAD_REDIS_IMAGE: "tf-download-redis",
    TF_DOWNLOAD_WORKER_IMAGE: "tf-download-worker",
    TF_INTEGRATIONS_IMAGE: "tf-integrations",
    TF_INTEGRATIONS_POSTGRES_IMAGE: "tf-integrations-postgres",
    TF_POSTGRES_IMAGE: "tf-postgres",
    TF_REDIS_IMAGE: "redis",
    TF_SEARCH_IMAGE: "tf-search",
    TF_WEB_IMAGE: "tf-web",
  };
  for (const [variable, image] of Object.entries(imageVariables)) {
    values.set(variable, `${registry}/${image}@${digests[image]}`);
  }
  await writeFile(
    path,
    [...values].map(([name, value]) => `${name}=${value}`).join("\n") + "\n",
    { encoding: "utf8", mode: 0o600 },
  );
}

function compose(
  docker: DockerCommand,
  file: string,
  envFile: string,
  project: string,
  args: readonly string[],
): Promise<CommandResult> {
  return docker(
    ["compose", "--env-file", envFile, "-f", file, "-p", project, ...args],
    { timeoutMs: 10 * 60_000 },
  );
}

type CookieJar = Map<string, string>;

function ingestCookies(response: Response, jar: CookieJar): void {
  for (const value of response.headers.getSetCookie()) {
    const [pair] = value.split(";", 1);
    const separator = pair.indexOf("=");
    jar.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
}

function cookieHeader(jar: CookieJar): string {
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function jsonRequest(
  url: string,
  options: RequestInit & {
    readonly expected: number | readonly number[];
    readonly jar?: CookieJar;
  },
): Promise<{ readonly body: any; readonly response: Response }> {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.jar?.size ? { cookie: cookieHeader(options.jar) } : {}),
      ...options.headers,
    },
    redirect: "manual",
  });
  if (options.jar !== undefined) ingestCookies(response, options.jar);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text.length === 0 ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  const expectedStatus = Array.isArray(options.expected)
    ? options.expected.includes(response.status)
    : response.status === options.expected;
  if (!expectedStatus) {
    const errorCode =
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "string" &&
      /^[a-z_]+$/.test(body.error)
        ? ` (${body.error})`
        : "";
    throw new Error(
      `application flow returned ${response.status}${errorCode} for ${
        new URL(url).pathname
      }`,
    );
  }
  return { body, response };
}

async function exercisePlatform(
  secrets: Awaited<ReturnType<typeof prepareSecrets>>,
): Promise<{
  readonly accountId: string;
  readonly grantSearch: () => Promise<void>;
  readonly portalCookies: CookieJar;
  readonly rawSecrets: string[];
}> {
  const origin = "http://127.0.0.1:18200";
  const publicOrigin = "https://admin.apollot.ru";
  const operatorCookies: CookieJar = new Map();
  const registration = await jsonRequest(`${origin}/v1/registration`, {
    expected: 200,
  });
  expect(registration.body).toEqual({ mode: "closed" });

  const operatorEmail = `operator-${randomUUID()}@example.test`;
  const operatorPassword = secret();
  let login: Awaited<ReturnType<typeof jsonRequest>> | undefined;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await jsonRequest(`${origin}/v1/operator/bootstrap`, {
      body: JSON.stringify({
        bootstrapToken: secrets.operatorBootstrapToken,
        displayName: "Local Release Operator",
        email: operatorEmail,
        password: operatorPassword,
        reason: "Task 5 local production package",
      }),
      expected: [201, 409, 503],
      headers: { "content-type": "application/json", origin: publicOrigin },
      method: "POST",
    });
    const candidate = await jsonRequest(`${origin}/v1/operator/sessions`, {
      body: JSON.stringify({
        email: operatorEmail,
        password: operatorPassword,
      }),
      expected: [200, 401, 503],
      headers: { "content-type": "application/json", origin: publicOrigin },
      jar: operatorCookies,
      method: "POST",
    });
    if (candidate.response.status === 200) {
      login = candidate;
      break;
    }
    await new Promise((resolveRetry) =>
      setTimeout(resolveRetry, attempt * 500),
    );
  }
  if (login === undefined) {
    throw new Error("operator bootstrap did not converge");
  }
  const csrf = String(login.body.csrfToken);
  const portalCookies: CookieJar = new Map();
  const portalLogin = await jsonRequest(`${origin}/v1/sessions`, {
    body: JSON.stringify({
      email: operatorEmail,
      password: operatorPassword,
    }),
    expected: 200,
    headers: {
      "content-type": "application/json",
      origin: "https://apollot.ru",
    },
    jar: portalCookies,
    method: "POST",
  });
  const operatorAccountId = String(portalLogin.body.accountId);
  const mutateEntitlement = async (
    accountId: string,
    moduleKey: "tf.downloads" | "tf.search",
    method: "DELETE" | "PUT",
    reason: string,
  ): Promise<void> => {
    await jsonRequest(
      `${origin}/v1/operator/accounts/${accountId}/entitlements/${moduleKey}`,
      {
        body: JSON.stringify({ reason }),
        expected: 200,
        headers: {
          "content-type": "application/json",
          origin: publicOrigin,
          "x-csrf-token": csrf,
        },
        jar: operatorCookies,
        method,
      },
    );
  };
  await jsonRequest(`${origin}/v1/operator/registration-settings`, {
    body: JSON.stringify({
      mode: "invite_only",
      reason: "Task 5 local invitation proof",
    }),
    expected: 200,
    headers: {
      "content-type": "application/json",
      origin: publicOrigin,
      "x-csrf-token": csrf,
    },
    jar: operatorCookies,
    method: "PATCH",
  });
  const memberEmail = `member-${randomUUID()}@example.test`;
  const memberPassword = secret();
  const invitation = await jsonRequest(`${origin}/v1/operator/invitations`, {
    body: JSON.stringify({
      email: memberEmail,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      moduleKeys: ["tf.downloads", "tf.search"],
      reason: "Task 5 local invitation",
      usesLimit: 1,
    }),
    expected: 201,
    headers: {
      "content-type": "application/json",
      origin: publicOrigin,
      "x-csrf-token": csrf,
    },
    jar: operatorCookies,
    method: "POST",
  });
  const member = await jsonRequest(`${origin}/v1/registrations`, {
    body: JSON.stringify({
      displayName: "Local Release Member",
      email: memberEmail,
      invitationToken: invitation.body.invitationToken,
      password: memberPassword,
    }),
    expected: 202,
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const accountId = String(member.body.account.id);
  await mutateEntitlement(
    accountId,
    "tf.search",
    "DELETE",
    "Task 5 invitation denial proof",
  );
  await mutateEntitlement(
    accountId,
    "tf.search",
    "PUT",
    "Task 5 invitation grant proof",
  );
  await mutateEntitlement(
    operatorAccountId,
    "tf.downloads",
    "PUT",
    "Task 5 TF download proof",
  );
  await mutateEntitlement(
    operatorAccountId,
    "tf.search",
    "PUT",
    "Task 5 TF denial setup",
  );
  await mutateEntitlement(
    operatorAccountId,
    "tf.search",
    "DELETE",
    "Task 5 TF denial proof",
  );
  return {
    accountId: operatorAccountId,
    portalCookies,
    rawSecrets: [
      operatorPassword,
      memberPassword,
      String(invitation.body.invitationToken),
      ...operatorCookies.values(),
      ...portalCookies.values(),
    ],
    grantSearch: async () => {
      await mutateEntitlement(
        operatorAccountId,
        "tf.search",
        "PUT",
        "Task 5 TF grant proof",
      );
    },
  };
}

function localBridgeUrl(
  value: string | null,
  publicOrigin: string,
  localOrigin: string,
  rawSecrets: string[],
): string {
  if (value === null) throw new Error("authorization redirect missing");
  const url = new URL(value);
  if (url.origin !== publicOrigin || url.username || url.password || url.hash) {
    throw new Error("authorization redirect escaped its registered origin");
  }
  for (const name of ["code", "nonce", "state"]) {
    const secretValue = url.searchParams.get(name);
    if (secretValue !== null) rawSecrets.push(secretValue);
  }
  return `${localOrigin}${url.pathname}${url.search}`;
}

async function bridgeTfSession(
  platform: Awaited<ReturnType<typeof exercisePlatform>>,
  sessionCookies: CookieJar = new Map(),
): Promise<CookieJar> {
  sessionCookies.delete("__Host-apollo_tf");
  sessionCookies.delete("__Host-apollo_tf_csrf");
  const start = await jsonRequest("http://127.0.0.1:18201/api/auth/start", {
    expected: 303,
    jar: sessionCookies,
  });
  platform.rawSecrets.push(...sessionCookies.values());
  const authorize = await jsonRequest(
    localBridgeUrl(
      start.response.headers.get("location"),
      "https://api.apollot.ru",
      "http://127.0.0.1:18200",
      platform.rawSecrets,
    ),
    {
      expected: 303,
      jar: platform.portalCookies,
    },
  );
  const callback = await jsonRequest(
    localBridgeUrl(
      authorize.response.headers.get("location"),
      "https://api.tf.apollot.ru",
      "http://127.0.0.1:18201",
      platform.rawSecrets,
    ),
    {
      expected: 303,
      jar: sessionCookies,
    },
  );
  if (callback.response.headers.get("location") !== "https://tf.apollot.ru") {
    throw new Error("TF callback returned an unexpected public redirect");
  }
  if (
    !sessionCookies.has("__Host-apollo_tf") ||
    !sessionCookies.has("__Host-apollo_tf_csrf")
  ) {
    throw new Error("TF callback did not issue the secure session cookies");
  }
  platform.rawSecrets.push(...sessionCookies.values());
  return sessionCookies;
}

function tfHeaders(session: CookieJar) {
  const csrf = session.get("__Host-apollo_tf_csrf");
  if (csrf === undefined) throw new Error("TF CSRF cookie missing");
  return {
    "content-type": "application/json",
    origin: "https://tf.apollot.ru",
    "x-csrf-token": csrf,
  };
}

async function exerciseTf(
  docker: DockerCommand,
  envFile: string,
  dashboardToken: string,
  platform: Awaited<ReturnType<typeof exercisePlatform>>,
): Promise<{
  readonly jobId: string;
  readonly session: CookieJar;
}> {
  const origin = "http://127.0.0.1:18201";
  let session = await bridgeTfSession(platform);
  const denied = await jsonRequest(`${origin}/api/tracks/search`, {
    body: JSON.stringify({
      artist: "Local Release",
      maxResults: 5,
      mode: "auto",
      sources: ["yt"],
      title: "Denied",
    }),
    expected: 403,
    headers: tfHeaders(session),
    jar: session,
    method: "POST",
  });
  expect(denied.body).toEqual({ error: "module_access_denied" });
  await platform.grantSearch();
  session = await bridgeTfSession(platform, session);
  await compose(docker, tfCompose, envFile, "apollo-tf", ["stop", "tf-search"]);
  const degraded = await jsonRequest(`${origin}/api/tracks/search`, {
    body: JSON.stringify({
      artist: "Local Release",
      maxResults: 5,
      mode: "auto",
      sources: ["yt"],
      title: "Degraded",
    }),
    expected: 503,
    headers: tfHeaders(session),
    jar: session,
    method: "POST",
  });
  expect(degraded.body).toEqual({ error: "search_unavailable" });
  await compose(docker, tfCompose, envFile, "apollo-tf", [
    "up",
    "-d",
    "--no-deps",
    "tf-search",
  ]);
  await waitFor("restored granted search readiness", async () => {
    const state = await docker(
      [
        "inspect",
        "apollo-tf-tf-search-1",
        "--format",
        "{{json .State.Health.Status}}",
      ],
      { allowNonZero: true },
    );
    return state.exitCode === 0 && JSON.parse(state.stdout) === "healthy";
  });
  const moduleStatuses = async () => {
    const dashboard = await jsonRequest(`${origin}/api/admin/dashboard`, {
      expected: 200,
      headers: { "x-admin-dashboard-token": dashboardToken },
    });
    return new Map<string, string>(
      (dashboard.body.modules as any[]).map((module) => [
        String(module.id),
        String(module.status),
      ]),
    );
  };
  await waitFor("signed module heartbeats", async () => {
    const modules = await moduleStatuses();
    return ["search-media", "account-integrations", "download-worker"].every(
      (name) => modules.get(name) === "healthy",
    );
  });
  const restored = await jsonRequest(`${origin}/api/tracks/search`, {
    body: JSON.stringify({
      artist: "Local Release",
      maxResults: 5,
      mode: "manual",
      sources: ["yt"],
      title: "Restored",
    }),
    expected: 200,
    headers: tfHeaders(session),
    jar: session,
    method: "POST",
  });
  expect(restored.body).toMatchObject({
    query: "Local Release Restored",
    sources: ["yt"],
  });
  expect(Array.isArray(restored.body.results)).toBe(true);
  const heartbeatStaleDeadlineMs = 90_000;
  const heartbeatStoppedAt = Date.now();
  await compose(docker, tfCompose, envFile, "apollo-tf", [
    "stop",
    "tf-integrations",
  ]);
  await waitFor(
    "account integrations heartbeat stale",
    async () => {
      const modules = await moduleStatuses();
      return (
        Date.now() - heartbeatStoppedAt > heartbeatStaleDeadlineMs &&
        modules.get("account-integrations") === "unknown"
      );
    },
    heartbeatStaleDeadlineMs + 30_000,
  );
  await compose(docker, tfCompose, envFile, "apollo-tf", [
    "up",
    "-d",
    "--no-deps",
    "tf-integrations",
  ]);
  await waitFor("account integrations heartbeat recovery", async () => {
    const modules = await moduleStatuses();
    return modules.get("account-integrations") === "healthy";
  });
  const trackUrl =
    "https://www.youtube.com/watch?v=apollo_local_release_cancel";
  const queued = await jsonRequest(`${origin}/api/tracks/download/queue`, {
    body: JSON.stringify({
      tracks: [
        {
          artist: "Local Release",
          quality: "320",
          title: "Cancel",
          trackId: `yt_${Buffer.from(trackUrl).toString("base64url")}`,
        },
      ],
    }),
    expected: 200,
    headers: tfHeaders(session),
    jar: session,
    method: "POST",
  });
  const jobId = String(queued.body.results[0].jobId);
  await jsonRequest(`${origin}/api/tracks/download/jobs/${jobId}`, {
    expected: 200,
    headers: tfHeaders(session),
    jar: session,
    method: "DELETE",
  });
  return { jobId, session };
}

async function proveAdmin(
  docker: DockerCommand,
  image: string,
  _secrets: Awaited<ReturnType<typeof prepareSecrets>>,
  root: string,
  runId: string,
): Promise<void> {
  const malformed = join(root, `malformed-admin-${runId}`);
  await mkdir(malformed);
  const canary = secret();
  const dashboardCanary = secret();
  await writeFile(join(malformed, "admin_access_user"), "valid-user");
  await writeFile(
    join(malformed, "admin_access_password"),
    `${canary}\nsecond-line`,
  );
  await writeFile(join(malformed, "admin_dashboard_token"), dashboardCanary);
  const name = `apollo-release-malformed-${runId}`;
  let proofError: unknown;
  try {
    const result = await docker(
      [
        "run",
        "--name",
        name,
        "--label",
        `apollo.local-release.run=${runId}`,
        "--network",
        "none",
        "--mount",
        `type=bind,source=${join(malformed, "admin_access_user")},target=/run/secrets/admin_access_user,readonly`,
        "--mount",
        `type=bind,source=${join(malformed, "admin_access_password")},target=/run/secrets/admin_access_password,readonly`,
        "--mount",
        `type=bind,source=${join(malformed, "admin_dashboard_token")},target=/run/secrets/admin_dashboard_token,readonly`,
        image,
      ],
      { allowNonZero: true },
    );
    if (result.exitCode === 0) {
      throw new Error("malformed admin container unexpectedly exited 0");
    }
    if (result.exitCode !== 1) {
      throw new Error("malformed admin container returned an unexpected exit");
    }
    const state = JSON.parse(
      (await docker(["inspect", name, "--format", "{{json .State}}"])).stdout,
    ) as {
      readonly ExitCode?: number;
      readonly Running?: boolean;
      readonly Status?: string;
    };
    if (
      state.ExitCode !== 1 ||
      state.Running !== false ||
      state.Status !== "exited"
    ) {
      throw new Error("malformed admin container state was unexpected");
    }
    const logs = await docker(["logs", name]);
    const disclosure = findSecretDisclosure(
      [result.stdout, result.stderr, logs.stdout, logs.stderr].join("\n"),
      [
        { id: "malformed-password", values: [canary] },
        { id: "malformed-dashboard", values: [dashboardCanary] },
      ],
    );
    if (disclosure !== undefined) {
      throw new Error(`malformed admin output disclosed [${disclosure}]`);
    }
  } catch (error) {
    proofError = error;
  }
  let cleanupError: unknown;
  try {
    await docker(["rm", "-f", name]);
  } catch (error) {
    cleanupError = error;
  }
  if (proofError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [proofError, cleanupError],
      "malformed admin proof and cleanup failed",
    );
  }
  if (proofError !== undefined) throw proofError;
  if (cleanupError !== undefined) throw cleanupError;
}

async function proveLiveAdmin(
  docker: DockerCommand,
  secrets: Awaited<ReturnType<typeof prepareSecrets>>,
): Promise<void> {
  await jsonRequest("http://127.0.0.1:18203/", { expected: 401 });
  const authorization = `Basic ${Buffer.from(
    `${secrets.adminUser}:${secrets.adminPassword}`,
  ).toString("base64")}`;
  await jsonRequest("http://127.0.0.1:18203/", {
    expected: 200,
    headers: { authorization },
  });
  await jsonRequest("http://127.0.0.1:18203/api/admin/dashboard", {
    expected: 200,
    headers: { authorization },
  });
  const stat = await docker([
    "exec",
    "apollo-tf-tf-admin-1",
    "stat",
    "-c",
    "%U:%G:%a",
    "/etc/nginx/.htpasswd",
  ]);
  expect(stat.stdout.trim()).toBe("root:nginx:640");
}

async function proveCaddyRoutes(
  docker: DockerCommand,
  root: string,
  runId: string,
  secrets: Awaited<ReturnType<typeof prepareSecrets>>,
): Promise<void> {
  const caddyCommand = async (
    label: string,
    args: readonly string[],
    options: Parameters<DockerCommand>[1] = {},
  ): Promise<CommandResult> => {
    try {
      return await docker(args, options);
    } catch {
      throw new Error(`Caddy ${label} failed`);
    }
  };
  const forwarder = `apollo-release-forwarder-${runId}`;
  const caddy = `apollo-release-caddy-${runId}`;
  const forwards = [
    [18200, "platform-api", 8080],
    [18201, "tf-api", 8080],
    [18202, "tf-web", 80],
    [18203, "tf-admin", 80],
  ]
    .map(
      ([listenPort, host, targetPort]) =>
        `socat TCP-LISTEN:${listenPort},bind=127.0.0.1,fork,reuseaddr TCP:${host}:${targetPort}`,
    )
    .join(" & ");
  await caddyCommand("forwarder start", [
    "run",
    "-d",
    "--name",
    forwarder,
    "--label",
    `apollo.local-release.run=${runId}`,
    "--add-host",
    "api.apollot.ru:127.0.0.1",
    "--add-host",
    "api.tf.apollot.ru:127.0.0.1",
    "--add-host",
    "tf.apollot.ru:127.0.0.1",
    "--add-host",
    "admin.apollot.ru:127.0.0.1",
    "--network",
    "apollo-platform-bridge-v1",
    "--entrypoint",
    "sh",
    socatImage,
    "-eu",
    "-c",
    `${forwards} & wait`,
  ]);
  await caddyCommand("forwarder network connect", [
    "network",
    "connect",
    "apollo-tf-edge-v1",
    forwarder,
  ]);
  const passwordHash = (
    await caddyCommand(
      "password hash",
      [
        "run",
        "--name",
        `apollo-release-caddy-hash-${runId}`,
        "--label",
        `apollo.local-release.run=${runId}`,
        "--network",
        "none",
        "--read-only",
        "-i",
        caddyImage,
        "caddy",
        "hash-password",
      ],
      { input: `${secrets.adminPassword}\n` },
    )
  ).stdout.trim();
  const wrapper = join(root, "Caddyfile");
  const caddyEnv = join(root, "caddy.env");
  await writeFile(
    wrapper,
    "{\n\tadmin off\n\tlocal_certs\n}\n\nimport /etc/caddy/apollo.caddyfile\n",
  );
  await writeFile(
    caddyEnv,
    `APOLLO_ADMIN_CADDY_USER=${secrets.adminUser}\n` +
      `APOLLO_ADMIN_CADDY_PASSWORD_HASH=${passwordHash}\n`,
  );
  await caddyCommand("start", [
    "run",
    "-d",
    "--name",
    caddy,
    "--label",
    `apollo.local-release.run=${runId}`,
    "--network",
    `container:${forwarder}`,
    "--read-only",
    "--env-file",
    caddyEnv,
    "--mount",
    `type=bind,source=${wrapper},target=/etc/caddy/Caddyfile,readonly`,
    "--mount",
    `type=bind,source=${caddyInclude},target=/etc/caddy/apollo.caddyfile,readonly`,
    "--tmpfs",
    "/config:rw,noexec,nosuid,size=16m",
    "--tmpfs",
    "/data:rw,noexec,nosuid,size=16m",
    caddyImage,
  ]);
  const probes = [
    ["api.apollot.ru", "/healthz", "ok"],
    ["api.tf.apollot.ru", "/api/healthz", "ok"],
    ["tf.apollot.ru", "/healthz", "ok"],
  ] as const;
  for (const [host, path, expectedBody] of probes) {
    await waitFor(`Caddy route ${host}`, async () => {
      const result = await docker([
        "exec",
        forwarder,
        "wget",
        "--no-check-certificate",
        "-qO-",
        `https://${host}${path}`,
      ]);
      return result.stdout.includes(expectedBody);
    });
  }
  const authorization = `Basic ${Buffer.from(
    `${secrets.adminUser}:${secrets.adminPassword}`,
  ).toString("base64")}`;
  const adminProbe =
    "IFS= read -r auth; exec wget --no-check-certificate " +
    '--header "Authorization: $auth" -qO- ' +
    "https://admin.apollot.ru/healthz";
  const admin = await caddyCommand(
    "admin route",
    ["exec", "-i", forwarder, "sh", "-eu", "-c", adminProbe],
    {
      input: `${authorization}\n`,
    },
  );
  expect(admin.stdout).toContain("ok");
}

async function proveProfiledEntrypoints(
  docker: DockerCommand,
  root: string,
  runId: string,
  registry: string,
  digests: Readonly<Record<string, string>>,
  sourceCommit: string,
): Promise<readonly string[]> {
  const profileRoot = join(root, "profiled-entrypoints");
  await mkdir(profileRoot);
  const profileSecrets = await prepareSecrets(profileRoot);
  const profileEnv = join(profileRoot, "release.env");
  await writeReleaseEnvironment(
    profileEnv,
    registry,
    digests,
    sourceCommit,
    profileSecrets,
  );
  const network = `apollo-release-profile-net-${runId}`;
  const volume = `apollo-release-profile-data-${runId}`;
  const database = `apollo-release-profile-db-${runId}`;
  const roleJob = `apollo-release-profile-role-${runId}`;
  const baselineJob = `apollo-release-profile-baseline-${runId}`;
  const project = `apollo-tf-profile-${runId}`;
  const override = join(profileRoot, "compose.override.yml");
  await writeFile(
    override,
    `networks:\n  tf-data:\n    external: true\n    name: ${network}\n`,
  );

  await docker([
    "network",
    "create",
    "--label",
    `apollo.local-release.run=${runId}`,
    network,
  ]);
  await docker([
    "volume",
    "create",
    "--label",
    `apollo.local-release.run=${runId}`,
    volume,
  ]);
  await docker([
    "run",
    "-d",
    "--name",
    database,
    "--label",
    `apollo.local-release.run=${runId}`,
    "--network",
    network,
    "--network-alias",
    "tf-postgres",
    "--mount",
    `type=volume,source=${volume},target=/var/lib/postgresql/data`,
    "--mount",
    `type=bind,source=${join(profileSecrets.tfDirectory, "tf_postgres_admin_password")},target=/run/secrets/tf_postgres_admin_password,readonly`,
    "--mount",
    `type=bind,source=${join(profileSecrets.tfDirectory, "tf_migrator_password")},target=/run/secrets/tf_migrator_password,readonly`,
    "--mount",
    `type=bind,source=${join(profileSecrets.tfDirectory, "tf_runtime_password")},target=/run/secrets/tf_runtime_password,readonly`,
    "--env",
    "POSTGRES_DB=apollo_trackfinder",
    "--env",
    "POSTGRES_USER=postgres",
    "--env",
    "POSTGRES_PASSWORD_FILE=/run/secrets/tf_postgres_admin_password",
    `${registry}/tf-postgres@${digests["tf-postgres"]}`,
  ]);
  await waitFor("profile PostgreSQL readiness", async () => {
    const ready = await docker(
      [
        "exec",
        database,
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-U",
        "postgres",
        "-d",
        "apollo_trackfinder",
      ],
      { allowNonZero: true },
    );
    return ready.exitCode === 0;
  });

  const composeRun = async (
    service: "tf-baseline" | "tf-role-bootstrap",
    name: string,
  ) =>
    docker(
      [
        "compose",
        "--profile",
        "baseline",
        "--env-file",
        profileEnv,
        "-f",
        tfCompose,
        "-f",
        override,
        "-p",
        project,
        "run",
        "--name",
        name,
        "--label",
        `apollo.local-release.run=${runId}`,
        "--no-deps",
        service,
      ],
      { allowNonZero: true, timeoutMs: 5 * 60_000 },
    );
  const assertExitedZero = async (name: string) => {
    const state = JSON.parse(
      (await docker(["inspect", name, "--format", "{{json .State}}"])).stdout,
    ) as {
      readonly ExitCode?: number;
      readonly Running?: boolean;
      readonly Status?: string;
    };
    expect(state).toMatchObject({
      ExitCode: 0,
      Running: false,
      Status: "exited",
    });
    return docker(["logs", name]);
  };

  const roleResult = await composeRun("tf-role-bootstrap", roleJob);
  if (roleResult.exitCode !== 0) {
    throw new Error("tf-role-bootstrap Compose contract failed");
  }
  const roleLogs = await assertExitedZero(roleJob);
  expect(roleLogs.stdout).toBe("");
  expect(roleLogs.stderr).toBe("");

  const startupSchema = await readFile(
    join(repositoryRoot, "lib/db/migrations/0001_tf_core_collections.sql"),
    "utf8",
  );
  const seedResult = await docker(
    [
      "exec",
      "-i",
      database,
      "psql",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      "apollo_trackfinder",
    ],
    { input: startupSchema },
  );
  expect(seedResult.stderr).toBe("");

  const baselineResult = await composeRun("tf-baseline", baselineJob);
  if (baselineResult.exitCode !== 0) {
    throw new Error("tf-baseline Compose contract failed");
  }
  const baselineLogs = await assertExitedZero(baselineJob);
  expect(baselineLogs.stderr).toBe("");
  expect(
    baselineLogs.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line)),
  ).toEqual([
    {
      alreadyApplied: 0,
      applied: 2,
      event: "tf_migrations_complete",
    },
  ]);

  const migrationState = await docker([
    "exec",
    database,
    "psql",
    "-X",
    "-At",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "postgres",
    "-d",
    "apollo_trackfinder",
    "-c",
    "select string_agg(name, ',' order by name) from apollo_tf.schema_migrations",
  ]);
  expect(migrationState.stdout.trim()).toBe(
    "0001_tf_core_collections.sql,0002_tf_runtime_privileges.sql",
  );
  const ownershipState = await docker([
    "exec",
    database,
    "psql",
    "-X",
    "-At",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "postgres",
    "-d",
    "apollo_trackfinder",
    "-c",
    "select count(*) from pg_tables where schemaname = 'public' and tableowner = 'apollo_tf_migrator' and tablename = any(array['track_search_cache','play_history','liked_tracks','playlists','playlist_tracks'])",
  ]);
  expect(ownershipState.stdout.trim()).toBe("5");

  const disclosure = findSecretDisclosure(
    [
      roleResult.stdout,
      roleResult.stderr,
      roleLogs.stdout,
      roleLogs.stderr,
      baselineResult.stdout,
      baselineResult.stderr,
      baselineLogs.stdout,
      baselineLogs.stderr,
    ].join("\n"),
    [{ id: "profile", values: profileSecrets.rawSecrets }],
  );
  if (disclosure !== undefined) {
    throw new Error(`profiled one-shot output disclosed [${disclosure}]`);
  }
  return profileSecrets.rawSecrets;
}

async function containerIdsForLabels(
  docker: DockerCommand,
  labels: readonly string[],
): Promise<readonly string[]> {
  const ids = new Set<string>();
  for (const label of labels) {
    const result = await docker(["ps", "-aq", "--filter", `label=${label}`]);
    for (const id of result.stdout.split(/\r?\n/).filter(Boolean)) {
      ids.add(id);
    }
  }
  return [...ids];
}

async function resourceIdsForRunLabel(
  docker: DockerCommand,
  kind: "network" | "volume",
  runId: string,
): Promise<readonly string[]> {
  return (
    await docker([
      kind,
      "ls",
      "-q",
      "--filter",
      `label=apollo.local-release.run=${runId}`,
    ])
  ).stdout
    .split(/\r?\n/)
    .filter(Boolean);
}

async function registryImageInventory(
  docker: DockerCommand,
  registry: string | undefined,
): Promise<
  readonly {
    readonly id: string;
    readonly references: readonly string[];
  }[]
> {
  if (registry === undefined) return [];
  const ids = [
    ...new Set(
      (await docker(["image", "ls", "-aq", "--no-trunc"])).stdout
        .split(/\r?\n/)
        .filter(Boolean),
    ),
  ];
  const inventory: { id: string; references: string[] }[] = [];
  for (const id of ids) {
    const inspected = await docker([
      "image",
      "inspect",
      id,
      "--format",
      "{{json .RepoTags}}\n{{json .RepoDigests}}",
    ]);
    const [rawTags = "null", rawDigests = "null"] = inspected.stdout
      .trim()
      .split(/\r?\n/, 2);
    const references = [
      ...((JSON.parse(rawTags) as string[] | null) ?? []),
      ...((JSON.parse(rawDigests) as string[] | null) ?? []),
    ].filter((reference) => reference.startsWith(`${registry}/`));
    if (references.length > 0) {
      inventory.push({ id, references });
    }
  }
  return inventory;
}

async function cleanupAudit(
  docker: DockerCommand,
  runId: string,
  registry: string | undefined,
  root: string | undefined,
): Promise<{
  readonly containers: number;
  readonly imageReferences: number;
  readonly networks: number;
  readonly registryFiles: number;
  readonly temporarySecrets: number;
  readonly volumes: number;
}> {
  const containers = (
    await containerIdsForLabels(docker, [
      `apollo.local-release.run=${runId}`,
      "com.docker.compose.project=apollo-platform",
      "com.docker.compose.project=apollo-tf",
    ])
  ).length;
  let networks = 0;
  for (const name of fixedNetworks) {
    if (await resourcePresent(docker, "network", name)) {
      networks += 1;
    }
  }
  networks += (await resourceIdsForRunLabel(docker, "network", runId)).length;
  let volumes = 0;
  for (const name of fixedVolumes) {
    if (await resourcePresent(docker, "volume", name)) {
      volumes += 1;
    }
  }
  volumes += (await resourceIdsForRunLabel(docker, "volume", runId)).length;
  const imageReferences = (
    await registryImageInventory(docker, registry)
  ).reduce((total, image) => total + image.references.length, 0);
  return {
    containers,
    imageReferences,
    networks,
    registryFiles:
      root !== undefined && (await pathExists(join(root, "registry")))
        ? (await readdir(join(root, "registry"))).length
        : 0,
    temporarySecrets: root !== undefined && (await pathExists(root)) ? 1 : 0,
    volumes,
  };
}

async function runWithVerifiedCleanup<T, A>(options: {
  readonly audit: () => Promise<A>;
  readonly cleanup: () => Promise<void>;
  readonly isClean: (audit: A) => boolean;
  readonly run: () => Promise<T>;
  readonly stage: () => string;
}): Promise<{ readonly audit: A; readonly value: T }> {
  const errors: unknown[] = [];
  let audit!: A;
  let value!: T;
  try {
    value = await options.run();
  } catch (error) {
    errors.push(error);
  } finally {
    try {
      await options.cleanup();
    } catch (error) {
      errors.push(error);
    }
    try {
      audit = await options.audit();
      if (!options.isClean(audit)) {
        errors.push(new Error("production smoke cleanup audit was nonzero"));
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `production smoke failed at ${options.stage()}`,
    );
  }
  return { audit, value };
}

async function runCoolifyProductionSmoke(): Promise<unknown> {
  let stage = "local-docker";
  const environment = await assertLocalDocker();
  const docker = createDocker(environment);
  stage = "clean-source";
  const status = (await command("git", ["status", "--porcelain"])).stdout;
  if (status.trim().length > 0) {
    throw new Error("exact-commit smoke requires a clean worktree");
  }
  const sourceCommit = (
    await command("git", ["rev-parse", "HEAD"])
  ).stdout.trim();
  stage = "fixed-resource-preflight";
  await assertFixedResourcesAbsent(docker);

  const runId = randomBytes(6).toString("hex");
  const temporaryParent = join(repositoryRoot, ".tmp");
  const registryContainer = `apollo-release-registry-${runId}`;
  const acquiredImages = new Map<string, boolean>();
  const localReferences: string[] = [];
  const digests: Record<string, string> = {};
  let root: string | undefined;
  let source: string | undefined;
  let registryData: string | undefined;
  let envFile: string | undefined;
  let registry: string | undefined;
  let temporaryParentWasPresent = true;
  let secrets: Awaited<ReturnType<typeof prepareSecrets>> | undefined;
  const { audit: cleanup } = await runWithVerifiedCleanup({
    run: async () => {
      stage = "resource-acquisition";
      temporaryParentWasPresent = await pathExists(temporaryParent);
      await mkdir(temporaryParent, { recursive: true });
      root = await mkdtemp(
        join(temporaryParent, `coolify-production-${runId}-`),
      );
      source = join(root, "source");
      registryData = join(root, "registry");
      envFile = join(root, "release.env");
      const registryPort = await freePort();
      registry = `localhost:${registryPort}`;

      stage = "image-inventory";
      for (const image of [registryImage, caddyImage, socatImage, redisImage]) {
        acquiredImages.set(image, await imagePresent(docker, image));
      }
      await mkdir(source);
      await mkdir(registryData);
      stage = "source-archive";
      const archive = join(root, "source.tar");
      await command("git", [
        "archive",
        "--format=tar",
        "--output",
        archive,
        sourceCommit,
      ]);
      await command("tar", ["-xf", archive, "-C", source]);
      await rm(archive, { force: true });
      stage = "secret-preparation";
      secrets = await prepareSecrets(root);

      stage = "registry-start";
      await docker([
        "run",
        "-d",
        "--name",
        registryContainer,
        "--label",
        `apollo.local-release.run=${runId}`,
        "-p",
        `127.0.0.1:${registryPort}:5000`,
        "--mount",
        `type=bind,source=${registryData},target=/var/lib/registry`,
        registryImage,
      ]);
      await waitFor("local registry", async () => {
        const response = await fetch(`http://${registry}/v2/`);
        return response.ok;
      });

      for (const target of productionTargets) {
        stage = `build-${target.image}`;
        const reference = `${registry}/${target.image}:${sourceCommit}`;
        await docker(
          [
            "buildx",
            "build",
            "--file",
            join(source, target.dockerfile),
            "--target",
            target.target,
            "--platform",
            "linux/amd64",
            "--label",
            `org.opencontainers.image.revision=${sourceCommit}`,
            "--tag",
            reference,
            "--push",
            source,
          ],
          { timeoutMs: 20 * 60_000 },
        );
        localReferences.push(reference);
        stage = `digest-${target.image}`;
        const digest = (
          await docker([
            "buildx",
            "imagetools",
            "inspect",
            reference,
            "--format",
            "{{json .Manifest.Digest}}",
          ])
        ).stdout
          .replaceAll('"', "")
          .trim();
        if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
          throw new Error("local registry returned a malformed digest");
        }
        digests[target.image] = digest;
        localReferences.push(`${registry}/${target.image}@${digest}`);
      }
      stage = "mirror-redis";
      const redisReference = `${registry}/redis:${sourceCommit}`;
      await docker(["pull", redisImage], { timeoutMs: 10 * 60_000 });
      await docker(["tag", redisImage, redisReference]);
      await docker(["push", redisReference], { timeoutMs: 10 * 60_000 });
      localReferences.push(redisReference);
      digests.redis = (
        await docker([
          "buildx",
          "imagetools",
          "inspect",
          redisReference,
          "--format",
          "{{json .Manifest.Digest}}",
        ])
      ).stdout
        .replaceAll('"', "")
        .trim();
      localReferences.push(`${registry}/redis@${digests.redis}`);

      stage = "release-env";
      await writeReleaseEnvironment(
        envFile,
        registry,
        digests,
        sourceCommit,
        secrets,
      );
      stage = "release-validation";
      await command(
        process.execPath,
        [
          "--experimental-strip-types",
          "--",
          join(repositoryRoot, "scripts/src/coolify-release.ts"),
          "--env-file",
          envFile,
        ],
        { env: environment },
      );
      stage = "profiled-entrypoints";
      const profileRawSecrets = await proveProfiledEntrypoints(
        docker,
        root,
        runId,
        registry,
        digests,
        sourceCommit,
      );
      stage = "admin-malformed";
      await proveAdmin(
        docker,
        `${registry}/tf-admin@${digests["tf-admin"]}`,
        secrets,
        root,
        runId,
      );

      stage = "platform-start";
      await compose(docker, platformCompose, envFile, "apollo-platform", [
        "up",
        "-d",
        "--wait",
        "--wait-timeout",
        "180",
      ]);
      await waitFor(
        "Platform readiness",
        async () => (await fetch("http://127.0.0.1:18200/readyz")).ok,
      );
      stage = "tf-start";
      await compose(docker, tfCompose, envFile, "apollo-tf", [
        "up",
        "-d",
        "--wait",
        "--wait-timeout",
        "240",
      ]);
      await waitFor(
        "TF readiness",
        async () => (await fetch("http://127.0.0.1:18201/api/readyz")).ok,
        240_000,
      );
      stage = "platform-flow";
      const platformEvidence = await exercisePlatform(secrets);
      stage = "tf-flow";
      const tfEvidence = await exerciseTf(
        docker,
        envFile,
        secrets.dashboardToken,
        platformEvidence,
      );
      stage = "admin-live";
      await proveLiveAdmin(docker, secrets);

      stage = "platform-restart";
      await compose(docker, platformCompose, envFile, "apollo-platform", [
        "restart",
        ...platformLongRunning,
      ]);
      stage = "tf-restart";
      await compose(docker, tfCompose, envFile, "apollo-tf", [
        "restart",
        ...tfLongRunning,
      ]);
      await waitFor(
        "persistent Platform readiness",
        async () => (await fetch("http://127.0.0.1:18200/readyz")).ok,
      );
      await waitFor(
        "persistent TF readiness",
        async () => (await fetch("http://127.0.0.1:18201/api/readyz")).ok,
      );
      stage = "persistence";
      const persistedRegistration = await jsonRequest(
        "http://127.0.0.1:18200/v1/registration",
        { expected: 200 },
      );
      expect(persistedRegistration.body).toEqual({ mode: "invite_only" });
      await waitFor("canceled download persistence", async () => {
        const status = await jsonRequest(
          `http://127.0.0.1:18201/api/tracks/download/status/${tfEvidence.jobId}`,
          {
            expected: 200,
            headers: tfHeaders(tfEvidence.session),
            jar: tfEvidence.session,
          },
        );
        return status.body.status === "canceled";
      });
      stage = "caddy-routes";
      await proveCaddyRoutes(docker, root, runId, secrets);

      stage = "log-scan";
      const logs = [
        await compose(docker, platformCompose, envFile, "apollo-platform", [
          "logs",
          "--no-color",
        ]),
        await compose(docker, tfCompose, envFile, "apollo-tf", [
          "logs",
          "--no-color",
        ]),
      ]
        .flatMap(({ stdout, stderr }) => [stdout, stderr])
        .join("\n");
      const disclosure = findSecretDisclosure(logs, [
        { id: "package", values: secrets.rawSecrets },
        { id: "profile", values: profileRawSecrets },
        { id: "flow", values: platformEvidence.rawSecrets },
      ]);
      if (disclosure !== undefined) {
        throw new Error(
          `container logs disclosed a disposable secret [${disclosure}]`,
        );
      }
      return undefined;
    },
    cleanup: async () => {
      const errors: unknown[] = [];
      const attempt = async (operation: () => Promise<unknown>) => {
        try {
          await operation();
        } catch (error) {
          errors.push(error);
        }
      };

      let helpers: readonly string[] = [];
      await attempt(async () => {
        helpers = await containerIdsForLabels(docker, [
          `apollo.local-release.run=${runId}`,
        ]);
      });
      for (const container of helpers) {
        await attempt(() => docker(["rm", "-f", container]));
      }
      if (envFile !== undefined) {
        await attempt(() =>
          compose(docker, tfCompose, envFile as string, "apollo-tf", [
            "down",
            "--volumes",
            "--remove-orphans",
            "--timeout",
            "20",
          ]),
        );
        await attempt(() =>
          compose(
            docker,
            platformCompose,
            envFile as string,
            "apollo-platform",
            ["down", "--volumes", "--remove-orphans", "--timeout", "20"],
          ),
        );
      }
      let leftovers: readonly string[] = [];
      await attempt(async () => {
        leftovers = await containerIdsForLabels(docker, [
          `apollo.local-release.run=${runId}`,
          "com.docker.compose.project=apollo-platform",
          "com.docker.compose.project=apollo-tf",
        ]);
      });
      for (const container of leftovers) {
        await attempt(() => docker(["rm", "-f", container]));
      }
      for (const kind of ["network", "volume"] as const) {
        let resources: readonly string[] = [];
        await attempt(async () => {
          resources = await resourceIdsForRunLabel(docker, kind, runId);
        });
        for (const resource of resources) {
          await attempt(() =>
            docker([
              kind,
              "rm",
              ...(kind === "volume" ? ["-f"] : []),
              resource,
            ]),
          );
        }
      }
      await attempt(() => removeExactRegistryReferences(docker, registry));
      for (const [image, wasPresent] of acquiredImages) {
        if (!wasPresent) {
          await attempt(async () => {
            if (await imagePresent(docker, image)) {
              await docker(["image", "rm", image]);
            }
          });
        }
      }
      if (root !== undefined) {
        await attempt(() =>
          rm(root as string, { force: true, recursive: true }),
        );
      }
      await attempt(() =>
        removeTaskCreatedParent(temporaryParent, temporaryParentWasPresent),
      );
      if (errors.length > 0) {
        throw new AggregateError(errors, "production smoke teardown failed");
      }
    },
    audit: () => cleanupAudit(docker, runId, registry, root),
    isClean: (audit) => Object.values(audit).every((value) => value === 0),
    stage: () => stage,
  });
  const evidence = {
    cleanup,
    digests: Object.fromEntries(
      Object.entries(digests).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    sourceCommit,
  };
  process.stdout.write(
    `COOLIFY_PRODUCTION_EVIDENCE=${JSON.stringify(evidence)}\n`,
  );
  return evidence;
}

describe("Coolify production smoke contract", () => {
  it.each([
    {
      environment: {
        DOCKER_CONTEXT: "default",
        DOCKER_HOST: "tcp://remote.example.invalid:2376",
      },
      label: "remote host with a local-looking context",
    },
    {
      environment: {
        DOCKER_CONTEXT: "remote-builder",
        DOCKER_HOST: "ssh://operator@remote.example.invalid",
      },
      label: "remote host with a remote context",
    },
  ])("rejects $label before any Docker command", async ({ environment }) => {
    const calls: readonly string[][] = [];
    const runner = async (
      _executable: string,
      args: readonly string[],
    ): Promise<CommandResult> => {
      (calls as string[][]).push([...args]);
      return { exitCode: 0, stderr: "", stdout: "" };
    };
    const validate = assertLocalDocker as unknown as (
      inherited: NodeJS.ProcessEnv,
      commandRunner: typeof runner,
    ) => Promise<NodeJS.ProcessEnv>;

    let error: unknown;
    await validate(environment, runner).catch((caught) => {
      error = caught;
    });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "production smoke requires local Docker",
    );
    expect(calls).toEqual([]);
  });

  it("validates the selected context through one sanitized Docker environment", async () => {
    const observed: {
      readonly args: readonly string[];
      readonly environment: NodeJS.ProcessEnv | undefined;
    }[] = [];
    const runner = async (
      _executable: string,
      args: readonly string[],
      options: Parameters<typeof command>[2] = {},
    ): Promise<CommandResult> => {
      observed.push({ args, environment: options.env });
      if (args[1] === "show") {
        return { exitCode: 0, stderr: "", stdout: "desktop-linux\n" };
      }
      return {
        exitCode: 0,
        stderr: "",
        stdout: `${JSON.stringify("npipe:////./pipe/docker_engine")}\n`,
      };
    };
    const validate = assertLocalDocker as unknown as (
      inherited: NodeJS.ProcessEnv,
      commandRunner: typeof runner,
    ) => Promise<NodeJS.ProcessEnv>;

    const environment = await validate(
      {
        DOCKER_CONTEXT: "desktop-linux",
        DOCKER_HOST: "npipe:////./pipe/docker_engine",
        SAFE_MARKER: "preserved",
      },
      runner,
    );

    expect(observed.map(({ args }) => args)).toEqual([
      ["context", "show"],
      [
        "context",
        "inspect",
        "desktop-linux",
        "--format",
        "{{json .Endpoints.docker.Host}}",
      ],
    ]);
    expect(
      observed.every(({ environment: value }) => value === environment),
    ).toBe(true);
    expect(environment.DOCKER_HOST).toBeUndefined();
    expect(environment.DOCKER_CONTEXT).toBe("desktop-linux");
    expect(environment.SAFE_MARKER).toBe("preserved");
  });

  it("rejects a selected remote context before any mutating Docker command", async () => {
    const calls: readonly string[][] = [];
    const runner = async (
      _executable: string,
      args: readonly string[],
    ): Promise<CommandResult> => {
      (calls as string[][]).push([...args]);
      return args[1] === "show"
        ? { exitCode: 0, stderr: "", stdout: "remote-builder\n" }
        : {
            exitCode: 0,
            stderr: "",
            stdout: `${JSON.stringify("tcp://remote.example.invalid:2376")}\n`,
          };
    };
    const validate = assertLocalDocker as unknown as (
      inherited: NodeJS.ProcessEnv,
      commandRunner: typeof runner,
    ) => Promise<NodeJS.ProcessEnv>;

    let error: unknown;
    await validate({ DOCKER_CONTEXT: "remote-builder" }, runner).catch(
      (caught) => {
        error = caught;
      },
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "production smoke requires local Docker",
    );
    expect(
      calls.some(
        (args) =>
          !(
            args[0] === "context" &&
            (args[1] === "show" || args[1] === "inspect")
          ),
      ),
    ).toBe(false);
  });

  it("identifies log disclosures without returning the matched value", () => {
    expect(
      findSecretDisclosure("prefix synthetic-two suffix", [
        { id: "package", values: ["synthetic-one", "synthetic-two"] },
        { id: "flow", values: ["synthetic-three"] },
      ]),
    ).toBe("package-2");
  });

  it("fails the malformed admin proof when the container exits zero", async () => {
    const root = await mkdtemp(join(tmpdir(), "apollo-admin-exit-zero-"));
    const secrets = await prepareSecrets(root);
    const docker: DockerCommand = async (args) => {
      if (args[0] === "exec") {
        return {
          exitCode: 0,
          stderr: "",
          stdout: "root:nginx:640\n",
        };
      }
      if (args[0] === "inspect") {
        return {
          exitCode: 0,
          stderr: "",
          stdout: `${JSON.stringify({
            ExitCode: 0,
            Running: false,
            Status: "exited",
          })}\n`,
        };
      }
      return { exitCode: 0, stderr: "", stdout: "" };
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_input, init) =>
      new Response("", {
        status:
          new Headers(init?.headers).has("authorization") === true ? 200 : 401,
      });
    try {
      await expect(
        proveAdmin(
          docker,
          "example.invalid/admin@sha256:synthetic",
          secrets,
          root,
          "exit-zero",
        ),
      ).rejects.toThrow("malformed admin container unexpectedly exited 0");
    } finally {
      globalThis.fetch = originalFetch;
      await rm(root, { force: true, recursive: true });
    }
  });

  it("scans malformed admin stdout and stderr without disclosing matches", async () => {
    const root = await mkdtemp(join(tmpdir(), "apollo-admin-stderr-"));
    const secrets = await prepareSecrets(root);
    let canary = "";
    const docker: DockerCommand = async (args) => {
      if (args[0] === "run") {
        const mount = args.find((value) =>
          value.includes("admin_access_password"),
        );
        if (mount === undefined) throw new Error("password mount missing");
        const source = /source=([^,]+)/.exec(mount)?.[1];
        if (source === undefined) throw new Error("password source missing");
        canary = (await readFile(source, "utf8")).split(/\r?\n/, 1)[0];
        return { exitCode: 1, stderr: "", stdout: "" };
      }
      if (args[0] === "inspect") {
        return {
          exitCode: 0,
          stderr: "",
          stdout: `${JSON.stringify({
            ExitCode: 1,
            Running: false,
            Status: "exited",
          })}\n`,
        };
      }
      if (args[0] === "logs") {
        return {
          exitCode: 0,
          stderr: `rejected value ${canary}`,
          stdout: "",
        };
      }
      if (args[0] === "exec") {
        return {
          exitCode: 0,
          stderr: "",
          stdout: "root:nginx:640\n",
        };
      }
      return { exitCode: 0, stderr: "", stdout: "" };
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_input, init) =>
      new Response("", {
        status:
          new Headers(init?.headers).has("authorization") === true ? 200 : 401,
      });
    let error: unknown;
    try {
      await proveAdmin(
        docker,
        "example.invalid/admin@sha256:synthetic",
        secrets,
        root,
        "stderr",
      ).catch((caught) => {
        error = caught;
      });
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "malformed admin output disclosed [malformed-password-1]",
      );
      expect((error as Error).message).not.toContain(canary);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(root, { force: true, recursive: true });
    }
  });

  it.each([
    "resource-acquisition",
    "helper-startup",
    "platform-compose-startup",
    "tf-compose-startup",
    "caddy-startup",
  ])("audits exact cleanup after injected %s failure", async (stage) => {
    const owned = new Set<string>();
    let auditCalls = 0;
    let error: unknown;

    await runWithVerifiedCleanup({
      audit: async () => {
        auditCalls += 1;
        return owned.size;
      },
      cleanup: async () => {
        owned.clear();
      },
      isClean: (remaining) => remaining === 0,
      run: async () => {
        owned.add(`${stage}-resource`);
        throw new Error(`injected ${stage} failure`);
      },
      stage: () => stage,
    }).catch((caught) => {
      error = caught;
    });

    expect(error).toBeInstanceOf(AggregateError);
    expect(
      (error as AggregateError).errors.some(
        (item) =>
          item instanceof Error && item.message === `injected ${stage} failure`,
      ),
    ).toBe(true);
    expect(owned.size).toBe(0);
    expect(auditCalls).toBe(1);
  });

  it("preserves lifecycle and teardown failures while still auditing", async () => {
    const owned = new Set(["owned-helper"]);
    let auditCalls = 0;
    let error: unknown;

    await runWithVerifiedCleanup({
      audit: async () => {
        auditCalls += 1;
        return owned.size;
      },
      cleanup: async () => {
        owned.clear();
        throw new Error("injected teardown failure");
      },
      isClean: (remaining) => remaining === 0,
      run: async () => {
        throw new Error("injected lifecycle failure");
      },
      stage: () => "tf-compose-startup",
    }).catch((caught) => {
      error = caught;
    });

    expect(error).toBeInstanceOf(AggregateError);
    expect(
      (error as AggregateError).errors.map((item) =>
        item instanceof Error ? item.message : String(item),
      ),
    ).toEqual(["injected lifecycle failure", "injected teardown failure"]);
    expect(owned.size).toBe(0);
    expect(auditCalls).toBe(1);
  });

  it("removes only an empty temporary parent created by the task", async () => {
    const created = join(tmpdir(), `apollo-created-${randomUUID()}`);
    const preexisting = join(tmpdir(), `apollo-preexisting-${randomUUID()}`);
    await mkdir(created);
    await mkdir(preexisting);
    try {
      await removeTaskCreatedParent(created, false);
      await removeTaskCreatedParent(preexisting, true);

      expect(await pathExists(created)).toBe(false);
      expect(await pathExists(preexisting)).toBe(true);
    } finally {
      await rm(created, { force: true, recursive: true });
      await rm(preexisting, { force: true, recursive: true });
    }
  });

  it("audits the union of run and both Compose project labels", async () => {
    const filters: string[] = [];
    const docker: DockerCommand = async (args) => {
      const filter = args.at(-1) ?? "";
      filters.push(filter);
      const stdout = filter.includes("local-release")
        ? "helper\nshared\n"
        : filter.includes("apollo-platform")
          ? "platform\nshared\n"
          : "tf\n";
      return { exitCode: 0, stderr: "", stdout };
    };

    const ids = await containerIdsForLabels(docker, [
      "apollo.local-release.run=synthetic",
      "com.docker.compose.project=apollo-platform",
      "com.docker.compose.project=apollo-tf",
    ]);

    expect(new Set(ids)).toEqual(
      new Set(["helper", "shared", "platform", "tf"]),
    );
    expect(filters).toEqual([
      "label=apollo.local-release.run=synthetic",
      "label=com.docker.compose.project=apollo-platform",
      "label=com.docker.compose.project=apollo-tf",
    ]);
  });

  it("removes only exact task-registry tags or digests without pruning", async () => {
    const commands: readonly string[][] = [];
    let removed = false;
    const docker: DockerCommand = async (args) => {
      (commands as string[][]).push([...args]);
      if (args[0] === "image" && args[1] === "ls") {
        return { exitCode: 0, stderr: "", stdout: "sha256:image-one\n" };
      }
      if (args[0] === "image" && args[1] === "inspect") {
        return {
          exitCode: 0,
          stderr: "",
          stdout: removed
            ? "null\nnull\n"
            : `${JSON.stringify(["localhost:62000/redis:source"])}\n${JSON.stringify(
                ["localhost:62000/redis@sha256:digest"],
              )}\n`,
        };
      }
      if (args[0] === "image" && args[1] === "rm") {
        expect(args).toEqual([
          "image",
          "rm",
          "-f",
          "localhost:62000/redis:source",
        ]);
        removed = true;
        return { exitCode: 0, stderr: "", stdout: "" };
      }
      throw new Error("unexpected Docker command");
    };

    await removeExactRegistryReferences(docker, "localhost:62000");

    expect(commands.some((args) => args.includes("prune"))).toBe(false);
    expect(removed).toBe(true);
  });

  it("uses the real Platform-to-TF authorization bridge", () => {
    expect(exercisePlatform.toString()).toContain("/v1/sessions");
    expect(exerciseTf.toString()).toContain("bridgeTfSession");
    expect(exerciseTf.toString()).not.toContain("seedTfSession");
  });

  it("proves restored granted search and exact heartbeat staleness recovery", () => {
    const source = exerciseTf.toString();

    expect(source).toContain("restored granted search");
    expect(source).toMatch(/\[\s*"stop",\s*"tf-integrations"\s*\]/);
    expect(source).toContain(
      'modules.get("account-integrations") === "unknown"',
    );
    expect(source).toMatch(
      /\[\s*"up",\s*"-d",\s*"--no-deps",\s*"tf-integrations"\s*\]/,
    );
    expect(source).toContain(
      'modules.get("account-integrations") === "healthy"',
    );
    expect(source).toContain("heartbeatStaleDeadlineMs");
    expect(source).toContain(
      "Date.now() - heartbeatStoppedAt > heartbeatStaleDeadlineMs",
    );
  });

  it("executes both baseline-profile one-shot services against disposable state", () => {
    const source = runCoolifyProductionSmoke.toString();

    expect(source).toContain("proveProfiledEntrypoints");
    expect(source).toContain('stage = "profiled-entrypoints"');
  });

  it("starts the route forwarder through a shell entrypoint", () => {
    const source = proveCaddyRoutes.toString();

    expect(source).toMatch(/"--entrypoint",\s*"sh"/);
  });

  it("forwards Caddy through the package networks without host listeners", () => {
    const source = proveCaddyRoutes.toString();

    expect(source).toContain('[18200, "platform-api", 8080]');
    expect(source).toContain('[18201, "tf-api", 8080]');
    expect(source).toContain('[18202, "tf-web", 80]');
    expect(source).toContain('[18203, "tf-admin", 80]');
    expect(source).toContain("TCP:${host}:${targetPort}");
    expect(source).toContain("apollo-platform-bridge-v1");
    expect(source).toContain("apollo-tf-edge-v1");
    expect(source).not.toContain("host.docker.internal");
  });

  it("probes Caddy with route hostnames in TLS SNI", () => {
    const source = proveCaddyRoutes.toString();

    for (const host of [
      "api.apollot.ru",
      "api.tf.apollot.ru",
      "tf.apollot.ru",
      "admin.apollot.ru",
    ]) {
      expect(source).toContain(`${host}:127.0.0.1`);
    }
    expect(source).toContain("https://${host}${path}");
    expect(source).toContain("https://admin.apollot.ru/healthz");
    expect(source).not.toContain("https://127.0.0.1");
  });

  it("terminates the private admin authorization input without logging it", () => {
    const source = proveCaddyRoutes.toString();

    expect(source).toMatch(/input:\s*`\$\{authorization\}\n`/);
  });

  it("records digest-qualified local image references for exact cleanup", () => {
    const source = runCoolifyProductionSmoke.toString();

    expect(source).toContain(
      "localReferences.push(`${registry}/${target.image}@${digest}`)",
    );
    expect(source).toContain(
      "localReferences.push(`${registry}/redis@${digests.redis}`)",
    );
  });

  it("removes network-sharing helpers before Compose resources", () => {
    const source = runCoolifyProductionSmoke.toString();
    const cleanupSource = source.slice(source.indexOf("cleanup: async"));
    const helperRemoval = cleanupSource.indexOf(
      'docker(["rm", "-f", container])',
    );
    const tfTeardown = cleanupSource.indexOf("tfCompose");
    const platformTeardown = cleanupSource.indexOf("platformCompose");

    expect(helperRemoval).toBeGreaterThan(-1);
    expect(helperRemoval).toBeLessThan(tfTeardown);
    expect(helperRemoval).toBeLessThan(platformTeardown);
  });

  it("builds every custom production target from one source commit", () => {
    expect(productionTargets).toEqual([
      {
        dockerfile: "artifacts/platform-api/Dockerfile",
        image: "platform-api",
        target: "runtime",
      },
      {
        dockerfile: "artifacts/platform-api/Dockerfile",
        image: "platform-postgres",
        target: "postgres-role-init",
      },
      {
        dockerfile: "artifacts/api-server/Dockerfile",
        image: "tf-api",
        target: "runner",
      },
      {
        dockerfile: "artifacts/api-server/Dockerfile",
        image: "tf-postgres",
        target: "postgres-role-init",
      },
      {
        dockerfile: "artifacts/music-player/Dockerfile",
        image: "tf-web",
        target: "runner",
      },
      {
        dockerfile: "artifacts/admin-dashboard/Dockerfile",
        image: "tf-admin",
        target: "default",
      },
      {
        dockerfile: "artifacts/tf-search/Dockerfile",
        image: "tf-search",
        target: "runner",
      },
      {
        dockerfile: "artifacts/tf-integrations/Dockerfile",
        image: "tf-integrations",
        target: "runner",
      },
      {
        dockerfile: "artifacts/tf-integrations/Dockerfile",
        image: "tf-integrations-postgres",
        target: "postgres-role-init",
      },
      {
        dockerfile: "artifacts/tf-download-worker/Dockerfile",
        image: "tf-download-worker",
        target: "runner",
      },
      {
        dockerfile: "artifacts/tf-download-worker/Dockerfile",
        image: "tf-download-redis",
        target: "queue-redis",
      },
    ]);
  });
});

describe.runIf(process.env.APOLLO_RUN_COOLIFY_PRODUCTION_SMOKE === "1")(
  "Coolify exact production package",
  () => {
    it(
      "builds, starts, exercises, persists, routes, and cleans the package",
      async () => {
        await expect(runCoolifyProductionSmoke()).resolves.toMatchObject({
          cleanup: {
            containers: 0,
            imageReferences: 0,
            networks: 0,
            registryFiles: 0,
            temporarySecrets: 0,
            volumes: 0,
          },
        });
      },
      60 * 60_000,
    );
  },
);
