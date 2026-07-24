import { execFile } from "node:child_process";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import assert from "node:assert/strict";
import WebSocket from "ws";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const composeFile = fileURLToPath(
  new URL("../docker-compose.bridge.yml", import.meta.url),
);
const EXPECTED_SERVICES = Object.freeze([
  "platform-api",
  "platform-migrate",
  "platform-postgres",
  "platform-redis",
  "tf-api",
  "tf-postgres",
  "tf-redis",
]);
const PUBLIC_TF_COOKIE_NAMES = Object.freeze(["__Host-apollo_tf_installation"]);
const PERMITTED_RESPONSE_COOKIE_NAMES = Object.freeze([
  "__Host-apollo_admin",
  "__Host-apollo_admin_csrf",
  "__Host-apollo_portal",
  "__Host-apollo_portal_csrf",
  "__Host-apollo_tf",
  "__Host-apollo_tf_csrf",
  "__Host-apollo_tf_installation",
  "__Host-apollo_tf_tx",
]);
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const COMPOSE_BUILD_TIMEOUT_MS = 5 * 60_000;
const COMPOSE_UP_TIMEOUT_MS = 150_000;
const COMPOSE_DOWN_TIMEOUT_MS = 60_000;
const BRIDGE_SMOKE_LIFECYCLE_MS = 15 * 60_000;
export const TLS_PROXY_CLOSE_TIMEOUT_MS = 2_000;
const BRIDGE_SMOKE_CLEANUP_GRACE_MS =
  COMPOSE_DOWN_TIMEOUT_MS + 3 * DEFAULT_COMMAND_TIMEOUT_MS + 30_000;
const BRIDGE_SMOKE_CHILD_MS =
  BRIDGE_SMOKE_LIFECYCLE_MS + BRIDGE_SMOKE_CLEANUP_GRACE_MS;
export const BRIDGE_SMOKE_TIMEOUTS = Object.freeze({
  childMs: BRIDGE_SMOKE_CHILD_MS,
  cleanupGraceMs: BRIDGE_SMOKE_CLEANUP_GRACE_MS,
  composeBuildMs: COMPOSE_BUILD_TIMEOUT_MS,
  lifecycleMs: BRIDGE_SMOKE_LIFECYCLE_MS,
  parentMs: BRIDGE_SMOKE_CHILD_MS + 30_000,
});
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
const OWNED_ENVIRONMENT_NAMES = Object.freeze([
  "BRIDGE_SECRET_DIRECTORY",
  "COMPOSE_DISABLE_ENV_FILE",
  "COMPOSE_PROJECT_NAME",
  "DATABASE_URL",
  "MIGRATOR_DATABASE_URL",
  "PLATFORM_ALLOWED_ORIGINS",
  "PLATFORM_API_PORT",
  "PLATFORM_API_IMAGE",
  "PLATFORM_MIGRATOR_DATABASE_URL",
  "PLATFORM_MIGRATOR_PASSWORD",
  "PLATFORM_OPERATOR_BOOTSTRAP_TOKEN",
  "PLATFORM_POSTGRES_IMAGE",
  "PLATFORM_POSTGRES_ADMIN_PASSWORD",
  "PLATFORM_PUBLIC_ORIGIN",
  "PLATFORM_RUNTIME_DATABASE_URL",
  "PLATFORM_RUNTIME_PASSWORD",
  "PLATFORM_SECRET_DIRECTORY",
  "TF_API_PORT",
  "TF_API_IMAGE",
  "TF_DATABASE_URL",
  "TF_POSTGRES_PASSWORD",
  "TF_PUBLIC_ORIGIN",
  "TF_SECRET_DIRECTORY",
]);
const JSON_LIMIT = 128 * 1024;
let smokeStage = "startup";

export function runBoundedCommand(executable, args, options = {}) {
  const { timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS, ...execOptions } = options;
  assert(
    Number.isInteger(timeoutMs) && timeoutMs > 0,
    "External command timeout must be positive",
  );
  return execFileAsync(executable, [...args], {
    ...execOptions,
    killSignal: "SIGKILL",
    timeout: timeoutMs,
  });
}

export async function runWithLifecycleDeadline(
  operation,
  timeoutMs,
  timers = {
    clearTimeout: (handle) => clearTimeout(handle),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  },
) {
  assert(
    Number.isInteger(timeoutMs) && timeoutMs > 0,
    "Lifecycle timeout must be positive",
  );
  const controller = new AbortController();
  let deadlineError;
  const watchdog = timers.setTimeout(() => {
    deadlineError = new Error("Bridge smoke lifecycle deadline exceeded");
    controller.abort(deadlineError);
  }, timeoutMs);
  try {
    const result = await operation(controller.signal);
    if (deadlineError !== undefined) throw deadlineError;
    return result;
  } catch (error) {
    if (deadlineError !== undefined) throw deadlineError;
    throw error;
  } finally {
    timers.clearTimeout(watchdog);
  }
}

