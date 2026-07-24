import { execFile } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
} from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const composeFile = fileURLToPath(
  new URL("../docker-compose.yml", import.meta.url),
);
const smokeScript = fileURLToPath(
  new URL("../scripts/smoke.mjs", import.meta.url),
);
const contractSecrets = Object.freeze({
  PLATFORM_OPERATOR_BOOTSTRAP_TOKEN: "contract-bootstrap-secret",
  PLATFORM_POSTGRES_ADMIN_PASSWORD: "contract-admin-password",
  PLATFORM_MIGRATOR_DATABASE_URL:
    "postgres://apollo_platform_migrator:contract-migrator-password@platform-postgres:5432/apollo_platform",
  PLATFORM_MIGRATOR_PASSWORD: "contract-migrator-password",
  PLATFORM_RUNTIME_DATABASE_URL:
    "postgres://apollo_platform_runtime:contract-runtime-password@platform-postgres:5432/apollo_platform",
  PLATFORM_RUNTIME_PASSWORD: "contract-runtime-password",
  PLATFORM_SMOKE_SESSION_TOKEN: "contract-smoke-session-token",
});

function composeEnvironment(secretDirectory: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...contractSecrets,
    COMPOSE_PROJECT_NAME: "apollo-platform-contract",
    PLATFORM_ALLOWED_ORIGINS: "http://127.0.0.1:18081",
    PLATFORM_API_PORT: "18081",
    PLATFORM_SECRET_DIRECTORY: secretDirectory,
  };
}

