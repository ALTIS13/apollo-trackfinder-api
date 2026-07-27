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
const cleanupProbeContainer = `apollo-tf-role-bootstrap-cleanup-${suffix}`;
const cleanupProbeVolume = `apollo-tf-role-bootstrap-cleanup-${suffix}`;
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

type DockerProofResource = {
  readonly inspectArgs: readonly string[];
  readonly label: string;
  readonly removeArgs: readonly string[];
};

const dockerProofResources: readonly DockerProofResource[] = [
  {
    inspectArgs: ["container", "inspect", cleanupProbeContainer],
    label: cleanupProbeContainer,
    removeArgs: ["rm", "-f", cleanupProbeContainer],
  },
  {
    inspectArgs: ["container", "inspect", databaseContainer],
    label: databaseContainer,
    removeArgs: ["rm", "-f", databaseContainer],
  },
  {
    inspectArgs: ["volume", "inspect", cleanupProbeVolume],
    label: cleanupProbeVolume,
    removeArgs: ["volume", "rm", "-f", cleanupProbeVolume],
  },
  {
    inspectArgs: ["volume", "inspect", dataVolume],
    label: dataVolume,
    removeArgs: ["volume", "rm", "-f", dataVolume],
  },
  {
    inspectArgs: ["volume", "inspect", secretVolume],
    label: secretVolume,
    removeArgs: ["volume", "rm", "-f", secretVolume],
  },
  {
    inspectArgs: ["network", "inspect", network],
    label: network,
    removeArgs: ["network", "rm", network],
  },
  {
    inspectArgs: ["image", "inspect", image],
    label: image,
    removeArgs: ["image", "rm", "-f", image],
  },
];

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
  const resource = dockerProofResources.find(
    (candidate) =>
      candidate.removeArgs.length === args.length &&
      candidate.removeArgs.every((part, index) => part === args[index]),
  );
  if (resource === undefined) {
    throw new Error("Disposable Docker cleanup received an unknown resource");
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await docker(args, { allowFailure: true, timeoutMs: 60_000 });
    const inspection = await docker(resource.inspectArgs, {
      allowFailure: true,
      timeoutMs: 10_000,
    });
    if (inspection.code !== 0) return;
    if (attempt < 19) await wait(250);
  }
  throw new Error(`Disposable Docker cleanup failed: ${resource.label}`);
}