function generatedSecret(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function cleanCaseInsensitive(environment, names) {
  const normalized = new Set(names.map((name) => name.toLowerCase()));
  for (const name of Object.keys(environment)) {
    if (normalized.has(name.toLowerCase())) delete environment[name];
  }
}

function configuredEnvironment(source = process.env) {
  const environment = { ...source };
  cleanCaseInsensitive(environment, OWNED_ENVIRONMENT_NAMES);
  environment.COMPOSE_DISABLE_ENV_FILE = "true";
  environment.COMPOSE_PROJECT_NAME =
    `apollo-platform-tf-bridge-${process.pid}-` +
    randomBytes(4).toString("hex");
  return environment;
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
  if (context.length > 0) canonicalEnvironment.DOCKER_CONTEXT = context;
  else if (host.length > 0) canonicalEnvironment.DOCKER_HOST = host;
  canonicalEnvironment.COMPOSE_BAKE = "false";
  canonicalEnvironment.COMPOSE_DISABLE_ENV_FILE = "true";
  return { context, environment: canonicalEnvironment, host };
}

async function inspectDockerContext(environment, context) {
  const { stdout } = await runBoundedCommand(
    "docker",
    [
      "context",
      "inspect",
      context,
      "--format",
      "{{json .Endpoints.docker.Host}}",
    ],
    {
      cwd: repositoryRoot,
      env: environment,
      maxBuffer: 1024 * 1024,
      timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    },
  );
  let endpoint;
  try {
    endpoint = JSON.parse(stdout.trim());
  } catch {
    endpoint = undefined;
  }
  assert(
    typeof endpoint === "string" && isLocalDockerEndpoint(endpoint),
    "Bridge smoke requires a local Docker socket",
  );
}

async function resolveLocalDockerEnvironment(environment) {
  const selectors = canonicalizeDockerSelectors(environment);
  if (selectors.context.length > 0) {
    await inspectDockerContext(selectors.environment, selectors.context);
    return selectors.environment;
  }
  if (selectors.host.length > 0) {
    assert(
      isLocalDockerEndpoint(selectors.host),
      "Bridge smoke requires a local Docker socket",
    );
    return selectors.environment;
  }
  const { stdout } = await runBoundedCommand("docker", ["context", "show"], {
    cwd: repositoryRoot,
    env: selectors.environment,
    maxBuffer: 1024 * 1024,
    timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
  });
  const context = stdout.trim();
  assert(context.length > 0, "Bridge smoke requires a Docker context");
  const resolved = {
    ...selectors.environment,
    DOCKER_CONTEXT: context,
  };
  await inspectDockerContext(resolved, context);
  return resolved;
}

async function compose(environment, args, options = {}) {
  const timeoutMs = args.includes("build")
    ? COMPOSE_BUILD_TIMEOUT_MS
    : args.includes("up")
      ? COMPOSE_UP_TIMEOUT_MS
      : args.includes("down")
        ? COMPOSE_DOWN_TIMEOUT_MS
        : DEFAULT_COMMAND_TIMEOUT_MS;
  return runBoundedCommand(
    "docker",
    [
      "compose",
      "--project-directory",
      repositoryRoot,
      "-f",
      composeFile,
      "-p",
      environment.COMPOSE_PROJECT_NAME,
      ...args,
    ],
    {
      cwd: repositoryRoot,
      env: environment,
      maxBuffer: 16 * 1024 * 1024,
      signal: options.signal,
      timeoutMs,
    },
  );
}

function assertSecretFree(text, secrets, label) {
  for (const secret of new Set(secrets.filter(Boolean))) {
    assert(!text.includes(secret), `${label} contains secret material`);
    assert(
      !text.includes(digest(secret)),
      `${label} contains digested secret material`,
    );
  }
}

function sanitizedDiagnostic(error, secrets) {
  const candidates = [
    error instanceof Error ? error.message : "",
    typeof error?.stdout === "string" ? error.stdout : "",
    typeof error?.stderr === "string" ? error.stderr : "",
  ];
  let output = candidates.filter(Boolean).join("\n");
  for (const secret of new Set(secrets.filter(Boolean))) {
    output = output.replaceAll(secret, "<redacted>");
    output = output.replaceAll(digest(secret), "<redacted-digest>");
  }
  return output.slice(0, 8_192);
}

async function assertTrackedFilesSecretFree(secrets) {
  const { stdout } = await runBoundedCommand("git", ["ls-files", "-z"], {
    cwd: repositoryRoot,
    encoding: "buffer",
    maxBuffer: 8 * 1024 * 1024,
    timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
  });
  const files = stdout.toString("utf8").split("\0").filter(Boolean);
  const needles = [...new Set(secrets.filter(Boolean))].flatMap((secret) => [
    Buffer.from(secret),
    Buffer.from(digest(secret)),
  ]);
  for (const file of files) {
    const bytes = await readFile(join(repositoryRoot, file));
    if (needles.some((needle) => bytes.includes(needle))) {
      throw new Error("Tracked file contains generated secret material");
    }
  }
}

async function freeLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address !== null && typeof address === "object");
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function generateTlsMaterials(directory) {
  const { stdout: version } = await runBoundedCommand("openssl", ["version"], {
    cwd: directory,
    maxBuffer: 1024 * 1024,
    timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
  });
  assert(/^OpenSSL 3\./.test(version), "OpenSSL 3 is required");
  const caKey = join(directory, "bridge-ca.key");
  const caCertificate = join(directory, "bridge-ca.crt");
  const serverKey = join(directory, "bridge-server.key");
  const serverRequest = join(directory, "bridge-server.csr");
  const serverCertificate = join(directory, "bridge-server.crt");
  const extensions = join(directory, "bridge-server.ext");
  await runBoundedCommand(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=Apollo Bridge Test CA",
      "-keyout",
      caKey,
      "-out",
      caCertificate,
    ],
    {
      cwd: directory,
      maxBuffer: 1024 * 1024,
      timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    },
  );
  await runBoundedCommand(
    "openssl",
    [
      "req",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-nodes",
      "-subj",
      "/CN=127.0.0.1",
      "-keyout",
      serverKey,
      "-out",
      serverRequest,
    ],
    {
      cwd: directory,
      maxBuffer: 1024 * 1024,
      timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    },
  );
  await writeFile(
    extensions,
    [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      "subjectAltName=IP:127.0.0.1,DNS:localhost",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  await runBoundedCommand(
    "openssl",
    [
      "x509",
      "-req",
      "-in",
      serverRequest,
      "-CA",
      caCertificate,
      "-CAkey",
      caKey,
      "-CAcreateserial",
      "-days",
      "1",
      "-sha256",
      "-extfile",
      extensions,
      "-out",
      serverCertificate,
    ],
    {
      cwd: directory,
      maxBuffer: 1024 * 1024,
      timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    },
  );
  const verified = await runBoundedCommand(
    "openssl",
    ["verify", "-CAfile", caCertificate, serverCertificate],
    {
      cwd: directory,
      maxBuffer: 1024 * 1024,
      timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    },
  );
  assert(verified.stdout.includes(": OK"), "Generated TLS certificate invalid");
  await Promise.all([
    chmod(caKey, 0o600),
    chmod(serverKey, 0o600),
    chmod(caCertificate, 0o444),
    chmod(serverCertificate, 0o444),
  ]);
  return {
    ca: await readFile(caCertificate),
    caPrivateKey: await readFile(caKey, "utf8"),
    certificate: await readFile(serverCertificate),
    privateKey: await readFile(serverKey),
    serverPrivateKey: await readFile(serverKey, "utf8"),
  };
}

export function retainSocket(sockets, socket) {
  if (sockets.has(socket)) return socket;
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  return socket;
}

export function closeTlsProxyServer(server, sockets, options = {}) {
  const {
    timeoutMs = TLS_PROXY_CLOSE_TIMEOUT_MS,
    timers = {
      clearTimeout: (handle) => clearTimeout(handle),
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    },
  } = options;
  assert(
    Number.isInteger(timeoutMs) && timeoutMs > 0,
    "TLS proxy close timeout must be positive",
  );
  return new Promise((resolveClose, rejectClose) => {
    let settled = false;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(deadline);
      if (error === undefined) resolveClose();
      else rejectClose(error);
    };
    const forceClose = () => {
      server.closeAllConnections?.();
      for (const socket of sockets) socket.destroy();
      settle();
    };
    const deadline = timers.setTimeout(forceClose, timeoutMs);
    try {
      server.closeAllConnections?.();
      server.close((error) => {
        if (error !== undefined) {
          for (const socket of sockets) socket.destroy();
        }
        settle(error);
      });
    } catch (error) {
      for (const socket of sockets) socket.destroy();
      settle(error);
    }
  });
}

