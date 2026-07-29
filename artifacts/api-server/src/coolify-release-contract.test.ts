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
const releaseWorkflowPath = join(
  repositoryRoot,
  ".github",
  "workflows",
  "apollo-release-images.yml",
);
const productionDockerfiles = [
  "artifacts/platform-api/Dockerfile",
  "artifacts/api-server/Dockerfile",
  "artifacts/admin-dashboard/Dockerfile",
  "artifacts/music-player/Dockerfile",
  "artifacts/tf-search/Dockerfile",
  "artifacts/tf-integrations/Dockerfile",
  "artifacts/tf-download-worker/Dockerfile",
] as const;

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

  it("pins the complete ingress variable-to-port allocation", async () => {
    const entries = Object.fromEntries(
      (await readFile(releaseEnvironmentPath, "utf8"))
        .split(/\r?\n/)
        .filter((line) => line.includes("="))
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );

    expect({
      PLATFORM_API_PORT: entries.PLATFORM_API_PORT,
      TF_API_PORT: entries.TF_API_PORT,
      TF_WEB_PORT: entries.TF_WEB_PORT,
      TF_ADMIN_PORT: entries.TF_ADMIN_PORT,
    }).toEqual({
      PLATFORM_API_PORT: "18200",
      TF_API_PORT: "18201",
      TF_WEB_PORT: "18202",
      TF_ADMIN_PORT: "18203",
    });
  });

  it("keeps data isolated while sharing only the internal Platform bridge", async () => {
    const [platform, tf] = await Promise.all([
      load(platformPath),
      load(tfPath),
    ]);
    expect(names(platform.compose.networks)).toEqual([
      "platform-bridge",
      "platform-data",
      "platform-edge",
    ]);
    expect(names(tf.compose.networks)).toEqual([
      "platform-bridge",
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
    expect(platform.compose.networks?.["platform-bridge"]).toEqual({
      name: "apollo-platform-bridge-v1",
      internal: true,
    });
    expect(tf.compose.networks?.["platform-bridge"]).toEqual({
      name: "apollo-platform-bridge-v1",
      external: true,
    });
    expect(
      names(platform.compose.networks).filter((name) =>
        names(tf.compose.networks).includes(name),
      ),
    ).toEqual(["platform-bridge"]);
    expect(networkNames(platform.compose.services["platform-api"])).toContain(
      "platform-bridge",
    );
    expect(networkNames(tf.compose.services["tf-api"])).toContain(
      "platform-bridge",
    );
    expect(
      tf.compose.services["tf-api"].environment?.APOLLO_PLATFORM_API_ORIGIN,
    ).toBe("http://platform-api:8080");
    expect(
      tf.compose.services["tf-api"].environment
        ?.APOLLO_TF_BRIDGE_ALLOW_INTERNAL_HTTP,
    ).toBe("true");
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
      for (const [name, definition] of Object.entries(
        value.compose.secrets ?? {},
      )) {
        expect(definition.environment).toBeUndefined();
        expect(definition.file).toMatch(
          name === "admin_access_htpasswd"
            ? /^\$\{TF_ADMIN_CREDENTIAL_DIRECTORY:\?\}\/admin_access_htpasswd$/
            : new RegExp(
                `^\\$\\{${directoryVariable}:\\?\\}/[a-z0-9_]+$`,
              ),
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

  it("uses one derived admin htpasswd and a UID 10001-owned shared dashboard token", async () => {
    const tf = await load(tfPath);
    const admin = tf.compose.services["tf-admin"];

    expect(admin.environment).toMatchObject({
      ADMIN_ACCESS_HTPASSWD_FILE: "/run/secrets/admin_access_htpasswd",
      ADMIN_DASHBOARD_TOKEN_FILE: "/run/secrets/admin_dashboard_token",
    });
    expect(admin.environment).not.toHaveProperty("ADMIN_ACCESS_USER_FILE");
    expect(admin.environment).not.toHaveProperty("ADMIN_ACCESS_PASSWORD_FILE");
    expect(admin.secrets).toEqual([
      {
        source: "admin_dashboard_token",
        target: "admin_dashboard_token",
        uid: "10001",
        gid: "10001",
        mode: "0400",
      },
      {
        source: "admin_access_htpasswd",
        target: "admin_access_htpasswd",
        uid: "0",
        gid: "0",
        mode: "0400",
      },
    ]);
    expect(tf.compose.secrets?.["admin_access_htpasswd"]?.file).toBe(
      "${TF_ADMIN_CREDENTIAL_DIRECTORY:?}/admin_access_htpasswd",
    );
    expect(tf.compose.secrets?.["admin_dashboard_token"]?.file).toBe(
      "${TF_SECRET_DIRECTORY:?}/admin_dashboard_token",
    );
    expect(tf.compose.secrets).not.toHaveProperty("admin_access_user");
    expect(tf.compose.secrets).not.toHaveProperty("admin_access_password");

    const releaseEnvironment = await readFile(releaseEnvironmentPath, "utf8");
    expect(releaseEnvironment).toContain(
      "TF_ADMIN_CREDENTIAL_DIRECTORY=/var/lib/apollo-tf/admin-credentials/replace-with-generation",
    );
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

describe("Apollo immutable image release workflow", () => {
  it("publishes every production target from manual or version-tag releases", async () => {
    const workflow = parse(await readFile(releaseWorkflowPath, "utf8")) as {
      readonly jobs: {
        readonly build: {
          readonly strategy: {
            readonly matrix: {
              readonly include: readonly Record<string, string>[];
            };
          };
        };
      };
      readonly on: {
        readonly push: { readonly tags: readonly string[] };
        readonly workflow_dispatch: unknown;
      };
    };

    expect(Object.keys(workflow.on).sort()).toEqual([
      "push",
      "workflow_dispatch",
    ]);
    expect(workflow.on.push.tags).toEqual(["v*"]);
    expect(workflow.jobs.build.strategy.matrix.include).toEqual([
      {
        dockerfile: "artifacts/platform-api/Dockerfile",
        image: "ghcr.io/altis13/apollo-platform-api",
        name: "platform-api",
        target: "runtime",
      },
      {
        dockerfile: "artifacts/platform-api/Dockerfile",
        image: "ghcr.io/altis13/apollo-platform-postgres",
        name: "platform-postgres",
        target: "postgres-role-init",
      },
      {
        dockerfile: "artifacts/api-server/Dockerfile",
        image: "ghcr.io/altis13/apollo-tf-api",
        name: "tf-api",
        target: "runner",
      },
      {
        dockerfile: "artifacts/api-server/Dockerfile",
        image: "ghcr.io/altis13/apollo-tf-postgres",
        name: "tf-postgres",
        target: "postgres-role-init",
      },
      {
        dockerfile: "artifacts/music-player/Dockerfile",
        image: "ghcr.io/altis13/apollo-tf-web",
        name: "tf-web",
        target: "runner",
      },
      {
        dockerfile: "artifacts/admin-dashboard/Dockerfile",
        image: "ghcr.io/altis13/apollo-tf-admin",
        name: "tf-admin",
        target: "default",
      },
      {
        dockerfile: "artifacts/tf-search/Dockerfile",
        image: "ghcr.io/altis13/apollo-tf-search",
        name: "tf-search",
        target: "runner",
      },
      {
        dockerfile: "artifacts/tf-integrations/Dockerfile",
        image: "ghcr.io/altis13/apollo-tf-integrations",
        name: "tf-integrations",
        target: "runner",
      },
      {
        dockerfile: "artifacts/tf-integrations/Dockerfile",
        image: "ghcr.io/altis13/apollo-tf-integrations-postgres",
        name: "tf-integrations-postgres",
        target: "postgres-role-init",
      },
      {
        dockerfile: "artifacts/tf-download-worker/Dockerfile",
        image: "ghcr.io/altis13/apollo-tf-download-worker",
        name: "tf-download-worker",
        target: "runner",
      },
      {
        dockerfile: "artifacts/tf-download-worker/Dockerfile",
        image: "ghcr.io/altis13/apollo-tf-download-redis",
        name: "tf-download-redis",
        target: "queue-redis",
      },
    ]);
  });

  it("grants exact least privilege per job and requires validation before build", async () => {
    const workflow = parse(await readFile(releaseWorkflowPath, "utf8")) as {
      readonly jobs: Record<
        "build" | "manifest" | "validate",
        {
          readonly needs?: string;
          readonly permissions?: Record<string, string>;
        }
      >;
      readonly permissions?: Record<string, string>;
    };

    expect(workflow.permissions).toBeUndefined();
    expect(workflow.jobs.validate.permissions).toEqual({
      contents: "read",
    });
    expect(workflow.jobs.build.permissions).toEqual({
      contents: "read",
      packages: "write",
    });
    expect(workflow.jobs.manifest.permissions).toEqual({
      packages: "read",
    });
    expect(workflow.jobs.build.needs).toBe("validate");
  });

  it("runs every affected suite and typecheck before any image push", async () => {
    const workflow = parse(await readFile(releaseWorkflowPath, "utf8")) as {
      readonly jobs: {
        readonly build: { readonly needs?: string };
        readonly validate: {
          readonly steps: readonly {
            readonly name?: string;
            readonly run?: string;
          }[];
        };
      };
    };
    const validation = workflow.jobs.validate.steps.find(
      ({ name }) => name === "Validate source",
    );
    expect(
      validation?.run
        ?.trim()
        .split(/\r?\n/)
        .map((line) => line.trim()),
    ).toEqual([
      "pnpm --filter @workspace/scripts test",
      "pnpm --filter @workspace/platform-api exec vitest run --maxWorkers=2",
      "pnpm --filter @workspace/api-server exec vitest run --maxWorkers=1",
      "pnpm --filter @workspace/admin-dashboard exec vitest run --maxWorkers=2",
      "pnpm --filter @workspace/music-player exec vitest run --maxWorkers=2",
      "pnpm --filter @workspace/tf-search exec vitest run --maxWorkers=2",
      "pnpm --filter @workspace/tf-integrations exec vitest run --maxWorkers=2",
      "pnpm --filter @workspace/tf-download-worker exec vitest run --maxWorkers=2",
      "pnpm run typecheck",
    ]);
    expect(workflow.jobs.build.needs).toBe("validate");
  });

  it("uses pinned actions, GITHUB_TOKEN, attestations, digest capture, and one final manifest artifact", async () => {
    const source = await readFile(releaseWorkflowPath, "utf8");
    const workflow = parse(source) as {
      readonly jobs: Record<
        string,
        {
          readonly env?: Record<string, string>;
          readonly steps: readonly {
            readonly id?: string;
            readonly name?: string;
            readonly run?: string;
            readonly uses?: string;
            readonly with?: Record<string, unknown>;
          }[];
        }
      >;
    };
    const steps = Object.values(workflow.jobs).flatMap(({ steps }) => steps);
    const actionUses = steps
      .map(({ uses }) => uses)
      .filter((uses): uses is string => uses !== undefined);

    expect(actionUses.length).toBeGreaterThan(0);
    for (const uses of actionUses) {
      expect(uses).toMatch(/^[^@\s]+@[a-f0-9]{40}$/);
    }
    expect(source).not.toContain("pull_request:");
    expect(source).not.toMatch(/secrets\.(?!GITHUB_TOKEN\b)[A-Z0-9_]+/);
    expect(source).toContain("secrets.GITHUB_TOKEN");

    const buildStep = steps.find(({ uses }) =>
      uses?.startsWith("docker/build-push-action@"),
    );
    expect(buildStep?.with).toMatchObject({
      provenance: "mode=max",
      push: true,
      sbom: true,
    });
    expect(buildStep?.id).toBe("build");
    expect(source).toContain("steps.build.outputs.digest");
    expect(source).toContain("docker buildx imagetools inspect");
    expect(workflow.jobs.build?.env).toEqual({
      DOCKER_BUILD_RECORD_UPLOAD: "false",
    });

    const validationIndex = steps.findIndex(
      ({ name }) => name === "Validate source",
    );
    const pushIndex = steps.findIndex(({ uses }) =>
      uses?.startsWith("docker/build-push-action@"),
    );
    expect(validationIndex).toBeGreaterThanOrEqual(0);
    expect(pushIndex).toBeGreaterThan(validationIndex);

    const uploads = steps.filter(({ uses }) =>
      uses?.startsWith("actions/upload-artifact@"),
    );
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.with).toMatchObject({
      name: "apollo-release-manifest",
      path: "apollo-release-manifest.json",
    });
    const manifestStep = steps.find(
      ({ name }) => name === "Capture immutable digests",
    );
    expect(manifestStep?.run).not.toMatch(
      /(?:password|token|secret|private|database_url|redis_url)"?\s*:/i,
    );
  });

  it("accepts only exact lowercase image digests and bounds GHCR manifest visibility retries", async () => {
    const workflow = parse(await readFile(releaseWorkflowPath, "utf8")) as {
      readonly jobs: Record<
        string,
        {
          readonly steps: readonly {
            readonly name?: string;
            readonly run?: string;
          }[];
        }
      >;
    };
    const steps = Object.values(workflow.jobs).flatMap(({ steps }) => steps);
    const buildDigest = steps.find(
      ({ name }) => name === "Record resulting digest",
    )?.run;
    const manifestDigests = steps.find(
      ({ name }) => name === "Capture immutable digests",
    )?.run;

    expect(buildDigest).toContain('[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]');
    expect(buildDigest).not.toContain('case "$digest"');
    expect(manifestDigests).toContain("for attempt in 1 2 3 4 5; do");
    expect(manifestDigests).toContain(
      "GHCR manifest digest unavailable after 5 attempts",
    );
    expect(manifestDigests).toContain('sleep "$attempt"');
    expect(manifestDigests).toMatch(
      /if \[\[ "\$attempt" == "5" \]\]; then[\s\S]*exit 1[\s\S]*fi/,
    );
  });
});

describe("production Dockerfile base image provenance", () => {
  it.each(productionDockerfiles)(
    "pins every external FROM in %s to a qualified non-placeholder index digest",
    async (relativePath) => {
      const source = await readFile(join(repositoryRoot, relativePath), "utf8");
      const stageNames = new Set<string>();
      const externalImages: string[] = [];

      for (const line of source.split(/\r?\n/)) {
        const match = line.match(
          /^FROM\s+(?<image>\S+)(?:\s+AS\s+(?<stage>[a-z0-9_-]+))?$/i,
        );
        if (match?.groups?.image === undefined) continue;
        const image = match.groups.image;
        if (!stageNames.has(image)) externalImages.push(image);
        if (match.groups.stage !== undefined) {
          stageNames.add(match.groups.stage);
        }
      }

      expect(externalImages.length).toBeGreaterThan(0);
      for (const image of externalImages) {
        expect(image).not.toContain("$");
        expect(image).toMatch(
          /^[a-z0-9.-]+(?::\d+)?\/[a-z0-9._/-]+:[a-z0-9._-]+@sha256:[a-f0-9]{64}$/,
        );
        expect(image).not.toMatch(/@sha256:0{64}$/);
      }
    },
  );
});
