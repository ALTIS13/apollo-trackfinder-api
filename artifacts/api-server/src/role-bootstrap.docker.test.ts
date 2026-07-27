import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const runDockerProof = process.env["TF_RUN_ROLE_BOOTSTRAP_DOCKER"] === "1";
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const suffix = `${process.pid}-${randomBytes(5).toString("hex")}`;
const image = `apollo-tf-role-bootstrap-proof:${suffix}`;
const network = `apollo-tf-role-bootstrap-proof-${suffix}`;
const databaseContainer = `apollo-tf-role-bootstrap-db-${suffix}`;
const secretVolume = `apollo-tf-role-bootstrap-secrets-${suffix}`;
const dataVolume = `apollo-tf-role-bootstrap-data-${suffix}`;
const databaseName = "apollo_trackfinder";
const sharedSecretGid = "10002";
const passwords = {
  admin: randomBytes(32).toString("base64url"),
  migrator: randomBytes(32).toString("base64url"),
  runtime: randomBytes(32).toString("base64url"),
};

type ProcessResult = {
  readonly code: number;
  readonly stderr: Buffer;
  readonly stdout: Buffer;
};

async function execute(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly input?: Buffer | string;
    readonly timeoutMs?: number;
  } = {},
): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Disposable role bootstrap command timed out"));
    }, options.timeoutMs ?? 120_000);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({
        code: code ?? -1,
        stderr: Buffer.concat(stderr),
        stdout: Buffer.concat(stdout),
      });
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

async function docker(
  args: readonly string[],
  options: {
    readonly allowFailure?: boolean;
    readonly input?: Buffer | string;
    readonly timeoutMs?: number;
  } = {},
): Promise<ProcessResult> {
  const result = await execute("docker", args, {
    cwd: repositoryRoot,
    input: options.input,
    timeoutMs: options.timeoutMs,
  });
  if (result.code !== 0 && options.allowFailure !== true) {
    throw new Error(`Disposable Docker command failed: ${args[0] ?? "docker"}`);
  }
  return result;
}

async function removeDockerResource(args: readonly string[]): Promise<void> {
  await docker(args, { allowFailure: true, timeoutMs: 60_000 });
}

async function writeSecret(
  name: string,
  value: Buffer | string,
  owner: string,
  mode: string,
): Promise<void> {
  const result = await docker(
    [
      "run",
      "--rm",
      "-i",
      "--network",
      "none",
      "--entrypoint",
      "sh",
      "--volume",
      `${secretVolume}:/secrets`,
      image,
      "-ceu",
      'target="/secrets/$1"; umask 077; : > "$target"; dd of="$target" bs=4096 status=none; chown "$2" "$target"; chmod "$3" "$target"',
      "write-secret",
      name,
      owner,
      mode,
    ],
    { input: value },
  );
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toBe("");
}

async function psqlAdmin(statement: string): Promise<ProcessResult> {
  return docker([
    "exec",
    databaseContainer,
    "psql",
    "-X",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "postgres",
    "-d",
    databaseName,
    "-c",
    statement,
  ]);
}

async function runManualBootstrap(
  allowFailure = false,
): Promise<ProcessResult> {
  return docker(
    [
      "run",
      "--rm",
      "--network",
      network,
      "--user",
      "999:999",
      "--group-add",
      sharedSecretGid,
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=16m",
      "--volume",
      `${secretVolume}:/run/secrets:ro`,
      "--env",
      "TF_ROLE_BOOTSTRAP_DATABASE_URL_FILE=/run/secrets/tf_admin_database_url",
      "--entrypoint",
      "/usr/local/bin/bootstrap-tf-roles.sh",
      image,
    ],
    { allowFailure, timeoutMs: 60_000 },
  );
}

async function waitForPostgres(): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = await docker(
      [
        "exec",
        databaseContainer,
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-U",
        "postgres",
        "-d",
        databaseName,
      ],
      { allowFailure: true, timeoutMs: 10_000 },
    );
    if (result.code === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Disposable PostgreSQL did not become ready");
}

