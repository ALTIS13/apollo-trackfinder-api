import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

const worktree = resolve(import.meta.dirname, "../..");
const bash = "C:/Program Files/Git/bin/bash.exe";
const backupScript = join(worktree, "deploy/ops/backup-postgres.sh");
const restoreScript = join(worktree, "deploy/ops/restore-postgres.sh");
const classifyScript = join(worktree, "deploy/ops/classify-retained-volume.sh");
const temporaryRoots: string[] = [];

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
  writeExecutable(join(bin, "pg_dump"), "#!/bin/sh\nprintf 'pg_dump %s\\n' \"$*\" >> \"$FAKE_LOG\"\nprintf 'task4-custom-dump'\n");
  writeExecutable(join(bin, "age"), "#!/bin/sh\nprintf 'age %s\\n' \"$*\" >> \"$FAKE_LOG\"\nif [ \"${FAKE_AGE_FAIL:-}\" = 1 ]; then cat >/dev/null; exit 1; fi\nprintf 'age:'\ncat\n");
  writeExecutable(join(bin, "psql"), "#!/bin/sh\nprintf 'psql %s\\n' \"$*\" >> \"$FAKE_LOG\"\nif [ \"${FAKE_TARGET_NOT_EMPTY:-}\" = 1 ]; then printf '1\\n'; fi\n");
  writeExecutable(join(bin, "pg_restore"), "#!/bin/sh\nprintf 'pg_restore %s\\n' \"$*\" >> \"$FAKE_LOG\"\ncat > \"$FAKE_RESTORE_INPUT\"\n");
  writeExecutable(join(bin, "sha256sum"), "#!/bin/sh\nprintf '%s  %s\\n' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \"$1\"\n");
  writeExecutable(join(bin, "chmod"), "#!/bin/sh\nprintf 'chmod %s\\n' \"$*\" >> \"$FAKE_LOG\"\n");
  writeExecutable(join(bin, "docker"), "#!/bin/sh\nprintf 'docker %s\\n' \"$*\" >> \"$FAKE_LOG\"\ncase \"$1\" in volume) printf '{}\\n' ;; ps) : ;; esac\n");
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
      [basename(artifacts.checksum), basename(artifacts.dump), basename(artifacts.metadata)].sort(),
    );
    const commandLog = readFileSync(env.FAKE_LOG!, "utf8");
    expect(commandLog).toContain("pg_dump --format=custom --no-owner --no-privileges");
    expect(commandLog).toContain("age -r");
  });

  it("removes all partial backup artifacts when encryption fails", () => {
    if (!requireScript(backupScript)) return;
    const root = temporaryRoot();
    const env = contractEnvironment(root, { FAKE_AGE_FAIL: "1" });
    const result = runScript(backupScript, env);
    expect(result.status).not.toBe(0);
    expect(output(result)).toBe("backup: encrypt failed\n");
    expect(readdirSync(env.APOLLO_BACKUP_DESTINATION!)).toEqual([]);
  });

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
        ...Object.entries(options.env).flatMap(([name, value]) => ["-e", `${name}=${value ?? ""}`]),
      );
    }
  }
  const result = spawnSync("docker", dockerArgs, {
    cwd: worktree,
    encoding: "utf8",
    input: options.input,
    env: process.env,
  });
  if (result.status !== 0) throw new Error("docker command failed");
  return result.stdout.trim();
}

function dockerQuiet(args: string[]): void {
  spawnSync("docker", args, { cwd: worktree, encoding: "utf8", stdio: "ignore" });
}

function dockerClientArgs(network: string, root: string, image: string, proofVolume: string): string[] {
  return ["run", "--rm", "-i", "--network", network, "-v", `${root.replaceAll("\\", "/")}:/work`, "-v", `${worktree.replaceAll("\\", "/")}:/work/repo:ro`, "-v", `${proofVolume}:/backup`, "-w", "/work", image];
}

