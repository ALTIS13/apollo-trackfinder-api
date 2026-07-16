import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const composeFile = fileURLToPath(
  new URL("../docker-compose.yml", import.meta.url),
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
        "platform_migrator_database_url",
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
    expect(JSON.stringify(api.healthcheck)).toContain("/healthz");
    expect(JSON.stringify(api.healthcheck)).toContain("/readyz");
    expect(api.environment).not.toHaveProperty("DATABASE_URL");
    expect(migrate.environment).not.toHaveProperty("MIGRATOR_DATABASE_URL");

    const directSecretSources = new Map<string, readonly string[]>([
      [
        "platform-api",
        ["platform_operator_bootstrap_token", "platform_runtime_database_url"],
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
      "platform_migrator_database_url",
      "platform_operator_bootstrap_token",
      "platform_runtime_database_url",
      "platform_smoke_session_token",
    ]) {
      expect(secrets[name].file).toMatch(new RegExp(`${name}$`));
      expect(secrets[name]).not.toHaveProperty("environment");
    }

    for (const value of Object.values(
      config.services as Record<string, Record<string, unknown>>,
    )) {
      const volumes = (value.volumes ?? []) as Array<Record<string, unknown>>;
      expect(volumes.every(({ type }) => type !== "bind")).toBe(true);
      expect(JSON.stringify(value)).not.toContain("docker.sock");
      expect(JSON.stringify(value)).not.toContain(".ops-private");
    }
  });

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
    expect(smoke).not.toMatch(/\/v1\/[a-z0-9_/:.-]*policy[a-z0-9_/:.-]*/i);
    expect(smoke).toContain('const INVITATION_MODULE_KEY = "tf.integrations";');
    expect(smoke).toContain("invitation-entitlement-revoke");
    expect(smoke.indexOf("invitation-entitlement-revoke")).toBeLessThan(
      smoke.indexOf("activation-without-entitlement"),
    );
  });
});

const liveBaseUrl = process.env.PLATFORM_E2E_BASE_URL;
const liveProject = process.env.COMPOSE_PROJECT_NAME;
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
    const baseArgs = ["compose", "-f", composeFile];
    const { stdout: containerId } = await execFileAsync(
      "docker",
      [...baseArgs, "ps", "-q", "platform-api"],
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
        ...baseArgs,
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
        ...baseArgs,
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
        "compose",
        "-f",
        composeFile,
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
