import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { stringify } from "yaml";

const execFileAsync = promisify(execFile);
const defaultRepositoryRoot = fileURLToPath(
  new URL("../../..", import.meta.url),
);
const SMOKE_QUERY_ARTIST = "Fixture Artist";
const SMOKE_QUERY_TITLE = "Fixture Track";
const SMOKE_ADMIN_TOKEN = "task-5-smoke-admin";
const FORBIDDEN_BUILD_SELECTORS = Object.freeze([
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
]);
const SENSITIVE_ENVIRONMENT = Object.freeze([
  "APOLLO_MODULE_HEARTBEAT_KEYS",
  "DATABASE_URL",
  "TF_SECRET_DIRECTORY",
  "TF_SEARCH_HEARTBEAT_SECRET",
  "TF_SEARCH_INTERNAL_AUTH_SECRET",
]);

function generatedSecret(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isLocalDockerEndpoint(value) {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith("npipe://") || normalized.startsWith("unix://");
}

export function canonicalizeDockerSelectors(environment) {
  const canonicalEnvironment = { ...environment };
  const readSelector = (name) => {
    const entries = Object.entries(canonicalEnvironment).filter(
      ([key]) => key.toUpperCase() === name,
    );
    const values = new Set(
      entries.map(([, value]) => String(value ?? "").trim()),
    );
    if (values.size > 1) {
      throw new Error("Conflicting Docker selector environment");
    }
    for (const [key] of entries) delete canonicalEnvironment[key];
    return values.values().next().value ?? "";
  };

  for (const name of FORBIDDEN_BUILD_SELECTORS) {
    if (readSelector(name).length > 0) {
      throw new Error("Unsafe Docker build selector environment");
    }
  }

  const context = readSelector("DOCKER_CONTEXT");
  const host = readSelector("DOCKER_HOST");
  if (host.length > 0 && !isLocalDockerEndpoint(host)) {
    throw new Error("TF search smoke requires local Docker");
  }
  if (context.length > 0) canonicalEnvironment.DOCKER_CONTEXT = context;
  else if (host.length > 0) canonicalEnvironment.DOCKER_HOST = host;
  canonicalEnvironment.COMPOSE_BAKE = "false";
  return { context, environment: canonicalEnvironment, host };
}

export function assertWorkspaceContainedPath(
  candidate,
  root = defaultRepositoryRoot,
) {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const fromRoot = relative(resolvedRoot, resolvedCandidate);
  if (
    fromRoot.length === 0 ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    resolve(resolvedRoot, fromRoot) !== resolvedCandidate
  ) {
    throw new Error("Path is outside the worktree");
  }
  return resolvedCandidate;
}

function assertPhysicalContainment(candidate, root, allowRoot = false) {
  const fromRoot = relative(root, candidate);
  if (
    (!allowRoot && fromRoot.length === 0) ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    resolve(root, fromRoot) !== candidate
  ) {
    throw new Error("Physical path is outside the worktree");
  }
}

async function verifiedWorkspaceRoot(root) {
  const lexicalRoot = resolve(root);
  const rootStats = await lstat(lexicalRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error("Workspace root cannot be symbolic or reparse-linked");
  }
  const physicalRoot = await realpath(lexicalRoot);
  return { lexicalRoot, physicalRoot };
}

async function verifiedPhysicalDirectory(candidate, workspace) {
  const lexicalCandidate = assertWorkspaceContainedPath(
    candidate,
    workspace.lexicalRoot,
  );
  const candidateStats = await lstat(lexicalCandidate);
  if (!candidateStats.isDirectory() || candidateStats.isSymbolicLink()) {
    throw new Error("Temporary directory cannot be symbolic or reparse-linked");
  }
  const physicalCandidate = await realpath(lexicalCandidate);
  assertPhysicalContainment(physicalCandidate, workspace.physicalRoot);
  return { lexicalCandidate, physicalCandidate };
}

async function verifiedPhysicalFile(candidate, parent, workspace) {
  const lexicalCandidate = assertWorkspaceContainedPath(
    candidate,
    workspace.lexicalRoot,
  );
  const candidateStats = await lstat(lexicalCandidate);
  if (!candidateStats.isFile() || candidateStats.isSymbolicLink()) {
    throw new Error("Temporary file cannot be symbolic or reparse-linked");
  }
  const physicalCandidate = await realpath(lexicalCandidate);
  assertPhysicalContainment(physicalCandidate, parent.physicalCandidate);
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function removeVerifiedDirectory(directory, options = {}) {
  const repositoryRoot = options.repositoryRoot ?? defaultRepositoryRoot;
  const workspace = await verifiedWorkspaceRoot(repositoryRoot);
  const temporaryRootPath = assertWorkspaceContainedPath(
    join(repositoryRoot, ".tmp"),
    repositoryRoot,
  );
  const temporaryRoot = await verifiedPhysicalDirectory(
    temporaryRootPath,
    workspace,
  );
  const verified = await verifiedPhysicalDirectory(directory, workspace);
  if (
    verified.physicalCandidate === temporaryRoot.physicalCandidate ||
    !verified.physicalCandidate.startsWith(
      `${temporaryRoot.physicalCandidate}${sep}`,
    )
  ) {
    throw new Error("Refusing to remove a non-smoke directory");
  }
  await verifiedWorkspaceRoot(repositoryRoot);
  await verifiedPhysicalDirectory(temporaryRootPath, workspace);
  await verifiedPhysicalDirectory(directory, workspace);
  await rm(verified.lexicalCandidate, { force: true, recursive: true });
  try {
    await verifiedWorkspaceRoot(repositoryRoot);
    const refreshedTemporaryRoot = await verifiedPhysicalDirectory(
      temporaryRootPath,
      workspace,
    );
    await rmdir(refreshedTemporaryRoot.lexicalCandidate);
  } catch (error) {
    if (
      error?.code !== "ENOENT" &&
      error?.code !== "ENOTEMPTY" &&
      error?.code !== "EEXIST"
    ) {
      throw error;
    }
  }
}

export async function prepareSecretDirectory(environment, options = {}) {
  const repositoryRoot = options.repositoryRoot ?? defaultRepositoryRoot;
  const workspace = await verifiedWorkspaceRoot(repositoryRoot);
  const temporaryRootPath = assertWorkspaceContainedPath(
    join(repositoryRoot, ".tmp"),
    repositoryRoot,
  );
  try {
    await verifiedPhysicalDirectory(temporaryRootPath, workspace);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(temporaryRootPath);
  }
  const temporaryRoot = await verifiedPhysicalDirectory(
    temporaryRootPath,
    workspace,
  );
  const directoryPath = assertWorkspaceContainedPath(
    await mkdtemp(join(temporaryRoot.lexicalCandidate, "tf-search-smoke-")),
    repositoryRoot,
  );
  const directory = await verifiedPhysicalDirectory(directoryPath, workspace);

  try {
    await chmod(directory.lexicalCandidate, 0o700);
    const postgresPassword = generatedSecret();
    const clientSecret = generatedSecret();
    const commandSecret = generatedSecret();
    const heartbeatSecret = generatedSecret();
    assert.notEqual(commandSecret, heartbeatSecret);
    const databaseUrl =
      `postgres://trackfinder:${encodeURIComponent(postgresPassword)}` +
      "@db:5432/trackfinder";
    const heartbeatKeys = JSON.stringify({
      "search-media": heartbeatSecret,
    });
    const secrets = [
      ["tf_client_secret", clientSecret],
      ["tf_database_url", databaseUrl],
      ["tf_module_heartbeat_keys", heartbeatKeys],
      ["tf_postgres_password", postgresPassword],
      ["tf_search_heartbeat_secret", heartbeatSecret],
      ["tf_search_internal_auth_secret", commandSecret],
    ];

    for (const [name, value] of secrets) {
      await verifiedWorkspaceRoot(repositoryRoot);
      const verifiedDirectory = await verifiedPhysicalDirectory(
        directory.lexicalCandidate,
        workspace,
      );
      const path = assertWorkspaceContainedPath(
        join(directory.lexicalCandidate, name),
        repositoryRoot,
      );
      await writeFile(path, value, { flag: "wx", mode: 0o600 });
      await verifiedPhysicalFile(path, verifiedDirectory, workspace);
      await chmod(path, 0o444);
    }
    if (process.platform !== "win32") {
      assert.equal(
        (await stat(directory.lexicalCandidate)).mode & 0o777,
        0o700,
      );
      for (const [name] of secrets) {
        assert.equal(
          (await stat(join(directory.lexicalCandidate, name))).mode & 0o777,
          0o444,
        );
      }
    }

    environment.TF_SECRET_DIRECTORY = directory.lexicalCandidate;
    return Object.freeze({
      directory: directory.lexicalCandidate,
      rawSecretCanaries: Object.freeze(secrets.map(([, value]) => value)),
      secretNames: Object.freeze(secrets.map(([name]) => name)),
    });
  } catch (error) {
    await removeVerifiedDirectory(directory.lexicalCandidate, {
      repositoryRoot,
    });
    throw error;
  }
}

function safePort(environment) {
  const raw =
    environment.TF_SEARCH_SMOKE_API_PORT ??
    String(18_000 + (process.pid % 1_000));
  if (!/^\d+$/.test(raw)) throw new Error("Invalid smoke API port");
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error("Invalid smoke API port");
  }
  return port;
}

function policyFixtureSource() {
  return String.raw`
const http = require("node:http");
const server = http.createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/oauth/introspect") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end('{"error":"not_found"}');
    return;
  }
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const payload = JSON.stringify({
        active: true,
        accountId: body.accountId,
        sessionId: body.sessionId,
        installationId: body.installationId,
        accountStatus: "active",
        entitlements: ["tf.search"],
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      });
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(payload),
      });
      response.end(payload);
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end('{"error":"invalid_request"}');
    }
  });
});
server.listen(8080, "0.0.0.0");
`;
}

async function writeSmokeOverride(
  environment,
  secretDirectory,
  repositoryRoot,
) {
  const port = safePort(environment);
  const overridePath = assertWorkspaceContainedPath(
    join(secretDirectory, "compose.smoke.yml"),
    repositoryRoot,
  );
  const override = {
    services: {
      api: {
        environment: {
          ADMIN_DASHBOARD_TOKEN: SMOKE_ADMIN_TOKEN,
          APOLLO_PLATFORM_API_ORIGIN: "http://platform-api:8080",
          APOLLO_PLATFORM_ISSUER: `http://127.0.0.1:${port}`,
          APOLLO_TF_BRIDGE_ALLOW_INTERNAL_HTTP: "true",
          APOLLO_TF_CALLBACK_URL: `http://127.0.0.1:${port}/api/auth/callback`,
          APOLLO_TF_WEB_ORIGIN: `http://127.0.0.1:${port}`,
          NODE_ENV: "development",
          SERVER_URL: `http://127.0.0.1:${port}`,
          WEB_URL: `http://127.0.0.1:${port}`,
        },
        depends_on: {
          "platform-api": { condition: "service_started" },
        },
      },
      "platform-api": {
        image: "node:20-bookworm-slim",
        command: ["node", "-e", policyFixtureSource()],
        init: true,
        read_only: true,
        tmpfs: ["/tmp:rw,noexec,nosuid,size=16m"],
        networks: ["tf-edge"],
        security_opt: ["no-new-privileges:true"],
        cap_drop: ["ALL"],
        pids_limit: 64,
      },
      "tf-search": {
        environment: {
          APOLLO_API_VERSION: "task-5-smoke",
          NODE_ENV: "test",
          TF_SEARCH_SMOKE_FIXTURES: "true",
        },
      },
    },
  };
  await writeFile(overridePath, stringify(override));
  return { overridePath, port };
}

function assertSecretFree(text, secrets, label) {
  for (const secret of secrets) {
    assert(!text.includes(secret), `${label} contains raw secret material`);
    assert(
      !text.includes(digest(secret)),
      `${label} contains secret digest material`,
    );
  }
}

function assertCanaryFree(text, canaries, label) {
  for (const canary of canaries) {
    if (canary.length > 0 && text.includes(canary)) {
      throw new Error(`${label} contains sensitive smoke canary`);
    }
  }
}

function sanitizeSmokeError(error, canaries) {
  const message = error instanceof Error ? error.message : "UnknownError";
  if (
    Array.from(canaries).some(
      (canary) => canary.length > 0 && message.includes(canary),
    )
  ) {
    return new Error("TF search smoke suppressed a sensitive smoke canary");
  }
  return error instanceof Error ? error : new Error("TF search smoke failed");
}

async function resolveLocalDockerEnvironment(environment, docker) {
  const selectors = canonicalizeDockerSelectors(environment);
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
    );
    const endpoint = JSON.parse(inspected.stdout.trim());
    if (typeof endpoint !== "string" || !isLocalDockerEndpoint(endpoint)) {
      throw new Error("TF search smoke requires local Docker");
    }
    return selectors.environment;
  }
  if (selectors.host.length > 0) return selectors.environment;

  const shown = await docker(["context", "show"], selectors.environment);
  const context = shown.stdout.trim();
  if (context.length === 0) {
    throw new Error("TF search smoke requires local Docker");
  }
  const resolvedEnvironment = {
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
    resolvedEnvironment,
  );
  const endpoint = JSON.parse(inspected.stdout.trim());
  if (typeof endpoint !== "string" || !isLocalDockerEndpoint(endpoint)) {
    throw new Error("TF search smoke requires local Docker");
  }
  return resolvedEnvironment;
}

