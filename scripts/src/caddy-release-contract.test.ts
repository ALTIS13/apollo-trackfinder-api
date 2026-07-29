import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const caddyfilePath = resolve(repositoryRoot, "deploy/caddy/apollo.caddyfile");
const validatorPath = resolve(
  repositoryRoot,
  "deploy/caddy/validate-caddy.ps1",
);
const protectedCommandPath = resolve(
  repositoryRoot,
  "deploy/caddy/caddy-protected-command.sh",
);
const rolloutPath = resolve(
  repositoryRoot,
  "docs/operations/apollo-production-rollout.md",
);
const rollbackEnvironmentCommand =
  'if [ -e "$1" ]; then cp --preserve=mode,ownership,timestamps "$1" "$2"; else rm -f "$2"; fi';

function caddyfile(): string {
  return readFileSync(caddyfilePath, "utf8");
}

function shellPath(path: string): string {
  if (process.platform !== "win32") return path;
  return `/${path[0]?.toLowerCase()}${path.slice(2).replaceAll("\\", "/")}`;
}

describe("Apollo Caddy release include", () => {
  it("routes only the four approved hosts to their fixed loopback publications", () => {
    const source = caddyfile();
    const routes = [
      ...source.matchAll(
        /^([a-z0-9.-]+)\s*\{[\s\S]*?^\s*reverse_proxy\s+([^\s]+)\s*$/gm,
      ),
    ].map((match) => [match[1], match[2]]);

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

  it("documents a protected file-backed credential validation and rollback flow", () => {
    const source = readFileSync(rolloutPath, "utf8");

    for (const value of [
      "APOLLO_ADMIN_CADDY_USER",
      "APOLLO_ADMIN_CADDY_PASSWORD_HASH",
      "<CADDY_ADMIN_USER_FILE>",
      "<CADDY_ADMIN_PASSWORD_FILE>",
      "<CADDY_ADMIN_HASH_FILE>",
      "<CADDY_APOLLO_ENV_STAGED>",
      "<CADDY_APOLLO_ENV_FILE>",
      "<CADDY_COMPLETE_CONFIG>",
      "<CADDY_COMPLETE_CONFIG_BACKUP>",
      "<CADDY_APOLLO_ENV_BACKUP>",
      "root:caddy",
      "0640",
      "root:root",
      "0600",
      'hash-password < "$1" > "$2"',
      "deploy/caddy/caddy-protected-command.sh validate",
      "deploy/caddy/caddy-protected-command.sh reload",
    ]) {
      expect(source).toContain(value);
    }
    expect(source).toContain("exactly one LF-terminated line");
    expect(source).toContain("bcrypt");
  });

  it.each([
    ["prior env present", true, "present"],
    ["prior env absent", false, "absent"],
  ] as const)(
    "runs rollback validate and reload with %s",
    (_label, priorEnvironment, expectedCredentialState) => {
      const root = mkdtempSync(join(tmpdir(), "apollo-caddy-command-"));
      const environmentPath = join(root, "apollo.env");
      const environmentBackupPath = join(root, "apollo.env.backup");
      const configPath = join(root, "Caddyfile");
      const fakeCaddyPath = join(root, "caddy-contract");
      const contractCommandPath = join(root, "caddy-protected-command.sh");
      writeFileSync(configPath, "{}\n", { mode: 0o600 });
      writeFileSync(
        fakeCaddyPath,
        `#!/bin/sh
set -eu
[ "$2" = "--config" ]
[ "$4" = "--adapter" ]
[ "$5" = "caddyfile" ]
if [ "\${APOLLO_ADMIN_CADDY_USER+x}" = x ] &&
   [ "\${APOLLO_ADMIN_CADDY_PASSWORD_HASH+x}" = x ]; then
  credential_state=present
else
  credential_state=absent
fi
printf '%s:%s\\n' "$1" "$credential_state"
`,
        { mode: 0o700 },
      );
      chmodSync(fakeCaddyPath, 0o700);
      const commandSource = readFileSync(protectedCommandPath, "utf8");
      expect(commandSource.match(/\/usr\/bin\/caddy/g)).toHaveLength(1);
      writeFileSync(
        contractCommandPath,
        commandSource.replace(
          "/usr/bin/caddy",
          `'${shellPath(fakeCaddyPath).replaceAll("'", "'\\''")}'`,
        ),
        { mode: 0o700 },
      );
      chmodSync(contractCommandPath, 0o700);
      writeFileSync(
        environmentPath,
        `APOLLO_ADMIN_CADDY_USER='${randomUUID()}'\n` +
          `APOLLO_ADMIN_CADDY_PASSWORD_HASH='${randomUUID()}'\n`,
        { mode: 0o600 },
      );
      if (priorEnvironment) {
        writeFileSync(
          environmentBackupPath,
          `APOLLO_ADMIN_CADDY_USER='${randomUUID()}'\n` +
            `APOLLO_ADMIN_CADDY_PASSWORD_HASH='${randomUUID()}'\n`,
          { mode: 0o600 },
        );
      }
      const executable =
        process.platform === "win32"
          ? "C:\\Program Files\\Git\\bin\\bash.exe"
          : "bash";
      try {
        expect(readFileSync(rolloutPath, "utf8")).toContain(
          rollbackEnvironmentCommand,
        );
        const restore = spawnSync(
          executable,
          [
            "-ceu",
            rollbackEnvironmentCommand,
            "sh",
            shellPath(environmentBackupPath),
            shellPath(environmentPath),
          ],
          {
            encoding: "utf8",
            windowsHide: true,
          },
        );
        expect({
          signal: restore.signal,
          status: restore.status,
          stderr: restore.stderr,
          stdout: restore.stdout,
        }).toEqual({
          signal: null,
          status: 0,
          stderr: "",
          stdout: "",
        });
        expect(existsSync(environmentPath)).toBe(priorEnvironment);
        for (const operation of ["validate", "reload"] as const) {
          const run = spawnSync(
            executable,
            [
              shellPath(contractCommandPath),
              operation,
              shellPath(environmentPath),
              shellPath(configPath),
            ],
            {
              encoding: "utf8",
              env: {
                ...process.env,
                APOLLO_ADMIN_CADDY_PASSWORD_HASH: randomUUID(),
                APOLLO_ADMIN_CADDY_USER: randomUUID(),
              },
              windowsHide: true,
            },
          );
          expect({
            signal: run.signal,
            status: run.status,
            stderr: run.stderr,
            stdout: run.stdout,
          }).toEqual({
            signal: null,
            status: 0,
            stderr: "",
            stdout: `${operation}:${expectedCredentialState}\n`,
          });
        }
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    },
  );
});

describe.runIf(process.env.APOLLO_RUN_CADDY_VALIDATION === "1")(
  "Apollo Caddy container validation",
  () => {
    it("validates the include in the pinned official Caddy image and cleans its exact resources", () => {
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

      expect({
        error: run.error?.name,
        signal: run.signal,
        status: run.status,
        stderr: run.stderr,
        stdout: run.stdout.replace(/\r\n/g, "\n"),
      }).toEqual({
        error: undefined,
        signal: null,
        status: 0,
        stderr: "",
        stdout:
          "Caddy include validation passed with docker.io/library/caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d\n",
      });
    }, 120_000);
  },
);