async function cleanupDockerProofResources(): Promise<void> {
  const failures: string[] = [];
  for (const resource of dockerProofResources) {
    try {
      await removeDockerResource(resource.removeArgs);
    } catch {
      failures.push(resource.label);
    }
  }

  const residuals: string[] = [];
  for (const resource of dockerProofResources) {
    const inspection = await docker(resource.inspectArgs, {
      allowFailure: true,
      timeoutMs: 10_000,
    });
    if (inspection.code === 0) residuals.push(resource.label);
  }
  if (residuals.length > 0 || failures.length > 0) {
    throw new Error(
      `Disposable Docker resource cleanup audit failed: ${[
        ...new Set([...failures, ...residuals]),
      ].join(", ")}`,
    );
  }
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

async function psqlAdmin(
  statement: string,
  targetDatabase = databaseName,
): Promise<ProcessResult> {
  const result = await docker(
    [
      "exec",
      databaseContainer,
      "psql",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      targetDatabase,
      "-c",
      statement,
    ],
    { allowFailure: true },
  );
  if (result.code !== 0) {
    throw new Error(
      `Disposable PostgreSQL admin fixture failed: ${result.stderr.toString().trim()}`,
    );
  }
  return result;
}

async function runManualBootstrap(
  allowFailure = false,
): Promise<ProcessResult> {
  const result = await docker(
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
    { allowFailure: true, timeoutMs: 60_000 },
  );
  if (result.code !== 0 && !allowFailure) {
    const logs = await docker(["logs", databaseContainer], {
      allowFailure: true,
      timeoutMs: 10_000,
    });
    const errors = logs.stderr
      .toString()
      .split(/\r?\n/)
      .filter((line) => line.includes("ERROR:"))
      .slice(-3)
      .join(" | ");
    throw new Error(`Disposable role bootstrap failed: ${errors}`);
  }
  return result;
}

async function psqlWithSecret(
  secretName: string,
  statement: string,
): Promise<ProcessResult> {
  return docker(
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
      'url=$(/usr/local/bin/read-bounded-secret "$1" 4096); exec psql -X "$url" -v ON_ERROR_STOP=1 -c "$2"',
      "role-query",
      `/run/secrets/${secretName}`,
      statement,
    ],
    { allowFailure: true },
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

async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
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
      await cleanupDockerProofResources();
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
    }, 30_000);

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

    it("retries exact cleanup through a delayed Docker volume release", async () => {
      await docker(["volume", "create", cleanupProbeVolume]);
      await docker([
        "run",
        "--detach",
        "--name",
        cleanupProbeContainer,
        "--network",
        "none",
        "--volume",
        `${cleanupProbeVolume}:/cleanup`,
        "--entrypoint",
        "sh",
        image,
        "-ceu",
        "sleep 30",
      ]);

      const delayedRelease = (async () => {
        await wait(500);
        await docker(["rm", "-f", cleanupProbeContainer]);
      })();
      await removeDockerResource(["volume", "rm", "-f", cleanupProbeVolume]);
      await delayedRelease;

      const residual = await docker(["volume", "inspect", cleanupProbeVolume], {
        allowFailure: true,
      });
      expect(residual.code).not.toBe(0);
    }, 30_000);

    it("normalizes direct and PUBLIC ACLs, role settings, attributes, and ownership", async () => {
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
        create type public.runtime_public_type as enum ('canary');
        grant truncate on table public.play_history to public;
        grant update on sequence public.play_history_id_seq to public;
        grant select on table public.runtime_canary to public;
        create function public.runtime_security_definer_canary()
          returns integer
          language sql
          security definer
          set search_path = pg_catalog
          as 'select 1';
        grant all privileges on database apollo_trackfinder to apollo_tf_runtime;
        grant all privileges on database postgres to apollo_tf_runtime;
        grant create on tablespace pg_default to apollo_tf_runtime;
        grant create on schema public to apollo_tf_runtime;
        grant all privileges on all tables in schema public, apollo_tf
          to apollo_tf_runtime;
        grant select (id) on public.runtime_canary to apollo_tf_runtime;
        grant select on table pg_catalog.pg_authid to apollo_tf_runtime;
        grant all privileges on all sequences in schema public
          to apollo_tf_runtime;
        grant execute on function pg_catalog.pg_sleep(double precision)
          to apollo_tf_runtime;
        grant usage on type pg_catalog.int4 to apollo_tf_runtime;
        grant usage on language plpgsql to apollo_tf_runtime;
        select lo_create(980001);
        grant select, update on large object 980001 to apollo_tf_runtime;
        grant select, update on large object 980001 to public;
        create foreign data wrapper tf_bootstrap_fdw no handler no validator;
        create server tf_bootstrap_server
          foreign data wrapper tf_bootstrap_fdw;
        grant usage on foreign data wrapper tf_bootstrap_fdw
          to apollo_tf_runtime;
        grant usage on foreign server tf_bootstrap_server
          to apollo_tf_runtime;
        grant usage on foreign data wrapper tf_bootstrap_fdw to public;
        grant usage on foreign server tf_bootstrap_server to public;
        grant set on parameter log_statement to apollo_tf_runtime;
        alter role apollo_tf_migrator
          set application_name = 'polluted-migrator-global';
        alter role apollo_tf_migrator in database apollo_trackfinder
          set search_path = pg_catalog;
        alter role apollo_tf_migrator in database postgres
          set statement_timeout = '1s';
        alter role apollo_tf_runtime
          set application_name = 'polluted-runtime-global';
        alter role apollo_tf_runtime in database apollo_trackfinder
          set search_path = pg_catalog;
        alter role apollo_tf_runtime in database postgres
          set statement_timeout = '1s';
        alter role apollo_tf_runtime
          connection limit 0 valid until '2000-01-01';
        alter role apollo_tf_migrator
          connection limit 0 valid until '2000-01-01';
      `);

      const publicCanaries = await psqlAdmin(`
        select concat_ws('|',
          has_table_privilege(
            'apollo_tf_runtime',
            'public.play_history',
            'truncate'
          ),
          has_sequence_privilege(
            'apollo_tf_runtime',
            'public.play_history_id_seq',
            'update'
          ),
          has_table_privilege(
            'apollo_tf_runtime',
            'public.runtime_canary',
            'select'
          ),
          has_function_privilege(
            'apollo_tf_runtime',
            'public.runtime_security_definer_canary()',
            'execute'
          ),
          (
            select routines.proacl is null
            from pg_proc routines
            where routines.oid =
              'public.runtime_security_definer_canary()'::regprocedure
          )
        );
      `);
      expect(publicCanaries.stdout.toString()).toContain("t|t|t|t|t");

      await psqlAdmin(`
        create function public.extension_public_canary()
          returns integer
          language sql
          as 'select 1';
        alter extension plpgsql
          add function public.extension_public_canary();
      `);
      const extensionPublicBefore = await psqlAdmin(`
        select concat_ws('|',
          has_function_privilege(
            'public',
            'public.extension_public_canary()',
            'execute'
          ),
          exists (
            select 1
            from pg_depend dependencies
            where dependencies.classid = 'pg_proc'::regclass
              and dependencies.objid =
                'public.extension_public_canary()'::regprocedure
              and dependencies.refclassid = 'pg_extension'::regclass
              and dependencies.deptype = 'e'
          )
        );
      `);
      expect(extensionPublicBefore.stdout.toString()).toContain("t|t");

      const extensionPublicFailure = await runManualBootstrap(true);
      expect(extensionPublicFailure.code).not.toBe(0);
      expect(extensionPublicFailure.stdout.toString()).toBe("");
      expect(extensionPublicFailure.stderr.toString()).toBe(
        "TF role bootstrap failed\n",
      );
      const extensionPublicRollback = await psqlAdmin(`
        select concat_ws('|',
          has_function_privilege(
            'public',
            'public.extension_public_canary()',
            'execute'
          ),
          (
            select rolconnlimit
            from pg_roles
            where rolname = 'apollo_tf_runtime'
          )
        );
      `);
      expect(extensionPublicRollback.stdout.toString()).toContain("t|0");
      await psqlAdmin(`
        alter extension plpgsql
          drop function public.extension_public_canary();
        drop function public.extension_public_canary();
      `);

      const roleSettingsBefore = await psqlAdmin(`
        select 'managed_role_settings=' || string_agg(
          concat_ws(
            ':',
            role_name,
            global_rows,
            current_database_rows,
            foreign_database_rows
          ),
          '|' order by role_name
        )
        from (
          select
            roles.rolname as role_name,
            count(*) filter (where settings.setdatabase = 0) as global_rows,
            count(*) filter (
              where settings.setdatabase = (
                select oid
                from pg_database
                where datname = current_database()
              )
            ) as current_database_rows,
            count(*) filter (
              where settings.setdatabase = (
                select oid
                from pg_database
                where datname = 'postgres'
              )
            ) as foreign_database_rows
          from pg_db_role_setting settings
          join pg_roles roles on roles.oid = settings.setrole
          where roles.rolname in (
            'apollo_tf_migrator',
            'apollo_tf_runtime'
          )
          group by roles.rolname
        ) managed_settings;
      `);
      expect(roleSettingsBefore.stdout.toString()).toContain(
        "managed_role_settings=apollo_tf_migrator:1:1:1|apollo_tf_runtime:1:1:1",
      );

      const roleSettingsBootstrap = await runManualBootstrap(true);
      expect(roleSettingsBootstrap.code).toBe(0);
      expect(roleSettingsBootstrap.stdout.toString()).toBe("");
      expect(roleSettingsBootstrap.stderr.toString()).toBe("");
      const roleSettingsAfter = await psqlAdmin(`
        select 'managed_role_settings=' || count(*)
        from pg_db_role_setting settings
        join pg_roles roles on roles.oid = settings.setrole
        where roles.rolname in (
          'apollo_tf_migrator',
          'apollo_tf_runtime'
        );
      `);
      expect(roleSettingsAfter.stdout.toString()).toContain(
        "managed_role_settings=0",
      );

      const idempotentRoleSettingsBootstrap = await runManualBootstrap(true);
      expect(idempotentRoleSettingsBootstrap.code).toBe(0);
      expect(idempotentRoleSettingsBootstrap.stdout.toString()).toBe("");
      expect(idempotentRoleSettingsBootstrap.stderr.toString()).toBe("");

      await psqlAdmin(
        `
          create table public.tf_cross_database_acl (id integer);
          grant select on table public.tf_cross_database_acl
            to apollo_tf_runtime;
        `,
        "postgres",
      );
      const crossDatabaseFailure = await runManualBootstrap(true);
      expect(crossDatabaseFailure.code).not.toBe(0);
      expect(crossDatabaseFailure.stdout.toString()).toBe("");
      expect(crossDatabaseFailure.stderr.toString()).toBe(
        "TF role bootstrap failed\n",
      );
      await psqlAdmin(
        `
          revoke all privileges on table public.tf_cross_database_acl
            from apollo_tf_runtime cascade;
          drop table public.tf_cross_database_acl;
        `,
        "postgres",
      );

      await psqlAdmin(`
        alter default privileges for role apollo_tf_runtime
          revoke execute on functions from public;
      `);
      await psqlAdmin(
        `
          alter default privileges for role apollo_tf_runtime
            revoke execute on functions from public;
        `,
        "postgres",
      );
      const foreignDefaultAclFailure = await runManualBootstrap(true);
      expect(foreignDefaultAclFailure.code).not.toBe(0);
      expect(foreignDefaultAclFailure.stdout.toString()).toBe("");
      expect(foreignDefaultAclFailure.stderr.toString()).toBe(
        "TF role bootstrap failed\n",
      );

      const rollback = await psqlAdmin(`
        select concat_ws('|',
          (select rolconnlimit
            from pg_roles where rolname = 'apollo_tf_runtime'),
          exists (
            select 1
            from pg_default_acl defaults
            where defaults.defaclrole = (
              select oid
              from pg_roles
              where rolname = 'apollo_tf_runtime'
            )
              and defaults.defaclobjtype = 'f'
          )
        );
      `);
      expect(rollback.stdout.toString()).toContain("-1|t");

      await psqlAdmin(
        `
          alter default privileges for role apollo_tf_runtime
            grant execute on functions to public;
        `,
        "postgres",
      );

      const bootstrap = await runManualBootstrap();
      expect(bootstrap.stdout.toString()).toBe("");
      expect(bootstrap.stderr.toString()).toBe("");

      const currentRuntimeDefaultAcl = await psqlAdmin(`
        select 'current_runtime_default_acl=' || concat_ws(
          '|',
          count(*),
          coalesce(sum(cardinality(defaults.defaclacl)), 0)
        )
        from pg_default_acl defaults
        where defaults.defaclrole = (
          select oid
          from pg_roles
          where rolname = 'apollo_tf_runtime'
        );
      `);
      expect(currentRuntimeDefaultAcl.stdout.toString()).toContain(
        "current_runtime_default_acl=1|0",
      );

      const projection = await psqlAdmin(`
        select concat_ws('|',
          has_database_privilege('apollo_tf_runtime', current_database(), 'create'),
          has_schema_privilege('apollo_tf_runtime', 'public', 'create'),
          has_table_privilege('apollo_tf_runtime', 'public.track_search_cache', 'truncate'),
          has_table_privilege('apollo_tf_runtime', 'public.play_history', 'truncate'),
          has_sequence_privilege('apollo_tf_runtime', 'public.play_history_id_seq', 'update'),
          has_table_privilege('apollo_tf_runtime', 'public.track_search_cache', 'select,insert,update,delete'),
          has_sequence_privilege('apollo_tf_runtime', 'public.track_search_cache_id_seq', 'usage'),
          has_table_privilege('apollo_tf_runtime', 'apollo_tf.schema_migrations', 'select'),
          has_table_privilege('apollo_tf_runtime', 'public.runtime_canary', 'select'),
          has_function_privilege(
            'apollo_tf_runtime',
            'public.runtime_security_definer_canary()',
            'execute'
          ),
          has_table_privilege('apollo_tf_runtime', 'pg_catalog.pg_authid', 'select'),
          has_column_privilege('apollo_tf_runtime', 'public.runtime_canary', 'id', 'select'),
          (select count(*)
            from pg_largeobject_metadata objects
            cross join lateral aclexplode(objects.lomacl) acl
            where objects.oid = 980001
              and acl.grantee = (
                select oid from pg_roles where rolname = 'apollo_tf_runtime'
              )),
          (select count(*)
            from pg_largeobject_metadata objects
            cross join lateral aclexplode(objects.lomacl) acl
            where objects.oid = 980001
              and acl.grantee = 0),
          has_type_privilege(
            'apollo_tf_runtime',
            'public.runtime_public_type',
            'usage'
          ),
          has_foreign_data_wrapper_privilege('apollo_tf_runtime', 'tf_bootstrap_fdw', 'usage'),
          has_server_privilege('apollo_tf_runtime', 'tf_bootstrap_server', 'usage'),
          has_parameter_privilege('apollo_tf_runtime', 'log_statement', 'set'),
          (select count(*) from pg_auth_members memberships
            join pg_roles members on members.oid = memberships.member
            where members.rolname = 'apollo_tf_runtime'),
          (select count(*) from pg_db_role_setting settings
            join pg_roles roles on roles.oid = settings.setrole
            where roles.rolname = 'apollo_tf_runtime'),
          (select count(*)
            from pg_database databases
            cross join lateral aclexplode(databases.datacl) acl
            where databases.datname = 'postgres'
              and acl.grantee = (
                select oid from pg_roles where rolname = 'apollo_tf_runtime'
              )),
          (select count(*)
            from pg_tablespace tablespaces
            cross join lateral aclexplode(tablespaces.spcacl) acl
            where tablespaces.spcname = 'pg_default'
              and acl.grantee = (
                select oid from pg_roles where rolname = 'apollo_tf_runtime'
              )),
          (select count(*)
            from pg_language languages
            cross join lateral aclexplode(languages.lanacl) acl
            where languages.lanname = 'plpgsql'
              and acl.grantee = (
                select oid from pg_roles where rolname = 'apollo_tf_runtime'
              )),
          (select count(*)
            from pg_proc routines
            cross join lateral aclexplode(routines.proacl) acl
            where routines.oid =
              'pg_catalog.pg_sleep(double precision)'::regprocedure
              and acl.grantee = (
                select oid from pg_roles where rolname = 'apollo_tf_runtime'
              )),
          (select count(*)
            from pg_type types
            cross join lateral aclexplode(types.typacl) acl
            where types.oid = 'pg_catalog.int4'::regtype
              and acl.grantee = (
                select oid from pg_roles where rolname = 'apollo_tf_runtime'
              )),
          (select rolconnlimit = -1
              and rolvaliduntil = 'infinity'::timestamptz
            from pg_roles where rolname = 'apollo_tf_runtime'),
          (select rolconnlimit = -1
              and rolvaliduntil = 'infinity'::timestamptz
            from pg_roles where rolname = 'apollo_tf_migrator')
        );
      `);
      expect(projection.stdout.toString().trim()).toContain(
        "f|f|f|f|f|t|t|t|f|f|f|f|0|0|f|f|f|f|0|0|0|0|0|0|0|t|t",
      );

      for (const statement of [
        "truncate table public.play_history",
        "select setval('public.play_history_id_seq', 1, false)",
        "select * from public.runtime_canary",
        "select public.runtime_security_definer_canary()",
        "select lo_get(980001)",
        "select lo_put(980001, 0, decode('00', 'hex'))",
      ]) {
        const denied = await psqlWithSecret(
          "tf_runtime_database_url",
          statement,
        );
        expect(denied.code).not.toBe(0);
        expect(denied.stdout.toString()).toBe("");
      }

      for (const [secretName, expectedRole] of [
        ["tf_migrator_database_url", "apollo_tf_migrator"],
        ["tf_runtime_database_url", "apollo_tf_runtime"],
      ] as const) {
        const login = await docker([
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
          'url=$(/usr/local/bin/read-bounded-secret "$1" 4096); exec psql -X -A -t "$url" -v ON_ERROR_STOP=1 -c "select current_user"',
          "login-proof",
          `/run/secrets/${secretName}`,
        ]);
        expect(login.stdout.toString().trim()).toBe(expectedRole);
        expect(login.stderr.toString()).toBe("");
      }

      const postgresLogin = await docker(
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
          'url=$(/usr/local/bin/read-bounded-secret "$1" 4096); postgres_url=${url%/*}/postgres; exec psql -X -A -t "$postgres_url" -v ON_ERROR_STOP=1 -c "select current_user"',
          "postgres-login-proof",
          "/run/secrets/tf_runtime_database_url",
        ],
        { allowFailure: true },
      );
      expect(postgresLogin.code).not.toBe(0);
      expect(postgresLogin.stdout.toString()).toBe("");

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