function configuredEnvironment(environment) {
  const configured = { ...environment };
  for (const name of SENSITIVE_ENVIRONMENT) {
    for (const key of Object.keys(configured)) {
      if (key.toUpperCase() === name) delete configured[key];
    }
  }
  delete configured.COMPOSE_PROJECT_NAME;
  configured.COMPOSE_BAKE = "false";
  configured.TF_API_PORT = String(safePort(environment));
  return configured;
}

function composeArguments(composeFile, overrideFile, project, args) {
  return [
    "compose",
    "-f",
    composeFile,
    "-f",
    overrideFile,
    "-p",
    project,
    ...args,
  ];
}

function nonEmptyLines(value) {
  return value.split(/\r?\n/).filter(Boolean);
}

async function auditProject(docker, environment, project) {
  const label = `label=com.docker.compose.project=${project}`;
  const [containers, networks, volumes, labeledImages, namedImages] =
    await Promise.all([
      docker(["ps", "-a", "-q", "--filter", label], environment),
      docker(["network", "ls", "-q", "--filter", label], environment),
      docker(["volume", "ls", "-q", "--filter", label], environment),
      docker(["image", "ls", "-q", "--filter", label], environment),
      docker(
        ["image", "ls", "-q", "--filter", `reference=${project}-*`],
        environment,
      ),
    ]);
  const images = new Set([
    ...nonEmptyLines(labeledImages.stdout),
    ...nonEmptyLines(namedImages.stdout),
  ]);
  return {
    containers: nonEmptyLines(containers.stdout).length,
    images: images.size,
    networks: nonEmptyLines(networks.stdout).length,
    volumes: nonEmptyLines(volumes.stdout).length,
  };
}

