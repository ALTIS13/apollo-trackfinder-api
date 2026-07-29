import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const rootComposePath = join(repositoryRoot, "docker-compose.yml");
const nestedComposePath = join(
  repositoryRoot,
  "artifacts",
  "api-server",
  "docker-compose.yml",
);
const startupScript = join(
  repositoryRoot,
  "artifacts",
  "tf-search",
  "container",
  "start-search.sh",
);
const dockerfilePath = join(
  repositoryRoot,
  "artifacts",
  "tf-search",
  "Dockerfile",
);
const temporaryDirectories: string[] = [];
const temporaryRoot = join(
  repositoryRoot,
  ".superpowers",
  "sdd",
  "task-5-search-deployment-tmp",
);

interface ComposeService {
  readonly build?: {
    readonly context?: string;
    readonly dockerfile?: string;
  };
  readonly cap_drop?: readonly string[];
  readonly depends_on?: Record<string, unknown>;
  readonly deploy?: {
    readonly replicas?: number;
    readonly resources?: {
      readonly limits?: {
        readonly cpus?: string;
        readonly memory?: string;
        readonly pids?: number;
      };
      readonly reservations?: {
        readonly cpus?: string;
        readonly memory?: string;
      };
    };
  };
  readonly environment?: Record<string, string>;
  readonly healthcheck?: Record<string, unknown>;
  readonly init?: boolean;
  readonly networks?:
    | readonly string[]
    | Readonly<Record<string, { readonly gw_priority?: number } | null>>;
  readonly pids_limit?: number;
  readonly ports?: readonly string[];
  readonly read_only?: boolean;
  readonly security_opt?: readonly string[];
  readonly secrets?: readonly (string | { readonly source: string })[];
  readonly stop_grace_period?: string;
  readonly tmpfs?: readonly string[];
  readonly user?: string;
  readonly volumes?: readonly string[];
}

interface ComposeTemplate {
  readonly networks?: Record<string, Record<string, unknown> | null>;
  readonly secrets?: Record<string, { readonly file?: string }>;
  readonly services: Record<string, ComposeService>;
}

async function composeTemplate(path: string): Promise<ComposeTemplate> {
  return parse(await readFile(path, "utf8")) as ComposeTemplate;
}

function service(template: ComposeTemplate, name: string): ComposeService {
  const value = template.services[name];
  if (value === undefined) throw new Error(`missing service ${name}`);
  return value;
}

function secretSources(current: ComposeService): string[] {
  return (current.secrets ?? []).map((secret) =>
    typeof secret === "string" ? secret : secret.source,
  );
}

function networkNames(value: ComposeService["networks"]): readonly string[] {
  if (value === undefined) return [];
  return Array.isArray(value)
    ? value
    : Object.keys(
        value as Readonly<
          Record<string, { readonly gw_priority?: number } | null>
        >,
      );
}

function shellPath(path: string): string {
  if (process.platform !== "win32") return path;
  const match = /^([A-Za-z]):\\(.*)$/.exec(path);
  if (match === null) return path.replaceAll("\\", "/");
  return `/${match[1]!.toLowerCase()}/${match[2]!.replaceAll("\\", "/")}`;
}

