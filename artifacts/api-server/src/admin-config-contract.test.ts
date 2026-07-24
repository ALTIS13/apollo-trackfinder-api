import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import dockerIgnore from "@balena/dockerignore";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const apiRoot = process.cwd();
const workspaceRoot = resolve(apiRoot, "../..");
const HEARTBEAT_KEYS_ENV = "APOLLO_MODULE_HEARTBEAT_KEYS";

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(workspaceRoot, path), "utf8");
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
      "`tf-integrations`: authenticated HTTP + отдельные heartbeat keys для provider adapters, минимальный entitlement `tf.integrations`",
    );
    expect(modulesDocumentation).toContain(
      "production\nstartup требует ровно `tf_postgres_password`, `tf_database_url` и\n`tf_client_secret`",
    );
  });

  it("passes the runtime token only to API and admin services", () => {
    const interpolation = 'ADMIN_DASHBOARD_TOKEN: "${ADMIN_DASHBOARD_TOKEN:-}"';

    expect(serviceBlock(rootCompose, "tf-api")).toContain(interpolation);
    const rootAdmin = serviceBlock(rootCompose, "tf-admin");
    expect(rootAdmin).toContain(interpolation);
    expect(rootAdmin).toContain('ADMIN_ACCESS_USER: "${ADMIN_ACCESS_USER:-}"');
    expect(rootAdmin).toContain(
      'ADMIN_ACCESS_PASSWORD: "${ADMIN_ACCESS_PASSWORD:-}"',
    );
    expect(rootAdmin).toContain('"127.0.0.1:${TF_ADMIN_PORT:-3001}:80"');
    expect(serviceBlock(rootCompose, "tf-api")).not.toContain("ADMIN_ACCESS_");
    expect(serviceBlock(rootCompose, "tf-postgres")).not.toContain(
      "ADMIN_DASHBOARD_TOKEN",
    );
    expect(serviceBlock(rootCompose, "tf-web")).not.toContain(
      "ADMIN_DASHBOARD_TOKEN",
    );

    expect(serviceBlock(apiCompose, "tf-api")).toContain(interpolation);
    expect(serviceBlock(apiCompose, "tf-postgres")).not.toContain(
      "ADMIN_DASHBOARD_TOKEN",
    );
    expect(serviceBlock(apiCompose, "tf-redis")).not.toContain(
      "ADMIN_DASHBOARD_TOKEN",
    );
  });

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
    const assertInterpolatedTokens = (compose: string) => {
      const assignments = [
        ...compose.matchAll(/ADMIN_DASHBOARD_TOKEN:\s*(.+)$/gm),
      ];
      expect(assignments.length).toBeGreaterThan(0);
      for (const assignment of assignments) {
        expect(assignment[1].trim()).toBe('"${ADMIN_DASHBOARD_TOKEN:-}"');
      }
    };

    expect(adminDockerfile).not.toContain("VITE_ADMIN_DASHBOARD_TOKEN");
    assertInterpolatedTokens(rootCompose);
    assertInterpolatedTokens(apiCompose);
    expect(loggerSource).toContain("req.headers['x-admin-dashboard-token']");
  });

  it("passes module heartbeat keys only to API containers and excludes operator files", () => {
    const interpolation =
      'APOLLO_MODULE_HEARTBEAT_KEYS: "${APOLLO_MODULE_HEARTBEAT_KEYS:-}"';
    const secretName = HEARTBEAT_KEYS_ENV;

    expect(serviceBlock(rootCompose, "tf-api")).toContain(interpolation);
    expect(serviceBlock(apiCompose, "tf-api")).toContain(interpolation);

    for (const compose of [rootCompose, apiCompose]) {
      expect(hasHeartbeatBuildArg(compose)).toBe(false);
    }

    for (const service of [
      serviceBlock(rootCompose, "tf-admin"),
      serviceBlock(rootCompose, "tf-web"),
      serviceBlock(rootCompose, "tf-postgres"),
      serviceBlock(apiCompose, "tf-postgres"),
      serviceBlock(apiCompose, "tf-redis"),
    ]) {
      expect(service).not.toContain(secretName);
    }

    for (const source of [
      apiDockerfile,
      adminDockerfile,
      webDockerfile,
      adminNginx,
      ...viteSources,
    ]) {
      expect(source).not.toContain(secretName);
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

  it("separates blocking worker connections from bounded telemetry commands", () => {
    expect(backgroundQueueSource).toMatch(
      /const workerConnection:\s*RedisOptions\s*=/,
    );
    expect(backgroundQueueSource).toMatch(
      /const telemetryConnection:\s*RedisOptions\s*=/,
    );
    expect(backgroundQueueSource).toContain("commandTimeout: 1000");
    expect(backgroundQueueSource).toContain("{ connection: workerConnection");
    expect(backgroundQueueSource).toContain(
      "{ connection: telemetryConnection }",
    );
  });
});
