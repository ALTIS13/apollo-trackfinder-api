import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

const worktree = resolve(import.meta.dirname, "../..");
const bash = "C:/Program Files/Git/bin/bash.exe";
const backupScript = join(worktree, "deploy/ops/backup-postgres.sh");
const verifyScript = join(worktree, "deploy/ops/verify-backup.sh");
const restoreScript = join(worktree, "deploy/ops/restore-postgres.sh");
const classifyScript = join(worktree, "deploy/ops/classify-retained-volume.sh");
const temporaryRoots: string[] = [];
const postgres16Fixture =
  "docker.io/library/postgres:16-bookworm@sha256:92620daddcd947f8d5ab5ba66e848702fe443d87fed30c4cea8e389fd78dfc55";
const shellContractTimeoutMs = 30_000;
const dockerContractTimeoutMs = 90_000;

type Result = ReturnType<typeof spawnSync>;

function posixPath(value: string): string {
  return value.replace(/^([A-Z]):/i, (_match, drive: string) => `/${drive.toLowerCase()}`).replaceAll("\\", "/");
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "apollo-task4-"));
  temporaryRoots.push(root);
  return root;
}

function requireScript(script: string): boolean {
  if (existsSync(script)) return true;
  expect(false).toBe(true);
  return false;
}

function runScript(script: string, env: NodeJS.ProcessEnv, args: string[] = []): Result {
  return spawnSync(bash, [posixPath(script), ...args], {
    cwd: worktree,
    encoding: "utf8",
    env,
  });
}

async function runScriptAsync(
  script: string,
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stderr: string; stdout: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(bash, [posixPath(script)], {
      cwd: worktree,
      env,
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", rejectRun);
    child.once("close", (status) =>
      resolveRun({
        status,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      }),
    );
  });
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error("test synchronization timed out");
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents, { encoding: "utf8", mode: 0o755 });
  chmodSync(path, 0o755);
}

function contractEnvironment(root: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const bin = join(root, "bin");
  const destination = join(root, "backup");
  const passfile = join(root, "pgpass");
  writeFileSync(passfile, "test-only-passfile\n", { encoding: "utf8", mode: 0o600 });
  execFileSync(bash, ["-lc", `mkdir -p '${posixPath(bin)}' '${posixPath(destination)}'`]);
  const log = join(root, "commands.log");
  writeExecutable(join(bin, "pg_dump"), "#!/bin/sh\nprintf 'pg_dump %s\\n' \"$*\" >> \"$FAKE_LOG\"\nif [ \"${1:-}\" = --version ]; then printf 'pg_dump (PostgreSQL) %s.0\\n' \"${FAKE_PG_DUMP_MAJOR:-16}\"; exit 0; fi\nif [ -n \"${FAKE_PG_DUMP_STARTED_FILE:-}\" ]; then : > \"$FAKE_PG_DUMP_STARTED_FILE\"; fi\nif [ -n \"${FAKE_PG_DUMP_RELEASE_FILE:-}\" ]; then while [ ! -e \"$FAKE_PG_DUMP_RELEASE_FILE\" ]; do sleep 0.02; done; fi\nif [ \"${FAKE_PG_DUMP_FAIL:-}\" = 1 ]; then printf '%s\\n' \"$FAKE_SENSITIVE\" >&2; exit 1; fi\nprintf 'task4-custom-dump'\n");
  writeExecutable(join(bin, "age"), "#!/bin/sh\nprintf 'age %s\\n' \"$*\" >> \"$FAKE_LOG\"\nif [ \"${FAKE_AGE_FAIL:-}\" = 1 ]; then cat >/dev/null; printf '%s\\n' \"$FAKE_SENSITIVE\" >&2; exit 1; fi\nprintf 'age:'\ncat\n");
  writeExecutable(join(bin, "psql"), "#!/bin/sh\nprintf 'psql %s\\n' \"$*\" >> \"$FAKE_LOG\"\ncase \"$*\" in *\"SHOW server_version_num\"*) printf '%s0000\\n' \"${FAKE_PG_SERVER_MAJOR:-16}\"; exit 0 ;; esac\nif [ \"${FAKE_PSQL_FAIL:-}\" = 1 ]; then printf '%s\\n' \"$FAKE_SENSITIVE\" >&2; exit 1; fi\nif [ -n \"${FAKE_TARGET_RESULT:-}\" ]; then printf '%s\\n' \"$FAKE_TARGET_RESULT\"; fi\nif [ -n \"${FAKE_TARGET_PROBE:-}\" ]; then case \"$*\" in *\"$FAKE_TARGET_PROBE\"*) printf '1\\n' ;; esac; fi\nif [ \"${FAKE_TARGET_NOT_EMPTY:-}\" = 1 ]; then printf '1\\n'; fi\n");
  writeExecutable(join(bin, "pg_restore"), "#!/bin/sh\nprintf 'pg_restore %s\\n' \"$*\" >> \"$FAKE_LOG\"\nif [ \"${1:-}\" = --version ]; then printf 'pg_restore (PostgreSQL) %s.0\\n' \"${FAKE_PG_RESTORE_MAJOR:-16}\"; exit 0; fi\nif [ \"${FAKE_PG_RESTORE_FAIL:-}\" = 1 ]; then cat >/dev/null; printf '%s\\n' \"$FAKE_SENSITIVE\" >&2; exit 1; fi\ncat > \"$FAKE_RESTORE_INPUT\"\n");
  writeExecutable(join(bin, "sha256sum"), "#!/bin/sh\nprintf 'sha256sum %s\\n' \"$*\" >> \"$FAKE_LOG\"\nif [ \"${FAKE_SHA256_FAIL:-}\" = 1 ]; then printf '%s\\n' \"$FAKE_SENSITIVE\" >&2; exit 1; fi\nprintf '%s  %s\\n' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \"$1\"\n");
  writeExecutable(join(bin, "mktemp"), "#!/bin/sh\nif [ \"${FAKE_MKTEMP_FAIL:-}\" = 1 ]; then printf '%s\\n' \"$FAKE_SENSITIVE\" >&2; exit 1; fi\nexec /usr/bin/mktemp \"$@\"\n");
  writeExecutable(join(bin, "docker"), "#!/bin/sh\nprintf 'docker %s\\n' \"$*\" >> \"$FAKE_LOG\"\ncase \"$1\" in volume) printf '%s\\n' \"$3\" ;; ps) if [ \"${FAKE_DOCKER_ATTACHED:-}\" = 1 ]; then printf 'task-owned-container\\n'; fi ;; esac\n");
  return {
    ...process.env,
    PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
    PGPASSFILE: passfile,
    APOLLO_BACKUP_PGHOST: "source.internal",
    APOLLO_BACKUP_PGPORT: "55432",
    APOLLO_BACKUP_PGDATABASE: "apollo_trackfinder",
    APOLLO_BACKUP_PGUSER: "backup_operator",
    APOLLO_BACKUP_STACK: "apollo-tf",
    APOLLO_BACKUP_RELEASE_ID: "release-task4-001",
    APOLLO_BACKUP_DESTINATION: destination,
    APOLLO_BACKUP_AGE_RECIPIENT: `age1${"a".repeat(58)}`,
    FAKE_LOG: log,
    FAKE_RESTORE_INPUT: join(root, "restore-input"),
    FAKE_SENSITIVE: ["sensitive", "tool", "output"].join("-"),
    ...overrides,
  };
}

