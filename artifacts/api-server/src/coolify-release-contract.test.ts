import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const releaseDirectory = join(repositoryRoot, "deploy", "coolify");
const platformPath = join(releaseDirectory, "apollo-platform.compose.yml");
const tfPath = join(releaseDirectory, "apollo-tf.compose.yml");
const releaseEnvironmentPath = join(releaseDirectory, "release.env.example");

type SecretMount = {
  readonly gid?: string;
  readonly mode?: string;
  readonly source?: string;
  readonly target?: string;
  readonly uid?: string;
};

type Service = {
  readonly build?: unknown;
  readonly command?: readonly string[];
  readonly container_name?: string;
  readonly depends_on?: Record<string, { readonly condition?: string }>;
  readonly deploy?: {
    readonly resources?: {
      readonly limits?: {
        readonly cpus?: string;
        readonly memory?: string;
        readonly pids?: number;
      };
    };
  };
  readonly environment?: Record<string, string>;
  readonly healthcheck?: Record<string, unknown>;
  readonly image?: string;
  readonly init?: boolean;
  readonly labels?: Record<string, string> | readonly string[];
  readonly logging?: {
    readonly driver?: string;
    readonly options?: Record<string, string>;
  };
  readonly network_mode?: string;
  readonly networks?: readonly string[] | Record<string, unknown>;
  readonly pids_limit?: number;
  readonly ports?: readonly string[];
  readonly privileged?: boolean;
  readonly profiles?: readonly string[];
  readonly restart?: string;
  readonly secrets?: readonly SecretMount[];
  readonly stop_grace_period?: string;
  readonly volumes?: readonly string[];
};

type Compose = {
  readonly networks?: Record<
    string,
    { readonly internal?: boolean; readonly name?: string }
  >;
  readonly secrets?: Record<
    string,
    { readonly environment?: string; readonly file?: string }
  >;
  readonly services: Record<string, Service>;
  readonly volumes?: Record<string, { readonly name?: string }>;
};

const platformServices = [
  "platform-api",
  "platform-migrate",
  "platform-postgres",
  "platform-redis",
] as const;
const tfServices = [
  "tf-admin",
  "tf-api",
  "tf-baseline",
  "tf-download-redis",
  "tf-download-worker",
  "tf-integrations",
  "tf-integrations-migrate",
  "tf-integrations-postgres",
  "tf-migrate",
  "tf-postgres",
  "tf-redis",
  "tf-role-bootstrap",
  "tf-search",
  "tf-web",
] as const;
const platformLongRunning = [
  "platform-api",
  "platform-postgres",
  "platform-redis",
] as const;
const platformJobs = ["platform-migrate"] as const;
const tfLongRunning = [
  "tf-admin",
  "tf-api",
  "tf-download-redis",
  "tf-download-worker",
  "tf-integrations",
  "tf-integrations-postgres",
  "tf-postgres",
  "tf-redis",
  "tf-search",
  "tf-web",
] as const;
const tfJobs = [
  "tf-baseline",
  "tf-integrations-migrate",
  "tf-migrate",
  "tf-role-bootstrap",
] as const;

async function load(path: string): Promise<{
  readonly compose: Compose;
  readonly source: string;
}> {
  const source = await readFile(path, "utf8");
  return { compose: parse(source, { merge: true }) as Compose, source };
}

function names(value: Record<string, unknown> | undefined): readonly string[] {
  return Object.keys(value ?? {}).sort();
}

function networkNames(service: Service): readonly string[] {
  if (Array.isArray(service.networks)) return [...service.networks];
  return Object.keys(service.networks ?? {});
}

function expectBoundedRuntime(service: Service): void {
  expect(service.init).toBe(true);
  expect(service.stop_grace_period).toMatch(/^\d+s$/);
  expect(service.pids_limit).toBeGreaterThan(0);
  expect(service.deploy?.resources?.limits).toMatchObject({
    cpus: expect.stringMatching(/^\d+(?:\.\d+)?$/),
    memory: expect.stringMatching(/^\d+(?:M|G)$/),
    pids: expect.any(Number),
  });
  expect(service.logging).toEqual({
    driver: "json-file",
    options: { "max-file": "5", "max-size": "10m" },
  });
}

