import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const apiRoot = process.cwd();
const workspaceRoot = resolve(apiRoot, "../..");

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(workspaceRoot, path), "utf8");
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
  const databaseSource = readWorkspaceFile("lib/db/src/index.ts");
  const backgroundQueueSource = readWorkspaceFile(
    "artifacts/api-server/src/lib/background-queue.ts",
  );
  const loggerSource = readWorkspaceFile(
    "artifacts/api-server/src/lib/logger.ts",
  );

  it("passes the runtime token only to API and admin services", () => {
    const interpolation = 'ADMIN_DASHBOARD_TOKEN: "${ADMIN_DASHBOARD_TOKEN:-}"';

    expect(serviceBlock(rootCompose, "api")).toContain(interpolation);
    const rootAdmin = serviceBlock(rootCompose, "admin");
    expect(rootAdmin).toContain(interpolation);
    expect(rootAdmin).toContain('ADMIN_ACCESS_USER: "${ADMIN_ACCESS_USER:-}"');
    expect(rootAdmin).toContain(
      'ADMIN_ACCESS_PASSWORD: "${ADMIN_ACCESS_PASSWORD:-}"',
    );
    expect(rootAdmin).toContain('"127.0.0.1:3001:80"');
    expect(serviceBlock(rootCompose, "api")).not.toContain("ADMIN_ACCESS_");
    expect(serviceBlock(rootCompose, "db")).not.toContain(
      "ADMIN_DASHBOARD_TOKEN",
    );
    expect(serviceBlock(rootCompose, "web")).not.toContain(
      "ADMIN_DASHBOARD_TOKEN",
    );

    expect(serviceBlock(apiCompose, "api")).toContain(interpolation);
    expect(serviceBlock(apiCompose, "db")).not.toContain(
      "ADMIN_DASHBOARD_TOKEN",
    );
    expect(serviceBlock(apiCompose, "redis")).not.toContain(
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

  it("uses a bounded PostgreSQL health client instead of an orphaned race", () => {
    expect(databaseSource).toContain("new Client");
    expect(databaseSource).toContain("connectionTimeoutMillis: timeoutMs");
    expect(databaseSource).toContain("query_timeout: timeoutMs");
    expect(databaseSource).toContain("statement_timeout: timeoutMs");
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