function claimDirectory(env: NodeJS.ProcessEnv): string {
  return join(
    env.APOLLO_BACKUP_DESTINATION!,
    `.${env.APOLLO_BACKUP_RELEASE_ID}.apollo-backup-claim`,
  );
}

function claimState(env: NodeJS.ProcessEnv): Record<string, unknown> {
  return JSON.parse(readFileSync(join(claimDirectory(env), "state.json"), "utf8"));
}

function withBashFunctions(root: string, env: NodeJS.ProcessEnv, functions: string): NodeJS.ProcessEnv {
  const hook = join(root, "bash-functions");
  writeFileSync(hook, functions, { encoding: "utf8", mode: 0o600 });
  return { ...env, BASH_ENV: posixPath(hook) };
}

function restoreEnvironment(root: string, env: NodeJS.ProcessEnv, artifacts: ReturnType<typeof backupArtifacts>, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const identity = join(root, "identity");
  writeFileSync(identity, "test identity\n", { mode: 0o600 });
  return {
    ...env,
    APOLLO_RESTORE_BACKUP: artifacts.dump,
    APOLLO_RESTORE_CHECKSUM: artifacts.checksum,
    APOLLO_RESTORE_METADATA: artifacts.metadata,
    APOLLO_RESTORE_AGE_IDENTITY: identity,
    APOLLO_RESTORE_PGHOST: "restore.internal",
    APOLLO_RESTORE_PGPORT: "55433",
    APOLLO_RESTORE_PGDATABASE: "apollo_trackfinder",
    APOLLO_RESTORE_PGUSER: "restore_operator",
    APOLLO_RESTORE_EXPECTED_STACK: "apollo-tf",
    APOLLO_RESTORE_EXPECTED_DATABASE: "apollo_trackfinder",
    APOLLO_RESTORE_EXPECTED_RELEASE_ID: "release-task4-001",
    APOLLO_RESTORE_DISPOSABLE: "1",
    ...overrides,
  };
}

