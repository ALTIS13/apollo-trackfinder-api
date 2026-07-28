import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import dockerIgnore from "@balena/dockerignore";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const apiRoot = process.cwd();
const workspaceRoot = resolve(apiRoot, "../..");
const HEARTBEAT_KEYS_ENV = "APOLLO_MODULE_HEARTBEAT_KEYS";
const HEARTBEAT_KEYS_FILE_ENV = "APOLLO_MODULE_HEARTBEAT_KEYS_FILE";
const ADMIN_DASHBOARD_TOKEN_FILE = "/run/secrets/admin_dashboard_token";

type RenderedSecretMount = {
  readonly source: string;
  readonly target: string;
  readonly uid?: string;
  readonly gid?: string;
  readonly mode?: string;
};

type RenderedService = {
  readonly environment?: Record<string, string>;
  readonly secrets?: readonly RenderedSecretMount[];
};

type RenderedCompose = {
  readonly services: Record<string, RenderedService>;
  readonly secrets: Record<string, { readonly file: string }>;
};

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(workspaceRoot, path), "utf8");
}

function renderCompose(path: string): RenderedCompose {
  const result = spawnSync(
    "docker",
    [
      "compose",
      "--file",
      resolve(workspaceRoot, path),
      "config",
      "--format",
      "json",
    ],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        TF_SECRET_DIRECTORY: "/var/lib/apollo-tf/secrets",
      },
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    },
  );
  if (result.error !== undefined) throw result.error;
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as RenderedCompose;
}

function readDirectoryFiles(absolutePath: string): string[] {
  return readdirSync(absolutePath, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? readDirectoryFiles(resolve(absolutePath, entry.name))
      : [readFileSync(resolve(absolutePath, entry.name), "utf8")],
  );
}

function serviceBlock(compose: string, service: string): string {
  const match = compose.match(
    new RegExp(
      `(?:^|\\n)  ${service}:\\n([\\s\\S]*?)(?=\\n  [a-zA-Z0-9-]+:\\n|\\nvolumes:|$)`,
    ),
  );
  expect(match, `missing ${service} service`).not.toBeNull();
  return match![1];
}

function hasHeartbeatBuildArg(compose: string): boolean {
  const document: unknown = parse(compose, { merge: true });
  if (!isRecord(document) || !isRecord(document.services)) return false;

  return Object.values(document.services).some((service) => {
    if (!isRecord(service) || !isRecord(service.build)) return false;
    return containsHeartbeatBuildArg(service.build.args);
  });
}

