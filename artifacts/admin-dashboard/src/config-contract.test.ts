import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const dashboardRoot = process.cwd();
const dashboardCss = readFileSync(
  resolve(dashboardRoot, "src/index.css"),
  "utf8",
);
const dockerfile = readFileSync(resolve(dashboardRoot, "Dockerfile"), "utf8");
const nginxConfig = readFileSync(resolve(dashboardRoot, "nginx.conf"), "utf8");
const nginxRuntimeDefaults = readFileSync(
  resolve(
    dashboardRoot,
    "docker-entrypoint.d/16-admin-dashboard-defaults.envsh",
  ),
  "utf8",
);
const mainEntry = readFileSync(resolve(dashboardRoot, "src/main.tsx"), "utf8");
const topologyPanel = readFileSync(
  resolve(dashboardRoot, "src/components/TopologyPanel.tsx"),
  "utf8",
);
const workspaceConfig = readFileSync(
  resolve(dashboardRoot, "../../pnpm-workspace.yaml"),
  "utf8",
);
const adminPackage = JSON.parse(
  readFileSync(resolve(dashboardRoot, "package.json"), "utf8"),
) as { dependencies?: Record<string, string> };
const composeConfig = readFileSync(
  resolve(dashboardRoot, "../../docker-compose.yml"),
  "utf8",
);
const rootPackage = JSON.parse(
  readFileSync(resolve(dashboardRoot, "../../package.json"), "utf8"),
) as { packageManager?: string };

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
    expect(dashboardCss).toMatch(
      /\.topology-scroll\s*{[^}]*overflow-x:\s*auto/s,
    );
    expect(dashboardCss).toMatch(
      /\.topology-canvas\s*{[^}]*min-width:\s*760px/s,
    );
    expect(dashboardCss).toMatch(
      /\.operational-layout\s*{[^}]*"topology incidents"\s*"details details"/s,
    );
    expect(dashboardCss).toMatch(
      /\.incident-rail\s*{[^}]*position:\s*static;[^}]*height:\s*100%;[^}]*align-self:\s*stretch/s,
    );
    expect(dashboardCss).not.toMatch(
      /\.incident-(?:row|title|rail)[^{]*:hover/,
    );
  });

  it("keeps base, hover, and subtle small text contrast at or above WCAG AA", () => {
    const token = (name: string) => {
      const value = dashboardCss.match(
        new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"),
      )?.[1];
      expect(value, `missing --${name}`).toBeDefined();
      return value!;
    };
    const luminance = (hex: string) => {
      const channels = hex.match(/[0-9a-f]{2}/gi)!.map((channel) => {
        const value = Number.parseInt(channel, 16) / 255;
        return value <= 0.04045
          ? value / 12.92
          : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const contrast = (foreground: string, background: string) => {
      const values = [luminance(foreground), luminance(background)].sort(
        (a, b) => b - a,
      );
      return (values[0] + 0.05) / (values[1] + 0.05);
    };

    expect(contrast("#ffffff", token("color-accent"))).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(
      contrast("#ffffff", token("color-accent-hover")),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(token("color-subtle"), token("color-surface")),
    ).toBeGreaterThanOrEqual(4.5);
    expect(dashboardCss).toMatch(
      /\.refresh-button:hover:not\(:disabled\)\s*{[^}]*background:\s*var\(--color-accent-hover\)/s,
    );
  });

  it("builds Vite without browser API credentials before producing the nginx image", () => {
    const viteBuild = dockerfile.indexOf(
      "pnpm --filter @workspace/admin-dashboard build",
    );
    const nginxStage = dockerfile.indexOf(
      "FROM docker.io/library/nginx:1.27-alpine@sha256:",
    );

    expect(viteBuild).toBeGreaterThan(-1);
    expect(nginxStage).toBeGreaterThan(viteBuild);
    expect(dockerfile).not.toContain("VITE_ADMIN_API_URL");
    expect(dockerfile).toContain("APOLLO_API_UPSTREAM=http://127.0.0.1:8080");
    expect(dockerfile).not.toMatch(/^\s*ADMIN_DASHBOARD_TOKEN=/m);
    expect(dockerfile).toContain("APOLLO_API_UPSTREAM|ADMIN_DASHBOARD_TOKEN");
    expect(dockerfile).toContain("/etc/nginx/templates/default.conf.template");
    expect(dockerfile).toContain(
      "/docker-entrypoint.d/16-admin-dashboard-defaults.envsh",
    );
    expect(dockerfile).toContain(
      "HEALTHCHECK CMD wget -qO- http://127.0.0.1/healthz || exit 1",
    );
  });

  it("loads bounded admin credentials only from the production secret files", () => {
    expect(nginxRuntimeDefaults).toContain(
      'ADMIN_DASHBOARD_TOKEN_FILE="/run/secrets/admin_dashboard_token"',
    );
    expect(nginxRuntimeDefaults).toContain(
      'ADMIN_ACCESS_USER_FILE="/run/secrets/admin_access_user"',
    );
    expect(nginxRuntimeDefaults).toContain(
      'ADMIN_ACCESS_PASSWORD_FILE="/run/secrets/admin_access_password"',
    );
    expect(nginxRuntimeDefaults).toMatch(
      /read_secret_file\(\)\s*{[\s\S]*file_path="\$1"[\s\S]*minimum_bytes="\$2"[\s\S]*maximum_bytes="\$3"/,
    );
    expect(nginxRuntimeDefaults).toContain(
      'read_secret_file "$ADMIN_DASHBOARD_TOKEN_FILE" 32 4096',
    );
    expect(nginxRuntimeDefaults).toContain(
      'read_secret_file "$ADMIN_ACCESS_USER_FILE" 1 128',
    );
    expect(nginxRuntimeDefaults).toContain(
      'read_secret_file "$ADMIN_ACCESS_PASSWORD_FILE" 16 4096',
    );
    expect(nginxRuntimeDefaults).toContain("umask 077");
    expect(nginxRuntimeDefaults).toContain(
      'carriage_return="$(printf \'\\r\')"',
    );
    expect(nginxRuntimeDefaults).toMatch(
      /case "\$secret_value" in[\s\S]*\*"\$carriage_return"\*[\s\S]*return 1/,
    );
    expect(nginxRuntimeDefaults).toMatch(
      /if \[ "\$admin_configuration_valid" != true \]; then[\s\S]*exit 1[\s\S]*fi/,
    );
    expect(nginxRuntimeDefaults).toMatch(
      /case "\$admin_access_user" in[\s\S]*""\|\*\[!a-zA-Z0-9_.@-\]\*/,
    );
    expect(nginxRuntimeDefaults).toContain("chmod 640 /etc/nginx/.htpasswd");
    expect(nginxRuntimeDefaults).toMatch(
      /unset\s+admin_dashboard_token\s+admin_access_user\s+admin_access_password\s+admin_password_hash/,
    );
    expect(nginxRuntimeDefaults).toContain(
      "printf '%s\\n' \"$admin_access_password\" | mkpasswd -P 0 -m sha512",
    );
    expect(nginxRuntimeDefaults).toContain(
      'admin_password_hash="$(printf \'%s\\n\' "$admin_access_password" | mkpasswd -P 0 -m sha512)" || exit 1',
    );
    expect(nginxRuntimeDefaults).toContain(
      '[ -n "$admin_password_hash" ] || exit 1',
    );
    expect(nginxRuntimeDefaults).not.toContain("set -x");
    expect(nginxRuntimeDefaults).not.toMatch(/\becho\b/);
    expect(nginxRuntimeDefaults).not.toContain("${ADMIN_ACCESS_USER:-}");
    expect(nginxRuntimeDefaults).not.toContain("${ADMIN_ACCESS_PASSWORD:-}");
  });

  it("limits the tokenized proxy to exact GET dashboard requests with deferred DNS", () => {
    const dashboardLocationStart = nginxConfig.indexOf(
      "location = /api/admin/dashboard",
    );
    const fallbackApiLocationStart = nginxConfig.indexOf(
      "location ^~ /api/",
      dashboardLocationStart,
    );
    const dashboardLocation = nginxConfig.slice(
      dashboardLocationStart,
      fallbackApiLocationStart,
    );
    const fallbackApiLocation = nginxConfig.slice(
      fallbackApiLocationStart,
      nginxConfig.indexOf("location /", fallbackApiLocationStart),
    );

    expect(nginxConfig).toMatch(
      /location\s*=\s*\/healthz\s*{[^}]*return\s+200/s,
    );
    expect(dashboardLocationStart).toBeGreaterThan(-1);
    expect(fallbackApiLocationStart).toBeGreaterThan(dashboardLocationStart);
    expect(dashboardLocation).toContain("if ($request_method != GET)");
    expect(dashboardLocation).toContain("return 405");
    expect(dashboardLocation).toContain("resolver 127.0.0.11");
    expect(dashboardLocation).toContain(
      'set $apollo_api_upstream "${APOLLO_API_UPSTREAM}"',
    );
    expect(dashboardLocation).toContain(
      'proxy_set_header X-Admin-Dashboard-Token "${ADMIN_DASHBOARD_TOKEN}"',
    );
    expect(dashboardLocation).toContain(
      "proxy_pass $apollo_api_upstream$request_uri",
    );
    expect(fallbackApiLocation).toContain("return 404");
    expect(fallbackApiLocation).not.toContain("proxy_pass");
    expect(fallbackApiLocation).not.toContain("X-Admin-Dashboard-Token");
    expect(nginxConfig.match(/proxy_pass/g)).toHaveLength(1);
    expect(nginxConfig.match(/X-Admin-Dashboard-Token/g)).toHaveLength(1);
    expect(nginxConfig).toMatch(
      /location\s+\/\s*{[^}]*try_files\s+\$uri\s+\$uri\/\s+\/index\.html/s,
    );
  });

  it("omits the Basic Auth identity from production access logs", () => {
    const safeLogStart = nginxConfig.indexOf("log_format apollo_admin_safe");
    const serverStart = nginxConfig.indexOf("server {", safeLogStart);
    const safeLogFormat = nginxConfig.slice(safeLogStart, serverStart);

    expect(safeLogStart).toBeGreaterThan(-1);
    expect(safeLogFormat).not.toContain("$remote_user");
    expect(nginxConfig).toContain(
      "access_log /var/log/nginx/access.log apollo_admin_safe;",
    );
  });

  it("configures the admin service with its runtime same-origin upstream", () => {
    expect(composeConfig).not.toMatch(/^version:/m);
    expect(composeConfig).toMatch(/\n\s{2}admin:\s*\n/);
    expect(composeConfig).toContain(
      "dockerfile: artifacts/admin-dashboard/Dockerfile",
    );
    expect(composeConfig).not.toContain("VITE_ADMIN_API_URL");
    expect(composeConfig).toContain('APOLLO_API_UPSTREAM: "http://api:8080"');
    expect(composeConfig).toContain('"127.0.0.1:${TF_ADMIN_PORT:-3001}:80"');
  });

  it("selects the fixed same-origin adapter in production without a browser token", () => {
    expect(mainEntry).toContain(
      "createDashboardAdapterForEnvironment(import.meta.env.PROD)",
    );
    expect(mainEntry).not.toContain("VITE_ADMIN_API_URL");
    expect(mainEntry).not.toContain("ADMIN_DASHBOARD_TOKEN");
  });

  it("pins patched Lodash for the admin topology dependency paths", () => {
    expect(workspaceConfig).toMatch(/overrides:[\s\S]*lodash:\s*4\.18\.1/);
    expect(adminPackage.dependencies?.zod).toBe("catalog:");
  });

  it("pins the package manager used by the production image", () => {
    expect(rootPackage.packageManager).toBe("pnpm@10.33.2");
  });

  it("renders connector edges without a closed arrow marker", () => {
    expect(topologyPanel).not.toContain("MarkerType.ArrowClosed");
  });

  it("hides routing handles behind compact borderless status terminals", () => {
    expect(dashboardCss).toMatch(/\.react-flow__handle\s*{[^}]*opacity:\s*0/s);
    expect(dashboardCss).toMatch(
      /\.service-node-terminal\s*{[^}]*width:\s*7px;[^}]*height:\s*6px;[^}]*border:\s*0/s,
    );
    expect(dashboardCss).not.toMatch(
      /\.service-node-terminal\s*{[^}]*width:\s*6px;[^}]*height:\s*16px/s,
    );
    expect(dashboardCss).not.toMatch(
      /\.service-node-terminal\s*{[^}]*border-block:/s,
    );
    expect(dashboardCss).toMatch(
      /\.service-node-terminal\s*{[^}]*box-shadow:\s*none/s,
    );
  });

  it("keeps topology alignment controls segmented and on a separate mobile header row", () => {
    expect(dashboardCss).toMatch(
      /\.topology-alignment-mode\s*{[^}]*display:\s*inline-flex;[^}]*overflow:\s*hidden/s,
    );
    expect(dashboardCss).toMatch(
      /\.topology-alignment-guide\s*{[^}]*position:\s*absolute;[^}]*pointer-events:\s*none/s,
    );
    expect(dashboardCss).toMatch(
      /@media\s*\(max-width:\s*540px\)\s*{[\s\S]*\.topology-alignment-mode\s*{[^}]*order:\s*3;[^}]*width:\s*100%/s,
    );
  });
});