async function renderedCompose(): Promise<Record<string, unknown>> {
  const secretDirectory = await mkdtemp(
    join(tmpdir(), "apollo-platform-contract-"),
  );
  try {
    await Promise.all(
      [
        "platform_assertion_private_jwk",
        "platform_assertion_public_jwks",
        "platform_migrator_database_url",
        "platform_oauth_clients",
        "platform_operator_bootstrap_token",
        "platform_runtime_database_url",
        "platform_smoke_session_token",
      ].map((name) => writeFile(join(secretDirectory, name), name, "utf8")),
    );
    const { stdout } = await execFileAsync(
      "docker",
      [
        "compose",
        "-f",
        composeFile,
        "--profile",
        "smoke",
        "config",
        "--format",
        "json",
      ],
      {
        cwd: repositoryRoot,
        env: composeEnvironment(secretDirectory),
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    for (const secret of Object.values(contractSecrets)) {
      expect(stdout).not.toContain(secret);
    }
    return JSON.parse(stdout) as Record<string, unknown>;
  } finally {
    await rm(secretDirectory, { force: true, recursive: true });
  }
}

type FakeDockerRecord = {
  args: string[];
  command: string;
  composeBake: string;
  dockerContext: string;
  dockerHost: string;
  effectiveProject: string;
  inheritedCredentials: boolean;
  inheritedDatabaseUrls: boolean;
  inheritedSecretDirectory: boolean;
  migratorUrl: { database?: string; hostname?: string; username?: string };
  runtimeUrl: { database?: string; hostname?: string; username?: string };
};

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function fakeDockerExecutable(directory: string): Promise<string> {
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
  return executable;
}

async function runSmokeWithFakeDocker(
  environmentOverrides: NodeJS.ProcessEnv = {},
): Promise<{
  exfiltrationAttempted: boolean;
  records: FakeDockerRecord[];
  sentinelExists: boolean;
}> {
  const directory = await mkdtemp(join(tmpdir(), "apollo-smoke-boundary-"));
  const binDirectory = join(directory, "bin");
  const logPath = join(directory, "docker-invocations.jsonl");
  const sentinelPath = join(directory, "existing-project.sentinel");
  const exfiltrationPath = join(directory, "repository-exfiltration.attempted");
  const inheritedSecretDirectory = join(directory, "hostile-secret-directory");
  const hookPath = join(directory, "fake-docker.cjs");
  await mkdir(binDirectory);
  await fakeDockerExecutable(binDirectory);
  await writeFile(sentinelPath, "existing project must survive", "utf8");
  await writeFile(
    hookPath,
    String.raw`
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(1);
const executableArgument = path.basename(args[0] ?? "");
if (executableArgument === "compose" || executableArgument === "context") {
args[0] = executableArgument;
const env = process.env;
const projectIndex = args.indexOf("-p");
const effectiveProject = projectIndex === -1 ? env.COMPOSE_PROJECT_NAME ?? "" : args[projectIndex + 1] ?? "";
const command = args[0] === "context" ? "context" : ["config", "ps", "up", "down"].find((value) => args.includes(value)) ?? "other";
function environmentValue(name) {
  const entry = Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1] ?? "";
}
function urlShape(name) {
  try {
    const value = new URL(env[name]);
    return { database: value.pathname.replace(/^\//, ""), hostname: value.hostname, username: value.username };
  } catch {
    return {};
  }
}
const record = {
  args,
  command,
  composeBake: environmentValue("COMPOSE_BAKE"),
  dockerContext: environmentValue("DOCKER_CONTEXT"),
  dockerHost: environmentValue("DOCKER_HOST"),
  effectiveProject,
  inheritedCredentials: [
    ["PLATFORM_POSTGRES_ADMIN_PASSWORD", "HOSTILE_POSTGRES_ADMIN_PASSWORD"],
    ["PLATFORM_MIGRATOR_PASSWORD", "HOSTILE_MIGRATOR_PASSWORD"],
    ["PLATFORM_RUNTIME_PASSWORD", "HOSTILE_RUNTIME_PASSWORD"],
    ["PLATFORM_OPERATOR_BOOTSTRAP_TOKEN", "HOSTILE_BOOTSTRAP_TOKEN"],
    ["PLATFORM_SMOKE_SESSION_TOKEN", "HOSTILE_SESSION_TOKEN"],
  ].some(([actual, hostile]) => env[actual] === env[hostile]),
  inheritedDatabaseUrls:
    env.PLATFORM_MIGRATOR_DATABASE_URL === env.HOSTILE_MIGRATOR_DATABASE_URL ||
    env.PLATFORM_RUNTIME_DATABASE_URL === env.HOSTILE_RUNTIME_DATABASE_URL,
  inheritedSecretDirectory: env.PLATFORM_SECRET_DIRECTORY === env.HOSTILE_SECRET_DIRECTORY,
  migratorUrl: urlShape("PLATFORM_MIGRATOR_DATABASE_URL"),
  runtimeUrl: urlShape("PLATFORM_RUNTIME_DATABASE_URL"),
};
fs.appendFileSync(env.FAKE_DOCKER_LOG, JSON.stringify(record) + "\n");
const buildSelectors = [
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
];
if (args[0] === "compose" && buildSelectors.some((name) => {
  const value = environmentValue(name);
  return value.length > 0 && !(name === "COMPOSE_BAKE" && value === "false");
})) {
  fs.writeFileSync(env.FAKE_EXFILTRATION_SENTINEL, "unsafe build route reached compose");
}
if (command === "context") {
  if (args.includes("show")) {
    process.stdout.write("local-context");
  } else {
    const endpoint = args.includes("remote-context")
      ? "tcp://remote.example:2375"
      : "npipe:////./pipe/docker_engine";
    process.stdout.write(JSON.stringify(endpoint));
  }
  process.exit(0);
}
if (command === "config") {
  process.stdout.write("{}");
  process.exit(0);
}
if (command === "up") process.exit(42);
if (command === "down") {
  if (effectiveProject === env.HOSTILE_PROJECT_NAME) {
    fs.rmSync(env.FAKE_EXISTING_PROJECT_SENTINEL, { force: true });
  }
  process.exit(0);
}
process.exit(0);
}
`,
    "utf8",
  );

  const hostile = {
    HOSTILE_BOOTSTRAP_TOKEN: "inherited-bootstrap-token",
    HOSTILE_MIGRATOR_DATABASE_URL:
      "postgres://wrong_migrator:inherited@remote.example:5432/production",
    HOSTILE_MIGRATOR_PASSWORD: "inherited-migrator-password",
    HOSTILE_POSTGRES_ADMIN_PASSWORD: "inherited-admin-password",
    HOSTILE_PROJECT_NAME: "existing-platform-project",
    HOSTILE_RUNTIME_DATABASE_URL:
      "postgres://wrong_runtime:inherited@remote.example:5432/production",
    HOSTILE_RUNTIME_PASSWORD: "inherited-runtime-password",
    HOSTILE_SECRET_DIRECTORY: inheritedSecretDirectory,
    HOSTILE_SESSION_TOKEN: "inherited-session-token",
  };
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ...hostile,
    COMPOSE_PROJECT_NAME: hostile.HOSTILE_PROJECT_NAME,
    FAKE_DOCKER_LOG: logPath,
    FAKE_EXISTING_PROJECT_SENTINEL: sentinelPath,
    FAKE_EXFILTRATION_SENTINEL: exfiltrationPath,
    NODE_OPTIONS: `--require=${hookPath}`,
    PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`,
    PLATFORM_MIGRATOR_DATABASE_URL: hostile.HOSTILE_MIGRATOR_DATABASE_URL,
    PLATFORM_MIGRATOR_PASSWORD: hostile.HOSTILE_MIGRATOR_PASSWORD,
    PLATFORM_OPERATOR_BOOTSTRAP_TOKEN: hostile.HOSTILE_BOOTSTRAP_TOKEN,
    PLATFORM_POSTGRES_ADMIN_PASSWORD: hostile.HOSTILE_POSTGRES_ADMIN_PASSWORD,
    PLATFORM_RUNTIME_DATABASE_URL: hostile.HOSTILE_RUNTIME_DATABASE_URL,
    PLATFORM_RUNTIME_PASSWORD: hostile.HOSTILE_RUNTIME_PASSWORD,
    PLATFORM_SECRET_DIRECTORY: hostile.HOSTILE_SECRET_DIRECTORY,
    PLATFORM_SMOKE_SESSION_TOKEN: hostile.HOSTILE_SESSION_TOKEN,
  };
  for (const selector of ["docker_context", "docker_host"]) {
    for (const name of Object.keys(environment)) {
      if (name.toLowerCase() === selector) delete environment[name];
    }
  }
  environment.DOCKER_CONTEXT = "";
  environment.DOCKER_HOST = "";
  for (const [name, value] of Object.entries(environmentOverrides)) {
    const normalized = name.toLowerCase();
    if (normalized === "docker_context" || normalized === "docker_host") {
      for (const current of Object.keys(environment)) {
        if (current.toLowerCase() === normalized) delete environment[current];
      }
    }
    environment[name] = value;
  }
  for (const name of Object.keys(environment)) {
    if (name.toLowerCase() === "path") delete environment[name];
  }
  environment.PATH = `${binDirectory}${delimiter}${process.env.PATH ?? process.env.Path ?? ""}`;

  try {
    await expect(
      execFileAsync(process.execPath, [smokeScript], {
        cwd: repositoryRoot,
        env: environment,
        timeout: 10_000,
      }),
    ).rejects.toBeDefined();
    const log = (await pathExists(logPath))
      ? await readFile(logPath, "utf8")
      : "";
    const records = log
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FakeDockerRecord);
    return {
      exfiltrationAttempted: await pathExists(exfiltrationPath),
      records,
      sentinelExists: await pathExists(sentinelPath),
    };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function service(
  config: Record<string, unknown>,
  name: string,
): Record<string, unknown> {
  const services = config.services as Record<string, Record<string, unknown>>;
  const value = services[name];
  if (value === undefined) throw new Error(`Missing Compose service: ${name}`);
  return value;
}

describe("platform container contract", () => {
  test("isolates every smoke lifecycle from a hostile inherited Compose project", async () => {
    const { exfiltrationAttempted, records, sentinelExists } =
      await runSmokeWithFakeDocker();
    const contextRecords = records.filter(
      ({ command }) => command === "context",
    );
    const composeRecords = records.filter(({ args }) => args[0] === "compose");

    expect(sentinelExists).toBe(true);
    expect(exfiltrationAttempted).toBe(false);
    expect(contextRecords.map(({ args }) => args.slice(1, 4))).toEqual([
      ["show"],
      ["inspect", "local-context", "--format"],
    ]);
    expect(contextRecords[0]).toMatchObject({
      dockerContext: "",
      dockerHost: "",
    });
    expect(contextRecords[1]).toMatchObject({
      dockerContext: "local-context",
      dockerHost: "",
    });
    expect(composeRecords.map(({ command }) => command)).toEqual([
      "config",
      "up",
      "down",
    ]);
    const projects = new Set(
      composeRecords.map(({ effectiveProject }) => effectiveProject),
    );
    expect(projects.size).toBe(1);
    const [project] = projects;
    expect(project).toMatch(/^apollo-platform-smoke-\d+-[a-f0-9]{8}$/);
    expect(project).not.toBe("existing-platform-project");
    for (const record of composeRecords) {
      expect(record.args).toContain("-p");
      expect(record.args[record.args.indexOf("-p") + 1]).toBe(project);
      expect(record.dockerContext).toBe("local-context");
      expect(record.dockerHost).toBe("");
      expect(record.composeBake).toBe("false");
    }
  });

  test("replaces inherited credentials, database URLs, and secret paths", async () => {
    const { records } = await runSmokeWithFakeDocker();
    const composeRecords = records.filter(({ args }) => args[0] === "compose");

    expect(composeRecords.length).toBeGreaterThan(0);
    for (const record of composeRecords) {
      expect(record.inheritedCredentials).toBe(false);
      expect(record.inheritedDatabaseUrls).toBe(false);
      expect(record.inheritedSecretDirectory).toBe(false);
      expect(record.migratorUrl).toEqual({
        database: "apollo_platform",
        hostname: "platform-postgres",
        username: "apollo_platform_migrator",
      });
      expect(record.runtimeUrl).toEqual({
        database: "apollo_platform",
        hostname: "platform-postgres",
        username: "apollo_platform_runtime",
      });
    }
  });

  test("refuses a remote Docker host before invoking Docker", async () => {
    const { records, sentinelExists } = await runSmokeWithFakeDocker({
      DOCKER_HOST: "tcp://remote.example:2375",
    });

    expect(records).toEqual([]);
    expect(sentinelExists).toBe(true);
  });

  test("gives a remote Docker context precedence over a local Docker host", async () => {
    const { records, sentinelExists } = await runSmokeWithFakeDocker({
      DOCKER_CONTEXT: "remote-context",
      DOCKER_HOST: "npipe:////./pipe/docker_engine",
    });

    expect(records.map(({ command }) => command)).toEqual(["context"]);
    expect(records[0]).toMatchObject({
      dockerContext: "remote-context",
      dockerHost: "",
    });
    expect(records.some(({ args }) => args[0] === "compose")).toBe(false);
    expect(sentinelExists).toBe(true);
  });

  test("recognizes a mixed-case remote Docker context before mutation", async () => {
    const { records, sentinelExists } = await runSmokeWithFakeDocker({
      Docker_Context: "remote-context",
      Docker_Host: "npipe:////./pipe/docker_engine",
    });

    expect(records.map(({ command }) => command)).toEqual(["context"]);
    expect(records[0]).toMatchObject({
      dockerContext: "remote-context",
      dockerHost: "",
    });
    expect(records.some(({ args }) => args[0] === "compose")).toBe(false);
    expect(sentinelExists).toBe(true);
  });

  test("rejects conflicting case-insensitive Docker selector keys", async () => {
    const runner = String.raw`
const module = await import(process.env.SMOKE_MODULE_URL);
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
          SMOKE_MODULE_URL: new URL("../scripts/smoke.mjs", import.meta.url)
            .href,
        },
      },
    );

    expect(stderr).toBe("");
    expect(stdout).toBe("Conflicting Docker selector environment");
  });

  test.each([
    ["BUILDKIT_HOST", "tcp://remote-builder.example:1234"],
    ["Buildx_Builder", "remote-builder"],
    ["BUILDX_CONFIG", "/tmp/hostile-buildx-config"],
    ["BUILDX_BAKE_FILE", "https://attacker.example/compose.hcl"],
    ["BUILDX_BAKE_FILE_SEPARATOR", ";"],
    ["BUILDX_BAKE_GIT_AUTH_HEADER", "authorization"],
    ["BUILDX_BAKE_GIT_AUTH_TOKEN", "attacker-token"],
    ["BUILDX_BAKE_GIT_SSH", "default=/tmp/attacker.sock"],
    ["BUILDX_BAKE_ENTITLEMENTS_FS", "*"],
    ["Compose_Bake", "true"],
    ["DOCKER_CONFIG", "/tmp/hostile-docker-config"],
  ])(
    "rejects inherited build routing selector %s before Docker or repository access",
    async (name, value) => {
      const { exfiltrationAttempted, records, sentinelExists } =
        await runSmokeWithFakeDocker({
          DOCKER_HOST: "npipe:////./pipe/docker_engine",
          [name]: value,
        });

      expect(records).toEqual([]);
      expect(exfiltrationAttempted).toBe(false);
      expect(sentinelExists).toBe(true);
    },
  );

  test("uses a Debian/glibc multi-stage image with immutable runtime assets", async () => {
    const dockerfile = await readFile(
      new URL("../Dockerfile", import.meta.url),
      "utf8",
    );

    expect(dockerfile).toMatch(/FROM node:20-bookworm-slim AS builder/);
    expect(dockerfile).toMatch(/FROM node:20-bookworm-slim AS runtime/);
    expect(dockerfile).toMatch(/USER 10001:10001/);
    expect(dockerfile).toContain("/app/migrations");
    expect(dockerfile).toContain("argon2");
    expect(dockerfile).not.toContain("--chown=10001");
    expect(dockerfile).not.toMatch(/CMD .*pnpm|ENTRYPOINT .*pnpm/);
    expect(dockerfile).not.toMatch(/COPY .*\.ts/);
  });

  test("renders separate private data, migration, API, and smoke services", async () => {
    const config = await renderedCompose();
    const services = config.services as Record<string, unknown>;
    expect(Object.keys(services).sort()).toEqual([
      "platform-api",
      "platform-migrate",
      "platform-postgres",
      "platform-redis",
      "platform-smoke",
    ]);

    expect(service(config, "platform-postgres").ports).toBeUndefined();
    expect(service(config, "platform-redis").ports).toBeUndefined();
    expect(service(config, "platform-migrate").ports).toBeUndefined();
    expect(service(config, "platform-smoke").ports).toBeUndefined();
    expect(service(config, "platform-api").ports).toEqual([
      expect.objectContaining({
        host_ip: "127.0.0.1",
        published: "18081",
        target: 8080,
      }),
    ]);
  });

  test("gates startup on migration and uses secret files without host mounts", async () => {
    const config = await renderedCompose();
    const api = service(config, "platform-api");
    const migrate = service(config, "platform-migrate");

    expect(api.read_only).toBe(true);
    expect(api.user).toBe("10001:10001");
    expect(api.depends_on).toMatchObject({
      "platform-migrate": { condition: "service_completed_successfully" },
      "platform-redis": { condition: "service_healthy" },
    });
    expect(migrate.depends_on).toMatchObject({
      "platform-postgres": { condition: "service_healthy" },
    });
    expect(
      JSON.stringify(service(config, "platform-postgres").healthcheck),
    ).toContain("pg_isready -h 127.0.0.1 -U postgres -d apollo_platform");
    expect(JSON.stringify(api.healthcheck)).toContain("/healthz");
    expect(JSON.stringify(api.healthcheck)).toContain("/readyz");
    expect(api.environment).not.toHaveProperty("DATABASE_URL");
    expect(migrate.environment).not.toHaveProperty("MIGRATOR_DATABASE_URL");

    const directSecretSources = new Map<string, readonly string[]>([
      [
        "platform-api",
        [
          "platform_assertion_private_jwk",
          "platform_assertion_public_jwks",
          "platform_oauth_clients",
          "platform_operator_bootstrap_token",
          "platform_runtime_database_url",
        ],
      ],
      ["platform-migrate", ["platform_migrator_database_url"]],
      [
        "platform-smoke",
        ["platform_runtime_database_url", "platform_smoke_session_token"],
      ],
    ]);
    for (const [name, sources] of directSecretSources) {
      const current = service(config, name);
      const volumes = (current.volumes ?? []) as Array<Record<string, unknown>>;
      expect(current.secrets).toBeInstanceOf(Array);
      expect(
        (current.secrets as Array<Record<string, unknown>>)
          .map(({ source }) => source)
          .sort(),
      ).toEqual([...sources].sort());
      for (const secret of current.secrets as Array<Record<string, unknown>>) {
        expect(secret).not.toHaveProperty("uid");
        expect(secret).not.toHaveProperty("gid");
        expect(secret).not.toHaveProperty("mode");
      }
      expect(volumes).not.toContainEqual(
        expect.objectContaining({ target: "/run/secrets" }),
      );
    }
    expect(
      Object.keys(config.volumes as Record<string, unknown>).sort(),
    ).toEqual(["platform-postgres-data", "platform-redis-data"]);
    const secrets = config.secrets as Record<string, Record<string, unknown>>;
    for (const name of [
      "platform_assertion_private_jwk",
      "platform_assertion_public_jwks",
      "platform_migrator_database_url",
      "platform_oauth_clients",
      "platform_operator_bootstrap_token",
      "platform_runtime_database_url",
      "platform_smoke_session_token",
    ]) {
      expect(secrets[name].file).toMatch(new RegExp(`${name}$`));
      expect(secrets[name]).not.toHaveProperty("environment");
    }

    expect(api.environment).toMatchObject({
      APOLLO_ASSERTION_PRIVATE_JWK_FILE:
        "/run/secrets/platform_assertion_private_jwk",
      APOLLO_ASSERTION_PUBLIC_JWKS_FILE:
        "/run/secrets/platform_assertion_public_jwks",
      APOLLO_OAUTH_CLIENTS_FILE: "/run/secrets/platform_oauth_clients",
    });
    for (const name of ["platform-migrate", "platform-smoke"]) {
      const serialized = JSON.stringify(service(config, name));
      expect(serialized).not.toContain("platform_assertion_private_jwk");
      expect(serialized).not.toContain("platform_assertion_public_jwks");
      expect(serialized).not.toContain("platform_oauth_clients");
    }

    for (const value of Object.values(
      config.services as Record<string, Record<string, unknown>>,
    )) {
      const volumes = (value.volumes ?? []) as Array<Record<string, unknown>>;
      expect(volumes.every(({ type }) => type !== "bind")).toBe(true);
      expect(JSON.stringify(value)).not.toContain("docker.sock");
      expect(JSON.stringify(value)).not.toContain(".ops-private");
    }
  }, 15_000);

  test("ships hardened role initialization and a one-shot migration entrypoint", async () => {
    const [roleInit, migrationEntrypoint, smoke] = await Promise.all([
      readFile(new URL("../container/init-roles.sh", import.meta.url), "utf8"),
      readFile(new URL("./migrate.ts", import.meta.url), "utf8"),
      readFile(new URL("../scripts/smoke.mjs", import.meta.url), "utf8"),
    ]);

    expect(roleInit).toContain("psql -X -q");
    expect(roleInit).toContain("ON_ERROR_STOP");
    expect(roleInit).toContain("apollo_platform_migrator");
    expect(roleInit).toContain("apollo_platform_runtime");
    expect(roleInit).toContain("\\getenv migrator_password");
    expect(roleInit).not.toMatch(/--set migrator_password/);
    expect(roleInit).toMatch(/NOSUPERUSER/i);
    expect(roleInit).toMatch(/NOBYPASSRLS/i);
    expect(migrationEntrypoint).toContain('"/app/migrations"');
    expect(migrationEntrypoint).toContain("runPlatformMigrations");
    expect(migrationEntrypoint).toContain("finally");
    expect(migrationEntrypoint).not.toContain("platform_assertion_private_jwk");
    expect(migrationEntrypoint).not.toContain("platform_assertion_public_jwks");
    expect(migrationEntrypoint).not.toContain("platform_oauth_clients");
    expect(smoke).not.toMatch(/\/v1\/[a-z0-9_/:.-]*policy[a-z0-9_/:.-]*/i);
    expect(smoke).toContain('const INVITATION_MODULE_KEY = "tf.integrations";');
    expect(smoke).toContain("invitation-entitlement-revoke");
    expect(smoke.indexOf("invitation-entitlement-revoke")).toBeLessThan(
      smoke.indexOf("activation-without-entitlement"),
    );
  });

  test("compares unavailable tokens by their complete public response contract", async () => {
    type SmokeResponse = {
      response: Response;
      body: Record<string, unknown>;
    };
    const smokeModule = (await import(
      new URL("../scripts/smoke.mjs", import.meta.url).href
    )) as {
      observableResponseContract?: (value: SmokeResponse) => unknown;
    };
    expect(smokeModule.observableResponseContract).toBeTypeOf("function");
    const observableResponseContract = smokeModule.observableResponseContract!;
    const unavailable = {
      response: new Response(null, {
        status: 409,
        headers: { "x-request-id": "request-a" },
      }),
      body: {
        error: "invitation_not_available",
        requestId: "request-a",
      },
    };
    const unknown = {
      response: new Response(null, {
        status: 409,
        headers: { "x-request-id": "request-b" },
      }),
      body: {
        error: "invitation_not_available",
        requestId: "request-b",
      },
    };

    expect(observableResponseContract(unavailable)).toEqual({
      status: 409,
      body: {
        error: "invitation_not_available",
        requestId: "<request-id>",
      },
    });
    expect(observableResponseContract(unknown)).toEqual(
      observableResponseContract(unavailable),
    );

    const smoke = await readFile(
      new URL("../scripts/smoke.mjs", import.meta.url),
      "utf8",
    );
    expect(smoke).toContain("invitation-consumed-contract");
    expect(smoke).toContain("invitation-unknown-contract");
    expect(smoke).toContain("verification-consumed-contract");
    expect(smoke).toContain("verification-unknown-contract");
    expect(smoke).toMatch(
      /observableResponseContract\(unknownInvitation\)[\s\S]*observableResponseContract\(consumedInvitation\)/,
    );
    expect(smoke).toMatch(
      /observableResponseContract\(unknownVerification\)[\s\S]*observableResponseContract\(consumedVerification\)/,
    );
  });

  test("prepares Linux-readable secret files under a private host directory", async () => {
    const smokeModule = (await import(
      new URL("../scripts/smoke.mjs", import.meta.url).href
    )) as {
      prepareSecretDirectory?: (
        environment: Record<string, string>,
      ) => Promise<{
        directory: string;
        rawSecretCanaries: {
          assertionPrivateKey: string;
          oauthClientSecret: string;
        };
      }>;
    };
    expect(smokeModule.prepareSecretDirectory).toBeTypeOf("function");
    const environment: Record<string, string> = {
      PLATFORM_MIGRATOR_DATABASE_URL: "migrator-url",
      PLATFORM_OPERATOR_BOOTSTRAP_TOKEN: "bootstrap-token",
      PLATFORM_RUNTIME_DATABASE_URL: "runtime-url",
      PLATFORM_SMOKE_SESSION_TOKEN: "session-token",
    };
    const expectedLegacy = new Map([
      ["platform_migrator_database_url", "migrator-url"],
      ["platform_operator_bootstrap_token", "bootstrap-token"],
      ["platform_runtime_database_url", "runtime-url"],
      ["platform_smoke_session_token", "session-token"],
    ]);
    const prepared = await smokeModule.prepareSecretDirectory!(environment);
    const { directory, rawSecretCanaries } = prepared;
    try {
      expect(environment.PLATFORM_SECRET_DIRECTORY).toBe(directory);
      expect((await readdir(directory)).sort()).toEqual([
        "platform_assertion_private_jwk",
        "platform_assertion_public_jwks",
        "platform_migrator_database_url",
        "platform_oauth_clients",
        "platform_operator_bootstrap_token",
        "platform_runtime_database_url",
        "platform_smoke_session_token",
      ]);
      if (process.platform !== "win32") {
        expect((await stat(directory)).mode & 0o777).toBe(0o700);
      }
      for (const [name, value] of expectedLegacy) {
        const path = join(directory, name);
        expect((await stat(path)).mode & 0o777).toBe(0o444);
        expect(await readFile(path, "utf8")).toBe(value);
      }

      const privateJwk = JSON.parse(
        await readFile(
          join(directory, "platform_assertion_private_jwk"),
          "utf8",
        ),
      ) as Record<string, unknown>;
      const publicJwks = JSON.parse(
        await readFile(
          join(directory, "platform_assertion_public_jwks"),
          "utf8",
        ),
      ) as { keys: Array<Record<string, unknown>> };
      const oauthClients = JSON.parse(
        await readFile(join(directory, "platform_oauth_clients"), "utf8"),
      ) as Array<Record<string, unknown>>;
      const expectedPublicJwk = {
        alg: "EdDSA",
        crv: "Ed25519",
        kid: privateJwk.kid,
        kty: "OKP",
        use: "sig",
        x: privateJwk.x,
      };

      expect(privateJwk).toEqual({
        ...expectedPublicJwk,
        d: rawSecretCanaries.assertionPrivateKey,
      });
      expect(rawSecretCanaries.assertionPrivateKey).toMatch(
        /^[A-Za-z0-9_-]{43}$/,
      );
      expect(publicJwks).toEqual({ keys: [expectedPublicJwk] });
      expect(
        createPublicKey(
          createPrivateKey({ format: "jwk", key: privateJwk }),
        ).export({ format: "jwk" }),
      ).toMatchObject({ crv: "Ed25519", kty: "OKP", x: privateJwk.x });
      expect(oauthClients).toEqual([
        {
          audience: "apollo-tf",
          clientId: "apollo-tf-api",
          clientSecretDigest: createHash("sha256")
            .update(rawSecretCanaries.oauthClientSecret)
            .digest("hex"),
          redirectUris: ["http://127.0.0.1/callback"],
        },
      ]);
      expect(rawSecretCanaries.oauthClientSecret).toMatch(
        /^[A-Za-z0-9_-]{43}$/,
      );
      expect(JSON.stringify(oauthClients)).not.toContain(
        rawSecretCanaries.oauthClientSecret,
      );
      for (const name of [
        "platform_assertion_private_jwk",
        "platform_assertion_public_jwks",
        "platform_oauth_clients",
      ]) {
        expect((await stat(join(directory, name))).mode & 0o777).toBe(0o444);
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }

    const smoke = await readFile(
      new URL("../scripts/smoke.mjs", import.meta.url),
      "utf8",
    );
    expect(smoke).toContain("await chmod(directory, 0o700)");
    expect(smoke).toContain("await chmod(path, 0o444)");
  });

  test("scans every tracked file byte for generated secrets and digests", async () => {
    const smoke = await readFile(
      new URL("../scripts/smoke.mjs", import.meta.url),
      "utf8",
    );

    expect(smoke).toMatch(/execFileAsync\(\s*"git",\s*\["ls-files", "-z"\]/);
    expect(smoke).toContain(
      "assertFileBytesSecretFree(files, secrets, repositoryRoot)",
    );
    expect(smoke).toContain("Buffer.from(digest(secret))");
    expect(smoke).toContain("tracked file contains secret material");
  });

  test("byte scanner detects raw and digest material with sanitized labels", async () => {
    const directory = await mkdtemp(join(tmpdir(), "apollo-secret-scan-"));
    const rawFile = "raw secret.bin";
    const digestFile = "digest secret.bin";
    const safeFile = "safe.bin";
    const secret = randomBytes(24).toString("base64url");
    const secretDigest = createHash("sha256").update(secret).digest("hex");
    try {
      await Promise.all([
        writeFile(join(directory, rawFile), Buffer.from(secret)),
        writeFile(join(directory, digestFile), Buffer.from(secretDigest)),
        writeFile(join(directory, safeFile), Buffer.from("public material")),
      ]);
      const runner = String.raw`
const module = await import(process.env.SMOKE_MODULE_URL);
const messages = [];
for (const file of [process.env.RAW_FILE, process.env.DIGEST_FILE]) {
  try {
    await module.assertFileBytesSecretFree([file], [process.env.SCAN_SECRET], process.env.SCAN_ROOT);
  } catch (error) {
    messages.push(error.message);
  }
}
await module.assertFileBytesSecretFree([process.env.SAFE_FILE], [process.env.SCAN_SECRET], process.env.SCAN_ROOT);
process.stdout.write(JSON.stringify(messages));
`;
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        ["--input-type=module", "-e", runner],
        {
          cwd: repositoryRoot,
          env: {
            ...process.env,
            DIGEST_FILE: digestFile,
            DOCKER_HOST: "tcp://remote.example:2375",
            RAW_FILE: rawFile,
            SAFE_FILE: safeFile,
            SCAN_ROOT: directory,
            SCAN_SECRET: secret,
            SMOKE_MODULE_URL: new URL("../scripts/smoke.mjs", import.meta.url)
              .href,
          },
        },
      );
      expect(stderr).toBe("");
      const messages = JSON.parse(stdout) as string[];
      expect(messages).toEqual([
        "tracked file contains secret material: raw?secret.bin",
        "tracked file contains secret material: digest?secret.bin",
      ]);
      expect(stdout).not.toContain(secret);
      expect(stdout).not.toContain(secretDigest);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("scopes every live Compose helper to one explicit project base", async () => {
    const source = await readFile(
      new URL("./e2e.test.ts", import.meta.url),
      "utf8",
    );
    const liveSection = source.slice(source.lastIndexOf("const liveBaseUrl ="));

    expect(liveSection).toContain("const liveComposeBaseArgs = [");
    expect(liveSection).toContain('"-p",\n  liveProject ?? "",');
    expect(liveSection).not.toContain("const baseArgs =");
    expect(liveSection.match(/"compose"/g)).toHaveLength(1);
    expect(liveSection.match(/\.\.\.liveComposeBaseArgs/g)).toHaveLength(4);
  });
});

const liveBaseUrl = process.env.PLATFORM_E2E_BASE_URL;
const liveProject = process.env.COMPOSE_PROJECT_NAME;
const liveComposeBaseArgs = [
  "compose",
  "-f",
  composeFile,
  "-p",
  liveProject ?? "",
];
const describeLive = liveBaseUrl && liveProject ? describe : describe.skip;

describeLive("running platform container", () => {
  test("reports liveness and migration-plus-Redis readiness", async () => {
    const [health, ready] = await Promise.all([
      fetch(`${liveBaseUrl}/healthz`),
      fetch(`${liveBaseUrl}/readyz`),
    ]);
    expect(health.status).toBe(200);
    expect(ready.status).toBe(200);
  });

  test("runs read-only as 10001 with native Argon2 available", async () => {
    const { stdout: containerId } = await execFileAsync(
      "docker",
      [...liveComposeBaseArgs, "ps", "-q", "platform-api"],
      { cwd: repositoryRoot, env: process.env },
    );
    const { stdout: inspected } = await execFileAsync(
      "docker",
      [
        "inspect",
        containerId.trim(),
        "--format",
        "{{json .Config.User}} {{json .HostConfig.ReadonlyRootfs}}",
      ],
      { cwd: repositoryRoot },
    );
    expect(inspected.trim()).toBe('"10001:10001" true');

    const { stdout: ownership } = await execFileAsync(
      "docker",
      [
        ...liveComposeBaseArgs,
        "exec",
        "-T",
        "platform-api",
        "stat",
        "-c",
        "%u:%g %A",
        "/app",
        "/app/dist/index.mjs",
      ],
      { cwd: repositoryRoot, env: process.env },
    );
    expect(ownership.trim().split(/\r?\n/)).toEqual([
      "0:0 dr-xr-xr-x",
      "0:0 -r--r--r--",
    ]);

    const { stdout: argon } = await execFileAsync(
      "docker",
      [
        ...liveComposeBaseArgs,
        "exec",
        "-T",
        "platform-api",
        "node",
        "-e",
        "import('argon2').then(async m=>{const h=await m.hash('image-proof');const ok=await m.verify(h,'image-proof');if(!ok)process.exit(1);process.stdout.write('argon2-ok')})",
      ],
      { cwd: repositoryRoot, env: process.env },
    );
    expect(argon).toBe("argon2-ok");
  });

  test("keeps runtime non-owner and without elevated role flags", async () => {
    const query = [
      "select rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls",
      "from pg_roles where rolname = 'apollo_platform_runtime';",
      "select count(*) from pg_tables where schemaname = 'apollo_platform'",
      "and tableowner = 'apollo_platform_runtime';",
    ].join(" ");
    const { stdout } = await execFileAsync(
      "docker",
      [
        ...liveComposeBaseArgs,
        "exec",
        "-T",
        "platform-postgres",
        "psql",
        "-X",
        "-qAt",
        "-U",
        "postgres",
        "-d",
        "apollo_platform",
        "-c",
        query,
      ],
      { cwd: repositoryRoot, env: process.env },
    );
    expect(stdout.trim().split(/\r?\n/)).toEqual([
      "apollo_platform_runtime|f|f|f|f|f",
      "0",
    ]);
  });
});