function containsHeartbeatBuildArg(args: unknown): boolean {
  if (Array.isArray(args)) {
    return args.some(
      (argument) =>
        typeof argument === "string" && argument.includes(HEARTBEAT_KEYS_ENV),
    );
  }
  if (!isRecord(args)) return false;
  return Object.entries(args).some(
    ([name, value]) =>
      name === HEARTBEAT_KEYS_ENV ||
      (typeof value === "string" && value.includes(HEARTBEAT_KEYS_ENV)),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGitIgnored(relativePath: string): boolean {
  const result = spawnSync(
    "git",
    ["check-ignore", "--quiet", "--no-index", "--", relativePath],
    { cwd: workspaceRoot, encoding: "utf8" },
  );
  if (result.error !== undefined) throw result.error;
  expect(result.status, result.stderr).toBeOneOf([0, 1]);
  return result.status === 0;
}

function isDockerIgnored(ignoreFile: string, relativePath: string): boolean {
  return dockerIgnore({ ignorecase: false })
    .add(ignoreFile)
    .ignores(relativePath.replaceAll("\\", "/"));
}

describe("admin telemetry container contract", () => {
  const rootCompose = readWorkspaceFile("docker-compose.yml");
  const apiCompose = readWorkspaceFile(
    "artifacts/api-server/docker-compose.yml",
  );
  const apiDockerfile = readWorkspaceFile("artifacts/api-server/Dockerfile");
  const adminDockerfile = readWorkspaceFile(
    "artifacts/admin-dashboard/Dockerfile",
  );
  const adminNginx = readWorkspaceFile("artifacts/admin-dashboard/nginx.conf");
  const adminEntrypoint = readWorkspaceFile(
    "artifacts/admin-dashboard/docker-entrypoint.d/16-admin-dashboard-defaults.envsh",
  );
  const backgroundQueueSource = readWorkspaceFile(
    "artifacts/api-server/src/lib/background-queue.ts",
  );
  const apiIndexSource = readWorkspaceFile("artifacts/api-server/src/index.ts");
  const modulesDocumentation = readWorkspaceFile("MODULES.md");
  const loggerSource = readWorkspaceFile(
    "artifacts/api-server/src/lib/logger.ts",
  );
  const gitignore = readWorkspaceFile(".gitignore");
  const dockerignore = readWorkspaceFile(".dockerignore");
  const webDockerfile = readWorkspaceFile("artifacts/music-player/Dockerfile");
  const viteSources = [
    ...readDirectoryFiles(
      resolve(workspaceRoot, "artifacts/admin-dashboard/src"),
    ),
    ...readDirectoryFiles(resolve(workspaceRoot, "artifacts/music-player/src")),
    readWorkspaceFile("artifacts/admin-dashboard/vite.config.ts"),
    readWorkspaceFile("artifacts/music-player/vite.config.ts"),
  ];

  it("uses a disposable Redis readiness probe and documents exact TF boundaries", () => {
    expect(apiIndexSource).toContain(
      'import { probeRedisHealth } from "./lib/redis-readiness.js";',
    );
    expect(apiIndexSource).toContain(
      "probeRedisHealth(authConfig.authRedisUrl, { timeoutMs: 1_200 })",
    );
    expect(apiIndexSource).not.toContain(
      'authRedis.ping().then((reply) => reply === "PONG")',
    );
    expect(modulesDocumentation).toContain(
      "Модуль получает только шесть runtime secrets:\n`tf_integrations_runtime_database_url`, `tf_integrations_token_keyring`,\n`tf_integrations_spotify_client_id`,\n`tf_integrations_spotify_client_secret`,\n`tf_integrations_internal_auth_secret` и\n`tf_integrations_heartbeat_secret`.",
    );
    expect(modulesDocumentation).toContain(
      "Модуль отправляет подписанный heartbeat `account-integrations` сразу после\nготовности и затем каждые 30 секунд. API считает последнее состояние свежим\n90 секунд.",
    );
    expect(modulesDocumentation).toContain(
      "Сеть `tf-integrations-control` является internal и содержит только `api` и\n`tf-integrations`. Internal `tf-integrations-data` содержит только module,\nmigrator и dedicated PostgreSQL. Только module подключён к\n`tf-integrations-egress`; у module, migrator и database нет host ports.",
    );
    expect(modulesDocumentation).toContain(
      "Без override оба Compose templates используют безопасный non-secret default\n`/var/lib/apollo-tf/secrets`; production startup требует шесть database\nsecret-файлов, базовые TF/search files и десять `tf_integrations_*` files.",
    );
  });

  it("mounts file-backed admin secrets only into their consumers", () => {
    const apiFileEnvironment = `ADMIN_DASHBOARD_TOKEN_FILE: ${ADMIN_DASHBOARD_TOKEN_FILE}`;
    const inlineAssignments =
      /^\s*(?:ADMIN_DASHBOARD_TOKEN|ADMIN_ACCESS_USER|ADMIN_ACCESS_PASSWORD):/m;

    expect(serviceBlock(rootCompose, "api")).toContain(apiFileEnvironment);
    const rootAdmin = serviceBlock(rootCompose, "admin");
    expect(rootAdmin).toContain("source: admin_dashboard_token");
    expect(rootAdmin).toContain("target: admin_dashboard_token");
    expect(rootAdmin).toContain("source: admin_access_user");
    expect(rootAdmin).toContain("target: admin_access_user");
    expect(rootAdmin).toContain("source: admin_access_password");
    expect(rootAdmin).toContain("target: admin_access_password");
    expect(rootAdmin).toContain('"127.0.0.1:${TF_ADMIN_PORT:-3001}:80"');
    expect(serviceBlock(rootCompose, "api")).not.toContain("ADMIN_ACCESS_");
    expect(serviceBlock(rootCompose, "api")).not.toMatch(inlineAssignments);
    expect(rootAdmin).not.toMatch(inlineAssignments);
    expect(serviceBlock(rootCompose, "db")).not.toContain(
      "ADMIN_DASHBOARD_TOKEN",
    );
    expect(serviceBlock(rootCompose, "web")).not.toContain(
      "ADMIN_DASHBOARD_TOKEN",
    );

    expect(serviceBlock(apiCompose, "api")).toContain(apiFileEnvironment);
    expect(serviceBlock(apiCompose, "api")).not.toMatch(inlineAssignments);
    expect(serviceBlock(apiCompose, "db")).not.toContain(
      "ADMIN_DASHBOARD_TOKEN",
    );
    expect(serviceBlock(apiCompose, "redis")).not.toContain(
      "ADMIN_DASHBOARD_TOKEN",
    );

    for (const compose of [rootCompose, apiCompose]) {
      expect(compose).toContain(
        "file: ${TF_SECRET_DIRECTORY:-/var/lib/apollo-tf/secrets}/admin_dashboard_token",
      );
      expect(compose).toContain(
        "file: ${TF_SECRET_DIRECTORY:-/var/lib/apollo-tf/secrets}/admin_access_user",
      );
      expect(compose).toContain(
        "file: ${TF_SECRET_DIRECTORY:-/var/lib/apollo-tf/secrets}/admin_access_password",
      );
    }
  });

  it.each([
    ["root", "docker-compose.yml", true],
    ["nested", "artifacts/api-server/docker-compose.yml", false],
  ])(
    "renders the %s file-backed admin boundary with exact mounts",
    (_label, path, hasAdmin) => {
      const rendered = renderCompose(path);
      const api = rendered.services["api"]!;
      const apiEnvironment = api.environment ?? {};

      expect(apiEnvironment["ADMIN_DASHBOARD_TOKEN_FILE"]).toBe(
        ADMIN_DASHBOARD_TOKEN_FILE,
      );
      expect(apiEnvironment).not.toHaveProperty("ADMIN_DASHBOARD_TOKEN");
      expect(api.secrets).toContainEqual({
        source: "admin_dashboard_token",
        target: "admin_dashboard_token",
        uid: "10001",
        gid: "10001",
        mode: "0400",
      });

      const renderedSecrets = hasAdmin
        ? [
            "admin_dashboard_token",
            "admin_access_user",
            "admin_access_password",
          ]
        : ["admin_dashboard_token"];
      for (const secret of renderedSecrets) {
        expect(rendered.secrets[secret]?.file).toBe(
          `/var/lib/apollo-tf/secrets/${secret}`,
        );
      }

      if (hasAdmin) {
        const admin = rendered.services["admin"]!;
        expect(admin.environment).toEqual({
          APOLLO_API_UPSTREAM: "http://api:8080",
        });
        expect(admin.secrets).toEqual([
          {
            source: "admin_dashboard_token",
            target: "admin_dashboard_token",
            uid: "0",
            gid: "0",
            mode: "0400",
          },
          {
            source: "admin_access_user",
            target: "admin_access_user",
            uid: "0",
            gid: "0",
            mode: "0400",
          },
          {
            source: "admin_access_password",
            target: "admin_access_password",
            uid: "0",
            gid: "0",
            mode: "0400",
          },
        ]);
      } else {
        expect(rendered.services).not.toHaveProperty("admin");
      }
    },
    30_000,
  );

  it("builds both consumers with the shared dashboard contract", () => {
    const apiSourceCopy = apiDockerfile.indexOf(
      "COPY artifacts/api-server ./artifacts/api-server",
    );
    const apiInstall = apiDockerfile.indexOf(
      "pnpm install --frozen-lockfile --filter @workspace/api-server...",
    );
    const apiBuild = apiDockerfile.indexOf(
      "pnpm --filter @workspace/api-server run build",
    );
    const adminContractCopy = adminDockerfile.indexOf(
      "COPY lib/admin-dashboard-contract ./lib/admin-dashboard-contract",
    );
    const adminInstall = adminDockerfile.indexOf(
      "pnpm install --frozen-lockfile --filter @workspace/admin-dashboard...",
    );

    expect(apiSourceCopy).toBeGreaterThan(-1);
    expect(apiInstall).toBeGreaterThan(apiSourceCopy);
    expect(apiBuild).toBeGreaterThan(apiInstall);
    expect(adminContractCopy).toBeGreaterThan(-1);
    expect(adminInstall).toBeGreaterThan(adminContractCopy);
    for (const dockerfile of [apiDockerfile, adminDockerfile]) {
      expect(dockerfile).toContain("lib/admin-dashboard-contract/package.json");
      expect(dockerfile).toContain("COPY lib/admin-dashboard-contract");
    }
  });

  it("keeps the token server-side and redacted from request logs", () => {
    expect(adminDockerfile).not.toContain("VITE_ADMIN_DASHBOARD_TOKEN");
    expect(rootCompose).not.toMatch(
      /^\s*ADMIN_DASHBOARD_TOKEN:\s*"\$\{ADMIN_DASHBOARD_TOKEN:-}"/m,
    );
    expect(apiCompose).not.toMatch(
      /^\s*ADMIN_DASHBOARD_TOKEN:\s*"\$\{ADMIN_DASHBOARD_TOKEN:-}"/m,
    );
    expect(loggerSource).toContain("req.headers['x-admin-dashboard-token']");
  });

  it("passes module heartbeat keys only to API containers and excludes operator files", () => {
    const interpolation =
      "APOLLO_MODULE_HEARTBEAT_KEYS_FILE: /run/secrets/tf_module_heartbeat_keys";

    expect(serviceBlock(rootCompose, "api")).toContain(interpolation);
    expect(serviceBlock(apiCompose, "api")).toContain(interpolation);
    expect(serviceBlock(rootCompose, "api")).not.toMatch(
      /^\s*APOLLO_MODULE_HEARTBEAT_KEYS:/m,
    );
    expect(serviceBlock(apiCompose, "api")).not.toMatch(
      /^\s*APOLLO_MODULE_HEARTBEAT_KEYS:/m,
    );

    for (const compose of [rootCompose, apiCompose]) {
      expect(hasHeartbeatBuildArg(compose)).toBe(false);
    }

    for (const service of [
      serviceBlock(rootCompose, "admin"),
      serviceBlock(rootCompose, "web"),
      serviceBlock(rootCompose, "db"),
      serviceBlock(apiCompose, "db"),
      serviceBlock(apiCompose, "redis"),
    ]) {
      expect(service).not.toContain(HEARTBEAT_KEYS_ENV);
      expect(service).not.toContain(HEARTBEAT_KEYS_FILE_ENV);
    }

    for (const source of [
      apiDockerfile,
      adminDockerfile,
      webDockerfile,
      adminNginx,
      ...viteSources,
    ]) {
      expect(source).not.toContain(HEARTBEAT_KEYS_ENV);
      expect(source).not.toContain(HEARTBEAT_KEYS_FILE_ENV);
    }
  });

  it.each([
    [
      "block mapping",
      "services:\n  api:\n    build:\n      args:\n        APOLLO_MODULE_HEARTBEAT_KEYS: value\n",
    ],
    [
      "inline mapping",
      "services:\n  api:\n    build:\n      args: { APOLLO_MODULE_HEARTBEAT_KEYS: value }\n",
    ],
    [
      "block list",
      "services:\n  api:\n    build:\n      args:\n        - APOLLO_MODULE_HEARTBEAT_KEYS=value\n",
    ],
    [
      "inline list",
      "services:\n  api:\n    build:\n      args: [APOLLO_MODULE_HEARTBEAT_KEYS=value]\n",
    ],
    [
      "fully inline build mapping",
      "services:\n  api:\n    build: { args: { APOLLO_MODULE_HEARTBEAT_KEYS: value } }\n",
    ],
    [
      "mapping value alias",
      'services:\n  api:\n    build:\n      args:\n        INTERNAL_KEYS: "${APOLLO_MODULE_HEARTBEAT_KEYS}"\n',
    ],
    [
      "list value alias",
      "services:\n  api:\n    build:\n      args:\n        - INTERNAL_KEYS=${APOLLO_MODULE_HEARTBEAT_KEYS}\n",
    ],
    [
      "merged mapping key",
      "x-api-args: &api-args\n  APOLLO_MODULE_HEARTBEAT_KEYS: value\nservices:\n  api:\n    build:\n      args:\n        <<: *api-args\n",
    ],
    [
      "merged mapping value alias",
      'x-api-args: &api-args\n  INTERNAL_KEYS: "${APOLLO_MODULE_HEARTBEAT_KEYS}"\nservices:\n  api:\n    build:\n      args:\n        <<: *api-args\n',
    ],
  ])("rejects heartbeat keys from %s Compose build args", (_label, compose) => {
    expect(hasHeartbeatBuildArg(compose)).toBe(true);
  });

  it.each([
    [
      "a comment",
      "services:\n  api:\n    build:\n      args:\n        # APOLLO_MODULE_HEARTBEAT_KEYS: not-an-argument\n        PUBLIC_BUILD_MODE: production\n",
      false,
    ],
    [
      "a mapping anchor",
      "x-api-args: &api-args\n  APOLLO_MODULE_HEARTBEAT_KEYS: value\nservices:\n  api:\n    build:\n      args: *api-args\n",
      true,
    ],
    [
      "a list anchor",
      "x-api-args: &api-args\n  - APOLLO_MODULE_HEARTBEAT_KEYS=value\nservices:\n  api:\n    build:\n      args: *api-args\n",
      true,
    ],
  ])(
    "handles heartbeat build args represented by %s",
    (_label, compose, expected) => {
      expect(hasHeartbeatBuildArg(compose)).toBe(expected);
    },
  );

  it("applies Git and Docker ignore rules in order for operator files", () => {
    for (const secretPath of [
      ".env",
      "artifacts/.env.local",
      "artifacts/api-server/.env.production",
    ]) {
      expect(isGitIgnored(secretPath)).toBe(true);
      expect(isDockerIgnored(dockerignore, secretPath)).toBe(true);
    }

    for (const examplePath of [
      ".env.example",
      "artifacts/.env.example",
      "artifacts/api-server/.env.example",
    ]) {
      expect(isGitIgnored(examplePath)).toBe(false);
      expect(isDockerIgnored(dockerignore, examplePath)).toBe(false);
    }

    expect(isGitIgnored(".ops-private/notes.txt")).toBe(true);
    expect(isDockerIgnored(dockerignore, ".ops-private/notes.txt")).toBe(true);
  });

  it("requires operator authentication and rate limits the public admin surface", () => {
    expect(adminNginx).toContain('auth_basic "Apollo TF Admin"');
    expect(adminNginx).toContain("auth_basic_user_file /etc/nginx/.htpasswd");
    expect(adminNginx).toMatch(/location = \/healthz\s*{[^}]*auth_basic off;/s);
    expect(adminNginx).toContain("limit_req_zone $binary_remote_addr");
    expect(adminNginx).toContain("limit_req zone=apollo_admin");
    expect(adminEntrypoint).toContain("mkpasswd -P 0 -m sha512");
    expect(adminEntrypoint).toContain("printf 'disabled:!\\n'");
    expect(adminEntrypoint).toContain("chown root:nginx /etc/nginx/.htpasswd");
    expect(adminEntrypoint).toContain("chmod 640 /etc/nginx/.htpasswd");
    expect(adminEntrypoint).toContain("unset ADMIN_ACCESS_PASSWORD");
  });

  it("separates producer, telemetry, and cancellation clients without embedding a worker", () => {
    expect(backgroundQueueSource).toContain('import { Queue } from "bullmq";');
    expect(backgroundQueueSource).not.toMatch(
      /import\s*{[^}]*\bWorker\b[^}]*}\s*from\s*"bullmq"/,
    );
    expect(backgroundQueueSource).toMatch(
      /interface Clients\s*{[\s\S]*producer:\s*QueueClient;[\s\S]*telemetry:\s*QueueClient;[\s\S]*cancellation:\s*RedisClient;[\s\S]*}/,
    );
    expect(backgroundQueueSource).toContain("commandTimeout: 1000");
    expect(backgroundQueueSource).toContain(
      "producer: { ...common, commandTimeout: PRODUCER_COMMAND_TIMEOUT_MS }",
    );
    expect(backgroundQueueSource).toContain("connection: config.producer");
    expect(backgroundQueueSource).toContain("connection: config.telemetry");
    expect(backgroundQueueSource).toContain(
      "const cancellation = makeRedis(config.cancellation)",
    );
    expect(backgroundQueueSource).toContain("workerEmbedded: false");
  });
});
