import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const rootComposePath = join(repositoryRoot, "docker-compose.yml");
const nestedComposePath = join(
  repositoryRoot,
  "artifacts",
  "api-server",
  "docker-compose.yml",
);
const dockerfilePath = join(
  repositoryRoot,
  "artifacts",
  "tf-integrations",
  "Dockerfile",
);
const buildScriptPath = join(
  repositoryRoot,
  "artifacts",
  "tf-integrations",
  "build.mjs",
);
const startupScriptPath = join(
  repositoryRoot,
  "artifacts",
  "tf-integrations",
  "container",
  "start-integrations.sh",
);
const roleInitScriptPath = join(
  repositoryRoot,
  "artifacts",
  "tf-integrations",
  "container",
  "init-roles.sh",
);

type ComposeSecret =
  | string
  | {
      readonly gid?: string;
      readonly mode?: string;
      readonly source?: string;
      readonly target?: string;
      readonly uid?: string;
    };

interface ComposeService {
  readonly build?: {
    readonly context?: string;
    readonly dockerfile?: string;
    readonly target?: string;
  };
  readonly cap_drop?: readonly string[];
  readonly command?: readonly string[];
  readonly depends_on?: Readonly<
    Record<string, { readonly condition?: string } | null>
  >;
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
  readonly environment?: Readonly<Record<string, string>>;
  readonly healthcheck?: Readonly<Record<string, unknown>>;
  readonly image?: string;
  readonly init?: boolean;
  readonly networks?:
    | readonly string[]
    | Readonly<Record<string, { readonly gw_priority?: number } | null>>;
  readonly pids_limit?: number;
  readonly ports?: readonly string[];
  readonly read_only?: boolean;
  readonly restart?: string;
  readonly secrets?: readonly ComposeSecret[];
  readonly security_opt?: readonly string[];
  readonly stop_grace_period?: string;
  readonly tmpfs?: readonly string[];
  readonly user?: string;
  readonly volumes?: readonly string[];
}

interface ComposeTemplate {
  readonly networks?: Readonly<Record<string, Record<string, unknown> | null>>;
  readonly secrets?: Readonly<Record<string, { readonly file?: string }>>;
  readonly services: Readonly<Record<string, ComposeService>>;
  readonly volumes?: Readonly<Record<string, unknown>>;
}

const composePaths = [
  ["root", rootComposePath],
  ["nested", nestedComposePath],
] as const;
const integrationServices = [
  "tf-integrations-postgres",
  "tf-integrations-migrate",
  "tf-integrations",
] as const;
const integrationSecrets = [
  "tf_integrations_postgres_admin_password",
  "tf_integrations_migrator_password",
  "tf_integrations_runtime_password",
  "tf_integrations_migrator_database_url",
  "tf_integrations_runtime_database_url",
  "tf_integrations_token_keyring",
  "tf_integrations_spotify_client_id",
  "tf_integrations_spotify_client_secret",
  "tf_integrations_internal_auth_secret",
  "tf_integrations_heartbeat_secret",
] as const;

let templates: Readonly<Record<(typeof composePaths)[number][0], ComposeTemplate>>;