describe
  .skipIf(!runDockerProof)
  .sequential("TF role bootstrap Docker proof", () => {
    beforeAll(async () => {
      await docker(
        [
          "build",
          "--target",
          "postgres-role-init",
          "--file",
          "artifacts/api-server/Dockerfile",
          "--tag",
          image,
          ".",
        ],
        { timeoutMs: 5 * 60_000 },
      );
      await docker(["network", "create", network]);
      await docker(["volume", "create", secretVolume]);
      await docker(["volume", "create", dataVolume]);

      const adminUrl =
        `postgres://postgres:${encodeURIComponent(passwords.admin)}` +
        `@${databaseContainer}:5432/${databaseName}`;
      const migratorUrl =
        `postgres://apollo_tf_migrator:${encodeURIComponent(passwords.migrator)}` +
        `@${databaseContainer}:5432/${databaseName}`;
      const runtimeUrl =
        `postgres://apollo_tf_runtime:${encodeURIComponent(passwords.runtime)}` +
        `@${databaseContainer}:5432/${databaseName}`;

      await writeSecret(
        "tf_postgres_admin_password",
        passwords.admin,
        "999:999",
        "0400",
      );
      await writeSecret(
        "tf_migrator_password",
        passwords.migrator,
        "999:999",
        "0400",
      );
      await writeSecret(
        "tf_runtime_password",
        passwords.runtime,
        "999:999",
        "0400",
      );
      await writeSecret(
        "tf_admin_database_url",
        adminUrl,
        `0:${sharedSecretGid}`,
        "0440",
      );
      await writeSecret(
        "tf_migrator_database_url",
        migratorUrl,
        "10001:10001",
        "0400",
      );
      await writeSecret(
        "tf_runtime_database_url",
        runtimeUrl,
        "10001:10001",
        "0400",
      );

      await docker([
        "run",
        "--detach",
        "--name",
        databaseContainer,
        "--network",
        network,
        "--volume",
        `${secretVolume}:/run/secrets:ro`,
        "--volume",
        `${dataVolume}:/var/lib/postgresql/data`,
        "--env",
        `POSTGRES_DB=${databaseName}`,
        "--env",
        "POSTGRES_USER=postgres",
        "--env",
        "POSTGRES_PASSWORD_FILE=/run/secrets/tf_postgres_admin_password",
        image,
      ]);
      await waitForPostgres();
    }, 6 * 60_000);

    afterAll(async () => {
      await removeDockerResource(["rm", "-f", databaseContainer]);
      await removeDockerResource(["volume", "rm", "-f", dataVolume]);
      await removeDockerResource(["volume", "rm", "-f", secretVolume]);
      await removeDockerResource(["network", "rm", network]);
      await removeDockerResource(["image", "rm", "-f", image]);
    }, 2 * 60_000);

    it("allows only the two supplementary-group consumers to read the shared admin URL", async () => {
      for (const user of ["999:999", "10001:10001"]) {
        const result = await docker([
          "run",
          "--rm",
          "--network",
          "none",
          "--user",
          user,
          "--group-add",
          sharedSecretGid,
          "--read-only",
          "--volume",
          `${secretVolume}:/run/secrets:ro`,
          "--entrypoint",
          "sh",
          image,
          "-ceu",
          'test -r /run/secrets/tf_admin_database_url; test "$(stat -c "%u:%g:%a" /run/secrets/tf_admin_database_url)" = "0:10002:440"',
        ]);
        expect(result.stdout.toString()).toBe("");
        expect(result.stderr.toString()).toBe("");
      }

      const denied = await docker(
        [
          "run",
          "--rm",
          "--network",
          "none",
          "--user",
          "10001:10001",
          "--read-only",
          "--volume",
          `${secretVolume}:/run/secrets:ro`,
          "--entrypoint",
          "sh",
          image,
          "-ceu",
          "test -r /run/secrets/tf_admin_database_url",
        ],
        { allowFailure: true },
      );
      expect(denied.code).not.toBe(0);
      expect(denied.stdout.toString()).toBe("");
    });

    it("reads exact bounded bytes once and rejects unsafe secret sources generically", async () => {
      const cases = [
        ["one", Buffer.from("x"), 512, true],
        ["limit", Buffer.alloc(512, 0x61), 512, true],
        ["oversize", Buffer.alloc(513, 0x62), 512, false],
        ["quotes", Buffer.from(`a'b"c\\d`), 512, true],
        ["newlines", Buffer.from("line-1\nline-2\n\n"), 512, true],
        ["nul", Buffer.from([0x61, 0x00, 0x62]), 512, false],
      ] as const;

      for (const [name, value, maximum, accepted] of cases) {
        await writeSecret(`reader-${name}`, value, "0:0", "0400");
        const result = await docker(
          [
            "run",
            "--rm",
            "--network",
            "none",
            "--read-only",
            "--volume",
            `${secretVolume}:/run/secrets:ro`,
            "--entrypoint",
            "/usr/local/bin/read-bounded-secret",
            image,
            `/run/secrets/reader-${name}`,
            String(maximum),
          ],
          { allowFailure: !accepted },
        );
        if (accepted) {
          expect(result.stdout).toEqual(value);
          expect(result.stderr.toString()).toBe("");
        } else {
          expect(result.code).not.toBe(0);
          expect(result.stdout.toString()).toBe("");
          expect(result.stderr.toString()).toBe("TF secret read failed\n");
        }
      }

      await docker([
        "run",
        "--rm",
        "--network",
        "none",
        "--volume",
        `${secretVolume}:/secrets`,
        "--entrypoint",
        "sh",
        image,
        "-ceu",
        "rm -f /secrets/reader-fifo; mkfifo /secrets/reader-fifo",
      ]);
      const fifo = await docker(
        [
          "run",
          "--rm",
          "--network",
          "none",
          "--read-only",
          "--volume",
          `${secretVolume}:/run/secrets:ro`,
          "--entrypoint",
          "/usr/local/bin/read-bounded-secret",
          image,
          "/run/secrets/reader-fifo",
          "512",
        ],
        { allowFailure: true },
      );
      expect(fifo.code).not.toBe(0);
      expect(fifo.stdout.toString()).toBe("");
      expect(fifo.stderr.toString()).toBe("TF secret read failed\n");

      const race = await docker([
        "run",
        "--rm",
        "--network",
        "none",
        "--volume",
        `${secretVolume}:/secrets`,
        "--entrypoint",
        "sh",
        image,
        "-ceu",
        [
          "old=$(printf '%0512d' 0 | tr '0' A)",
          "new=$(printf '%0512d' 0 | tr '0' B)",
          'printf %s "$old" > /secrets/reader-race',
          '(i=0; while [ "$i" -lt 500 ]; do printf %s "$new" > /secrets/reader-next; mv -f /secrets/reader-next /secrets/reader-race; printf %s "$old" > /secrets/reader-next; mv -f /secrets/reader-next /secrets/reader-race; i=$((i+1)); done) &',
          "writer=$!",
          "i=0",
          'while [ "$i" -lt 200 ]; do',
          "  if value=$(/usr/local/bin/read-bounded-secret --append-sentinel /secrets/reader-race 512 2>/dev/null); then",
          "    value=${value%?}",
          '    [ "$value" = "$old" ] || [ "$value" = "$new" ] || exit 91',
          "  fi",
          "  i=$((i+1))",
          "done",
          'wait "$writer"',
        ].join("\n"),
      ]);
      expect(race.stdout.toString()).toBe("");
      expect(race.stderr.toString()).toBe("");
    }, 120_000);

    it("normalizes an overprivileged runtime and fails closed on unexpected ownership", async () => {
      await psqlAdmin(`
        create role tf_bootstrap_parent nologin;
        grant tf_bootstrap_parent to apollo_tf_runtime;
        create schema if not exists apollo_tf authorization apollo_tf_migrator;
        create table if not exists apollo_tf.schema_migrations (
          name text primary key,
          checksum text not null,
          applied_at timestamptz not null default now()
        );
        alter table apollo_tf.schema_migrations owner to apollo_tf_migrator;
        create table public.track_search_cache (id bigserial primary key);
        create table public.play_history (id bigserial primary key);
        create table public.liked_tracks (id bigserial primary key);
        create table public.playlists (id bigserial primary key);
        create table public.playlist_tracks (id bigserial primary key);
        alter table public.track_search_cache owner to apollo_tf_migrator;
        alter table public.play_history owner to apollo_tf_migrator;
        alter table public.liked_tracks owner to apollo_tf_migrator;
        alter table public.playlists owner to apollo_tf_migrator;
        alter table public.playlist_tracks owner to apollo_tf_migrator;
        create table public.runtime_canary (id integer);
        grant all privileges on database apollo_trackfinder to apollo_tf_runtime;
        grant create on schema public to apollo_tf_runtime;
        grant all privileges on all tables in schema public, apollo_tf
          to apollo_tf_runtime;
        grant all privileges on all sequences in schema public
          to apollo_tf_runtime;
        alter role apollo_tf_runtime set search_path = pg_catalog;
      `);

      const bootstrap = await runManualBootstrap();
      expect(bootstrap.stdout.toString()).toBe("");
      expect(bootstrap.stderr.toString()).toBe("");

      const projection = await psqlAdmin(`
        select concat_ws('|',
          has_database_privilege('apollo_tf_runtime', current_database(), 'create'),
          has_schema_privilege('apollo_tf_runtime', 'public', 'create'),
          has_table_privilege('apollo_tf_runtime', 'public.track_search_cache', 'truncate'),
          has_table_privilege('apollo_tf_runtime', 'public.track_search_cache', 'select,insert,update,delete'),
          has_sequence_privilege('apollo_tf_runtime', 'public.track_search_cache_id_seq', 'usage'),
          has_table_privilege('apollo_tf_runtime', 'apollo_tf.schema_migrations', 'select'),
          has_table_privilege('apollo_tf_runtime', 'public.runtime_canary', 'select'),
          (select count(*) from pg_auth_members memberships
            join pg_roles members on members.oid = memberships.member
            where members.rolname = 'apollo_tf_runtime'),
          (select count(*) from pg_db_role_setting settings
            join pg_roles roles on roles.oid = settings.setrole
            where roles.rolname = 'apollo_tf_runtime')
        );
      `);
      expect(projection.stdout.toString().trim()).toContain(
        "f|f|f|t|t|t|f|0|0",
      );

      const setRole = await docker(
        [
          "run",
          "--rm",
          "--network",
          network,
          "--user",
          "10001:10001",
          "--read-only",
          "--volume",
          `${secretVolume}:/run/secrets:ro`,
          "--entrypoint",
          "sh",
          image,
          "-ceu",
          'url=$(dd if=/run/secrets/tf_runtime_database_url status=none); exec psql -X "$url" -v ON_ERROR_STOP=1 -c "set role tf_bootstrap_parent"',
        ],
        { allowFailure: true },
      );
      expect(setRole.code).not.toBe(0);

      await psqlAdmin(`
        create table public.runtime_owned (id integer);
        alter table public.runtime_owned owner to apollo_tf_runtime;
      `);
      const ownershipFailure = await runManualBootstrap(true);
      expect(ownershipFailure.code).not.toBe(0);
      expect(ownershipFailure.stdout.toString()).toBe("");
      expect(ownershipFailure.stderr.toString()).toBe(
        "TF role bootstrap failed\n",
      );
      await psqlAdmin("drop table public.runtime_owned;");
    }, 120_000);
  });
