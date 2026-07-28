import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const caddyfilePath = resolve(
  repositoryRoot,
  "deploy/caddy/apollo.caddyfile",
);
const validatorPath = resolve(
  repositoryRoot,
  "deploy/caddy/validate-caddy.ps1",
);

function caddyfile(): string {
  return readFileSync(caddyfilePath, "utf8");
}

describe("Apollo Caddy release include", () => {
  it("routes only the four approved hosts to their fixed loopback publications", () => {
    const source = caddyfile();
    const routes = [...source.matchAll(
      /^([a-z0-9.-]+)\s*\{[\s\S]*?^\s*reverse_proxy\s+([^\s]+)\s*$/gm,
    )].map((match) => [match[1], match[2]]);

    expect(routes).toEqual([
      ["api.apollot.ru", "127.0.0.1:18200"],
      ["api.tf.apollot.ru", "127.0.0.1:18201"],
      ["tf.apollot.ru", "127.0.0.1:18202"],
      ["admin.apollot.ru", "127.0.0.1:18203"],
    ]);
    expect(source).not.toMatch(
      /(?:^|\s)(?:apollot\.ru|www\.apollot\.ru|quasar\.apollot\.ru|ga\.apollot\.ru)(?:\s|\{)/m,
    );
  });

  it("protects admin and applies the approved response security headers", () => {
    const source = caddyfile();
    const admin = source.slice(source.indexOf("admin.apollot.ru"));

    expect(admin).toMatch(
      /basic_auth\s*\{\s*\{\$APOLLO_ADMIN_CADDY_USER\}\s+\{\$APOLLO_ADMIN_CADDY_PASSWORD_HASH\}\s*\}/s,
    );
    for (const header of [
      "Strict-Transport-Security",
      "X-Content-Type-Options",
      "X-Frame-Options",
      "Referrer-Policy",
    ]) {
      expect(source).toContain(header);
    }
    expect(source.match(/import apollo_security_headers/g)).toHaveLength(4);
  });

  it("uses native WebSocket-compatible reverse proxy defaults without unrelated imports or credential literals", () => {
    const source = caddyfile();
    const imports = [...source.matchAll(/^\s*import\s+([^\s]+)\s*$/gm)].map(
      (match) => match[1],
    );

    expect(imports).toEqual([
      "apollo_security_headers",
      "apollo_security_headers",
      "apollo_security_headers",
      "apollo_security_headers",
    ]);
    expect(source).not.toMatch(/header_up\s+(?:Connection|Upgrade)/i);
    expect(source).not.toMatch(/\$(?:2[aby]|argon2|scrypt)\$/i);
    expect(source).not.toMatch(
      /(?:password|passwd|token|secret|private[_-]?key)\s+[^\s{]/i,
    );
  });
});

describe.runIf(process.env.APOLLO_RUN_CADDY_VALIDATION === "1")(
  "Apollo Caddy container validation",
  () => {
    it(
      "validates the include in the pinned official Caddy image and cleans its exact resources",
      () => {
        const run = spawnSync(
          "pwsh",
          ["-NoLogo", "-NoProfile", "-File", validatorPath],
          {
            cwd: repositoryRoot,
            encoding: "utf8",
            env: process.env,
            windowsHide: true,
          },
        );

        expect(
          {
            error: run.error?.name,
            signal: run.signal,
            status: run.status,
            stderr: run.stderr,
            stdout: run.stdout.replace(/\r\n/g, "\n"),
          },
        ).toEqual({
          error: undefined,
          signal: null,
          status: 0,
          stderr: "",
          stdout:
            "Caddy include validation passed with docker.io/library/caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d\n",
        });
      },
      120_000,
    );
  },
);