describe.runIf(dockerProofEnabled)("PostgreSQL 16 encrypted restore proof", () => {
  it("restores marker schema and data after the disposable source is destroyed", () => {
    if (!requireScript(backupScript) || !requireScript(restoreScript)) return;
    const root = temporaryRoot();
    const runId = `apollo-task4-${randomBytes(6).toString("hex")}`;
    const network = `${runId}-network`;
    const source = `${runId}-source`;
    const target = `${runId}-target`;
    const sourceVolume = `${runId}-source-data`;
    const targetVolume = `${runId}-target-data`;
    const proofVolume = `${runId}-proof-data`;
    const image = `${runId}-client`;
    const label = `com.apollo.task4=${runId}`;
    const password = randomBytes(24).toString("base64url");
    const releaseId = "task4-disposable-proof-001";
    let sourceDestroyed = false;

    try {
      writeFileSync(join(root, "Dockerfile"), "FROM postgres:16\nRUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/* && curl -fsSL https://github.com/FiloSottile/age/releases/download/v1.2.1/age-v1.2.1-linux-amd64.tar.gz | tar -xz --strip-components=1 -C /usr/local/bin age/age age/age-keygen\n", { encoding: "utf8" });
      docker(["build", "--label", label, "-t", image, root]);
      docker(["network", "create", "--label", label, network]);
      docker(["volume", "create", "--label", label, sourceVolume]);
      docker(["volume", "create", "--label", label, targetVolume]);
      docker(["volume", "create", "--label", label, proofVolume]);
      docker([...dockerClientArgs(network, root, image, proofVolume), "sh", "-ceu", "umask 077; mkdir -p /backup/data; IFS= read -r password; printf '%s\\n' \"$password\" > /backup/postgres-password; printf 'source:5432:apollo_trackfinder:postgres:%s\\ntarget:5432:apollo_trackfinder:postgres:%s\\n' \"$password\" \"$password\" > /backup/pgpass"], { input: `${password}\n` });
      docker(["run", "-d", "--name", source, "--label", label, "--network", network, "--network-alias", "source", "-e", "POSTGRES_DB=apollo_trackfinder", "-e", "POSTGRES_USER=postgres", "-e", "POSTGRES_PASSWORD_FILE=/run/secrets/postgres-password", "-v", `${sourceVolume}:/var/lib/postgresql/data`, "-v", `${proofVolume}:/run/secrets:ro`, "postgres:16"]);
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const ready = spawnSync("docker", [...dockerClientArgs(network, root, image, proofVolume), "pg_isready", "-h", "source", "-U", "postgres", "-d", "apollo_trackfinder"], { encoding: "utf8" });
        if (ready.status === 0) break;
        if (attempt === 29) throw new Error("source readiness timed out");
        execFileSync(bash, ["-lc", "sleep 1"]);
      }
      docker([...dockerClientArgs(network, root, image, proofVolume), "sh", "-ceu", "psql -h source -U postgres -d apollo_trackfinder -c \"CREATE TABLE task4_marker (marker text primary key); INSERT INTO task4_marker VALUES ('restore-marker')\""], { env: { PGPASSFILE: "/backup/pgpass" } });
      const recipient = docker([...dockerClientArgs(network, root, image, proofVolume), "sh", "-ceu", "age-keygen -o /backup/identity >/dev/null; age-keygen -y /backup/identity"]);
      docker([...dockerClientArgs(network, root, image, proofVolume), "sh", "-ceu", "/work/repo/deploy/ops/backup-postgres.sh"], {
        env: {
          PGPASSFILE: "/backup/pgpass",
          APOLLO_BACKUP_PGHOST: "source",
          APOLLO_BACKUP_PGPORT: "5432",
          APOLLO_BACKUP_PGDATABASE: "apollo_trackfinder",
          APOLLO_BACKUP_PGUSER: "postgres",
          APOLLO_BACKUP_STACK: "apollo-tf",
          APOLLO_BACKUP_RELEASE_ID: releaseId,
          APOLLO_BACKUP_DESTINATION: "/backup/data",
          APOLLO_BACKUP_AGE_RECIPIENT: recipient,
        },
      });
      expect(docker([...dockerClientArgs(network, root, image, proofVolume), "sh", "-ceu", "stat -c '%a' /backup/data/task4-disposable-proof-001.dump.age /backup/data/task4-disposable-proof-001.sha256 /backup/data/task4-disposable-proof-001.json | sort -u"])).toBe("600");
      docker(["rm", "-fv", source]);
      sourceDestroyed = true;
      docker(["run", "-d", "--name", target, "--label", label, "--network", network, "--network-alias", "target", "-e", "POSTGRES_DB=apollo_trackfinder", "-e", "POSTGRES_USER=postgres", "-e", "POSTGRES_PASSWORD_FILE=/run/secrets/postgres-password", "-v", `${targetVolume}:/var/lib/postgresql/data`, "-v", `${proofVolume}:/run/secrets:ro`, "postgres:16"]);
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const ready = spawnSync("docker", [...dockerClientArgs(network, root, image, proofVolume), "pg_isready", "-h", "target", "-U", "postgres", "-d", "apollo_trackfinder"], { encoding: "utf8" });
        if (ready.status === 0) break;
        if (attempt === 29) throw new Error("target readiness timed out");
        execFileSync(bash, ["-lc", "sleep 1"]);
      }
      docker([...dockerClientArgs(network, root, image, proofVolume), "sh", "-ceu", "/work/repo/deploy/ops/restore-postgres.sh"], {
        env: {
          PGPASSFILE: "/backup/pgpass",
          APOLLO_RESTORE_BACKUP: "/backup/data/task4-disposable-proof-001.dump.age",
          APOLLO_RESTORE_CHECKSUM: "/backup/data/task4-disposable-proof-001.sha256",
          APOLLO_RESTORE_METADATA: "/backup/data/task4-disposable-proof-001.json",
          APOLLO_RESTORE_AGE_IDENTITY: "/backup/identity",
          APOLLO_RESTORE_PGHOST: "target",
          APOLLO_RESTORE_PGPORT: "5432",
          APOLLO_RESTORE_PGDATABASE: "apollo_trackfinder",
          APOLLO_RESTORE_PGUSER: "postgres",
          APOLLO_RESTORE_EXPECTED_STACK: "apollo-tf",
          APOLLO_RESTORE_EXPECTED_DATABASE: "apollo_trackfinder",
          APOLLO_RESTORE_EXPECTED_RELEASE_ID: releaseId,
          APOLLO_RESTORE_DISPOSABLE: "1",
        },
      });
      const marker = docker([...dockerClientArgs(network, root, image, proofVolume), "psql", "-Atqc", "SELECT marker FROM task4_marker", "-h", "target", "-U", "postgres", "-d", "apollo_trackfinder"], { env: { PGPASSFILE: "/backup/pgpass" } });
      const schemaCount = docker([...dockerClientArgs(network, root, image, proofVolume), "psql", "-Atqc", "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'task4_marker'", "-h", "target", "-U", "postgres", "-d", "apollo_trackfinder"], { env: { PGPASSFILE: "/backup/pgpass" } });
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
    }
  }, 180_000);
});