function assertObservations(observations) {
  for (const field of [
    "health",
    "ready",
    "unsignedRejected",
    "staleRejected",
    "replayRejected",
    "publicPolicySearch",
    "heartbeatHealthy",
    "heartbeatUnknownAfterRestart",
    "heartbeatRecovered",
  ]) {
    assert.equal(
      observations[field],
      true,
      `Smoke observation failed: ${field}`,
    );
  }
  assert.equal(observations.heartbeatVersion, "task-5-smoke");
  assert(
    Number.isInteger(observations.requestsPerMinute) &&
      observations.requestsPerMinute > 0,
    "Heartbeat RPM was not observed",
  );
}

export async function runTfSearchSmoke(options) {
  const repositoryRoot = resolve(
    options.repositoryRoot ?? defaultRepositoryRoot,
  );
  const docker = options.docker;
  const originalEnvironment = options.environment ?? process.env;
  const selectorSafeEnvironment = await resolveLocalDockerEnvironment(
    originalEnvironment,
    docker,
  );
  const environment = configuredEnvironment(selectorSafeEnvironment);
  const project = `apollo-tf-search-smoke-${process.pid}-${randomBytes(4).toString("hex")}`;
  environment.COMPOSE_PROJECT_NAME = project;

  let prepared;
  let overridePath;
  let observations;
  let lifecycleError;
  let cleanupError;
  let compose;
  let logsCollected = false;
  const logCanaries = new Set([
    SMOKE_QUERY_ARTIST,
    SMOKE_QUERY_TITLE,
    `${SMOKE_QUERY_ARTIST} ${SMOKE_QUERY_TITLE}`,
    SMOKE_ADMIN_TOKEN,
  ]);
  const registerLogCanaries = (values) => {
    for (const value of values) {
      if (typeof value === "string" && value.length > 0) {
        logCanaries.add(value);
      }
    }
  };
  let cleanup = {
    containers: -1,
    images: -1,
    networks: -1,
    volumes: -1,
    temporaryDirectories: -1,
  };
  try {
    prepared = await prepareSecretDirectory(environment, { repositoryRoot });
    const override = await writeSmokeOverride(
      environment,
      prepared.directory,
      repositoryRoot,
    );
    overridePath = override.overridePath;
    compose = (args) =>
      docker(
        composeArguments(
          join(repositoryRoot, "docker-compose.yml"),
          overridePath,
          project,
          args,
        ),
        environment,
      );

    const rendered = await compose(["config"]);
    assertSecretFree(
      `${rendered.stdout}\n${rendered.stderr}`,
      prepared.rawSecretCanaries,
      "rendered config",
    );
    await compose([
      "up",
      "-d",
      "--build",
      "db",
      "redis",
      "platform-api",
      "tf-search",
      "api",
    ]);
    const exerciseStack = options.exerciseStack ?? exerciseRealStack;
    observations = await exerciseStack({
      apiOrigin: `http://127.0.0.1:${override.port}`,
      compose,
      environment,
      project,
      registerLogCanaries,
      restartApi: async () => {
        await compose(["restart", "api"]);
      },
    });
    assertObservations(observations);
    const logs = await compose(["logs", "--no-color", "api", "tf-search"]);
    logsCollected = true;
    const logText = `${logs.stdout}\n${logs.stderr}`;
    assertSecretFree(logText, prepared.rawSecretCanaries, "container logs");
    assertCanaryFree(logText, logCanaries, "container logs");
  } catch (error) {
    lifecycleError = error;
  } finally {
    if (prepared !== undefined && compose !== undefined && !logsCollected) {
      try {
        const logs = await compose(["logs", "--no-color", "api", "tf-search"]);
        const logText = `${logs.stdout}\n${logs.stderr}`;
        assertSecretFree(
          logText,
          prepared.rawSecretCanaries,
          "failure container logs",
        );
        assertCanaryFree(logText, logCanaries, "failure container logs");
        if (lifecycleError instanceof Error && logText.trim().length > 0) {
          lifecycleError = new Error(
            `${lifecycleError.message}\n${logText.slice(-16_384)}`,
            { cause: lifecycleError },
          );
        }
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (prepared !== undefined && overridePath !== undefined) {
      try {
        await docker(
          composeArguments(
            join(repositoryRoot, "docker-compose.yml"),
            overridePath,
            project,
            ["down", "-v", "--remove-orphans", "--rmi", "local"],
          ),
          environment,
        );
      } catch (error) {
        cleanupError = error;
      }
    }

    try {
      const audited = await auditProject(docker, environment, project);
      if (prepared !== undefined) {
        await removeVerifiedDirectory(prepared.directory, { repositoryRoot });
      }
      cleanup = {
        ...audited,
        temporaryDirectories:
          prepared !== undefined && (await pathExists(prepared.directory))
            ? 1
            : 0,
      };
      assert.deepEqual(cleanup, {
        containers: 0,
        images: 0,
        networks: 0,
        volumes: 0,
        temporaryDirectories: 0,
      });
    } catch (error) {
      cleanupError ??= error;
    }
  }

  const allCanaries = new Set([
    ...(prepared?.rawSecretCanaries ?? []),
    ...logCanaries,
  ]);
  if (cleanupError !== undefined) {
    const safeCleanupError = sanitizeSmokeError(cleanupError, allCanaries);
    if (safeCleanupError.message.includes("sensitive smoke canary")) {
      throw safeCleanupError;
    }
  }
  if (lifecycleError !== undefined) {
    throw sanitizeSmokeError(lifecycleError, allCanaries);
  }
  if (cleanupError !== undefined) {
    throw sanitizeSmokeError(cleanupError, allCanaries);
  }
  return { project, cleanup, observations };
}

async function waitFor(name, probe, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined && value !== false) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(
    `${name} deadline exceeded${lastError instanceof Error ? `: ${lastError.name}` : ""}`,
  );
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    redirect: "error",
    ...options,
  });
  const text = await response.text();
  let body;
  try {
    body = text.length === 0 ? null : JSON.parse(text);
  } catch {
    body = null;
  }
  return { body, response, text };
}