async function runSearchStartup(options: {
  readonly commandSecret?: string;
  readonly heartbeatSecret?: string;
  readonly commandPath?: string;
  readonly heartbeatPath?: string;
}): Promise<{ readonly stderr: string; readonly stdout: string }> {
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(
    join(temporaryRoot, "apollo-tf-search-startup-"),
  );
  const fromRoot = relative(repositoryRoot, directory);
  if (
    fromRoot.length === 0 ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`)
  ) {
    throw new Error("Temporary path escaped the worktree");
  }
  temporaryDirectories.push(directory);
  const commandPath =
    options.commandPath ?? join(directory, "tf_search_internal_auth_secret");
  const heartbeatPath =
    options.heartbeatPath ?? join(directory, "tf_search_heartbeat_secret");
  if (options.commandSecret !== undefined) {
    await writeFile(commandPath, options.commandSecret);
  }
  if (options.heartbeatSecret !== undefined) {
    await writeFile(heartbeatPath, options.heartbeatSecret);
  }

  return execFileAsync(
    "sh",
    [
      shellPath(startupScript),
      process.execPath,
      "-e",
      [
        "process.stdout.write(JSON.stringify({",
        " commandPath: process.env.TF_SEARCH_INTERNAL_AUTH_SECRET_FILE,",
        " heartbeatPath: process.env.TF_SEARCH_HEARTBEAT_SECRET_FILE,",
        " hasDatabase: process.env.DATABASE_URL !== undefined,",
        " hasPlatform: process.env.APOLLO_PLATFORM_API_ORIGIN !== undefined,",
        "}));",
      ].join(""),
    ],
    {
      cwd: repositoryRoot,
      env: {
        PATH: process.env.PATH,
        TF_SEARCH_INTERNAL_AUTH_SECRET_FILE: shellPath(commandPath),
        TF_SEARCH_HEARTBEAT_SECRET_FILE: shellPath(heartbeatPath),
      },
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    },
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
  try {
    await rmdir(temporaryRoot);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
      throw error;
    }
  }
});

describe("tf-search deployment contract", () => {
  it.each([
    [
      "root",
      rootComposePath,
      [
        "admin",
        "api",
        "db",
        "redis",
        "tf-baseline",
        "tf-download-redis",
        "tf-download-worker",
        "tf-integrations",
        "tf-integrations-migrate",
        "tf-integrations-postgres",
        "tf-migrate",
        "tf-role-bootstrap",
        "tf-search",
        "web",
      ],
    ],
    [
      "nested",
      nestedComposePath,
      [
        "api",
        "db",
        "redis",
        "tf-baseline",
        "tf-download-redis",
        "tf-download-worker",
        "tf-integrations",
        "tf-integrations-migrate",
        "tf-integrations-postgres",
        "tf-migrate",
        "tf-role-bootstrap",
        "tf-search",
      ],
    ],
  ])(
    "adds one isolated search service to the %s template",
    async (_label, path, expectedServices) => {
      const template = await composeTemplate(path);
      const search = service(template, "tf-search");
      const api = service(template, "api");

      expect(Object.keys(template.services).sort()).toEqual(expectedServices);
      expect(search.build).toEqual({
        context: path === rootComposePath ? "." : "../..",
        dockerfile: "artifacts/tf-search/Dockerfile",
      });
      expect(search.ports).toBeUndefined();
      expect(search.volumes).toBeUndefined();
      expect(search.networks).toEqual({
        "tf-search-control": { gw_priority: 0 },
        "tf-search-egress": { gw_priority: 1 },
      });
      expect(networkNames(search.networks)).not.toContain("tf-data");
      expect(networkNames(search.networks)).not.toContain("tf-edge");
      expect(networkNames(api.networks)).toContain("tf-search-control");
      expect(
        (
          search.networks as Readonly<
            Record<string, { readonly gw_priority?: number }>
          >
        )["tf-search-control"]?.gw_priority,
      ).toBeLessThan(
        (
          search.networks as Readonly<
            Record<string, { readonly gw_priority?: number }>
          >
        )["tf-search-egress"]?.gw_priority ?? 0,
      );
      expect(template.networks?.["tf-search-control"]).toEqual({
        internal: true,
      });
      expect(template.networks?.["tf-search-egress"]).toEqual({});
      expect(search.depends_on ?? {}).not.toHaveProperty("api");
    },
  );

  it.each([
    ["root", rootComposePath],
    ["nested", nestedComposePath],
  ])(
    "mounts exact distinct file-backed secrets in the %s template",
    async (_label, path) => {
      const template = await composeTemplate(path);
      const api = service(template, "api");
      const search = service(template, "tf-search");
      const serialized = JSON.stringify(template);

      expect(secretSources(api)).toEqual(
        expect.arrayContaining([
          "tf_client_secret",
          "tf_runtime_database_url",
          "tf_search_internal_auth_secret",
          "tf_module_heartbeat_keys",
        ]),
      );
      expect(secretSources(api)).not.toContain("tf_search_heartbeat_secret");
      expect(secretSources(search)).toEqual([
        "tf_search_internal_auth_secret",
        "tf_search_heartbeat_secret",
      ]);
      expect(search.environment).toMatchObject({
        TF_SEARCH_INTERNAL_AUTH_SECRET_FILE:
          "/run/secrets/tf_search_internal_auth_secret",
        TF_SEARCH_HEARTBEAT_SECRET_FILE:
          "/run/secrets/tf_search_heartbeat_secret",
        TF_SEARCH_HEARTBEAT_API_ORIGIN: "http://api:8080",
        TF_SEARCH_HEARTBEAT_ALLOW_INSECURE_HTTP: "true",
      });
      expect(api.environment).toMatchObject({
        APOLLO_MODULE_HEARTBEAT_KEYS_FILE:
          "/run/secrets/tf_module_heartbeat_keys",
        TF_SEARCH_INTERNAL_AUTH_SECRET_FILE:
          "/run/secrets/tf_search_internal_auth_secret",
        TF_SEARCH_ORIGIN: "http://tf-search:8080",
        TF_SEARCH_ALLOW_INSECURE_HTTP: "true",
      });
      expect(Object.keys(template.secrets ?? {}).sort()).toEqual([
        "admin_access_password",
        "admin_access_user",
        "admin_dashboard_token",
        "tf_admin_database_url",
        "tf_client_secret",
        "tf_download_heartbeat_secret",
        "tf_download_internal_auth_secret",
        "tf_download_queue_password",
        "tf_download_queue_redis_url",
        "tf_integrations_heartbeat_secret",
        "tf_integrations_internal_auth_secret",
        "tf_integrations_migrator_database_url",
        "tf_integrations_migrator_password",
        "tf_integrations_postgres_admin_password",
        "tf_integrations_runtime_database_url",
        "tf_integrations_runtime_password",
        "tf_integrations_spotify_client_id",
        "tf_integrations_spotify_client_secret",
        "tf_integrations_token_keyring",
        "tf_migrator_database_url",
        "tf_migrator_password",
        "tf_module_heartbeat_keys",
        "tf_postgres_admin_password",
        "tf_runtime_database_url",
        "tf_runtime_password",
        "tf_search_heartbeat_secret",
        "tf_search_internal_auth_secret",
      ]);
      for (const secretName of [
        "tf_search_internal_auth_secret",
        "tf_search_heartbeat_secret",
        "tf_module_heartbeat_keys",
      ]) {
        expect(template.secrets?.[secretName]?.file).toBe(
          `\${TF_SECRET_DIRECTORY:-/var/lib/apollo-tf/secrets}/${secretName}`,
        );
      }
      expect(serialized).not.toContain("raw-command-canary");
      expect(serialized).not.toContain("raw-heartbeat-canary");
      expect(serialized).not.toMatch(/[a-f0-9]{64}.*canary/i);
    },
  );

  it.each([
    ["root", rootComposePath],
    ["nested", nestedComposePath],
  ])("hardens and bounds the %s search process", async (_label, path) => {
    const template = await composeTemplate(path);
    const search = service(template, "tf-search");

    expect(search.user).toBe("10001:10001");
    expect(search.read_only).toBe(true);
    expect(search.init).toBe(true);
    expect(search.security_opt).toEqual(["no-new-privileges:true"]);
    expect(search.cap_drop).toEqual(["ALL"]);
    expect(search.pids_limit).toBe(128);
    expect(search.tmpfs).toEqual([
      "/tmp:rw,noexec,nosuid,size=32m",
      "/tmp/yt-dlp:rw,noexec,nosuid,size=64m",
    ]);
    expect(search.stop_grace_period).toBe("20s");
    expect(search.deploy).toEqual({
      replicas: 1,
      resources: {
        limits: { cpus: "1.0", memory: "512M", pids: 128 },
        reservations: { cpus: "0.25", memory: "256M" },
      },
    });
    expect(search.healthcheck).toMatchObject({
      interval: "5s",
      timeout: "3s",
      retries: 20,
    });
    expect(search.healthcheck?.["test"]).toEqual([
      "CMD",
      "node",
      "-e",
      expect.stringContaining("http://127.0.0.1:8080/readyz"),
    ]);
  });

  it.each([
    ["root", rootComposePath],
    ["nested", nestedComposePath],
  ])(
    "keeps data, provider-account, and control-plane credentials out of %s search",
    async (_label, path) => {
      const search = service(await composeTemplate(path), "tf-search");
      const environment = Object.keys(search.environment ?? {});
      const forbidden =
        /DATABASE|POSTGRES|REDIS|PLATFORM|SPOTIFY|YANDEX|PROVIDER|DOCKER|COOLIFY|CADDY|UFW|SSH/i;

      expect(environment.filter((name) => forbidden.test(name))).toEqual([]);
      expect(secretSources(search)).not.toEqual(
        expect.arrayContaining([
          "tf_client_secret",
          "tf_admin_database_url",
          "tf_migrator_database_url",
          "tf_postgres_admin_password",
          "tf_runtime_database_url",
          "tf_module_heartbeat_keys",
        ]),
      );
    },
  );

  it("uses the non-root immutable search image entrypoint", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");

    expect(dockerfile).toContain(
      "COPY artifacts/tf-search/container/start-search.sh ./bin/start-search.sh",
    );
    expect(dockerfile).toContain("USER 10001:10001");
    expect(dockerfile).toContain('ENTRYPOINT ["/app/bin/start-search.sh"]');
    expect(dockerfile).toContain('CMD ["node", "/app/dist/index.mjs"]');
  });

  it("starts with only two readable, distinct owning secret files", async () => {
    const commandSecret = "c".repeat(32);
    const heartbeatSecret = "h".repeat(32);
    const result = await runSearchStartup({
      commandSecret,
      heartbeatSecret,
    });
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(parsed).toMatchObject({
      hasDatabase: false,
      hasPlatform: false,
    });
    expect(parsed.commandPath).toContain("tf_search_internal_auth_secret");
    expect(parsed.heartbeatPath).toContain("tf_search_heartbeat_secret");
    expect(result.stderr).toBe("");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(commandSecret);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(heartbeatSecret);
  });

  it.each([
    ["missing command", undefined, "h".repeat(32)],
    ["empty command", "", "h".repeat(32)],
    ["short command", "c".repeat(31), "h".repeat(32)],
    ["oversized command", "c".repeat(513), "h".repeat(32)],
    ["missing heartbeat", "c".repeat(32), undefined],
    ["empty heartbeat", "c".repeat(32), ""],
    ["short heartbeat", "c".repeat(32), "h".repeat(31)],
    ["oversized heartbeat", "c".repeat(32), "h".repeat(513)],
    ["equal secrets", "s".repeat(32), "s".repeat(32)],
  ])(
    "rejects %s before the search process starts",
    async (_label, commandSecret, heartbeatSecret) => {
      await expect(
        runSearchStartup({
          ...(commandSecret === undefined ? {} : { commandSecret }),
          ...(heartbeatSecret === undefined ? {} : { heartbeatSecret }),
        }),
      ).rejects.toBeDefined();
    },
  );
});