function service(template: ComposeTemplate, name: string): ComposeService {
  const value = template.services[name];
  if (value === undefined) throw new Error(`missing service ${name}`);
  return value;
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

function secretNames(value: ComposeService["secrets"]): readonly string[] {
  return (value ?? []).map((entry) =>
    typeof entry === "string" ? entry : (entry.source ?? ""),
  );
}

function expectedSecretMount(
  name: string,
  owner = "10001",
): ComposeSecret {
  return {
    source: name,
    target: name,
    uid: owner,
    gid: owner,
    mode: "0400",
  };
}

function servicesOnNetwork(
  template: ComposeTemplate,
  network: string,
): readonly string[] {
  return Object.entries(template.services)
    .filter(([, current]) => networkNames(current.networks).includes(network))
    .map(([name]) => name)
    .sort();
}

function normalizedIntegrationServices(
  template: ComposeTemplate,
): Readonly<Record<string, ComposeService>> {
  return Object.fromEntries(
    integrationServices.map((name) => {
      const current = service(template, name);
      return [
        name,
        {
          ...current,
          ...(current.build === undefined
            ? {}
            : {
                build: {
                  ...current.build,
                  context: "<workspace>",
                },
              }),
        },
      ];
    }),
  );
}

beforeAll(async () => {
  const [root, nested] = await Promise.all(
    composePaths.map(async ([, path]) =>
      parse(await readFile(path, "utf8")) as ComposeTemplate,
    ),
  );
  templates = { root, nested };
});

describe("tf-integrations deployment contract", () => {
  it("defines the same integration service names and images in root and nested Compose", () => {
    const root = templates.root;
    const nested = templates.nested;

    for (const template of [root, nested]) {
      expect(
        integrationServices.filter(
          (name) => template.services[name] !== undefined,
        ),
      ).toEqual(integrationServices);
      expect(service(template, "tf-integrations-postgres")).toMatchObject({
        image:
          "${TF_INTEGRATIONS_POSTGRES_IMAGE:-apollo-tf-integrations-postgres:local}",
        build: {
          dockerfile: "artifacts/tf-integrations/Dockerfile",
          target: "postgres-role-init",
        },
      });
      expect(service(template, "tf-integrations-migrate")).toMatchObject({
        image: "${TF_INTEGRATIONS_IMAGE:-apollo-tf-integrations:local}",
        build: {
          dockerfile: "artifacts/tf-integrations/Dockerfile",
          target: "runtime",
        },
      });
      expect(service(template, "tf-integrations")).toMatchObject({
        image: "${TF_INTEGRATIONS_IMAGE:-apollo-tf-integrations:local}",
        build: {
          dockerfile: "artifacts/tf-integrations/Dockerfile",
          target: "runtime",
        },
      });
      expect(template.volumes).toHaveProperty(
        "tf-integrations-postgres-data",
      );
    }
    expect(normalizedIntegrationServices(root)).toEqual(
      normalizedIntegrationServices(nested),
    );
  });

  it("publishes no integration module, database, or migrator host port", () => {
    for (const template of Object.values(templates)) {
      for (const name of integrationServices) {
        expect(service(template, name).ports).toBeUndefined();
      }
    }
  });

  it("attaches API and module only to the internal integration control network", () => {
    for (const template of Object.values(templates)) {
      expect(template.networks?.["tf-integrations-control"]).toEqual({
        internal: true,
      });
      expect(
        servicesOnNetwork(template, "tf-integrations-control"),
      ).toEqual(["api", "tf-integrations"]);
    }
  });

  it("attaches module and database/migrator only through the isolated data network", () => {
    for (const template of Object.values(templates)) {
      expect(template.networks?.["tf-integrations-data"]).toEqual({
        internal: true,
      });
      expect(servicesOnNetwork(template, "tf-integrations-data")).toEqual([
        "tf-integrations",
        "tf-integrations-migrate",
        "tf-integrations-postgres",
      ]);
      expect(networkNames(service(template, "tf-integrations").networks)).not
        .toEqual(expect.arrayContaining(["tf-data", "tf-edge"]));
    }
  });

  it("attaches only the module to integration egress", () => {
    for (const template of Object.values(templates)) {
      expect(template.networks?.["tf-integrations-egress"]).toEqual({});
      expect(servicesOnNetwork(template, "tf-integrations-egress")).toEqual([
        "tf-integrations",
      ]);
      const networks = service(template, "tf-integrations")
        .networks as Readonly<
        Record<string, { readonly gw_priority?: number } | null>
      >;
      expect(networks["tf-integrations-egress"]?.gw_priority).toBe(1);
      expect(networks["tf-integrations-control"]?.gw_priority).toBe(0);
      expect(networks["tf-integrations-data"]?.gw_priority).toBe(0);
    }
  });

  it("mounts command, heartbeat, database, keyring, and Spotify secrets to exact owners", () => {
    for (const template of Object.values(templates)) {
      const postgres = service(template, "tf-integrations-postgres");
      const migrate = service(template, "tf-integrations-migrate");
      const module = service(template, "tf-integrations");
      const api = service(template, "api");

      expect(postgres.secrets).toEqual(
        [
          "tf_integrations_postgres_admin_password",
          "tf_integrations_migrator_password",
          "tf_integrations_runtime_password",
        ].map((name) => expectedSecretMount(name, "999")),
      );
      expect(migrate.secrets).toEqual(
        ["tf_integrations_migrator_database_url"].map((name) =>
          expectedSecretMount(name),
        ),
      );
      expect(module.secrets).toEqual(
        [
          "tf_integrations_runtime_database_url",
          "tf_integrations_token_keyring",
          "tf_integrations_spotify_client_id",
          "tf_integrations_spotify_client_secret",
          "tf_integrations_internal_auth_secret",
          "tf_integrations_heartbeat_secret",
        ].map((name) => expectedSecretMount(name)),
      );
      expect(
        (api.secrets ?? []).filter(
          (entry) =>
            typeof entry !== "string" &&
            entry.source?.startsWith("tf_integrations_"),
        ),
      ).toEqual([
        expectedSecretMount("tf_integrations_internal_auth_secret"),
      ]);
      expect(module.environment).toMatchObject({
        APOLLO_API_VERSION: "${TF_INTEGRATIONS_VERSION:-unknown}",
        APOLLO_DEPLOYED_AT: "${TF_INTEGRATIONS_DEPLOYED_AT:-}",
        NODE_ENV: "production",
        PORT: "8080",
        TF_INTEGRATIONS_DATABASE_URL_FILE:
          "/run/secrets/tf_integrations_runtime_database_url",
        TF_INTEGRATIONS_HEARTBEAT_ALLOW_INSECURE_HTTP: "true",
        TF_INTEGRATIONS_HEARTBEAT_API_ORIGIN: "http://api:8080",
        TF_INTEGRATIONS_HEARTBEAT_SECRET_FILE:
          "/run/secrets/tf_integrations_heartbeat_secret",
        TF_INTEGRATIONS_INTERNAL_AUTH_SECRET_FILE:
          "/run/secrets/tf_integrations_internal_auth_secret",
        TF_INTEGRATIONS_SPOTIFY_CALLBACK_URI:
          "${TF_INTEGRATIONS_SPOTIFY_CALLBACK_URI:-https://api.tf.apollot.ru/api/spotify/callback}",
        TF_INTEGRATIONS_SPOTIFY_CLIENT_ID_FILE:
          "/run/secrets/tf_integrations_spotify_client_id",
        TF_INTEGRATIONS_SPOTIFY_CLIENT_SECRET_FILE:
          "/run/secrets/tf_integrations_spotify_client_secret",
        TF_INTEGRATIONS_TOKEN_KEYRING_FILE:
          "/run/secrets/tf_integrations_token_keyring",
      });
      expect(api.environment).toMatchObject({
        TF_INTEGRATIONS_ALLOW_INSECURE_HTTP: "true",
        TF_INTEGRATIONS_INTERNAL_AUTH_SECRET_FILE:
          "/run/secrets/tf_integrations_internal_auth_secret",
        TF_INTEGRATIONS_ORIGIN: "http://tf-integrations:8080",
      });
      for (const [name, secret] of Object.entries(template.secrets ?? {})) {
        expect(secret.file).toBe(
          `\${TF_SECRET_DIRECTORY:-/var/lib/apollo-tf/secrets}/${name}`,
        );
      }
    }
  });

  it("passes no provider secret value through environment variables", () => {
    for (const template of Object.values(templates)) {
      const apiEnvironment = service(template, "api").environment ?? {};
      const moduleEnvironment =
        service(template, "tf-integrations").environment ?? {};

      expect(apiEnvironment).not.toHaveProperty("SPOTIFY_CLIENT_ID");
      expect(apiEnvironment).not.toHaveProperty("SPOTIFY_CLIENT_SECRET");
      expect(
        Object.entries(moduleEnvironment).filter(([name]) =>
          /SPOTIFY_(?:CLIENT_ID|CLIENT_SECRET)$/.test(name),
        ),
      ).toEqual([]);
      expect(JSON.stringify(moduleEnvironment)).not.toMatch(
        /\$\{(?:SPOTIFY|YANDEX)_[A-Z0-9_]+/,
      );
    }
  });

  it("passes no TF/Platform DB, Redis, browser, Docker, SSH, Caddy, or Coolify credential to the module", () => {
    const forbiddenSecret =
      /(?:^|_)(?:PLATFORM|REDIS|BROWSER|SESSION|DOCKER|SSH|CADDY|COOLIFY|UFW)(?:_|$)|^tf_(?:client|database|postgres|module|search)_/i;
    const forbiddenEnvironment =
      /(?:^|_)(?:PLATFORM|REDIS|BROWSER|SESSION|DOCKER|SSH|CADDY|COOLIFY|UFW)(?:_|$)|^(?:DATABASE_URL|TF_DATABASE_URL)/i;

    for (const template of Object.values(templates)) {
      const module = service(template, "tf-integrations");
      expect(
        secretNames(module.secrets).filter((name) =>
          forbiddenSecret.test(name),
        ),
      ).toEqual([]);
      expect(
        Object.keys(module.environment ?? {})
          .filter(
            (name) => name !== "TF_INTEGRATIONS_DATABASE_URL_FILE",
          )
          .filter((name) => forbiddenEnvironment.test(name)),
      ).toEqual([]);
      expect(networkNames(module.networks)).not.toEqual(
        expect.arrayContaining([
          "tf-data",
          "tf-edge",
          "tf-search-control",
        ]),
      );
    }
  });

  it("uses non-root read-only runtime, dropped capabilities, no-new-privileges, init, bounded tmpfs, and health checks", async () => {
    for (const template of Object.values(templates)) {
      const module = service(template, "tf-integrations");
      const migrate = service(template, "tf-integrations-migrate");
      for (const current of [module, migrate]) {
        expect(current.user).toBe("10001:10001");
        expect(current.read_only).toBe(true);
        expect(current.init).toBe(true);
        expect(current.cap_drop).toEqual(["ALL"]);
        expect(current.security_opt).toEqual(["no-new-privileges:true"]);
        expect(current.tmpfs).toEqual([
          "/tmp:rw,noexec,nosuid,size=16m",
        ]);
        expect(current.pids_limit).toBeGreaterThan(0);
      }
      expect(module.healthcheck).toMatchObject({
        interval: "5s",
        retries: 20,
        timeout: "3s",
      });
      expect(
        service(template, "tf-integrations-postgres").healthcheck,
      ).toMatchObject({
        interval: "5s",
        retries: 20,
        timeout: "5s",
      });
    }

    const [dockerfile, buildScript, startup, roleInit] = await Promise.all([
      readFile(dockerfilePath, "utf8"),
      readFile(buildScriptPath, "utf8"),
      readFile(startupScriptPath, "utf8"),
      readFile(roleInitScriptPath, "utf8"),
    ]);
    expect(dockerfile).toContain("FROM postgres:16-bookworm AS postgres-role-init");
    expect(dockerfile.match(/^FROM node:[^\s]+ AS (?:builder|runtime)$/gm)).toEqual([
      "FROM node:24-bookworm-slim AS builder",
      "FROM node:24-bookworm-slim AS runtime",
    ]);
    expect(dockerfile).not.toContain("node:20");
    expect(buildScript).toContain('target: "node24"');
    expect(dockerfile).toContain("USER 10001:10001");
    expect(dockerfile).toContain("chmod -R a-w /app");
    expect(dockerfile).toContain(
      'ENTRYPOINT ["/app/bin/start-integrations.sh"]',
    );
    expect(startup).toContain("TF_INTEGRATIONS_TOKEN_KEYRING_FILE");
    expect(startup).not.toMatch(/\b(?:echo|printf)\b.*(?:secret|database_url)/i);
    expect(roleInit).toContain("apollo_tf_integrations_migrator");
    expect(roleInit).toContain("apollo_tf_integrations_runtime");
    expect(roleInit).toContain("\\getenv migrator_password");
    expect(roleInit).toContain("\\getenv runtime_password");
    expect(roleInit).not.toContain("--set migrator_password");
  });

  it("keeps migration one-shot and gates readiness on successful migration/database health", () => {
    for (const template of Object.values(templates)) {
      const postgres = service(template, "tf-integrations-postgres");
      const migrate = service(template, "tf-integrations-migrate");
      const module = service(template, "tf-integrations");
      const api = service(template, "api");

      expect(migrate.command).toEqual([
        "node",
        "/app/dist/migrate.mjs",
      ]);
      expect(migrate.restart).toBe("no");
      expect(migrate.depends_on).toEqual({
        "tf-integrations-postgres": { condition: "service_healthy" },
      });
      expect(module.depends_on).toMatchObject({
        "tf-integrations-migrate": {
          condition: "service_completed_successfully",
        },
        "tf-integrations-postgres": { condition: "service_healthy" },
      });
      expect(api.depends_on).toMatchObject({
        "tf-integrations": { condition: "service_healthy" },
      });
      expect(JSON.stringify(module.healthcheck)).toContain(
        "http://127.0.0.1:8080/readyz",
      );
      expect(JSON.stringify(module.healthcheck)).not.toMatch(
        /spotify|yandex|provider/i,
      );
      expect(postgres.ports).toBeUndefined();
    }
  });
});