async function waitForApi(apiOrigin) {
  await waitFor("TF API readiness", async () => {
    const { response } = await fetchJson(`${apiOrigin}/api/readyz`);
    return response.ok;
  });
}

async function runInternalCommandContract(compose) {
  const source = String.raw`
(async () => {
const { createHash, createHmac, randomBytes, randomUUID } = require("node:crypto");
const { readFileSync } = require("node:fs");
const path = "/v1/search";
const secret = readFileSync(process.env.TF_SEARCH_INTERNAL_AUTH_SECRET_FILE, "utf8").trim();
const body = JSON.stringify({
  schemaVersion: 1,
  requestId: randomUUID(),
  artist: "Fixture Artist",
  title: "Fixture Track",
  mode: "auto",
  sources: ["yt", "sc", "bc", "dz"],
  maxResults: 20,
});
function headers(timestamp, nonce) {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const canonical = ["POST", path, timestamp, nonce, bodyHash].join("\n");
  const signature = createHmac("sha256", secret).update(canonical).digest("hex");
  return {
    "content-type": "application/json",
    "x-apollo-internal-timestamp": timestamp,
    "x-apollo-internal-nonce": nonce,
    "x-apollo-internal-signature": "v1=" + signature,
  };
}
const unsigned = await fetch("http://127.0.0.1:8080" + path, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body,
});
const stale = await fetch("http://127.0.0.1:8080" + path, {
  method: "POST",
  headers: headers(String(Math.floor(Date.now() / 1000) - 120), randomBytes(32).toString("base64url")),
  body,
});
const timestamp = String(Math.floor(Date.now() / 1000));
const nonce = randomBytes(32).toString("base64url");
const first = await fetch("http://127.0.0.1:8080" + path, {
  method: "POST",
  headers: headers(timestamp, nonce),
  body,
});
const replay = await fetch("http://127.0.0.1:8080" + path, {
  method: "POST",
  headers: headers(timestamp, nonce),
  body,
});
process.stdout.write(JSON.stringify({
  unsigned: unsigned.status,
  stale: stale.status,
  first: first.status,
  replay: replay.status,
}));
})().catch((error) => { console.error(error); process.exitCode = 1; });
`;
  const result = await compose([
    "exec",
    "-T",
    "tf-search",
    "node",
    "-e",
    source,
  ]);
  const statuses = JSON.parse(result.stdout.trim());
  return {
    unsignedRejected: statuses.unsigned === 401,
    staleRejected: statuses.stale === 401,
    replayRejected: statuses.first === 200 && statuses.replay === 401,
  };
}