function output(result: Result): string {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function backupArtifacts(destination: string): { dump: string; checksum: string; metadata: string } {
  const names = readdirSync(destination);
  const dump = names.find((name) => name.endsWith(".dump.age"));
  const checksum = names.find((name) => name.endsWith(".sha256"));
  const metadata = names.find((name) => name.endsWith(".json"));
  expect(dump).toBeDefined();
  expect(checksum).toBeDefined();
  expect(metadata).toBeDefined();
  return {
    dump: join(destination, dump!),
    checksum: join(destination, checksum!),
    metadata: join(destination, metadata!),
  };
}

afterEach(() => {
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
});

describe("encrypted PostgreSQL backup contract", () => {
  it("rejects password and database URL arguments without printing them", () => {
    if (!requireScript(backupScript)) return;
    const root = temporaryRoot();
    const env = contractEnvironment(root);
    const forbiddenArgument = ["postgres:", "//blocked@invalid", "/database"].join("");
    const result = runScript(backupScript, env, [forbiddenArgument]);
    expect(result.status).not.toBe(0);
    expect(output(result)).toBe("backup: input failed\n");
  });

  it.each([
    "APOLLO_BACKUP_AGE_RECIPIENT",
    "APOLLO_BACKUP_DESTINATION",
    "APOLLO_BACKUP_RELEASE_ID",
  ])("fails before writing when %s is absent", (missing) => {
    if (!requireScript(backupScript)) return;
    const root = temporaryRoot();
    const env = contractEnvironment(root, { [missing]: "" });
    const result = runScript(backupScript, env);
    expect(result.status).not.toBe(0);
    expect(output(result)).toBe("backup: input failed\n");
    expect(readdirSync(join(root, "backup"))).toEqual([]);
  });

  it("streams pg_dump into age and commits only private final artifacts", () => {
    if (!requireScript(backupScript)) return;
    const root = temporaryRoot();
    const env = contractEnvironment(root);
    const result = runScript(backupScript, env);
    expect(result.status, output(result)).toBe(0);
    expect(output(result)).toBe("backup: complete\n");
    const artifacts = backupArtifacts(env.APOLLO_BACKUP_DESTINATION!);
    expect(readFileSync(artifacts.dump, "utf8")).toBe("age:task4-custom-dump");
    expect(readdirSync(env.APOLLO_BACKUP_DESTINATION!).sort()).toEqual(
      [
        basename(artifacts.checksum),
        basename(artifacts.dump),
        basename(artifacts.metadata),
        basename(claimDirectory(env)),
      ].sort(),
    );
    expect(claimState(env)).toMatchObject({
      release_id: "release-task4-001",
      state: "complete",
    });
    const commandLog = readFileSync(env.FAKE_LOG!, "utf8");
    expect(commandLog).toContain("pg_dump --format=custom --no-owner --no-privileges");
    expect(commandLog).toContain("age -r");
  });

  it.each([
    ["apollo-platform", "apollo_platform", "16"],
    ["apollo-tf", "apollo_trackfinder", "16"],
    ["apollo-tf-integrations", "apollo_tf_integrations", "17"],
  ])(
    "enforces PostgreSQL %s client and server major for %s",
    (stack, database, major) => {
      if (!requireScript(backupScript)) return;
      const root = temporaryRoot();
      const env = contractEnvironment(root, {
        APOLLO_BACKUP_STACK: stack,
        APOLLO_BACKUP_PGDATABASE: database,
        FAKE_PG_DUMP_MAJOR: major,
        FAKE_PG_SERVER_MAJOR: major,
      });
      const result = runScript(backupScript, env);

      expect(result.status, output(result)).toBe(0);
      const log = readFileSync(env.FAKE_LOG!, "utf8");
      expect(log).toContain("pg_dump --version");
      expect(log).toContain("SHOW server_version_num");
      expect(
        JSON.parse(
          readFileSync(
            backupArtifacts(env.APOLLO_BACKUP_DESTINATION!).metadata,
            "utf8",
          ),
        ),
      ).toMatchObject({
        postgres_client_major: Number(major),
        postgres_server_major: Number(major),
      });
    },
  );

  it.each([
    ["client", { FAKE_PG_DUMP_MAJOR: "16", FAKE_PG_SERVER_MAJOR: "17" }],
    ["server", { FAKE_PG_DUMP_MAJOR: "17", FAKE_PG_SERVER_MAJOR: "16" }],
  ])("rejects an integrations PostgreSQL %s major mismatch", (_kind, overrides) => {
    if (!requireScript(backupScript)) return;
    const root = temporaryRoot();
    const env = contractEnvironment(root, {
      APOLLO_BACKUP_STACK: "apollo-tf-integrations",
      APOLLO_BACKUP_PGDATABASE: "apollo_tf_integrations",
      ...overrides,
    });
    const result = runScript(backupScript, env);

    expect(result.status).not.toBe(0);
    expect(output(result)).toBe("backup: version failed\n");
    expect(
      readdirSync(env.APOLLO_BACKUP_DESTINATION!).filter((name) =>
        /\.(?:dump\.age|sha256|json)$/.test(name),
      ),
    ).toEqual([]);
    expect(claimState(env)).toMatchObject({
      failed_stage: "version",
      state: "quarantined",
    });
  });

  it("removes all partial backup artifacts when encryption fails", () => {
    if (!requireScript(backupScript)) return;
    const root = temporaryRoot();
    const env = contractEnvironment(root, { FAKE_AGE_FAIL: "1" });
    const result = runScript(backupScript, env);
    expect(result.status).not.toBe(0);
    expect(output(result)).toBe("backup: encrypt failed\n");
    expect(readdirSync(env.APOLLO_BACKUP_DESTINATION!)).toEqual([
      basename(claimDirectory(env)),
    ]);
    expect(claimState(env)).toMatchObject({
      failed_stage: "encrypt",
      state: "quarantined",
    });
  });

  it.each([
    ["pg_dump", { FAKE_PG_DUMP_FAIL: "1" }, "backup: dump failed\n"],
    ["age", { FAKE_AGE_FAIL: "1" }, "backup: encrypt failed\n"],
  ])("redacts %s failures", (_tool, overrides, expected) => {
    if (!requireScript(backupScript)) return;
    const root = temporaryRoot();
    const env = contractEnvironment(root, overrides);
    const result = runScript(backupScript, env);
    expect(result.status).not.toBe(0);
    expect(output(result)).toBe(expected);
    expect(output(result).includes(env.FAKE_SENSITIVE!)).toBe(false);
  });

  it("redacts mktemp failures", () => {
    if (!requireScript(backupScript)) return;
    const root = temporaryRoot();
    const env = withBashFunctions(root, contractEnvironment(root), "mktemp() { printf '%s\\n' \"$FAKE_SENSITIVE\" >&2; return 1; }\n");
    const result = runScript(backupScript, env);
    expect(result.status).not.toBe(0);
    expect(output(result)).toBe("backup: prepare failed\n");
    expect(output(result).includes(env.FAKE_SENSITIVE!)).toBe(false);
  });

  it("redacts cleanup failures after an interrupted backup", () => {
    if (!requireScript(backupScript)) return;
    const root = temporaryRoot();
    const env = withBashFunctions(root, contractEnvironment(root, { FAKE_AGE_FAIL: "1" }), "rm() { printf '%s\\n' \"$FAKE_SENSITIVE\" >&2; return 1; }\n");
    const result = runScript(backupScript, env);
    expect(result.status).not.toBe(0);
    expect(output(result)).toBe("backup: encrypt failed\n");
    expect(output(result).includes(env.FAKE_SENSITIVE!)).toBe(false);
  });

  it("uses no-overwrite publication and requests 0600 for final artifacts", () => {
    if (!requireScript(backupScript)) return;
    const root = temporaryRoot();
    const env = withBashFunctions(root, contractEnvironment(root), "chmod() { printf 'chmod %s\\n' \"$*\" >> \"$FAKE_LOG\"; }\nln() { printf 'ln %s\\n' \"$*\" >> \"$FAKE_LOG\"; /usr/bin/ln \"$@\"; }\n");
    const result = runScript(backupScript, env);
    expect(result.status).toBe(0);
    const artifacts = backupArtifacts(env.APOLLO_BACKUP_DESTINATION!);
    const log = readFileSync(env.FAKE_LOG!, "utf8");
    expect(log.match(/^ln /gm)).toHaveLength(6);
    const finalChmod = log.split("\n").find((line) => line.startsWith("chmod 600") && line.includes(basename(artifacts.dump)));
    expect(finalChmod).toContain("chmod 600");
    expect(finalChmod).toContain(basename(artifacts.checksum));
    expect(finalChmod).toContain(basename(artifacts.metadata));
  });

  it("writes final artifacts with actual 0600 modes in Linux", () => {
    if (!requireScript(backupScript)) return;
    const runId = `apollo-task4-mode-${randomBytes(6).toString("hex")}`;
    const label = `com.apollo.task4.mode-test=${runId}`;
    const volume = `${runId}-artifacts`;
    let modes = "";
    try {
      docker(["volume", "create", "--label", label, volume]);
      modes = docker(["run", "--rm", "--label", label, "-v", `${worktree.replaceAll("\\\\", "/")}:/repo:ro`, "-v", `${volume}:/work`, postgres16Fixture, "sh", "-ceu", `
        mkdir -p /work/bin /work/backups
        cat > /work/bin/pg_dump <<'EOF'
#!/bin/sh
if [ "\${1:-}" = --version ]; then
  printf 'pg_dump (PostgreSQL) 16.0\\n'
  exit 0
fi
printf 'task4-custom-dump'
EOF
        cat > /work/bin/psql <<'EOF'
#!/bin/sh
printf '160000\\n'
EOF
        cat > /work/bin/age <<'EOF'
#!/bin/sh
cat
EOF
        chmod 755 /work/bin/pg_dump /work/bin/psql /work/bin/age
        printf 'host:5432:apollo_trackfinder:backup_operator:mode-test\\n' > /work/pgpass
        chmod 600 /work/pgpass
        /repo/deploy/ops/backup-postgres.sh
        stat -c '%a' /work/backups/*.dump.age /work/backups/*.sha256 /work/backups/*.json | sort -u
      `], {
        env: {
          PATH: "/work/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          PGPASSFILE: "/work/pgpass",
          APOLLO_BACKUP_DESTINATION: "/work/backups",
          APOLLO_BACKUP_PGHOST: "mode-test.internal",
          APOLLO_BACKUP_PGPORT: "5432",
          APOLLO_BACKUP_PGDATABASE: "apollo_trackfinder",
          APOLLO_BACKUP_PGUSER: "backup_operator",
          APOLLO_BACKUP_AGE_RECIPIENT: "age1modeproofrecipient000000000000000000000000000000000000000000",
          APOLLO_BACKUP_STACK: "apollo-tf",
          APOLLO_BACKUP_RELEASE_ID: "release-task4-mode",
        },
      });
    } finally {
      dockerQuiet(["volume", "rm", volume]);
    }
    expect(modes.split("\n").at(-1)).toBe("600");
    expect(dockerExists(["volume", "inspect", volume])).toBe(false);
  }, dockerContractTimeoutMs);

  it("removes only invocation-owned published artifacts when publication fails", () => {
    if (!requireScript(backupScript)) return;
    const root = temporaryRoot();
    const env = withBashFunctions(root, contractEnvironment(root), "ln_count=0\nln() { ln_count=$((ln_count + 1)); if [ \"$ln_count\" -eq 4 ]; then printf '%s\\n' \"$FAKE_SENSITIVE\" >&2; return 1; fi; /usr/bin/ln \"$@\"; }\n");
    const result = runScript(backupScript, env);
    expect(result.status).not.toBe(0);
    expect(output(result)).toBe("backup: commit failed\n");
    expect(output(result).includes(env.FAKE_SENSITIVE!)).toBe(false);
    expect(readdirSync(env.APOLLO_BACKUP_DESTINATION!)).toEqual([
      basename(claimDirectory(env)),
    ]);
    expect(claimState(env)).toMatchObject({
      failed_stage: "commit",
      state: "quarantined",
    });
  });

  it("fails closed on a stale release claim without touching its review record", () => {
    if (!requireScript(backupScript)) return;
    const root = temporaryRoot();
    const env = contractEnvironment(root);
    const claim = claimDirectory(env);
    execFileSync(bash, ["-lc", `mkdir '${posixPath(claim)}'`]);
    const staleState =
      '{"format_version":1,"release_id":"release-task4-001","state":"active"}\n';
    writeFileSync(join(claim, "state.json"), staleState, { mode: 0o600 });

    const result = runScript(backupScript, env);

    expect(result.status).not.toBe(0);
    expect(output(result)).toBe("backup: claim failed\n");
    expect(readFileSync(join(claim, "state.json"), "utf8")).toBe(staleState);
    expect(existsSync(env.FAKE_LOG!)).toBe(false);
  });

  it.each([
    ["successful owner", false, "complete"],
    ["failing owner", true, "quarantined"],
  ])(
    "preserves same-release evidence across a concurrent %s interleaving",
    async (_name, ownerFails, expectedState) => {
      if (!requireScript(backupScript)) return;
      const root = temporaryRoot();
      const started = join(root, "pg-dump-started");
      const release = join(root, "pg-dump-release");
      const env = contractEnvironment(root, {
        FAKE_AGE_FAIL: ownerFails ? "1" : "",
        FAKE_PG_DUMP_RELEASE_FILE: posixPath(release),
        FAKE_PG_DUMP_STARTED_FILE: posixPath(started),
      });
      const owner = runScriptAsync(backupScript, env);
      await waitForFile(started);

      const contender = runScript(backupScript, {
        ...env,
        FAKE_AGE_FAIL: ownerFails ? "" : "1",
        FAKE_PG_DUMP_RELEASE_FILE: "",
        FAKE_PG_DUMP_STARTED_FILE: "",
      });
      writeFileSync(release, "continue\n");
      const ownerResult = await owner;

      expect(contender.status).not.toBe(0);
      expect(output(contender)).toBe("backup: claim failed\n");
      expect(ownerResult.status).toBe(ownerFails ? 1 : 0);
      expect(ownerResult.stdout + ownerResult.stderr).toBe(
        ownerFails ? "backup: encrypt failed\n" : "backup: complete\n",
      );
      expect(claimState(env)).toMatchObject({ state: expectedState });
      const finalNames = readdirSync(env.APOLLO_BACKUP_DESTINATION!).filter(
        (name) => /\.(?:dump\.age|sha256|json)$/.test(name),
      );
      expect(finalNames).toHaveLength(ownerFails ? 0 : 3);
      if (!ownerFails) {
        expect(
          readFileSync(
            backupArtifacts(env.APOLLO_BACKUP_DESTINATION!).dump,
            "utf8",
          ),
        ).toBe("age:task4-custom-dump");
      }
    },
    20_000,
  );

  it("writes metadata without connection, destination, credential, or recipient values", () => {
    if (!requireScript(backupScript)) return;
    const root = temporaryRoot();
    const env = contractEnvironment(root);
    const result = runScript(backupScript, env);
    expect(result.status, output(result)).toBe(0);
    const metadata = readFileSync(backupArtifacts(env.APOLLO_BACKUP_DESTINATION!).metadata, "utf8");
    const forbiddenValues = [
      env.APOLLO_BACKUP_DESTINATION,
      env.APOLLO_BACKUP_PGHOST,
      env.APOLLO_BACKUP_PGUSER,
      env.PGPASSFILE,
      env.APOLLO_BACKUP_AGE_RECIPIENT,
    ];
    for (const value of forbiddenValues) expect(metadata.includes(value!)).toBe(false);
    expect(JSON.parse(metadata)).toMatchObject({
      database: "apollo_trackfinder",
      release_id: "release-task4-001",
      stack: "apollo-tf",
    });
  });

  it("verifies an untampered backup directly", () => {
    if (!requireScript(backupScript) || !requireScript(verifyScript)) return;
    const root = temporaryRoot();
    const env = contractEnvironment(root);
    expect(runScript(backupScript, env).status).toBe(0);
    const artifacts = backupArtifacts(env.APOLLO_BACKUP_DESTINATION!);
    expect(JSON.parse(readFileSync(artifacts.metadata, "utf8")).encrypted_sha256).toMatch(/^[a-f0-9]{64}$/);
    const result = runScript(verifyScript, {
      ...env,
      APOLLO_BACKUP_FILE: artifacts.dump,
      APOLLO_BACKUP_CHECKSUM_FILE: artifacts.checksum,
      APOLLO_BACKUP_METADATA_FILE: artifacts.metadata,
      APOLLO_BACKUP_EXPECTED_STACK: "apollo-tf",
      APOLLO_BACKUP_EXPECTED_DATABASE: "apollo_trackfinder",
      APOLLO_BACKUP_EXPECTED_RELEASE_ID: "release-task4-001",
    });
    expect(result.status).toBe(0);
    expect(output(result)).toBe("verify: complete\n");
  });

  it("rejects hostile metadata before running checksum verification or disclosing it", () => {
    if (!requireScript(backupScript) || !requireScript(verifyScript)) return;
    const root = temporaryRoot();
    const env = contractEnvironment(root);
    expect(runScript(backupScript, env).status).toBe(0);
    const artifacts = backupArtifacts(env.APOLLO_BACKUP_DESTINATION!);
    writeFileSync(artifacts.metadata, JSON.stringify({ hostile: env.FAKE_SENSITIVE }));
    const result = runScript(verifyScript, {
      ...env,
      APOLLO_BACKUP_FILE: artifacts.dump,
      APOLLO_BACKUP_CHECKSUM_FILE: artifacts.checksum,
      APOLLO_BACKUP_METADATA_FILE: artifacts.metadata,
      APOLLO_BACKUP_EXPECTED_STACK: "apollo-tf",
      APOLLO_BACKUP_EXPECTED_DATABASE: "apollo_trackfinder",
      APOLLO_BACKUP_EXPECTED_RELEASE_ID: "release-task4-001",
    });
    expect(result.status).not.toBe(0);
    expect(output(result)).toBe("verify: metadata failed\n");
    expect(output(result).includes(env.FAKE_SENSITIVE!)).toBe(false);
    expect(readFileSync(env.FAKE_LOG!, "utf8")).not.toContain("sha256sum");
  });

  it("redacts direct verifier checksum failures", () => {
    if (!requireScript(backupScript) || !requireScript(verifyScript)) return;
    const root = temporaryRoot();
    const env = contractEnvironment(root);
    expect(runScript(backupScript, env).status).toBe(0);
    const artifacts = backupArtifacts(env.APOLLO_BACKUP_DESTINATION!);
    const result = runScript(verifyScript, withBashFunctions(root, {
      ...env,
      APOLLO_BACKUP_FILE: artifacts.dump,
      APOLLO_BACKUP_CHECKSUM_FILE: artifacts.checksum,
      APOLLO_BACKUP_METADATA_FILE: artifacts.metadata,
      APOLLO_BACKUP_EXPECTED_STACK: "apollo-tf",
      APOLLO_BACKUP_EXPECTED_DATABASE: "apollo_trackfinder",
      APOLLO_BACKUP_EXPECTED_RELEASE_ID: "release-task4-001",
    }, "sha256sum() { printf '%s\\n' \"$FAKE_SENSITIVE\" >&2; return 1; }\n"));
    expect(result.status).not.toBe(0);
    expect(output(result)).toBe("verify: checksum failed\n");
    expect(output(result).includes(env.FAKE_SENSITIVE!)).toBe(false);
  });

  it("enforces PostgreSQL 17 restore client and target server for integrations evidence", () => {
    if (!requireScript(backupScript) || !requireScript(restoreScript)) return;
    const root = temporaryRoot();
    const env = contractEnvironment(root, {
      APOLLO_BACKUP_STACK: "apollo-tf-integrations",
      APOLLO_BACKUP_PGDATABASE: "apollo_tf_integrations",
      FAKE_PG_DUMP_MAJOR: "17",
      FAKE_PG_RESTORE_MAJOR: "17",
      FAKE_PG_SERVER_MAJOR: "17",
    });
    expect(runScript(backupScript, env).status).toBe(0);
    const artifacts = backupArtifacts(env.APOLLO_BACKUP_DESTINATION!);
    const result = runScript(
      restoreScript,
      restoreEnvironment(root, env, artifacts, {
        APOLLO_RESTORE_PGDATABASE: "apollo_tf_integrations",
        APOLLO_RESTORE_EXPECTED_STACK: "apollo-tf-integrations",
        APOLLO_RESTORE_EXPECTED_DATABASE: "apollo_tf_integrations",
      }),
    );

    expect(result.status, output(result)).toBe(0);
    const log = readFileSync(env.FAKE_LOG!, "utf8");
    expect(log).toContain("pg_restore --version");
    expect(log).toContain("SHOW server_version_num");
  });

  it.each([
    ["client", { FAKE_PG_RESTORE_MAJOR: "16", FAKE_PG_SERVER_MAJOR: "17" }],
    ["server", { FAKE_PG_RESTORE_MAJOR: "17", FAKE_PG_SERVER_MAJOR: "16" }],
  ])("rejects an integrations restore %s major mismatch", (_kind, overrides) => {
    if (!requireScript(backupScript) || !requireScript(restoreScript)) return;
    const root = temporaryRoot();
    const env = contractEnvironment(root, {
      APOLLO_BACKUP_STACK: "apollo-tf-integrations",
      APOLLO_BACKUP_PGDATABASE: "apollo_tf_integrations",
      FAKE_PG_DUMP_MAJOR: "17",
      FAKE_PG_SERVER_MAJOR: "17",
    });
    expect(runScript(backupScript, env).status).toBe(0);
    const result = runScript(
      restoreScript,
      restoreEnvironment(
        root,
        { ...env, ...overrides },
        backupArtifacts(env.APOLLO_BACKUP_DESTINATION!),
        {
          APOLLO_RESTORE_PGDATABASE: "apollo_tf_integrations",
          APOLLO_RESTORE_EXPECTED_STACK: "apollo-tf-integrations",
          APOLLO_RESTORE_EXPECTED_DATABASE: "apollo_tf_integrations",
        },
      ),
    );

    expect(result.status).not.toBe(0);
    expect(output(result)).toBe("restore: version failed\n");
    expect(existsSync(env.FAKE_RESTORE_INPUT!)).toBe(false);
  });

  it.each([
    ["checksum", (root: string, artifacts: ReturnType<typeof backupArtifacts>, env: NodeJS.ProcessEnv) => writeFileSync(artifacts.checksum, `${"0".repeat(64)}\n`)],
    ["release ID", (_root: string, artifacts: ReturnType<typeof backupArtifacts>) => writeFileSync(artifacts.metadata, JSON.stringify({ format_version: 1, stack: "apollo-tf", database: "apollo_trackfinder", release_id: "other-release", encrypted_sha256: "ignored" }))],
    ["expected database", (_root: string, artifacts: ReturnType<typeof backupArtifacts>) => writeFileSync(artifacts.metadata, JSON.stringify({ format_version: 1, stack: "apollo-tf", database: "apollo_platform", release_id: "release-task4-001", encrypted_sha256: "ignored" }))],
  ])("rejects restore when the %s evidence is invalid", (_name, mutate) => {
    if (!requireScript(backupScript) || !requireScript(restoreScript)) return;
    const root = temporaryRoot();
    const env = contractEnvironment(root);
    expect(runScript(backupScript, env).status).toBe(0);
    const artifacts = backupArtifacts(env.APOLLO_BACKUP_DESTINATION!);
    mutate(root, artifacts, env);
    writeFileSync(join(root, "identity"), "test identity\n", { mode: 0o600 });
    const result = runScript(restoreScript, {
      ...env,
      APOLLO_RESTORE_BACKUP: artifacts.dump,
      APOLLO_RESTORE_CHECKSUM: artifacts.checksum,
      APOLLO_RESTORE_METADATA: artifacts.metadata,
      APOLLO_RESTORE_AGE_IDENTITY: join(root, "identity"),
      APOLLO_RESTORE_PGHOST: "restore.internal",
      APOLLO_RESTORE_PGPORT: "55433",
      APOLLO_RESTORE_PGDATABASE: "apollo_trackfinder",
      APOLLO_RESTORE_PGUSER: "restore_operator",
      APOLLO_RESTORE_EXPECTED_STACK: "apollo-tf",
      APOLLO_RESTORE_EXPECTED_DATABASE: "apollo_trackfinder",
      APOLLO_RESTORE_EXPECTED_RELEASE_ID: "release-task4-001",
      APOLLO_RESTORE_DISPOSABLE: "1",
    });
    expect(result.status).not.toBe(0);
    expect(output(result)).toBe("restore: verify failed\n");
  });

  it("requires an empty explicitly disposable target before restoring", () => {
    if (!requireScript(backupScript) || !requireScript(restoreScript)) return;
    const root = temporaryRoot();
    const env = contractEnvironment(root, { FAKE_TARGET_NOT_EMPTY: "1" });
    expect(runScript(backupScript, env).status).toBe(0);
    const artifacts = backupArtifacts(env.APOLLO_BACKUP_DESTINATION!);
    writeFileSync(join(root, "identity"), "test identity\n", { mode: 0o600 });
    const result = runScript(restoreScript, {
      ...env,
      APOLLO_RESTORE_BACKUP: artifacts.dump,
      APOLLO_RESTORE_CHECKSUM: artifacts.checksum,
      APOLLO_RESTORE_METADATA: artifacts.metadata,
      APOLLO_RESTORE_AGE_IDENTITY: join(root, "identity"),
      APOLLO_RESTORE_PGHOST: "restore.internal",
      APOLLO_RESTORE_PGPORT: "55433",
      APOLLO_RESTORE_PGDATABASE: "apollo_trackfinder",
      APOLLO_RESTORE_PGUSER: "restore_operator",
      APOLLO_RESTORE_EXPECTED_STACK: "apollo-tf",
      APOLLO_RESTORE_EXPECTED_DATABASE: "apollo_trackfinder",
      APOLLO_RESTORE_EXPECTED_RELEASE_ID: "release-task4-001",
      APOLLO_RESTORE_DISPOSABLE: "1",
    });
    expect(result.status).not.toBe(0);
    expect(output(result)).toBe("restore: target-check failed\n");
    expect(existsSync(env.FAKE_RESTORE_INPUT!)).toBe(false);
  });

  it("redacts hostile target-check results before restore", () => {
    if (!requireScript(backupScript) || !requireScript(restoreScript)) return;
    const root = temporaryRoot();
    const env = contractEnvironment(root, { FAKE_TARGET_RESULT: "malformed-target-result-sensitive" });
    expect(runScript(backupScript, env).status).toBe(0);
    const result = runScript(restoreScript, restoreEnvironment(root, env, backupArtifacts(env.APOLLO_BACKUP_DESTINATION!)));
    expect(result.status).not.toBe(0);
    expect(output(result)).toBe("restore: target-check failed\n");
    expect(output(result)).not.toContain(env.FAKE_TARGET_RESULT!);
    expect(existsSync(env.FAKE_RESTORE_INPUT!)).toBe(false);
  });

  it.each([
    ["table", "pg_class"],
    ["schema", "pg_namespace"],
    ["view", "pg_class"],
    ["sequence", "pg_class"],
    ["type", "pg_type"],
    ["function", "pg_proc"],
    ["extension", "pg_extension"],
    ["access method", "pg_am"],
    ["cast", "pg_cast"],
    ["collation", "pg_collation"],
    ["conversion", "pg_conversion"],
    ["default privilege", "pg_default_acl"],
    ["event trigger", "pg_event_trigger"],
    ["foreign-data wrapper", "pg_foreign_data_wrapper"],
    ["foreign server", "pg_foreign_server"],
    ["user mapping", "pg_user_mapping"],
    ["procedural language", "pg_language"],
    ["operator", "pg_operator"],
    ["operator class", "pg_opclass"],
    ["operator family", "pg_opfamily"],
    ["row-level policy", "pg_policy"],
    ["publication", "pg_publication"],
    ["subscription", "pg_subscription"],
    ["rule", "pg_rewrite"],
    ["transform", "pg_transform"],
    ["trigger", "pg_trigger"],
    ["text-search configuration", "pg_ts_config"],
    ["text-search dictionary", "pg_ts_dict"],
    ["text-search parser", "pg_ts_parser"],
    ["text-search template", "pg_ts_template"],
    ["extended statistic", "pg_statistic_ext"],
    ["large object", "pg_largeobject_metadata"],
  ])("rejects a disposable target containing a user %s", (objectClass, probe) => {
    if (!requireScript(backupScript) || !requireScript(restoreScript)) return;
    const root = temporaryRoot();
    const env = contractEnvironment(root, { FAKE_TARGET_PROBE: probe });
    expect(runScript(backupScript, env).status).toBe(0);
    const result = runScript(restoreScript, restoreEnvironment(root, env, backupArtifacts(env.APOLLO_BACKUP_DESTINATION!)));
    expect(result.status).not.toBe(0);
    expect(output(result)).toBe("restore: target-check failed\n");
    expect(existsSync(env.FAKE_RESTORE_INPUT!)).toBe(false);
  }, shellContractTimeoutMs);

  it.each([
    ["psql", { FAKE_PSQL_FAIL: "1" }, "restore: target-check failed\n"],
    ["pg_restore", { FAKE_PG_RESTORE_FAIL: "1" }, "restore: restore failed\n"],
  ])("redacts restore %s failures", (_tool, overrides, expected) => {
    if (!requireScript(backupScript) || !requireScript(restoreScript)) return;
    const root = temporaryRoot();
    const env = contractEnvironment(root, overrides);
    expect(runScript(backupScript, env).status).toBe(0);
    const result = runScript(restoreScript, restoreEnvironment(root, env, backupArtifacts(env.APOLLO_BACKUP_DESTINATION!)));
    expect(result.status).not.toBe(0);
    expect(output(result)).toBe(expected);
    expect(output(result).includes(env.FAKE_SENSITIVE!)).toBe(false);
  }, shellContractTimeoutMs);

  it("classifies an original retained volume with metadata only", () => {
    if (!requireScript(classifyScript)) return;
    const root = temporaryRoot();
    const env = contractEnvironment(root);
    const result = runScript(classifyScript, env, ["retained-volume"]);
    expect(result.status).toBe(0);
    expect(output(result)).toBe("DETACHED_UNKNOWN\n");
    const dockerCalls = readFileSync(env.FAKE_LOG!, "utf8");
    expect(dockerCalls).toContain("docker volume inspect retained-volume");
    expect(dockerCalls).not.toMatch(/docker (create|run|start|compose)/);
  });

  it("blocks an attached retained volume without starting PostgreSQL", () => {
    if (!requireScript(classifyScript)) return;
    const root = temporaryRoot();
    const env = contractEnvironment(root, { FAKE_DOCKER_ATTACHED: "1" });
    const result = runScript(classifyScript, env, ["retained-volume"]);
    expect(result.status).toBe(0);
    expect(output(result)).toBe("ATTACHED_BLOCKED\n");
    expect(readFileSync(env.FAKE_LOG!, "utf8")).not.toMatch(/docker (create|run|start|compose)/);
  });

  it("never treats a static release label as proof of freshness", () => {
    if (!requireScript(classifyScript)) return;
    const root = temporaryRoot();
    const env = contractEnvironment(root, { FAKE_DOCKER_FRESH: "1" });
    const result = runScript(classifyScript, env, ["fresh-release-volume"]);
    expect(result.status).toBe(0);
    expect(output(result)).toBe("DETACHED_UNKNOWN\n");
    expect(readFileSync(env.FAKE_LOG!, "utf8")).not.toMatch(/docker (create|run|start|compose)/);
  });
});

const dockerProofEnabled = process.env.APOLLO_RUN_BACKUP_RESTORE_DOCKER === "1";

function docker(args: string[], options: { input?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const dockerArgs = [...args];
  if (options.env !== undefined) {
    const runIndex = dockerArgs.indexOf("run");
    if (runIndex >= 0) {
      dockerArgs.splice(
        runIndex + 1,
        0,
        ...Object.entries(options.env).flatMap(([name, value]) =>
          name === "PATH" ? ["-e", `PATH=${value ?? ""}`] : ["-e", name],
        ),
      );
    }
  }
  const result = spawnSync("docker", dockerArgs, {
    cwd: worktree,
    encoding: "utf8",
    input: options.input,
    env: {
      ...process.env,
      ...options.env,
      PATH: process.env.PATH,
    },
  });
  if (result.status !== 0) throw new Error("docker command failed");
  return result.stdout.trim();
}

function dockerQuiet(args: string[]): void {
  spawnSync("docker", args, { cwd: worktree, encoding: "utf8", stdio: "ignore" });
}

function dockerExists(args: string[]): boolean {
  return spawnSync("docker", args, { cwd: worktree, encoding: "utf8", stdio: "ignore" }).status === 0;
}

function dockerClientArgs(network: string, root: string, image: string, proofVolume: string, label: string): string[] {
  return ["run", "--rm", "-i", "--label", label, "--network", network, "-v", `${root.replaceAll("\\", "/")}:/work`, "-v", `${worktree.replaceAll("\\", "/")}:/work/repo:ro`, "-v", `${proofVolume}:/backup`, "-w", "/work", image];
}

function runPostgresBackupRestoreProof(options: {
  readonly baseImage: string;
  readonly database: "apollo_tf_integrations" | "apollo_trackfinder";
  readonly evidencePrefix: string;
  readonly major: 16 | 17;
  readonly stack: "apollo-tf" | "apollo-tf-integrations";
}): void {
  if (!requireScript(backupScript) || !requireScript(restoreScript)) return;
    const root = temporaryRoot();
    const runId =
      `apollo-pg${options.major}-proof-` +
      randomBytes(6).toString("hex");
    const network = `${runId}-network`;
    const source = `${runId}-source`;
    const target = `${runId}-target`;
    const sourceVolume = `${runId}-source-data`;
    const targetVolume = `${runId}-target-data`;
    const proofVolume = `${runId}-proof-data`;
    const image = `${runId}-client`;
    const label = `com.apollo.task4=${runId}`;
    const password = randomBytes(24).toString("base64url");
    const releaseId = `${options.evidencePrefix}-001`;
    let sourceDestroyed = false;

    try {
      writeFileSync(
        join(root, "Dockerfile"),
        `FROM ${options.baseImage}\n` +
          "RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/* && curl -fsSL https://github.com/FiloSottile/age/releases/download/v1.2.1/age-v1.2.1-linux-amd64.tar.gz | tar -xz --strip-components=1 -C /usr/local/bin age/age age/age-keygen\n",
        { encoding: "utf8" },
      );
      docker(["build", "--label", label, "-t", image, root]);
      docker(["network", "create", "--label", label, network]);
      docker(["volume", "create", "--label", label, sourceVolume]);
      docker(["volume", "create", "--label", label, targetVolume]);
      docker(["volume", "create", "--label", label, proofVolume]);
      docker(
        [
          ...dockerClientArgs(network, root, image, proofVolume, label),
          "sh",
          "-ceu",
          `umask 077; mkdir -p /backup/data; IFS= read -r password; printf '%s\\n' "$password" > /backup/postgres-password; printf 'source:5432:${options.database}:postgres:%s\\ntarget:5432:${options.database}:postgres:%s\\n' "$password" "$password" > /backup/pgpass`,
        ],
        { input: `${password}\n` },
      );
      docker([
        "run",
        "-d",
        "--name",
        source,
        "--label",
        label,
        "--network",
        network,
        "--network-alias",
        "source",
        "-e",
        `POSTGRES_DB=${options.database}`,
        "-e",
        "POSTGRES_USER=postgres",
        "-e",
        "POSTGRES_PASSWORD_FILE=/run/secrets/postgres-password",
        "-v",
        `${sourceVolume}:/var/lib/postgresql/data`,
        "-v",
        `${proofVolume}:/run/secrets:ro`,
        options.baseImage,
      ]);
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const ready = spawnSync("docker", [...dockerClientArgs(network, root, image, proofVolume, label), "pg_isready", "-h", "source", "-U", "postgres", "-d", options.database], { encoding: "utf8" });
        if (ready.status === 0) break;
        if (attempt === 29) throw new Error("source readiness timed out");
        execFileSync(bash, ["-lc", "sleep 1"]);
      }
      docker([...dockerClientArgs(network, root, image, proofVolume, label), "sh", "-ceu", `psql -h source -U postgres -d ${options.database} -c "CREATE TABLE task4_marker (marker text primary key); INSERT INTO task4_marker VALUES ('restore-marker')"`], { env: { PGPASSFILE: "/backup/pgpass" } });
      const recipient = docker([...dockerClientArgs(network, root, image, proofVolume, label), "sh", "-ceu", "age-keygen -o /backup/identity >/dev/null; age-keygen -y /backup/identity"]);
      docker([...dockerClientArgs(network, root, image, proofVolume, label), "sh", "-ceu", "/work/repo/deploy/ops/backup-postgres.sh"], {
        env: {
          PGPASSFILE: "/backup/pgpass",
          APOLLO_BACKUP_PGHOST: "source",
          APOLLO_BACKUP_PGPORT: "5432",
          APOLLO_BACKUP_PGDATABASE: options.database,
          APOLLO_BACKUP_PGUSER: "postgres",
          APOLLO_BACKUP_STACK: options.stack,
          APOLLO_BACKUP_RELEASE_ID: releaseId,
          APOLLO_BACKUP_DESTINATION: "/backup/data",
          APOLLO_BACKUP_AGE_RECIPIENT: recipient,
        },
      });
      expect(docker([...dockerClientArgs(network, root, image, proofVolume, label), "sh", "-ceu", `stat -c '%a' /backup/data/${releaseId}.dump.age /backup/data/${releaseId}.sha256 /backup/data/${releaseId}.json | sort -u`])).toBe("600");
      docker(["rm", "-fv", source]);
      sourceDestroyed = true;
      docker([
        "run",
        "-d",
        "--name",
        target,
        "--label",
        label,
        "--network",
        network,
        "--network-alias",
        "target",
        "-e",
        `POSTGRES_DB=${options.database}`,
        "-e",
        "POSTGRES_USER=postgres",
        "-e",
        "POSTGRES_PASSWORD_FILE=/run/secrets/postgres-password",
        "-v",
        `${targetVolume}:/var/lib/postgresql/data`,
        "-v",
        `${proofVolume}:/run/secrets:ro`,
        options.baseImage,
      ]);
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const ready = spawnSync("docker", [...dockerClientArgs(network, root, image, proofVolume, label), "pg_isready", "-h", "target", "-U", "postgres", "-d", options.database], { encoding: "utf8" });
        if (ready.status === 0) break;
        if (attempt === 29) throw new Error("target readiness timed out");
        execFileSync(bash, ["-lc", "sleep 1"]);
      }
      docker([...dockerClientArgs(network, root, image, proofVolume, label), "sh", "-ceu", "/work/repo/deploy/ops/restore-postgres.sh"], {
        env: {
          PGPASSFILE: "/backup/pgpass",
          APOLLO_RESTORE_BACKUP: `/backup/data/${releaseId}.dump.age`,
          APOLLO_RESTORE_CHECKSUM: `/backup/data/${releaseId}.sha256`,
          APOLLO_RESTORE_METADATA: `/backup/data/${releaseId}.json`,
          APOLLO_RESTORE_AGE_IDENTITY: "/backup/identity",
          APOLLO_RESTORE_PGHOST: "target",
          APOLLO_RESTORE_PGPORT: "5432",
          APOLLO_RESTORE_PGDATABASE: options.database,
          APOLLO_RESTORE_PGUSER: "postgres",
          APOLLO_RESTORE_EXPECTED_STACK: options.stack,
          APOLLO_RESTORE_EXPECTED_DATABASE: options.database,
          APOLLO_RESTORE_EXPECTED_RELEASE_ID: releaseId,
          APOLLO_RESTORE_DISPOSABLE: "1",
        },
      });
      const marker = docker([...dockerClientArgs(network, root, image, proofVolume, label), "psql", "-Atqc", "SELECT marker FROM task4_marker", "-h", "target", "-U", "postgres", "-d", options.database], { env: { PGPASSFILE: "/backup/pgpass" } });
      const schemaCount = docker([...dockerClientArgs(network, root, image, proofVolume, label), "psql", "-Atqc", "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'task4_marker'", "-h", "target", "-U", "postgres", "-d", options.database], { env: { PGPASSFILE: "/backup/pgpass" } });
      expect(marker).toBe("restore-marker");
      expect(schemaCount).toBe("1");
      expect(sourceDestroyed).toBe(true);
    } finally {
      dockerQuiet(["rm", "-fv", source]);
      dockerQuiet(["rm", "-fv", target]);
      dockerQuiet(["volume", "rm", sourceVolume]);
      dockerQuiet(["volume", "rm", targetVolume]);
      dockerQuiet(["volume", "rm", proofVolume]);
      dockerQuiet(["network", "rm", network]);
      dockerQuiet(["image", "rm", image]);
      expect(docker(["ps", "-aq", "--filter", `label=${label}`])).toBe("");
      expect(docker(["network", "ls", "-q", "--filter", `label=${label}`])).toBe("");
      expect(docker(["volume", "ls", "-q", "--filter", `label=${label}`])).toBe("");
      expect(docker(["image", "ls", "-q", "--filter", `label=${label}`])).toBe("");
      expect(dockerExists(["volume", "inspect", proofVolume])).toBe(false);
    }
}

describe.runIf(dockerProofEnabled)("PostgreSQL 16 encrypted restore proof", () => {
  it("restores PostgreSQL 16 marker schema and data after source destruction", () => {
    runPostgresBackupRestoreProof({
      baseImage: postgres16Fixture,
      database: "apollo_trackfinder",
      evidencePrefix: "pg16-disposable-proof",
      major: 16,
      stack: "apollo-tf",
    });
  }, 240_000);
});

describe.runIf(dockerProofEnabled)("PostgreSQL 17 encrypted restore proof", () => {
  it("restores PostgreSQL 17 integrations schema and data after source destruction", () => {
    runPostgresBackupRestoreProof({
      baseImage:
        "docker.io/library/postgres:17-bookworm@sha256:4f736ae292687621d4dbe0d499ffd024a36bd2ee7d8ca6f2ccd4c800f047b394",
      database: "apollo_tf_integrations",
      evidencePrefix: "pg17-integrations-disposable-proof",
      major: 17,
      stack: "apollo-tf-integrations",
    });
  }, 240_000);
});