function expectNoUnsafeHostAccess(service: Service): void {
  expect(service.build).toBeUndefined();
  expect(service.container_name).toBeUndefined();
  expect(service.network_mode).not.toBe("host");
  expect(service.privileged).not.toBe(true);
  for (const volume of service.volumes ?? []) {
    expect(volume).not.toMatch(/(?:^|:)\/(?:$|:)/);
    expect(volume).not.toContain("/var/run/docker.sock");
  }
  expect(JSON.stringify(service.labels ?? {})).not.toMatch(
    /(?:coolify|traefik|caddy|nginx)\./i,
  );
}

describe("Coolify production release manifests", () => {
  it("contains only the two manifests and the non-secret environment example", async () => {
    expect((await readdir(releaseDirectory)).sort()).toEqual([
      "apollo-platform.compose.yml",
      "apollo-tf.compose.yml",
      "release.env.example",
    ]);
  });

  it("defines the exact Platform and TF service sets", async () => {
    const [platform, tf] = await Promise.all([
      load(platformPath),
      load(tfPath),
    ]);
    expect(names(platform.compose.services)).toEqual(platformServices);
    expect(names(tf.compose.services)).toEqual(tfServices);
  });

  it("uses required immutable images and rejects unsafe host integration", async () => {
    for (const { compose } of await Promise.all([
      load(platformPath),
      load(tfPath),
    ])) {
      for (const service of Object.values(compose.services)) {
        expect(service.image).toMatch(/^\$\{[A-Z][A-Z0-9_]+:\?\}$/);
        expectNoUnsafeHostAccess(service);
      }
    }
  });

  it("publishes only the four loopback endpoints through required variables", async () => {
    const [platform, tf] = await Promise.all([
      load(platformPath),
      load(tfPath),
    ]);
    expect(platform.compose.services["platform-api"].ports).toEqual([
      "127.0.0.1:${PLATFORM_API_PORT:?}:8080",
    ]);
    expect(tf.compose.services["tf-api"].ports).toEqual([
      "127.0.0.1:${TF_API_PORT:?}:8080",
    ]);
    expect(tf.compose.services["tf-web"].ports).toEqual([
      "127.0.0.1:${TF_WEB_PORT:?}:80",
    ]);
    expect(tf.compose.services["tf-admin"].ports).toEqual([
      "127.0.0.1:${TF_ADMIN_PORT:?}:80",
    ]);

    const published = [
      ...Object.entries(platform.compose.services),
      ...Object.entries(tf.compose.services),
    ]
      .filter(([, service]) => service.ports !== undefined)
      .map(([name]) => name)
      .sort();
    expect(published).toEqual(["platform-api", "tf-admin", "tf-api", "tf-web"]);
  });

  it("keeps the stacks and their database networks isolated", async () => {
    const [platform, tf] = await Promise.all([
      load(platformPath),
      load(tfPath),
    ]);
    expect(names(platform.compose.networks)).toEqual([
      "platform-data",
      "platform-edge",
    ]);
    expect(names(tf.compose.networks)).toEqual([
      "tf-data",
      "tf-download-control",
      "tf-download-egress",
      "tf-download-queue",
      "tf-edge",
      "tf-integrations-control",
      "tf-integrations-data",
      "tf-integrations-egress",
      "tf-search-control",
      "tf-search-egress",
    ]);
    expect(platform.compose.networks?.["platform-data"]?.internal).toBe(true);
    expect(tf.compose.networks?.["tf-data"]?.internal).toBe(true);
    expect(
      new Set([
        ...names(platform.compose.networks),
        ...names(tf.compose.networks),
      ]).size,
    ).toBe(
      names(platform.compose.networks).length +
        names(tf.compose.networks).length,
    );
    for (const service of Object.values(platform.compose.services)) {
      expect(networkNames(service)).not.toContain("tf-data");
    }
    for (const service of Object.values(tf.compose.services)) {
      expect(networkNames(service)).not.toContain("platform-data");
    }
  });

  it("preserves manual baseline and migration readiness ordering", async () => {
    const [platform, tf] = await Promise.all([
      load(platformPath),
      load(tfPath),
    ]);
    expect(tf.compose.services["tf-role-bootstrap"].profiles).toEqual([
      "baseline",
    ]);
    expect(tf.compose.services["tf-baseline"].profiles).toEqual(["baseline"]);
    for (const [name, service] of Object.entries(tf.compose.services)) {
      if (name !== "tf-role-bootstrap" && name !== "tf-baseline") {
        expect(service.profiles).toBeUndefined();
      }
    }
    expect(
      platform.compose.services["platform-api"].depends_on?.["platform-migrate"]
        ?.condition,
    ).toBe("service_completed_successfully");
    expect(
      tf.compose.services["tf-api"].depends_on?.["tf-migrate"]?.condition,
    ).toBe("service_completed_successfully");
    expect(
      tf.compose.services["tf-integrations"].depends_on?.[
        "tf-integrations-migrate"
      ]?.condition,
    ).toBe("service_completed_successfully");
    expect(
      tf.compose.services["tf-baseline"].depends_on?.["tf-role-bootstrap"]
        ?.condition,
    ).toBe("service_completed_successfully");
  });

  it("uses only owning-directory file secrets and explicit mount metadata", async () => {
    const manifests = [
      {
        directoryVariable: "PLATFORM_SECRET_DIRECTORY",
        value: await load(platformPath),
      },
      {
        directoryVariable: "TF_SECRET_DIRECTORY",
        value: await load(tfPath),
      },
    ] as const;
    const secretEnvironment =
      /(?:PASSWORD|SECRET|TOKEN|KEYRING|PRIVATE_JWK|OAUTH_CLIENTS|DATABASE_URL)$/;

    for (const { directoryVariable, value } of manifests) {
      for (const definition of Object.values(value.compose.secrets ?? {})) {
        expect(definition.environment).toBeUndefined();
        expect(definition.file).toMatch(
          new RegExp(`^\\$\\{${directoryVariable}:\\?\\}/[a-z0-9_]+$`),
        );
      }
      for (const service of Object.values(value.compose.services)) {
        for (const [key] of Object.entries(service.environment ?? {})) {
          if (secretEnvironment.test(key)) {
            expect(key).toMatch(/_FILE$/);
          }
        }
        for (const mount of service.secrets ?? []) {
          expect(mount).toMatchObject({
            gid: expect.stringMatching(/^\d+$/),
            mode: expect.stringMatching(/^04[04]0$/),
            source: expect.stringMatching(/^[a-z0-9_]+$/),
            target: expect.stringMatching(/^[a-z0-9_]+$/),
            uid: expect.stringMatching(/^\d+$/),
          });
          expect(value.compose.secrets?.[mount.source ?? ""]).toBeDefined();
        }
      }
    }
  });

  it("pins stable retained volume identities", async () => {
    const [platform, tf] = await Promise.all([
      load(platformPath),
      load(tfPath),
    ]);
    expect(
      Object.values(platform.compose.volumes ?? {})
        .map((volume) => volume.name)
        .sort(),
    ).toEqual(["apollo-platform-postgres-v1", "apollo-platform-redis-v1"]);
    expect(
      Object.values(tf.compose.volumes ?? {})
        .map((volume) => volume.name)
        .sort(),
    ).toEqual([
      "apollo-tf-download-redis-v1",
      "apollo-tf-downloads-v1",
      "apollo-tf-integrations-postgres-v1",
      "apollo-tf-postgres-v1",
      "apollo-tf-redis-v1",
    ]);
  });

  it("applies health, restart, resource, and bounded log policies", async () => {
    const [platform, tf] = await Promise.all([
      load(platformPath),
      load(tfPath),
    ]);
    for (const name of platformLongRunning) {
      const service = platform.compose.services[name];
      expect(service.healthcheck).toBeDefined();
      expect(service.restart).toBe("unless-stopped");
      expectBoundedRuntime(service);
    }
    for (const name of tfLongRunning) {
      const service = tf.compose.services[name];
      expect(service.healthcheck).toBeDefined();
      expect(service.restart).toBe("unless-stopped");
      expectBoundedRuntime(service);
    }
    for (const name of platformJobs) {
      const service = platform.compose.services[name];
      expect(service.restart).toBe("no");
      expectBoundedRuntime(service);
    }
    for (const name of tfJobs) {
      const service = tf.compose.services[name];
      expect(service.restart).toBe("no");
      expectBoundedRuntime(service);
    }
  });

  it("keeps the release environment example non-secret and digest-pinned", async () => {
    const source = await readFile(releaseEnvironmentPath, "utf8");
    expect(source).not.toMatch(
      /(?:PASSWORD|SECRET|TOKEN|KEYRING|PRIVATE_JWK|DATABASE_URL)=/i,
    );
    const imageLines = source
      .split(/\r?\n/)
      .filter((line) => /^[A-Z0-9_]+_IMAGE=/.test(line));
    expect(imageLines.length).toBeGreaterThan(0);
    for (const line of imageLines) {
      expect(line).toMatch(/@sha256:0{64}$/);
    }
  });
});