export async function seedPolicySession(compose, registerLogCanaries) {
  const sessionHandle = generatedSecret();
  const csrf = generatedSecret();
  const revision = generatedSecret();
  const accountId = randomUUID();
  const platformSessionId = randomUUID();
  const installationId = randomUUID();
  const tfSessionId = randomUUID();
  const now = Date.now();
  registerLogCanaries([
    accountId,
    platformSessionId,
    installationId,
    tfSessionId,
    sessionHandle,
    csrf,
    revision,
  ]);
  const stored = JSON.stringify({
    revision,
    session: {
      id: tfSessionId,
      accountId,
      platformSessionId,
      installationId,
      entitlements: ["tf.search"],
      assertionExpiresAt: new Date(now + 1_000).toISOString(),
      expiresAt: new Date(now + 30 * 60_000).toISOString(),
    },
  });
  const key = `tf-auth:session:${digest(sessionHandle)}`;
  await compose([
    "exec",
    "-T",
    "redis",
    "redis-cli",
    "-n",
    "1",
    "SET",
    key,
    stored,
    "PX",
    String(30 * 60_000),
  ]);
  return {
    accountId,
    csrf,
    installationId,
    platformSessionId,
    revision,
    sessionHandle,
    tfSessionId,
  };
}

async function publicPolicySearch(apiOrigin, policySession) {
  const result = await fetchJson(`${apiOrigin}/api/tracks/search`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie:
        `__Host-apollo_tf=${policySession.sessionHandle}; ` +
        `__Host-apollo_tf_csrf=${policySession.csrf}`,
      origin: apiOrigin,
      "x-csrf-token": policySession.csrf,
    },
    body: JSON.stringify({
      artist: SMOKE_QUERY_ARTIST,
      title: SMOKE_QUERY_TITLE,
      mode: "auto",
      sources: ["yt", "sc", "bc", "dz"],
      maxResults: 20,
    }),
  });
  assert.equal(result.response.status, 200, "public policy search status");
  assert(Array.isArray(result.body?.results), "public search results missing");
  assert(result.body.results.length > 0, "public search returned no fixture");
  assert(
    !result.text.includes("sourceUrl"),
    "public response exposes source URL",
  );
  assert(
    !result.text.includes("providerStatus"),
    "public response exposes provider status",
  );
  return result.text;
}