async function startTlsProxy(targetPort, tls) {
  const sockets = new Set();
  const server = https.createServer(
    { cert: tls.certificate, key: tls.privateKey },
    (request, response) => {
      const upstream = http.request(
        {
          host: "127.0.0.1",
          port: targetPort,
          method: request.method,
          path: request.url,
          headers: request.headers,
        },
        (upstreamResponse) => {
          response.writeHead(
            upstreamResponse.statusCode ?? 502,
            upstreamResponse.statusMessage,
            upstreamResponse.rawHeaders,
          );
          upstreamResponse.pipe(response);
        },
      );
      upstream.on("socket", (socket) => retainSocket(sockets, socket));
      upstream.setTimeout(10_000, () => upstream.destroy());
      upstream.on("error", () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      request.pipe(upstream);
    },
  );
  server.on("connection", (socket) => retainSocket(sockets, socket));
  server.on("upgrade", (request, socket, head) => {
    const upstream = retainSocket(
      sockets,
      net.connect(targetPort, "127.0.0.1"),
    );
    const destroyBoth = () => {
      upstream.destroy();
      socket.destroy();
    };
    upstream.setTimeout(10_000, destroyBoth);
    upstream.once("error", destroyBoth);
    socket.once("error", destroyBoth);
    upstream.once("connect", () => {
      upstream.setTimeout(0);
      const rawHeaders = [];
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        rawHeaders.push(
          `${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`,
        );
      }
      upstream.write(
        `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n` +
          `${rawHeaders.join("\r\n")}\r\n\r\n`,
      );
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address !== null && typeof address === "object");
  return {
    origin: `https://127.0.0.1:${address.port}`,
    close: () => closeTlsProxyServer(server, sockets),
  };
}

export async function removeVerifiedDirectory(
  directory,
  operations = { access, rm },
) {
  await operations.rm(directory, { force: true, recursive: true });
  try {
    await operations.access(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Temporary directory cleanup incomplete: ${directory}`);
}

export async function prepareSecretDirectory(environment, tfPublicOrigin) {
  const directory = await mkdtemp(
    join(tmpdir(), "apollo-platform-tf-bridge-secrets-"),
  );
  try {
    await chmod(directory, 0o700);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privateJwk = privateKey.export({ format: "jwk" });
    const publicJwk = publicKey.export({ format: "jwk" });
    const keyId = `bridge-${randomBytes(12).toString("hex")}`;
    const platformPostgresAdminPassword = generatedSecret();
    const platformMigratorPassword = generatedSecret();
    const platformRuntimePassword = generatedSecret();
    const tfPostgresPassword = generatedSecret();
    const operatorBootstrapToken = generatedSecret();
    const oauthClientSecret = generatedSecret();
    const pkceVerifier = generatedSecret(48);
    const platformMigratorDatabaseUrl =
      `postgres://apollo_platform_migrator:${encodeURIComponent(platformMigratorPassword)}` +
      "@platform-postgres:5432/apollo_platform";
    const platformRuntimeDatabaseUrl =
      `postgres://apollo_platform_runtime:${encodeURIComponent(platformRuntimePassword)}` +
      "@platform-postgres:5432/apollo_platform";
    const tfDatabaseUrl =
      `postgres://apollo_tf_runtime:${encodeURIComponent(tfPostgresPassword)}` +
      "@tf-postgres:5432/apollo_tf";
    const assertionPrivateJwk = {
      alg: "EdDSA",
      crv: "Ed25519",
      d: privateJwk.d,
      kid: keyId,
      kty: "OKP",
      use: "sig",
      x: privateJwk.x,
    };
    const assertionPublicJwk = {
      alg: "EdDSA",
      crv: "Ed25519",
      kid: keyId,
      kty: "OKP",
      use: "sig",
      x: publicJwk.x,
    };
    const files = new Map([
      ["platform_assertion_private_jwk", JSON.stringify(assertionPrivateJwk)],
      [
        "platform_assertion_public_jwks",
        JSON.stringify({ keys: [assertionPublicJwk] }),
      ],
      ["platform_migrator_database_url", platformMigratorDatabaseUrl],
      ["platform_migrator_password", platformMigratorPassword],
      [
        "platform_oauth_clients",
        JSON.stringify([
          {
            audience: "apollo-tf",
            clientId: "apollo-tf-api",
            clientSecretDigest: digest(oauthClientSecret),
            redirectUris: [`${tfPublicOrigin}/api/auth/callback`],
          },
        ]),
      ],
      ["platform_operator_bootstrap_token", operatorBootstrapToken],
      ["platform_postgres_admin_password", platformPostgresAdminPassword],
      ["platform_runtime_database_url", platformRuntimeDatabaseUrl],
      ["platform_runtime_password", platformRuntimePassword],
      ["tf_client_secret", oauthClientSecret],
      ["tf_database_url", tfDatabaseUrl],
      ["tf_pkce_verifier", pkceVerifier],
      ["tf_postgres_password", tfPostgresPassword],
    ]);
    await Promise.all(
      [...files].map(async ([name, value]) => {
        const path = join(directory, name);
        await writeFile(path, value, { mode: 0o600 });
        await chmod(path, 0o444);
      }),
    );
    if (process.platform !== "win32") {
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      for (const name of files.keys()) {
        assert.equal((await stat(join(directory, name))).mode & 0o777, 0o444);
      }
    }
    environment.BRIDGE_SECRET_DIRECTORY = directory;
    return {
      directory,
      operatorBootstrapToken,
      oauthClientSecret,
      pkceVerifier,
      rawSecrets: [
        platformPostgresAdminPassword,
        platformMigratorPassword,
        platformRuntimePassword,
        tfPostgresPassword,
        operatorBootstrapToken,
        oauthClientSecret,
        pkceVerifier,
        platformMigratorDatabaseUrl,
        platformRuntimeDatabaseUrl,
        tfDatabaseUrl,
        assertionPrivateJwk.d,
      ],
    };
  } catch (error) {
    try {
      await removeVerifiedDirectory(directory);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Secret preparation and cleanup failed",
      );
    }
    throw error;
  }
}

function configService(config, name) {
  const current = config.services?.[name];
  assert(current !== undefined, `Missing Compose service ${name}`);
  return current;
}

function attachedNetworks(current) {
  if (Array.isArray(current.networks)) return [...current.networks].sort();
  if (current.networks !== null && typeof current.networks === "object") {
    return Object.keys(current.networks).sort();
  }
  return [];
}

function secretSources(current) {
  assert(
    current.secrets === undefined || Array.isArray(current.secrets),
    "Invalid Compose secret configuration",
  );
  return (current.secrets ?? [])
    .map((entry) =>
      typeof entry === "string" ? entry : String(entry.source ?? ""),
    )
    .sort();
}

function assertDependencies(current, expected) {
  assert.deepEqual(
    Object.keys(current.depends_on ?? {}).sort(),
    Object.keys(expected).sort(),
  );
  for (const [name, condition] of Object.entries(expected)) {
    assert.equal(current.depends_on[name]?.condition, condition);
  }
}

function assertHardenedRuntime(current, name) {
  assert.equal(current.user, "10001:10001", `${name} must run non-root`);
  assert.equal(
    current.read_only,
    true,
    `${name} root filesystem must be read-only`,
  );
  assert(
    Array.isArray(current.tmpfs) &&
      current.tmpfs.length > 0 &&
      current.tmpfs.every(
        (entry) =>
          typeof entry === "string" &&
          entry.startsWith("/tmp") &&
          entry.includes("noexec") &&
          entry.includes("nosuid") &&
          entry.includes("size="),
      ),
    `${name} must use bounded hardened tmpfs`,
  );
  assert.deepEqual(
    current.cap_add ?? [],
    [],
    `${name} cannot add capabilities`,
  );
  assert.deepEqual(
    current.cap_drop,
    ["ALL"],
    `${name} must drop all capabilities`,
  );
  assert(
    current.security_opt?.includes("no-new-privileges:true"),
    `${name} must set no-new-privileges`,
  );
}

function assertExactVolumes(current, name, expected) {
  const volumes = current.volumes ?? [];
  assert(Array.isArray(volumes), `${name} volumes are invalid`);
  assert.deepEqual(
    volumes.map((volume) => {
      assert(
        volume !== null && typeof volume === "object",
        `${name} cannot use short-syntax mounts`,
      );
      return {
        source: volume.source,
        target: volume.target,
        type: volume.type,
      };
    }),
    expected,
    `${name} volume mounts are unsafe`,
  );
}

export function validateRenderedBridgeConfig(output, secrets, secretDirectory) {
  assertSecretFree(output, secrets, "Compose config");
  assert(
    typeof secretDirectory === "string" && secretDirectory.length > 0,
    "Secret directory is required",
  );
  const config = JSON.parse(output);
  assert.deepEqual(
    Object.keys(config.services ?? {}).sort(),
    EXPECTED_SERVICES,
  );
  assert.deepEqual(Object.keys(config.networks ?? {}).sort(), [
    "bridge-edge",
    "platform-data",
    "platform-tf-control",
    "tf-data",
  ]);
  assert.notEqual(config.networks["bridge-edge"]?.internal, true);
  for (const name of ["platform-data", "platform-tf-control", "tf-data"]) {
    assert.equal(
      config.networks[name]?.internal,
      true,
      `${name} must be internal`,
    );
  }
  assert.deepEqual(Object.keys(config.volumes ?? {}).sort(), [
    "platform-postgres-data",
    "platform-redis-data",
    "tf-postgres-data",
    "tf-redis-data",
  ]);
  assert.deepEqual(Object.keys(config.secrets ?? {}).sort(), [
    "platform_assertion_private_jwk",
    "platform_assertion_public_jwks",
    "platform_migrator_database_url",
    "platform_migrator_password",
    "platform_oauth_clients",
    "platform_operator_bootstrap_token",
    "platform_postgres_admin_password",
    "platform_runtime_database_url",
    "platform_runtime_password",
    "tf_client_secret",
    "tf_database_url",
    "tf_pkce_verifier",
    "tf_postgres_password",
  ]);
  for (const name of Object.keys(config.secrets)) {
    assert.equal(
      resolve(config.secrets[name]?.file ?? ""),
      resolve(secretDirectory, name),
      `${name} secret file source is unsafe`,
    );
  }

  const expectedNetworks = {
    "platform-postgres": ["platform-data"],
    "platform-redis": ["platform-data"],
    "platform-migrate": ["platform-data"],
    "platform-api": ["bridge-edge", "platform-data", "platform-tf-control"],
    "tf-postgres": ["tf-data"],
    "tf-redis": ["tf-data"],
    "tf-api": ["bridge-edge", "platform-tf-control", "tf-data"],
  };
  for (const [name, networks] of Object.entries(expectedNetworks)) {
    assert.deepEqual(
      attachedNetworks(configService(config, name)),
      [...networks].sort(),
      `${name} network membership is unsafe`,
    );
  }

  for (const name of [
    "platform-postgres",
    "platform-redis",
    "platform-migrate",
    "tf-postgres",
    "tf-redis",
  ]) {
    assert.equal(configService(config, name).ports, undefined);
  }
  for (const name of ["platform-api", "tf-api"]) {
    const ports = configService(config, name).ports;
    assert(Array.isArray(ports) && ports.length === 1);
    assert.equal(ports[0].host_ip, "127.0.0.1");
    assert.equal(ports[0].target, 8080);
  }

  const expectedImages = {
    "platform-api": "apollo-platform-api:bridge",
    "platform-migrate": "apollo-platform-api:bridge",
    "platform-postgres": "apollo-platform-postgres:bridge",
    "platform-redis": "redis:7-bookworm",
    "tf-api": "apollo-tf-api:bridge",
    "tf-postgres": "postgres:16-bookworm",
    "tf-redis": "redis:7-bookworm",
  };
  for (const [name, image] of Object.entries(expectedImages)) {
    assert.equal(
      configService(config, name).image,
      image,
      `${name} image is unsafe`,
    );
  }

  const expectedBuilds = {
    "platform-postgres": {
      dockerfile: "artifacts/platform-api/Dockerfile",
      target: "postgres-role-init",
    },
    "platform-migrate": {
      dockerfile: "artifacts/platform-api/Dockerfile",
      target: "runtime",
    },
    "platform-api": {
      dockerfile: "artifacts/platform-api/Dockerfile",
      target: "runtime",
    },
    "tf-api": {
      dockerfile: "artifacts/api-server/Dockerfile",
      target: undefined,
    },
  };
  for (const [name, expected] of Object.entries(expectedBuilds)) {
    const current = configService(config, name);
    assert.equal(
      resolve(current.build?.context ?? ""),
      resolve(repositoryRoot),
    );
    assert.equal(
      resolve(repositoryRoot, current.build?.dockerfile ?? ""),
      resolve(repositoryRoot, expected.dockerfile),
    );
    assert.equal(current.build?.target, expected.target);
  }

  assertDependencies(configService(config, "platform-migrate"), {
    "platform-postgres": "service_healthy",
  });
  assertDependencies(configService(config, "platform-api"), {
    "platform-migrate": "service_completed_successfully",
    "platform-redis": "service_healthy",
  });
  assertDependencies(configService(config, "tf-api"), {
    "platform-api": "service_healthy",
    "tf-postgres": "service_healthy",
    "tf-redis": "service_healthy",
  });

  const expectedSecrets = {
    "platform-postgres": [
      "platform_migrator_password",
      "platform_postgres_admin_password",
      "platform_runtime_password",
    ],
    "platform-redis": [],
    "platform-migrate": ["platform_migrator_database_url"],
    "platform-api": [
      "platform_assertion_private_jwk",
      "platform_assertion_public_jwks",
      "platform_oauth_clients",
      "platform_operator_bootstrap_token",
      "platform_runtime_database_url",
    ],
    "tf-postgres": ["tf_postgres_password"],
    "tf-redis": [],
    "tf-api": ["tf_client_secret", "tf_database_url", "tf_pkce_verifier"],
  };
  for (const [name, expected] of Object.entries(expectedSecrets)) {
    assert.deepEqual(
      secretSources(configService(config, name)),
      [...expected].sort(),
      `${name} secret boundary is unsafe`,
    );
  }

  for (const name of ["platform-migrate", "platform-api", "tf-api"]) {
    assertHardenedRuntime(configService(config, name), name);
  }
  assert.equal(
    configService(config, "platform-postgres").environment?.POSTGRES_USER,
    "postgres",
  );
  assert.equal(
    configService(config, "tf-postgres").environment?.POSTGRES_USER,
    "apollo_tf_runtime",
  );

  const serialized = JSON.stringify(config);
  for (const forbidden of [
    "docker.sock",
    ".ops-private",
    '"privileged":true',
    '"network_mode":"host"',
    '"pid":"host"',
    '"ipc":"host"',
  ]) {
    assert(!serialized.includes(forbidden), "Unsafe Compose configuration");
  }
  for (const [name, current] of Object.entries(config.services)) {
    assert.deepEqual(
      current.cap_add ?? [],
      [],
      `${name} cannot add capabilities`,
    );
    assertExactVolumes(
      current,
      name,
      {
        "platform-postgres": [
          {
            source: "platform-postgres-data",
            target: "/var/lib/postgresql/data",
            type: "volume",
          },
        ],
        "platform-redis": [
          { source: "platform-redis-data", target: "/data", type: "volume" },
        ],
        "platform-migrate": [],
        "platform-api": [],
        "tf-postgres": [
          {
            source: "tf-postgres-data",
            target: "/var/lib/postgresql/data",
            type: "volume",
          },
        ],
        "tf-redis": [
          { source: "tf-redis-data", target: "/data", type: "volume" },
        ],
        "tf-api": [],
      }[name],
    );
  }
}

export class CookieJar {
  #cookies = new Map();

  ingest(response) {
    const values = response.headers["set-cookie"] ?? [];
    for (const source of Array.isArray(values) ? values : [values]) {
      const pair = source.split(";", 1)[0];
      const separator = pair.indexOf("=");
      if (separator < 1) continue;
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (/Max-Age=0/i.test(source) || value.length === 0) {
        this.#cookies.delete(name);
      } else {
        this.#cookies.set(name, value);
      }
    }
  }

  header() {
    return [...this.#cookies]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  secretValues(publicNames = []) {
    const publicNameSet = new Set(publicNames);
    return [...this.#cookies]
      .filter(([name]) => !publicNameSet.has(name))
      .map(([, value]) => value);
  }
}

async function secureRequest(ca, origin, path, options = {}) {
  const url = new URL(path, origin);
  assert.equal(url.origin, origin);
  const body =
    options.body === undefined ? undefined : Buffer.from(options.body, "utf8");
  return new Promise((resolveRequest, rejectRequest) => {
    const request = https.request(
      url,
      {
        method: options.method ?? "GET",
        ca,
        rejectUnauthorized: true,
        signal: options.signal,
        headers: {
          ...options.headers,
          ...(body === undefined
            ? {}
            : { "Content-Length": String(body.byteLength) }),
        },
      },
      (response) => {
        const chunks = [];
        let total = 0;
        response.on("data", (chunk) => {
          total += chunk.length;
          if (total > JSON_LIMIT) {
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.once("error", () =>
          rejectRequest(new Error("HTTPS response failed")),
        );
        response.once("end", () => {
          const bodyBytes = Buffer.concat(chunks);
          const text = bodyBytes.toString("utf8");
          let json = null;
          if (text.length > 0) {
            try {
              json = JSON.parse(text);
            } catch {
              json = null;
            }
          }
          resolveRequest({
            status: response.statusCode ?? 0,
            headers: response.headers,
            rawHeaders: [...response.rawHeaders],
            bodyBytes,
            text,
            json,
          });
        });
      },
    );
    request.setTimeout(10_000, () => request.destroy());
    request.once("error", () =>
      rejectRequest(new Error("HTTPS request failed")),
    );
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function requireStatus(response, expected, label) {
  assert.equal(response.status, expected, `${label} status`);
  return response;
}

function redactSetCookie(value, cookieNames) {
  const separator = value.indexOf("=");
  if (separator < 1) return value;
  const name = value.slice(0, separator);
  if (!cookieNames.has(name)) return value;
  const attributes = value.indexOf(";", separator + 1);
  return (
    `${name}=<redacted-cookie>` +
    (attributes < 0 ? "" : value.slice(attributes))
  );
}

function redactLocation(value, parameters) {
  if (parameters.size === 0) return value;
  let location;
  try {
    location = new URL(value);
  } catch {
    return value;
  }
  for (const parameter of parameters) {
    assert(
      location.searchParams.getAll(parameter).length === 1,
      "Redirect parameter must occur exactly once",
    );
    location.searchParams.set(parameter, "<redacted>");
  }
  return location.toString();
}

function skipJsonWhitespace(input, start) {
  let index = start;
  while (
    index < input.length &&
    [0x20, 0x09, 0x0a, 0x0d].includes(input[index])
  ) {
    index += 1;
  }
  return index;
}

function jsonStringEnd(input, start) {
  assert.equal(input[start], 0x22, "Expected JSON string");
  let index = start + 1;
  while (index < input.length) {
    if (input[index] === 0x22) return index + 1;
    if (input[index] === 0x5c) index += 1;
    index += 1;
  }
  throw new Error("Unterminated JSON string");
}

function jsonValueEnd(input, start) {
  let index = skipJsonWhitespace(input, start);
  if (input[index] === 0x22) return jsonStringEnd(input, index);
  if (input[index] === 0x7b) {
    index = skipJsonWhitespace(input, index + 1);
    if (input[index] === 0x7d) return index + 1;
    while (index < input.length) {
      index = jsonStringEnd(input, index);
      index = skipJsonWhitespace(input, index);
      assert.equal(input[index], 0x3a, "Expected JSON object separator");
      index = jsonValueEnd(input, index + 1);
      index = skipJsonWhitespace(input, index);
      if (input[index] === 0x7d) return index + 1;
      assert.equal(input[index], 0x2c, "Expected JSON object delimiter");
      index = skipJsonWhitespace(input, index + 1);
    }
  }
  if (input[index] === 0x5b) {
    index = skipJsonWhitespace(input, index + 1);
    if (input[index] === 0x5d) return index + 1;
    while (index < input.length) {
      index = jsonValueEnd(input, index);
      index = skipJsonWhitespace(input, index);
      if (input[index] === 0x5d) return index + 1;
      assert.equal(input[index], 0x2c, "Expected JSON array delimiter");
      index = skipJsonWhitespace(input, index + 1);
    }
  }
  const valueStart = index;
  while (
    index < input.length &&
    ![0x2c, 0x5d, 0x7d, 0x20, 0x09, 0x0a, 0x0d].includes(input[index])
  ) {
    index += 1;
  }
  assert(index > valueStart, "Expected JSON value");
  return index;
}

function redactTopLevelJsonFields(rawBody, bodyFields) {
  JSON.parse(rawBody.toString("utf8"));
  let index = skipJsonWhitespace(rawBody, 0);
  assert.equal(rawBody[index], 0x7b, "Redacted JSON body must be an object");
  index = skipJsonWhitespace(rawBody, index + 1);
  const replacements = [];
  const seenPermittedFields = new Set();
  while (rawBody[index] !== 0x7d) {
    const keyStart = index;
    const keyEnd = jsonStringEnd(rawBody, keyStart);
    const key = JSON.parse(rawBody.subarray(keyStart, keyEnd).toString("utf8"));
    index = skipJsonWhitespace(rawBody, keyEnd);
    assert.equal(rawBody[index], 0x3a, "Expected JSON object separator");
    const valueStart = skipJsonWhitespace(rawBody, index + 1);
    const valueEnd = jsonValueEnd(rawBody, valueStart);
    if (bodyFields.has(key)) {
      assert(
        !seenPermittedFields.has(key),
        `Duplicate permitted JSON field: ${key}`,
      );
      seenPermittedFields.add(key);
      replacements.push({ start: valueStart, end: valueEnd });
    }
    index = skipJsonWhitespace(rawBody, valueEnd);
    if (rawBody[index] === 0x7d) break;
    assert.equal(rawBody[index], 0x2c, "Expected JSON object delimiter");
    index = skipJsonWhitespace(rawBody, index + 1);
  }

  const chunks = [];
  let previousEnd = 0;
  for (const replacement of replacements) {
    chunks.push(
      rawBody.subarray(previousEnd, replacement.start),
      Buffer.from('"<redacted>"', "utf8"),
    );
    previousEnd = replacement.end;
  }
  chunks.push(rawBody.subarray(previousEnd));
  return Buffer.concat(chunks);
}

function projectHeaderValue(name, value, cookieNames, locationParameters) {
  const text = String(value);
  if (name.toLowerCase() === "set-cookie") {
    return redactSetCookie(text, cookieNames);
  }
  if (name.toLowerCase() === "location") {
    return redactLocation(text, locationParameters);
  }
  return text;
}

function redactExactRedirectBody(response, rawBody) {
  const location = response.headers.location;
  assert.equal(
    typeof location,
    "string",
    "Redirect response must contain one location header",
  );
  const sourceRawHeaders = response.rawHeaders ?? [];
  const rawLocations = [];
  for (let index = 0; index < sourceRawHeaders.length; index += 2) {
    if (String(sourceRawHeaders[index]).toLowerCase() === "location") {
      rawLocations.push(String(sourceRawHeaders[index + 1]));
    }
  }
  assert.equal(
    rawLocations.length,
    1,
    "Redirect response must contain one raw location header",
  );
  assert(
    rawLocations[0] === location,
    "Redirect response location headers must match",
  );
  const statusMessage = http.STATUS_CODES[response.status];
  assert.equal(
    typeof statusMessage,
    "string",
    "Redirect response status is invalid",
  );
  if (rawBody.byteLength === 0) return rawBody;
  assert(
    rawBody.toString("utf8") === `${statusMessage}. Redirecting to ${location}`,
    "Redirect response body is not an exact location duplicate",
  );
  return Buffer.from(
    `${statusMessage}. Redirecting to <redacted-location>`,
    "utf8",
  );
}

export function projectResponseForSecretScan(response, options = {}) {
  const bodyFields = new Set(options.bodyFields ?? []);
  const cookieNames = new Set(options.cookieNames ?? []);
  const locationQueryParameters = new Set(
    options.locationQueryParameters ?? [],
  );
  const originalBody = Buffer.isBuffer(response.bodyBytes)
    ? Buffer.from(response.bodyBytes)
    : Buffer.from(response.text, "utf8");
  let rawBody = originalBody;
  if (
    bodyFields.size > 0 &&
    response.json !== null &&
    typeof response.json === "object"
  ) {
    rawBody = redactTopLevelJsonFields(originalBody, bodyFields);
  }
  if (options.redactExactRedirectBody === true) {
    assert.equal(
      bodyFields.size,
      0,
      "Redirect body redaction cannot be combined with JSON field redaction",
    );
    rawBody = redactExactRedirectBody(response, originalBody);
  }

  const headers = {};
  for (const [rawName, rawValue] of Object.entries(response.headers)) {
    if (rawValue === undefined) continue;
    const name = rawName.toLowerCase();
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    const projected = values.map((value) =>
      projectHeaderValue(name, value, cookieNames, locationQueryParameters),
    );
    headers[name] = Array.isArray(rawValue) ? projected : projected[0];
  }

  const sourceRawHeaders = response.rawHeaders ?? [];
  assert.equal(
    sourceRawHeaders.length % 2,
    0,
    "Raw response headers are malformed",
  );
  const rawHeaders = [];
  for (let index = 0; index < sourceRawHeaders.length; index += 2) {
    const name = String(sourceRawHeaders[index]);
    rawHeaders.push(
      name,
      projectHeaderValue(
        name,
        sourceRawHeaders[index + 1],
        cookieNames,
        locationQueryParameters,
      ),
    );
  }
  return {
    status: response.status,
    headers,
    rawHeaders,
    rawBody,
    body: rawBody.toString("utf8"),
  };
}

function assertResponseProjectionSecretFree(projection, secrets) {
  assertSecretFree(
    projection.response.rawBody,
    secrets,
    `sanitized raw response body ${projection.label}`,
  );
  assertSecretFree(
    JSON.stringify(projection),
    secrets,
    `sanitized response projection ${projection.label}`,
  );
}

export function recordResponseBeforeStatus(state, response, options) {
  const isExpectedStatus = response.status === options.expectedStatus;
  const projection = {
    label: options.label,
    response: projectResponseForSecretScan(response, {
      bodyFields: isExpectedStatus ? (options.bodyFields ?? []) : [],
      cookieNames: isExpectedStatus ? (options.cookieNames ?? []) : [],
      locationQueryParameters: isExpectedStatus
        ? (options.locationQueryParameters ?? [])
        : [],
      redactExactRedirectBody:
        isExpectedStatus && options.redactExactRedirectBody === true,
    }),
  };
  state.projections.push(projection);
  if (Array.isArray(state.rawSecrets)) {
    assertResponseProjectionSecretFree(projection, state.rawSecrets);
  }
  return requireStatus(response, options.expectedStatus, options.label);
}

function normalizedPublicError(response) {
  assert(response.json !== null && typeof response.json === "object");
  const body = structuredClone(response.json);
  assert.equal(typeof body.requestId, "string");
  body.requestId = "<request-id>";
  return { status: response.status, body };
}

async function jsonCall(state, origin, path, options = {}) {
  const headers = {
    Origin: options.origin ?? origin,
    ...(options.jar?.header() ? { Cookie: options.jar.header() } : {}),
    ...options.headers,
  };
  const body =
    options.body === undefined ? undefined : JSON.stringify(options.body);
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await secureRequest(state.ca, origin, path, {
    method: options.method,
    headers,
    body,
    signal: state.lifecycleSignal,
  });
  options.jar?.ingest(response);
  recordResponseBeforeStatus(state, response, {
    expectedStatus: options.status ?? 200,
    label: options.label ?? path,
    bodyFields: options.redact ?? [],
    cookieNames: PERMITTED_RESPONSE_COOKIE_NAMES,
  });
  return response;
}

function protectedOperatorHeaders(state) {
  return { "X-CSRF-Token": state.operatorCsrf };
}

async function mutateEntitlement(state, accountId, moduleKey, method) {
  return jsonCall(
    state,
    state.platformOrigin,
    `/v1/operator/accounts/${accountId}/entitlements/${moduleKey}`,
    {
      method,
      jar: state.operatorCookies,
      headers: protectedOperatorHeaders(state),
      body: { reason: `Bridge smoke ${method.toLowerCase()} entitlement` },
      label: `entitlement-${method.toLowerCase()}-${moduleKey}`,
    },
  );
}

export async function waitForReadiness(state, signal, dependencies = {}) {
  const request = dependencies.request ?? secureRequest;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    throwIfLifecycleAborted(signal);
    const responses = await Promise.allSettled([
      request(state.ca, state.platformOrigin, "/readyz", { signal }),
      request(state.ca, state.tfOrigin, "/api/readyz", { signal }),
    ]);
    let ready = true;
    for (const [label, result] of [
      ["platform-readiness", responses[0]],
      ["tf-readiness", responses[1]],
    ]) {
      if (result.status !== "fulfilled") {
        ready = false;
        continue;
      }
      recordResponseBeforeStatus(state, result.value, {
        expectedStatus: result.value.status,
        label,
      });
      if (result.value.status !== 200) ready = false;
    }
    if (ready) return;
    throwIfLifecycleAborted(signal);
    // Continue bounded polling while containers finish startup.
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error("Bridge readiness deadline exceeded");
}

async function proveMountedSecretsReadable(environment, signal) {
  const platformFiles = [
    "platform_assertion_private_jwk",
    "platform_assertion_public_jwks",
    "platform_oauth_clients",
    "platform_operator_bootstrap_token",
    "platform_runtime_database_url",
  ];
  const tfFiles = ["tf_client_secret", "tf_database_url", "tf_pkce_verifier"];
  for (const [service, files] of [
    ["platform-api", platformFiles],
    ["tf-api", tfFiles],
  ]) {
    await compose(
      environment,
      [
        "exec",
        "-T",
        "--user",
        "10001:10001",
        service,
        "sh",
        "-c",
        files.map((name) => `test -r /run/secrets/${name}`).join(" && "),
      ],
      { signal },
    );
  }
}

async function openWebSocket(url, ca) {
  return new Promise((resolveSocket, rejectSocket) => {
    const socket = new WebSocket(url, {
      ca,
      rejectUnauthorized: true,
      handshakeTimeout: 10_000,
      perMessageDeflate: false,
    });
    socket.once("open", () => resolveSocket(socket));
    socket.once("error", () =>
      rejectSocket(new Error("WebSocket upgrade failed")),
    );
  });
}

export async function rejectedWebSocketStatus(url, ca, state) {
  return new Promise((resolveStatus, rejectStatus) => {
    const socket = new WebSocket(url, {
      ca,
      rejectUnauthorized: true,
      handshakeTimeout: 10_000,
      perMessageDeflate: false,
    });
    let responseOwned = false;
    let settled = false;
    const finish = (operation) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation();
    };
    const fail = (message) => {
      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      ) {
        socket.terminate();
      }
      finish(() => rejectStatus(new Error(message)));
    };
    const timer = setTimeout(
      () => fail("WebSocket replay deadline exceeded"),
      11_000,
    );
    timer.unref?.();
    socket.once("unexpected-response", (_request, response) => {
      responseOwned = true;
      const status = response.statusCode ?? 0;
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > JSON_LIMIT) {
          response.destroy();
          fail("WebSocket replay response exceeds byte limit");
          return;
        }
        chunks.push(chunk);
      });
      response.once("error", () => fail("WebSocket replay response failed"));
      response.once("end", () => {
        const bodyBytes = Buffer.concat(chunks);
        const text = bodyBytes.toString("utf8");
        let json = null;
        if (text.length > 0) {
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
        }
        try {
          if (state !== undefined) {
            recordResponseBeforeStatus(
              state,
              {
                status,
                headers: response.headers,
                rawHeaders: [...response.rawHeaders],
                bodyBytes,
                text,
                json,
              },
              { expectedStatus: 401, label: "websocket-replay" },
            );
          }
          finish(() => resolveStatus({ status, bytes }));
        } catch (error) {
          finish(() => rejectStatus(error));
        }
      });
      response.resume();
    });
    socket.once("open", () => {
      fail("WebSocket replay unexpectedly authorized");
    });
    socket.once("error", () => {
      if (!responseOwned) fail("WebSocket replay failed");
    });
    socket.once("close", () => {
      if (!responseOwned) fail("WebSocket replay failed");
    });
  });
}

async function waitForWebSocketClose(socket) {
  return Promise.race([
    new Promise((resolveClose) => {
      socket.once("close", (code) => resolveClose(code));
    }),
    new Promise((_, rejectClose) => {
      const timer = setTimeout(
        () => rejectClose(new Error("WebSocket revocation deadline exceeded")),
        38_000,
      );
      timer.unref?.();
    }),
  ]);
}

export function validateTfCallbackLocation(location, tfOrigin) {
  let callback;
  try {
    callback = new URL(location);
  } catch {
    throw new Error("TF callback URL is invalid");
  }
  assert(callback.origin === tfOrigin, "TF callback origin is invalid");
  assert(
    callback.pathname === "/api/auth/callback",
    "TF callback path is invalid",
  );
  const keys = [...callback.searchParams.keys()];
  assert(
    keys.length === 2 &&
      new Set(keys).size === 2 &&
      keys.includes("code") &&
      keys.includes("state"),
    "TF callback query is invalid",
  );
  return callback;
}

async function runFlow(state, fixture, signal) {
  state.lifecycleSignal = signal;
  throwIfLifecycleAborted(signal);
  const operatorEmail = `operator-${randomUUID()}@example.test`;
  const memberEmail = `member-${randomUUID()}@example.test`;
  const operatorPassword = generatedSecret();
  const memberPassword = generatedSecret();
  state.rawSecrets.push(operatorPassword, memberPassword);

  smokeStage = "registration-closed";
  const registration = await jsonCall(
    state,
    state.platformOrigin,
    "/v1/registration",
    { label: "registration-closed" },
  );
  assert.deepEqual(registration.json, { mode: "closed" });

  smokeStage = "operator-bootstrap";
  await jsonCall(state, state.platformOrigin, "/v1/operator/bootstrap", {
    method: "POST",
    status: 201,
    body: {
      bootstrapToken: fixture.operatorBootstrapToken,
      email: operatorEmail,
      displayName: "Bridge Operator",
      password: operatorPassword,
      reason: "Task 9 local bridge smoke",
    },
    label: "operator-bootstrap",
  });

  smokeStage = "operator-login";
  const operatorLogin = await jsonCall(
    state,
    state.platformOrigin,
    "/v1/operator/sessions",
    {
      method: "POST",
      jar: state.operatorCookies,
      body: { email: operatorEmail, password: operatorPassword },
      redact: ["csrfToken"],
      label: "operator-login",
    },
  );
  state.operatorCsrf = operatorLogin.json.csrfToken;
  assert.equal(typeof state.operatorCsrf, "string");
  state.rawSecrets.push(
    state.operatorCsrf,
    ...state.operatorCookies.secretValues(),
  );

  smokeStage = "registration-invite-only";
  await jsonCall(
    state,
    state.platformOrigin,
    "/v1/operator/registration-settings",
    {
      method: "PATCH",
      jar: state.operatorCookies,
      headers: protectedOperatorHeaders(state),
      body: { mode: "invite_only", reason: "Task 9 bridge invitation" },
      label: "registration-invite-only",
    },
  );

  smokeStage = "invitation-create";
  const invitation = await jsonCall(
    state,
    state.platformOrigin,
    "/v1/operator/invitations",
    {
      method: "POST",
      status: 201,
      jar: state.operatorCookies,
      headers: protectedOperatorHeaders(state),
      body: {
        email: memberEmail,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        usesLimit: 1,
        moduleKeys: ["tf.search"],
        reason: "Task 9 bridge member",
      },
      redact: ["invitationToken"],
      label: "invitation-create",
    },
  );
  const invitationToken = invitation.json.invitationToken;
  assert.equal(typeof invitationToken, "string");
  state.rawSecrets.push(invitationToken);

  smokeStage = "member-register";
  const registered = await jsonCall(
    state,
    state.platformOrigin,
    "/v1/registrations",
    {
      method: "POST",
      status: 202,
      body: {
        email: memberEmail,
        displayName: "Bridge Member",
        password: memberPassword,
        invitationToken,
      },
      redact: ["verificationToken"],
      label: "member-register",
    },
  );
  const accountId = registered.json.account.id;
  const verificationToken = registered.json.verificationToken;
  assert.equal(typeof accountId, "string");
  assert.equal(typeof verificationToken, "string");
  state.rawSecrets.push(verificationToken);

  smokeStage = "member-verify";
  await jsonCall(
    state,
    state.platformOrigin,
    "/v1/email-verifications/consume",
    {
      method: "POST",
      body: { token: verificationToken },
      label: "member-verify",
    },
  );

  smokeStage = "search-grant";
  await mutateEntitlement(state, accountId, "tf.search", "PUT");

  smokeStage = "member-activate";
  await jsonCall(
    state,
    state.platformOrigin,
    `/v1/operator/accounts/${accountId}/activate`,
    {
      method: "POST",
      jar: state.operatorCookies,
      headers: protectedOperatorHeaders(state),
      body: { reason: "Task 9 bridge activation" },
      label: "member-activate",
    },
  );

  smokeStage = "portal-login";
  const portal = await jsonCall(state, state.platformOrigin, "/v1/sessions", {
    method: "POST",
    jar: state.portalCookies,
    body: { email: memberEmail, password: memberPassword },
    redact: ["csrfToken"],
    label: "portal-login",
  });
  assert.equal(portal.json.accountId, accountId);
  state.rawSecrets.push(
    portal.json.csrfToken,
    ...state.portalCookies.secretValues(),
  );

  smokeStage = "tf-auth-start";
  const authStart = recordResponseBeforeStatus(
    state,
    await secureRequest(state.ca, state.tfOrigin, "/api/auth/start", {
      signal,
    }),
    {
      expectedStatus: 303,
      label: "tf-auth-start",
      cookieNames: PERMITTED_RESPONSE_COOKIE_NAMES,
      locationQueryParameters: [
        "code_challenge",
        "installation_id",
        "nonce",
        "state",
      ],
      redactExactRedirectBody: true,
    },
  );
  state.tfCookies.ingest(authStart);
  state.rawSecrets.push(
    ...state.tfCookies.secretValues(PUBLIC_TF_COOKIE_NAMES),
  );
  const authorizationLocation = authStart.headers.location;
  assert.equal(typeof authorizationLocation, "string");
  const authorizationUrl = new URL(authorizationLocation);
  assert.equal(authorizationUrl.origin, state.platformOrigin);
  assert.equal(authorizationUrl.pathname, "/v1/oauth/authorize");
  assert.deepEqual([...authorizationUrl.searchParams.keys()].sort(), [
    "client_id",
    "code_challenge",
    "code_challenge_method",
    "installation_id",
    "installation_label",
    "nonce",
    "redirect_uri",
    "response_type",
    "state",
  ]);
  assert.equal(authorizationUrl.searchParams.get("client_id"), "apollo-tf-api");
  assert.equal(
    authorizationUrl.searchParams.get("redirect_uri"),
    `${state.tfOrigin}/api/auth/callback`,
  );
  assert.equal(authorizationUrl.searchParams.get("response_type"), "code");
  assert.equal(
    authorizationUrl.searchParams.get("code_challenge_method"),
    "S256",
  );
  assert.equal(
    authorizationUrl.searchParams.get("installation_label"),
    "Apollo TF Web",
  );
  const challenge = authorizationUrl.searchParams.get("code_challenge");
  const stateValue = authorizationUrl.searchParams.get("state");
  const nonce = authorizationUrl.searchParams.get("nonce");
  const installationId = authorizationUrl.searchParams.get("installation_id");
  assert.equal(
    challenge,
    createHash("sha256")
      .update(fixture.pkceVerifier, "ascii")
      .digest("base64url"),
  );
  for (const value of [challenge, stateValue, nonce]) {
    assert.equal(typeof value, "string");
    state.rawSecrets.push(value);
  }
  assert.equal(typeof installationId, "string");
  smokeStage = "platform-authorize";
  const authorize = recordResponseBeforeStatus(
    state,
    await secureRequest(
      state.ca,
      state.platformOrigin,
      `${authorizationUrl.pathname}${authorizationUrl.search}`,
      {
        headers: { Cookie: state.portalCookies.header() },
        signal,
      },
    ),
    {
      expectedStatus: 303,
      label: "platform-authorize",
      cookieNames: PERMITTED_RESPONSE_COOKIE_NAMES,
      locationQueryParameters: ["code", "state"],
      redactExactRedirectBody: true,
    },
  );
  const callbackLocation = authorize.headers.location;
  assert.equal(typeof callbackLocation, "string");
  const callbackUrl = validateTfCallbackLocation(
    callbackLocation,
    state.tfOrigin,
  );
  assert.equal(callbackUrl.searchParams.get("state"), stateValue);
  const code = callbackUrl.searchParams.get("code");
  assert.equal(typeof code, "string");
  state.rawSecrets.push(code);
  smokeStage = "tf-auth-callback";
  const callback = recordResponseBeforeStatus(
    state,
    await secureRequest(
      state.ca,
      state.tfOrigin,
      `${callbackUrl.pathname}${callbackUrl.search}`,
      {
        headers: { Cookie: state.tfCookies.header() },
        signal,
      },
    ),
    {
      expectedStatus: 303,
      label: "tf-auth-callback",
      cookieNames: PERMITTED_RESPONSE_COOKIE_NAMES,
    },
  );
  state.tfCookies.ingest(callback);
  assert.equal(callback.headers.location, state.tfOrigin);
  state.rawSecrets.push(
    ...state.tfCookies.secretValues(PUBLIC_TF_COOKIE_NAMES),
  );

  smokeStage = "code-replay";
  const basic = Buffer.from(
    `apollo-tf-api:${fixture.oauthClientSecret}`,
    "utf8",
  ).toString("base64");
  const replayBody = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: `${state.tfOrigin}/api/auth/callback`,
    code_verifier: fixture.pkceVerifier,
  }).toString();
  const replay = recordResponseBeforeStatus(
    state,
    await secureRequest(state.ca, state.platformOrigin, "/v1/oauth/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: replayBody,
      signal,
    }),
    {
      expectedStatus: 400,
      label: "code-replay",
    },
  );
  const unknownCode = generatedSecret(48);
  state.rawSecrets.push(unknownCode);
  const unknown = recordResponseBeforeStatus(
    state,
    await secureRequest(state.ca, state.platformOrigin, "/v1/oauth/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: unknownCode,
        redirect_uri: `${state.tfOrigin}/api/auth/callback`,
        code_verifier: fixture.pkceVerifier,
      }).toString(),
      signal,
    }),
    {
      expectedStatus: 400,
      label: "code-unknown",
    },
  );
  assert.deepEqual(
    normalizedPublicError(replay),
    normalizedPublicError(unknown),
  );
  assert.equal(replay.json.error, "invalid_grant");
  smokeStage = "tf-session";
  const me = await jsonCall(state, state.tfOrigin, "/api/auth/me", {
    jar: state.tfCookies,
    origin: state.tfOrigin,
    label: "tf-session",
  });
  assert.equal(me.json.accountId, accountId);
  assert(me.json.entitlements.includes("tf.search"));

  const downloadBody = {
    tracks: [{ trackId: "smoke-invalid-track" }],
  };
  const downloadRequest = async (status, label) =>
    jsonCall(state, state.tfOrigin, "/api/tracks/download/queue", {
      method: "POST",
      status,
      jar: state.tfCookies,
      origin: state.tfOrigin,
      body: downloadBody,
      label,
    });

  smokeStage = "download-denied";
  const denied = await downloadRequest(403, "download-denied");
  assert.deepEqual(denied.json, { error: "module_access_denied" });

  smokeStage = "download-grant";
  await mutateEntitlement(state, accountId, "tf.downloads", "PUT");
  const allowed = await downloadRequest(200, "download-allowed");
  assert.deepEqual(allowed.json, {
    results: [
      {
        trackId: "smoke-invalid-track",
        error: "Could not resolve a trusted source URL for this track",
      },
    ],
  });

  smokeStage = "download-revoke";
  await mutateEntitlement(state, accountId, "tf.downloads", "DELETE");
  const revoked = await downloadRequest(403, "download-revoked");
  assert.deepEqual(revoked.json, { error: "module_access_denied" });

  smokeStage = "websocket-ticket";
  const ticketResponse = recordResponseBeforeStatus(
    state,
    await secureRequest(state.ca, state.tfOrigin, "/api/ws/tickets", {
      method: "POST",
      headers: {
        Cookie: state.tfCookies.header(),
        Origin: state.tfOrigin,
        "Content-Length": "0",
      },
      signal,
    }),
    {
      expectedStatus: 201,
      label: "websocket-ticket",
      bodyFields: ["ticket"],
    },
  );
  const ticket = ticketResponse.json.ticket;
  assert.equal(typeof ticket, "string");
  state.rawSecrets.push(ticket);
  const websocketUrl =
    state.tfOrigin.replace("https://", "wss://") + `/api/ws?ticket=${ticket}`;
  const socket = await openWebSocket(websocketUrl, state.ca);
  try {
    smokeStage = "websocket-replay";
    const replayUpgrade = await rejectedWebSocketStatus(
      websocketUrl,
      state.ca,
      state,
    );
    assert.deepEqual(replayUpgrade, { status: 401, bytes: 0 });

    smokeStage = "account-suspend";
    const close = waitForWebSocketClose(socket);
    await jsonCall(
      state,
      state.platformOrigin,
      `/v1/operator/accounts/${accountId}/suspend`,
      {
        method: "POST",
        jar: state.operatorCookies,
        headers: protectedOperatorHeaders(state),
        body: { reason: "Task 9 WebSocket revocation" },
        label: "account-suspend",
      },
    );
    assert.equal(await close, 4403);
  } finally {
    if (
      socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING
    ) {
      socket.terminate();
    }
  }

  smokeStage = "projection-secret-scan";
  for (const projection of state.projections) {
    assertResponseProjectionSecretFree(projection, state.rawSecrets);
  }
  assertSecretFree(
    JSON.stringify(state.projections),
    state.rawSecrets,
    "sanitized response projections",
  );
  await assertTrackedFilesSecretFree(state.rawSecrets);
}

function throwIfLifecycleAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("Bridge smoke lifecycle deadline exceeded");
}

export async function runBridgeLifecycle(dependencies, options = {}) {
  const signal = options.signal;
  let failure;
  try {
    throwIfLifecycleAborted(signal);
    dependencies.setStage?.("compose-config");
    const configured = await dependencies.compose(
      ["config", "--format", "json"],
      { signal },
    );
    throwIfLifecycleAborted(signal);
    dependencies.validateConfig(`${configured.stdout}\n${configured.stderr}`);
    dependencies.setStage?.("compose-build");
    await dependencies.compose(["build"], { signal });
    throwIfLifecycleAborted(signal);
    dependencies.setStage?.("compose-up");
    await dependencies.compose(
      ["up", "-d", "--wait", "--wait-timeout", "120"],
      { signal },
    );
    throwIfLifecycleAborted(signal);
    dependencies.setStage?.("readiness");
    await dependencies.waitForReadiness(signal);
    throwIfLifecycleAborted(signal);
    dependencies.setStage?.("flow");
    await dependencies.runFlow(signal);
    throwIfLifecycleAborted(signal);
    dependencies.setStage?.("compose-logs");
    const logs = await dependencies.compose(
      ["logs", "--no-color", ...EXPECTED_SERVICES],
      { signal },
    );
    throwIfLifecycleAborted(signal);
    dependencies.scanLogs(`${logs.stdout}\n${logs.stderr}`);
  } catch (error) {
    failure = error;
    if (
      process.env.APOLLO_BRIDGE_SMOKE_DIAGNOSTICS === "true" &&
      !signal?.aborted
    ) {
      try {
        const diagnosticLogs = await dependencies.compose([
          "logs",
          "--no-color",
          "tf-api",
        ]);
        failure = new Error(
          `${error instanceof Error ? error.message : "bridge failure"}\n` +
            `${diagnosticLogs.stdout}\n${diagnosticLogs.stderr}`,
        );
      } catch {
        // Keep the original failure when diagnostic log collection fails.
      }
    }
  } finally {
    try {
      if (failure === undefined) dependencies.setStage?.("compose-down");
      await dependencies.compose([
        "down",
        "--volumes",
        "--remove-orphans",
        "--timeout",
        "10",
      ]);
    } catch (cleanupError) {
      if (failure === undefined) failure = cleanupError;
    }
  }
  if (failure !== undefined) throw failure;
}

