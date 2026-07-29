import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
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
const credentialGeneratorPath = resolve(
  repositoryRoot,
  "deploy/caddy/prepare-admin-credentials.sh",
);
const credentialVerifierPath = resolve(
  repositoryRoot,
  "deploy/caddy/verify-admin-credentials.sh",
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
    expect(source.match(/import apollo_security_headers/g)).toHaveLength(5);
  });

  it("runs admin security headers before authentication and proxy responses", () => {
    const source = caddyfile();
    const admin = source.slice(source.indexOf("admin.apollot.ru"));
    const route = admin.match(/route\s*\{([\s\S]*?)^\s*\}\s*^\}/m)?.[1];
    const headerIndex = route?.indexOf("import apollo_security_headers") ?? -1;
    const authenticationIndex = route?.indexOf("basic_auth") ?? -1;
    const proxyIndex = route?.indexOf("reverse_proxy") ?? -1;

    expect(route).toBeDefined();
    expect(headerIndex).toBeGreaterThanOrEqual(0);
    expect(authenticationIndex).toBeGreaterThanOrEqual(0);
    expect(proxyIndex).toBeGreaterThanOrEqual(0);
    expect(headerIndex).toBeLessThan(authenticationIndex);
    expect(authenticationIndex).toBeLessThan(proxyIndex);
  });

  it("renders admin authentication failures through the security header handler", () => {
    const source = caddyfile();
    const admin = source.slice(source.indexOf("admin.apollot.ru"));

    expect(admin).toMatch(
      /handle_errors\s+401\s*\{[\s\S]*?import\s+apollo_security_headers[\s\S]*?header\s+WWW-Authenticate\s+"Basic realm=\\"restricted\\""\s*[\s\S]*?respond\s+401\s*\}/,
    );
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
      "deploy/caddy/verify-admin-credentials.sh",
      "deploy/caddy/caddy-protected-command.sh validate",
      "deploy/caddy/caddy-protected-command.sh reload",
    ]) {
      expect(source).toContain(value);
    }
    expect(source).toContain(
      "sudo deploy/caddy/verify-admin-credentials.sh \\\n" +
        "  '<ADMIN_CREDENTIAL_GENERATION_PARENT>/<ADMIN_CREDENTIAL_GENERATION>/admin_access_htpasswd' \\\n" +
        "  '<ADMIN_CREDENTIAL_GENERATION_PARENT>/<ADMIN_CREDENTIAL_GENERATION>/caddy.env'",
    );
    expect(source).toContain("exactly one LF-terminated line");
    expect(source).toContain("bcrypt");
  });

  it("derives the nginx htpasswd and Caddy handoff from one protected source without credential argv", () => {
    const root = mkdtempSync(join(tmpdir(), "apollo-admin-credentials-"));
    const sourceDirectory = join(root, "source");
    const generationParent = join(root, "generations");
    const bin = join(root, "bin");
    const generation = "release-contract-001";
    const commandLog = join(root, "commands.log");
    const username = "release-contract-user";
    const password = "synthetic-contract-password-value";
    const bcrypt = `$2a$12$${"A".repeat(53)}`;
    const executable =
      process.platform === "win32"
        ? "C:\\Program Files\\Git\\bin\\bash.exe"
        : "bash";
    try {
      for (const directory of [sourceDirectory, generationParent, bin]) {
        mkdirSync(directory);
      }
      writeFileSync(
        join(sourceDirectory, "admin_access_user"),
        `${username}\n`,
        {
          mode: 0o600,
        },
      );
      writeFileSync(
        join(sourceDirectory, "admin_access_password"),
        `${password}\n`,
        { mode: 0o600 },
      );
      writeFileSync(
        join(bin, "caddy"),
        `#!/bin/sh
set -eu
printf 'caddy %s\n' "$*" >> "$APOLLO_COMMAND_LOG"
[ "$#" -eq 1 ] && [ "$1" = hash-password ]
cat >/dev/null
printf '%s\n' '${bcrypt}'
`,
        { mode: 0o700 },
      );
      writeFileSync(
        join(bin, "stat"),
        `#!/bin/sh
set -eu
case "$*" in
  *admin_access_user|*admin_access_password) printf '0:0:600\n' ;;
  *) exec /usr/bin/stat "$@" ;;
esac
`,
        { mode: 0o700 },
      );
      writeFileSync(
        join(bin, "chown"),
        `#!/bin/sh
set -eu
printf 'chown %s\n' "$*" >> "$APOLLO_COMMAND_LOG"
`,
        { mode: 0o700 },
      );
      chmodSync(join(bin, "caddy"), 0o700);
      chmodSync(join(bin, "stat"), 0o700);
      chmodSync(join(bin, "chown"), 0o700);

      const run = spawnSync(
        executable,
        [
          "-ceu",
          'PATH="$APOLLO_TEST_BIN:$PATH"; export PATH; exec "$1"',
          "sh",
          shellPath(credentialGeneratorPath),
        ],
        {
          cwd: repositoryRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            APOLLO_ADMIN_CREDENTIAL_GENERATION: generation,
            APOLLO_ADMIN_GENERATION_PARENT: shellPath(generationParent),
            APOLLO_ADMIN_SOURCE_DIRECTORY: shellPath(sourceDirectory),
            APOLLO_COMMAND_LOG: shellPath(commandLog),
            APOLLO_TEST_BIN: shellPath(bin),
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
        stdout: "admin-credential-generation: complete\n",
      });
      const outputDirectory = join(generationParent, generation);
      const htpasswd = readFileSync(
        join(outputDirectory, "admin_access_htpasswd"),
        "utf8",
      );
      const caddyEnvironment = readFileSync(
        join(outputDirectory, "caddy.env"),
        "utf8",
      );
      expect(htpasswd).toBe(`${username}:${bcrypt}`);
      expect(caddyEnvironment).toBe(
        `APOLLO_ADMIN_CADDY_USER='${username}'\n` +
          `APOLLO_ADMIN_CADDY_PASSWORD_HASH='${bcrypt}'\n`,
      );
      expect(htpasswd).not.toContain(password);
      expect(caddyEnvironment).not.toContain(password);

      const verify = (htpasswdFile: string, environmentFile: string) =>
        spawnSync(
          executable,
          [
            shellPath(credentialVerifierPath),
            shellPath(htpasswdFile),
            shellPath(environmentFile),
          ],
          {
            cwd: repositoryRoot,
            encoding: "utf8",
            windowsHide: true,
          },
        );
      const htpasswdFile = join(outputDirectory, "admin_access_htpasswd");
      const environmentFile = join(outputDirectory, "caddy.env");
      const verified = verify(htpasswdFile, environmentFile);
      expect({
        signal: verified.signal,
        status: verified.status,
        stderr: verified.stderr,
        stdout: verified.stdout,
      }).toEqual({
        signal: null,
        status: 0,
        stderr: "",
        stdout: "",
      });

      const commandMarker = join(root, "caddy-environment-command-marker");
      const invalidUsername = "invalid user";
      const invalidBcrypt = `$2x$12$${"A".repeat(53)}`;
      const malformedPairHash = "not-a-bcrypt";
      const hostileCases: Array<{
        name: string;
        htpasswd: string;
        environment: string;
        marker?: string;
      }> = [
        { name: "empty htpasswd", htpasswd: "", environment: caddyEnvironment },
        {
          name: "LF-terminated htpasswd",
          htpasswd: `${htpasswd}\n`,
          environment: caddyEnvironment,
        },
        {
          name: "mismatched Caddy username",
          htpasswd,
          environment:
            `APOLLO_ADMIN_CADDY_USER='other-user'\n` +
            `APOLLO_ADMIN_CADDY_PASSWORD_HASH='${bcrypt}'\n`,
        },
        {
          name: "mismatched Caddy hash",
          htpasswd,
          environment:
            `APOLLO_ADMIN_CADDY_USER='${username}'\n` +
            `APOLLO_ADMIN_CADDY_PASSWORD_HASH='$2a$12$${"B".repeat(53)}'\n`,
        },
        {
          name: "command-bearing Caddy environment",
          htpasswd,
          environment: `${caddyEnvironment}: > '${shellPath(commandMarker)}'\n`,
          marker: commandMarker,
        },
        {
          name: "syntactically malformed Caddy environment",
          htpasswd,
          environment:
            `APOLLO_ADMIN_CADDY_USER='${username}'\n` +
            `APOLLO_ADMIN_CADDY_PASSWORD_HASH='${bcrypt}\n`,
        },
        {
          name: "Caddy environment with an extra line",
          htpasswd,
          environment: `${caddyEnvironment}UNEXPECTED='value'\n`,
        },
        {
          name: "invalid username",
          htpasswd: `${invalidUsername}:${bcrypt}`,
          environment:
            `APOLLO_ADMIN_CADDY_USER='${invalidUsername}'\n` +
            `APOLLO_ADMIN_CADDY_PASSWORD_HASH='${bcrypt}'\n`,
        },
        {
          name: "invalid bcrypt",
          htpasswd: `${username}:${invalidBcrypt}`,
          environment:
            `APOLLO_ADMIN_CADDY_USER='${username}'\n` +
            `APOLLO_ADMIN_CADDY_PASSWORD_HASH='${invalidBcrypt}'\n`,
        },
        {
          name: "matching malformed pair",
          htpasswd: `${username}:${malformedPairHash}`,
          environment:
            `APOLLO_ADMIN_CADDY_USER='${username}'\n` +
            `APOLLO_ADMIN_CADDY_PASSWORD_HASH='${malformedPairHash}'\n`,
        },
      ];
      for (const { name, htpasswd: hostileHtpasswd, environment, marker } of hostileCases) {
        const hostileHtpasswdFile = join(root, `${name}.htpasswd`);
        const hostileEnvironmentFile = join(root, `${name}.env`);
        writeFileSync(hostileHtpasswdFile, hostileHtpasswd, { mode: 0o400 });
        writeFileSync(hostileEnvironmentFile, environment, {
          mode: 0o640,
        });

        const rejected = verify(hostileHtpasswdFile, hostileEnvironmentFile);
        expect(rejected.status, name).not.toBe(0);
        expect(rejected.stdout, name).toBe("");
        expect(rejected.stderr, name).toBe("");
        if (marker) expect(existsSync(marker), name).toBe(false);
        for (const secret of [
          username,
          bcrypt,
          password,
          invalidUsername,
          invalidBcrypt,
          malformedPairHash,
        ]) {
          expect(`${rejected.stdout}${rejected.stderr}`, name).not.toContain(
            secret,
          );
        }
      }

      expect(readFileSync(commandLog, "utf8")).toBe(
        "caddy hash-password\n" +
          "chown root:root " +
          `${shellPath(join(outputDirectory, "admin_access_htpasswd.tmp"))}\n` +
          "chown root:caddy " +
          `${shellPath(join(outputDirectory, "caddy.env.tmp"))}\n` +
          "chown root:caddy " +
          `${shellPath(outputDirectory)}\n`,
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }, 30_000);

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