async function dashboardModule(apiOrigin, status) {
  return waitFor(
    `search-media heartbeat ${status}`,
    async () => {
      const result = await fetchJson(`${apiOrigin}/api/admin/dashboard`, {
        headers: { "x-admin-dashboard-token": SMOKE_ADMIN_TOKEN },
      });
      if (!result.response.ok || !Array.isArray(result.body?.modules)) {
        return false;
      }
      const module = result.body.modules.find(
        (candidate) => candidate.id === "search-media",
      );
      return module?.status === status ? module : false;
    },
    45_000,
  );
}

async function exerciseRealStack(context) {
  await waitFor("TF search health", async () => {
    const result = await context.compose([
      "exec",
      "-T",
      "tf-search",
      "node",
      "-e",
      "const r=await fetch('http://127.0.0.1:8080/healthz');process.exit(r.ok?0:1)",
    ]);
    return result.stderr.length === 0;
  });
  await waitFor("TF search readiness", async () => {
    await context.compose([
      "exec",
      "-T",
      "tf-search",
      "node",
      "-e",
      "const r=await fetch('http://127.0.0.1:8080/readyz');process.exit(r.ok?0:1)",
    ]);
    return true;
  });
  await waitForApi(context.apiOrigin);

  const internal = await runInternalCommandContract(context.compose);
  const policySession = await seedPolicySession(
    context.compose,
    context.registerLogCanaries,
  );
  const responseProjection = await publicPolicySearch(
    context.apiOrigin,
    policySession,
  );
  const healthy = await dashboardModule(context.apiOrigin, "healthy");
  assert.equal(healthy.version, "task-5-smoke");
  assert(healthy.requestsPerMinute > 0);

  await context.restartApi();
  await waitForApi(context.apiOrigin);
  const unknownResult = await fetchJson(
    `${context.apiOrigin}/api/admin/dashboard`,
    { headers: { "x-admin-dashboard-token": SMOKE_ADMIN_TOKEN } },
  );
  const unknownModule = unknownResult.body?.modules?.find(
    (candidate) => candidate.id === "search-media",
  );
  const heartbeatUnknownAfterRestart = unknownModule?.status === "unknown";
  const recovered = await dashboardModule(context.apiOrigin, "healthy");

  return {
    health: true,
    ready: true,
    ...internal,
    publicPolicySearch: true,
    heartbeatHealthy: healthy.status === "healthy",
    heartbeatUnknownAfterRestart,
    heartbeatRecovered: recovered.status === "healthy",
    heartbeatVersion: recovered.version,
    requestsPerMinute: recovered.requestsPerMinute,
    responseProjection,
  };
}

async function realDocker(args, environment) {
  return execFileAsync("docker", args, {
    cwd: defaultRepositoryRoot,
    env: environment,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 5 * 60_000,
    windowsHide: true,
  });
}

const invokedPath =
  process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  if (process.env.TF_SEARCH_SMOKE_REAL_DOCKER !== "1") {
    process.stderr.write(
      "Set TF_SEARCH_SMOKE_REAL_DOCKER=1 for explicit local execution\n",
    );
    process.exitCode = 1;
  } else {
    runTfSearchSmoke({
      environment: process.env,
      docker: realDocker,
      repositoryRoot: defaultRepositoryRoot,
    })
      .then(({ project, cleanup }) => {
        process.stdout.write(
          `TF search deterministic fixture smoke passed ${project} ${JSON.stringify(cleanup)}\n`,
        );
      })
      .catch((error) => {
        process.stderr.write(
          `TF search smoke failed: ${error instanceof Error ? error.message : "UnknownError"}\n`,
        );
        process.exitCode = 1;
      });
  }
}