async function auditDockerCleanup(environment) {
  const project = environment.COMPOSE_PROJECT_NAME;
  for (const args of [
    ["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`],
    [
      "network",
      "ls",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${project}`,
    ],
    [
      "volume",
      "ls",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${project}`,
    ],
  ]) {
    const { stdout } = await runBoundedCommand("docker", args, {
      cwd: repositoryRoot,
      env: environment,
      maxBuffer: 1024 * 1024,
      timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    });
    assert.equal(stdout.trim(), "", "Bridge Docker cleanup incomplete");
  }
}

async function main() {
  const startedAt = Date.now();
  smokeStage = "docker-context";
  const environment = await resolveLocalDockerEnvironment(
    configuredEnvironment(),
  );
  let directory;
  let platformProxy;
  let tfProxy;
  let failure;
  let diagnosticSecrets = [];
  const commandOutput = [];
  try {
    smokeStage = "openssl";
    directory = await mkdtemp(join(tmpdir(), "apollo-platform-tf-bridge-tls-"));
    await chmod(directory, 0o700);
    const tls = await generateTlsMaterials(directory);
    const platformApiPort = await freeLoopbackPort();
    const tfApiPort = await freeLoopbackPort();
    platformProxy = await startTlsProxy(platformApiPort, tls);
    tfProxy = await startTlsProxy(tfApiPort, tls);
    environment.PLATFORM_API_PORT = String(platformApiPort);
    environment.TF_API_PORT = String(tfApiPort);
    environment.PLATFORM_PUBLIC_ORIGIN = platformProxy.origin;
    environment.TF_PUBLIC_ORIGIN = tfProxy.origin;
    environment.PLATFORM_ALLOWED_ORIGINS = `${platformProxy.origin},${tfProxy.origin}`;

    smokeStage = "secret-preparation";
    const fixture = await prepareSecretDirectory(environment, tfProxy.origin);
    const state = {
      ca: tls.ca,
      platformOrigin: platformProxy.origin,
      tfOrigin: tfProxy.origin,
      operatorCookies: new CookieJar(),
      portalCookies: new CookieJar(),
      tfCookies: new CookieJar(),
      operatorCsrf: "",
      projections: [],
      rawSecrets: [
        ...fixture.rawSecrets,
        tls.caPrivateKey,
        tls.serverPrivateKey,
      ],
    };
    diagnosticSecrets = state.rawSecrets;

    const composeRunner = async (args, options = {}) => {
      const result = await compose(environment, args, options);
      commandOutput.push(`${result.stdout}\n${result.stderr}`);
      return result;
    };
    await runWithLifecycleDeadline(
      (signal) =>
        runBridgeLifecycle(
          {
            compose: composeRunner,
            setStage: (stage) => {
              smokeStage = stage;
            },
            validateConfig: (output) =>
              validateRenderedBridgeConfig(
                output,
                state.rawSecrets,
                fixture.directory,
              ),
            waitForReadiness: async (signal) => {
              smokeStage = "readiness";
              await waitForReadiness(state, signal);
              smokeStage = "mounted-secret-readability";
              await proveMountedSecretsReadable(environment, signal);
            },
            runFlow: async (signal) => runFlow(state, fixture, signal),
            scanLogs: (output) =>
              assertSecretFree(output, state.rawSecrets, "container logs"),
          },
          { signal },
        ),
      BRIDGE_SMOKE_TIMEOUTS.lifecycleMs,
    );
    smokeStage = "command-output-secret-scan";
    assertSecretFree(
      commandOutput.join("\n"),
      state.rawSecrets,
      "Compose command output",
    );
    await auditDockerCleanup(environment);
  } catch (error) {
    failure = error;
    if (process.env.APOLLO_BRIDGE_SMOKE_DIAGNOSTICS === "true") {
      process.stderr.write(
        `${sanitizedDiagnostic(error, diagnosticSecrets)}\n`,
      );
    }
  } finally {
    const cleanupFailures = [];
    const proxyResults = await Promise.allSettled(
      [platformProxy, tfProxy]
        .filter((proxy) => proxy !== undefined)
        .map((proxy) => proxy.close()),
    );
    cleanupFailures.push(
      ...proxyResults
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason),
    );
    for (const temporaryDirectory of [
      environment.BRIDGE_SECRET_DIRECTORY,
      directory,
    ]) {
      if (temporaryDirectory === undefined) continue;
      try {
        await removeVerifiedDirectory(temporaryDirectory);
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
    }
    try {
      await auditDockerCleanup(environment);
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError);
    }
    if (cleanupFailures.length > 0) {
      const cleanupFailure =
        cleanupFailures.length === 1
          ? cleanupFailures[0]
          : new AggregateError(cleanupFailures, "Bridge cleanup failed");
      failure =
        failure === undefined
          ? cleanupFailure
          : new AggregateError(
              [failure, cleanupFailure],
              "Bridge execution and cleanup failed",
            );
    }
  }
  if (failure !== undefined) throw failure;
  process.stdout.write(
    "Bridge smoke passed: closed, portal, PKCE, replay, grant, revoke, WebSocket\n",
  );
  process.stdout.write(
    `Bridge smoke time: ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main().catch(() => {
    process.stderr.write(`Bridge smoke failed at ${smokeStage}\n`);
    process.exitCode = 1;
  });
}
