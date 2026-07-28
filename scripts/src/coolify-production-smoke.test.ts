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
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
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
  readonly stderr: string;
  readonly stdout: string;
};

async function command(
  executable: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly input?: string;
    readonly timeoutMs?: number;
  } = {},
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
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) rejectCommand(error);
      else {
        resolveCommand({
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
    child.once("close", (code) =>
      code === 0
        ? finish()
        : finish(new Error(`local command exited ${String(code)}`)),
    );
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

async function docker(
  args: readonly string[],
  options: Parameters<typeof command>[2] = {},
): Promise<CommandResult> {
  return command("docker", args, options);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
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

async function assertLocalDocker(): Promise<NodeJS.ProcessEnv> {
  const environment = { ...process.env };
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
  const context = (await docker(["context", "show"])).stdout.trim();
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
  if (
    !endpoint.toLowerCase().startsWith("npipe://") &&
    !endpoint.toLowerCase().startsWith("unix://")
  ) {
    throw new Error("production smoke requires local Docker");
  }
  delete environment.COMPOSE_PROJECT_NAME;
  environment.COMPOSE_BAKE = "false";
  environment.DOCKER_CONTEXT = context;
  return environment;
}

async function imagePresent(image: string): Promise<boolean> {
  try {
    await docker(["image", "inspect", image]);
    return true;
  } catch {
    return false;
  }
}

async function assertFixedResourcesAbsent(): Promise<void> {
  for (const [kind, names] of [
    ["network", fixedNetworks],
    ["volume", fixedVolumes],
  ] as const) {
    for (const name of names) {
      try {
        await docker([kind, "inspect", name]);
        throw new Error("production smoke fixed resource is already owned");
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "production smoke fixed resource is already owned"
        ) {
          throw error;
        }
      }
    }
  }
  const containers = (
    await docker([
      "ps",
      "-aq",
      "--filter",
      "label=com.docker.compose.project=apollo-platform",
      "--filter",
      "label=com.docker.compose.project=apollo-tf",
    ])
  ).stdout.trim();
  if (containers.length > 0) {
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
  file: string,
  envFile: string,
  project: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  return docker(
    ["compose", "--env-file", envFile, "-f", file, "-p", project, ...args],
    { env: environment, timeoutMs: 10 * 60_000 },
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
  environment: NodeJS.ProcessEnv,
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
  await compose(
    tfCompose,
    envFile,
    "apollo-tf",
    ["stop", "tf-search"],
    environment,
  );
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
  await compose(
    tfCompose,
    envFile,
    "apollo-tf",
    ["up", "-d", "--no-deps", "tf-search"],
    environment,
  );
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
  await waitFor("signed module heartbeats", async () => {
    const dashboard = await jsonRequest(`${origin}/api/admin/dashboard`, {
      expected: 200,
      headers: { "x-admin-dashboard-token": dashboardToken },
    });
    const modules = new Map(
      (dashboard.body.modules as any[]).map((module) => [
        module.id,
        module.status,
      ]),
    );
    return ["search-media", "account-integrations", "download-worker"].every(
      (name) => modules.get(name) === "healthy",
    );
  });
  return { jobId, session };
}

async function proveAdmin(
  image: string,
  secrets: Awaited<ReturnType<typeof prepareSecrets>>,
  root: string,
  runId: string,
): Promise<void> {
  const malformed = join(root, `malformed-admin-${runId}`);
  await mkdir(malformed);
  const canary = secret();
  await writeFile(join(malformed, "admin_access_user"), "valid-user");
  await writeFile(
    join(malformed, "admin_access_password"),
    `${canary}\nsecond-line`,
  );
  await writeFile(join(malformed, "admin_dashboard_token"), secret());
  const name = `apollo-release-malformed-${runId}`;
  let output = "";
  try {
    await docker([
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
    ]);
    throw new Error("malformed admin secrets unexpectedly started");
  } catch {
    output = (
      await docker(["logs", name]).catch(() => ({ stdout: "", stderr: "" }))
    ).stdout;
  } finally {
    await docker(["rm", "-f", name]).catch(() => undefined);
  }
  if (output.includes(canary)) {
    throw new Error("malformed admin secret was disclosed");
  }

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
  root: string,
  runId: string,
  secrets: Awaited<ReturnType<typeof prepareSecrets>>,
): Promise<void> {
  const caddyCommand = async (
    label: string,
    args: readonly string[],
    options: Parameters<typeof docker>[1] = {},
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
        "--rm",
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
    "--header \"Authorization: $auth\" -qO- " +
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

async function cleanupAudit(
  runId: string,
  registry: string,
  root: string,
): Promise<{
  readonly containers: number;
  readonly imageReferences: number;
  readonly networks: number;
  readonly registryFiles: number;
  readonly temporarySecrets: number;
  readonly volumes: number;
}> {
  const containers = (
    await docker([
      "ps",
      "-aq",
      "--filter",
      `label=apollo.local-release.run=${runId}`,
    ])
  ).stdout
    .split(/\r?\n/)
    .filter(Boolean).length;
  let networks = 0;
  for (const name of fixedNetworks) {
    if (
      await docker(["network", "inspect", name])
        .then(() => true)
        .catch(() => false)
    ) {
      networks += 1;
    }
  }
  let volumes = 0;
  for (const name of fixedVolumes) {
    if (
      await docker(["volume", "inspect", name])
        .then(() => true)
        .catch(() => false)
    ) {
      volumes += 1;
    }
  }
  const imageReferences = (
    await docker(["image", "ls", "--format", "{{.Repository}}:{{.Tag}}"])
  ).stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith(`${registry}/`)).length;
  return {
    containers,
    imageReferences,
    networks,
    registryFiles: (await pathExists(join(root, "registry")))
      ? (await readdir(join(root, "registry"))).length
      : 0,
    temporarySecrets: (await pathExists(root)) ? 1 : 0,
    volumes,
  };
}

async function runCoolifyProductionSmoke(): Promise<unknown> {
  let stage = "local-docker";
  const environment = await assertLocalDocker();
  stage = "clean-source";
  const status = (await command("git", ["status", "--porcelain"])).stdout;
  if (status.trim().length > 0) {
    throw new Error("exact-commit smoke requires a clean worktree");
  }
  const sourceCommit = (
    await command("git", ["rev-parse", "HEAD"])
  ).stdout.trim();
  stage = "fixed-resource-preflight";
  await assertFixedResourcesAbsent();

  const runId = randomBytes(6).toString("hex");
  const temporaryParent = join(repositoryRoot, ".tmp");
  await mkdir(temporaryParent, { recursive: true });
  const root = await mkdtemp(
    join(temporaryParent, `coolify-production-${runId}-`),
  );
  const source = join(root, "source");
  const registryData = join(root, "registry");
  const envFile = join(root, "release.env");
  const registryPort = await freePort();
  const registry = `localhost:${registryPort}`;
  const registryContainer = `apollo-release-registry-${runId}`;
  const acquiredImages = new Map<string, boolean>();
  const localReferences: string[] = [];
  const digests: Record<string, string> = {};
  let lifecycleError: unknown;
  let cleanupError: unknown;
  let secrets: Awaited<ReturnType<typeof prepareSecrets>> | undefined;
  try {
    stage = "image-inventory";
    for (const image of [registryImage, caddyImage, socatImage, redisImage]) {
      acquiredImages.set(image, await imagePresent(image));
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
        { env: environment, timeoutMs: 20 * 60_000 },
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
    stage = "admin-malformed";
    await proveAdmin(
      `${registry}/tf-admin@${digests["tf-admin"]}`,
      secrets,
      root,
      runId,
    ).catch((error) => {
      // The live admin assertions run after the stack; only malformed runs now.
      if (
        !(error instanceof Error) ||
        !error.message.includes("fetch failed")
      ) {
        throw error;
      }
    });

    stage = "platform-start";
    await compose(
      platformCompose,
      envFile,
      "apollo-platform",
      ["up", "-d", "--wait", "--wait-timeout", "180"],
      environment,
    );
    await waitFor(
      "Platform readiness",
      async () => (await fetch("http://127.0.0.1:18200/readyz")).ok,
    );
    stage = "tf-start";
    await compose(
      tfCompose,
      envFile,
      "apollo-tf",
      ["up", "-d", "--wait", "--wait-timeout", "240"],
      environment,
    );
    await waitFor(
      "TF readiness",
      async () => (await fetch("http://127.0.0.1:18201/api/readyz")).ok,
      240_000,
    );
    stage = "platform-flow";
    const platformEvidence = await exercisePlatform(secrets);
    stage = "tf-flow";
    const tfEvidence = await exerciseTf(
      environment,
      envFile,
      secrets.dashboardToken,
      platformEvidence,
    );
    stage = "admin-live";
    await proveAdmin(
      `${registry}/tf-admin@${digests["tf-admin"]}`,
      secrets,
      root,
      `${runId}-live`,
    );

    stage = "platform-restart";
    await compose(
      platformCompose,
      envFile,
      "apollo-platform",
      ["restart", ...platformLongRunning],
      environment,
    );
    stage = "tf-restart";
    await compose(
      tfCompose,
      envFile,
      "apollo-tf",
      ["restart", ...tfLongRunning],
      environment,
    );
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
    await proveCaddyRoutes(root, runId, secrets);

    stage = "log-scan";
    const logs = [
      await compose(
        platformCompose,
        envFile,
        "apollo-platform",
        ["logs", "--no-color"],
        environment,
      ),
      await compose(
        tfCompose,
        envFile,
        "apollo-tf",
        ["logs", "--no-color"],
        environment,
      ),
    ]
      .flatMap(({ stdout, stderr }) => [stdout, stderr])
      .join("\n");
    const disclosure = findSecretDisclosure(logs, [
      { id: "package", values: secrets.rawSecrets },
      { id: "flow", values: platformEvidence.rawSecrets },
    ]);
    if (disclosure !== undefined) {
      throw new Error(
        `container logs disclosed a disposable secret [${disclosure}]`,
      );
    }
  } catch (error) {
    lifecycleError = error;
  } finally {
    const helpers = (
      await docker([
        "ps",
        "-aq",
        "--filter",
        `label=apollo.local-release.run=${runId}`,
      ]).catch(() => ({ stdout: "", stderr: "" }))
    ).stdout
      .split(/\r?\n/)
      .filter(Boolean);
    for (const container of helpers) {
      await docker(["rm", "-f", container]).catch((error) => {
        cleanupError ??= error;
      });
    }
    await compose(
      tfCompose,
      envFile,
      "apollo-tf",
      ["down", "--volumes", "--remove-orphans", "--timeout", "20"],
      environment,
    ).catch((error) => {
      cleanupError ??= error;
    });
    await compose(
      platformCompose,
      envFile,
      "apollo-platform",
      ["down", "--volumes", "--remove-orphans", "--timeout", "20"],
      environment,
    ).catch((error) => {
      cleanupError ??= error;
    });
    for (const reference of localReferences.reverse()) {
      await docker(["image", "rm", "-f", reference]).catch(() => undefined);
    }
    for (const [image, wasPresent] of acquiredImages) {
      if (!wasPresent) {
        await docker(["image", "rm", image]).catch(() => undefined);
      }
    }
    await rm(root, { force: true, recursive: true }).catch((error) => {
      cleanupError ??= error;
    });
    await rm(temporaryParent, { force: false }).catch(() => undefined);
  }
  const cleanup = await cleanupAudit(runId, registry, root);
  if (Object.values(cleanup).some((value) => value !== 0)) {
    cleanupError ??= new Error("production smoke cleanup audit was nonzero");
  }
  if (lifecycleError !== undefined) {
    throw new Error(
      `production smoke lifecycle failed at ${stage}: ${
        lifecycleError instanceof Error ? lifecycleError.message : "unknown"
      }`,
    );
  }
  if (cleanupError !== undefined) {
    throw new Error("production smoke cleanup failed");
  }
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
  it("identifies log disclosures without returning the matched value", () => {
    expect(
      findSecretDisclosure("prefix synthetic-two suffix", [
        { id: "package", values: ["synthetic-one", "synthetic-two"] },
        { id: "flow", values: ["synthetic-three"] },
      ]),
    ).toBe("package-2");
  });

  it("uses the real Platform-to-TF authorization bridge", () => {
    expect(exercisePlatform.toString()).toContain("/v1/sessions");
    expect(exerciseTf.toString()).toContain("bridgeTfSession");
    expect(exerciseTf.toString()).not.toContain("seedTfSession");
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
    const cleanupSource = runCoolifyProductionSmoke
      .toString()
      .slice(runCoolifyProductionSmoke.toString().lastIndexOf("finally {"));
    const helperRemoval = cleanupSource.indexOf(
      'await docker(["rm", "-f", container])',
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
