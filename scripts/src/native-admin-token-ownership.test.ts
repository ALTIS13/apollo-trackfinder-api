import { spawnSync } from "node:child_process";
import {
  chmodSync,
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
const proofPath = resolve(
  repositoryRoot,
  "deploy/ops/prove-admin-token-ownership.sh",
);

function shellPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive) => {
    return `/${String(drive).toLowerCase()}`;
  });
}

describe("native-Linux shared admin token proof", () => {
  it("uses one bind-secret source for the real UID 10001 and root image consumers", () => {
    const source = readFileSync(proofPath, "utf8");

    expect(source).toContain('expected_metadata="10001:10001:400"');
    expect(source).toContain('user: "10001:10001"');
    expect(source).toContain('user: "0:0"');
    expect(source.match(/source: admin_dashboard_token/g)).toHaveLength(2);
    expect(source.match(/cap_drop:/g)).toHaveLength(1);
    expect(source).toContain("file: ${APOLLO_ADMIN_DASHBOARD_TOKEN_FILE:?}");
    expect(source).not.toContain("FRESH_RELEASE_VOLUME");
    expect(source).not.toContain("apollo-tf-postgres-v1");
    expect(source).toContain('test -f "$$file" && test -r "$$file"');
    expect(source).toContain('test "$$size" -ge 32');
    expect(source).toContain('test "$$size" -le 4096');
    expect(source).not.toContain('test -f "$file"');
  });

  it("runs without credential or source-path disclosure in argv or output", () => {
    const root = mkdtempSync(join(tmpdir(), "apollo-native-token-contract-"));
    const bin = join(root, "bin");
    const lockParent = join(root, "locks");
    const secretDirectory = join(root, "secrets");
    const tokenPath = join(secretDirectory, "admin_dashboard_token");
    const commandLog = join(root, "commands.log");
    const composeLog = join(root, "compose-input.log");
    const token = "synthetic-native-token-value-1234567890";
    const digest = `sha256:${"a".repeat(64)}`;
    const executable =
      process.platform === "win32"
        ? "C:\\Program Files\\Git\\bin\\bash.exe"
        : "bash";
    try {
      for (const directory of [bin, lockParent, secretDirectory]) {
        mkdirSync(directory);
      }
      writeFileSync(tokenPath, token, { mode: 0o400 });
      writeFileSync(
        join(bin, "stat"),
        `#!/bin/sh
set -eu
printf 'stat %s\n' "$*" >> "$APOLLO_COMMAND_LOG"
printf '10001:10001:400\n'
`,
        { mode: 0o700 },
      );
      writeFileSync(
        join(bin, "docker"),
        `#!/bin/sh
set -eu
printf 'docker %s\n' "$*" >> "$APOLLO_COMMAND_LOG"
case "$*" in
  *"compose -f - -p "*" run "*)
    cat >> "$APOLLO_COMPOSE_LOG"
    ;;
  *"compose -f - -p "*" down"*)
    cat >> "$APOLLO_COMPOSE_LOG"
    ;;
esac
`,
        { mode: 0o700 },
      );
      chmodSync(join(bin, "stat"), 0o700);
      chmodSync(join(bin, "docker"), 0o700);

      const run = spawnSync(
        executable,
        [
          "-ceu",
          'PATH="$APOLLO_TEST_BIN:$PATH"; export PATH; exec "$1"',
          "sh",
          shellPath(proofPath),
        ],
        {
          cwd: repositoryRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            APOLLO_ADMIN_DASHBOARD_TOKEN_FILE: shellPath(tokenPath),
            APOLLO_COMMAND_LOG: shellPath(commandLog),
            APOLLO_COMPOSE_LOG: shellPath(composeLog),
            APOLLO_NATIVE_PROOF_ID: "contract-001",
            APOLLO_NATIVE_PROOF_LOCK_PARENT: shellPath(lockParent),
            APOLLO_TEST_BIN: shellPath(bin),
            APOLLO_TF_ADMIN_IMAGE: `ghcr.io/example/tf-admin@${digest}`,
            APOLLO_TF_API_IMAGE: `ghcr.io/example/tf-api@${digest}`,
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
        stdout: "native-admin-token-proof: complete\n",
      });
      const commands = readFileSync(commandLog, "utf8");
      const compose = readFileSync(composeLog, "utf8");
      expect(commands).not.toContain(token);
      expect(commands).not.toContain(shellPath(tokenPath));
      expect(run.stdout + run.stderr).not.toContain(token);
      expect(run.stdout + run.stderr).not.toContain(shellPath(tokenPath));
      expect(compose).not.toContain(token);
      expect(compose).toContain("file: ${APOLLO_ADMIN_DASHBOARD_TOKEN_FILE:?}");
      expect(compose.match(/source: admin_dashboard_token/g)).toHaveLength(6);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
