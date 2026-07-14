import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const dashboardRoot = process.cwd();
const dashboardCss = readFileSync(resolve(dashboardRoot, "src/index.css"), "utf8");
const dockerfile = readFileSync(resolve(dashboardRoot, "Dockerfile"), "utf8");
const nginxConfig = readFileSync(resolve(dashboardRoot, "nginx.conf"), "utf8");
const composeConfig = readFileSync(
  resolve(dashboardRoot, "../../docker-compose.yml"),
  "utf8",
);

describe("admin dashboard delivery contracts", () => {
  it("defines the approved visual tokens and portrait topology overflow", () => {
    expect(dashboardCss).toMatch(/--color-bg:\s*#[0-9a-f]{6}/i);
    expect(dashboardCss).toMatch(/--color-accent:\s*#[0-9a-f]{6}/i);
    expect(dashboardCss).toContain("--color-healthy:");
    expect(dashboardCss).toContain("--color-warning:");
    expect(dashboardCss).toContain("--color-degraded:");
    expect(dashboardCss).toContain("--color-info:");
    expect(dashboardCss).toContain("--color-unknown:");
    expect(dashboardCss).toContain("--radius-panel: 6px");
    expect(dashboardCss).toContain("--radius-metric: 8px");
    expect(dashboardCss).toMatch(/@media\s*\(max-width:\s*800px\)/);
    expect(dashboardCss).toMatch(/\.topology-scroll\s*{[^}]*overflow-x:\s*auto/s);
    expect(dashboardCss).toMatch(/\.topology-canvas\s*{[^}]*min-width:\s*760px/s);
  });

  it("builds Vite with the API argument before producing the nginx image", () => {
    const apiArg = dockerfile.indexOf("ARG VITE_ADMIN_API_URL");
    const viteBuild = dockerfile.indexOf("pnpm --filter @workspace/admin-dashboard build");
    const nginxStage = dockerfile.indexOf("FROM nginx:1.27-alpine");

    expect(apiArg).toBeGreaterThan(-1);
    expect(viteBuild).toBeGreaterThan(apiArg);
    expect(nginxStage).toBeGreaterThan(viteBuild);
    expect(dockerfile).toContain("ENV VITE_ADMIN_API_URL=$VITE_ADMIN_API_URL");
    expect(dockerfile).toContain("HEALTHCHECK CMD wget -qO- http://127.0.0.1/healthz || exit 1");
  });

  it("serves the SPA and a literal health endpoint", () => {
    expect(nginxConfig).toMatch(/location\s*=\s*\/healthz\s*{[^}]*return\s+200/s);
    expect(nginxConfig).toMatch(/location\s+\/\s*{[^}]*try_files\s+\$uri\s+\$uri\/\s+\/index\.html/s);
  });

  it("adds an isolated admin service with a build-time API URL and local port", () => {
    expect(composeConfig).toMatch(/\n\s{2}admin:\s*\n/);
    expect(composeConfig).toContain("dockerfile: artifacts/admin-dashboard/Dockerfile");
    expect(composeConfig).toContain("VITE_ADMIN_API_URL:");
    expect(composeConfig).toContain('"3001:80"');
  });
});
