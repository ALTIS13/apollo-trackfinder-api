import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const artifactRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(artifactRoot, "../..");
const rootComposePath = path.join(repositoryRoot, "docker-compose.yml");
const nestedComposePath = path.join(
  repositoryRoot,
  "artifacts/api-server/docker-compose.yml",
);

interface ComposeSecretMount {
  readonly source: string;
  readonly target: string;
  readonly uid: string;
  readonly gid: string;
  readonly mode: string;
}

interface ComposeService {
  readonly build?: {
    readonly context?: string;
    readonly dockerfile?: string;
    readonly target?: string;
  };
  readonly cap_drop?: readonly string[];
  readonly depends_on?: Record<string, { readonly condition?: string }>;
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
  readonly healthcheck?: {
    readonly test?: readonly string[];
    readonly interval?: string;
    readonly timeout?: string;
    readonly retries?: number;
  };
  readonly image?: string;
  readonly init?: boolean;
  readonly networks?:
    | readonly string[]
    | Readonly<Record<string, { readonly gw_priority?: number } | null>>;
  readonly pids_limit?: number;
  readonly ports?: readonly string[];
  readonly read_only?: boolean;
  readonly security_opt?: readonly string[];
  readonly secrets?: readonly (string | ComposeSecretMount)[];
  readonly stop_grace_period?: string;
  readonly tmpfs?: readonly string[];
  readonly user?: string;
  readonly volumes?: readonly string[];
}

interface ComposeTemplate {
  readonly networks?: Record<string, Record<string, unknown> | null>;
  readonly secrets?: Record<string, { readonly file?: string }>;
  readonly services: Record<string, ComposeService>;
  readonly volumes?: Record<string, Record<string, unknown> | null>;
}

async function text(filePath: string): Promise<string> {
  return readFile(filePath, "utf8").catch(() => "");
}

async function composeTemplate(filePath: string): Promise<ComposeTemplate> {
  return parse(await readFile(filePath, "utf8")) as ComposeTemplate;
}

function service(template: ComposeTemplate, name: string): ComposeService {
  const value = template.services[name];
  if (value === undefined) throw new Error(`missing service ${name}`);
  return value;
}

function networkNames(value: ComposeService["networks"]): readonly string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : Object.keys(value);
}

function secretSources(service: ComposeService): readonly string[] {
  return (service.secrets ?? []).map((secret) =>
    typeof secret === "string" ? secret : secret.source,
  );
}

function namedVolumeSource(value: string): string {
  return value.split(":", 1)[0] ?? value;
}

function owners(
  template: ComposeTemplate,
  selector: (service: ComposeService) => readonly string[],
  name: string,
): readonly string[] {
  return Object.entries(template.services)
    .filter(([, value]) => selector(value).includes(name))
    .map(([serviceName]) => serviceName)
    .sort();
}

function withoutBuildContext(service: ComposeService): ComposeService {
  const copy = structuredClone(service);
  if (copy.build === undefined) return copy;
  const { context: _context, ...build } = copy.build;
  return { ...copy, build };
}

describe("TF download worker build and image boundary", () => {
  beforeAll(async () => {
    await execute(process.execPath, [path.join(artifactRoot, "build.mjs")], {
      cwd: repositoryRoot,
      windowsHide: true,
      timeout: 120_000,
    });
    await execute(
      process.execPath,
      [path.join(repositoryRoot, "artifacts/api-server/build.mjs")],
      {
        cwd: repositoryRoot,
        windowsHide: true,
        timeout: 120_000,
      },
    );
  }, 240_000);

  it("builds one production runtime entry without forbidden control or data dependencies", async () => {
    const bundle = await text(path.join(artifactRoot, "dist/index.mjs"));
    const packageJson = JSON.parse(
      await text(path.join(artifactRoot, "package.json")),
    ) as { dependencies?: Record<string, string> };

    expect(bundle.length).toBeGreaterThan(10_000);
    expect(bundle).toContain("apollo-tf-downloads-v1");
    expect(bundle).toContain("/v1/files");
    for (const forbidden of [
      "@workspace/db",
      "tf-integrations-db",
      "provider-account",
      "SESSION_REDIS",
      "CACHE_REDIS",
      "SPOTIFY_CLIENT_SECRET",
      "YANDEX_TOKEN",
      "dockerode",
      "ssh2",
      "coolify",
      "caddy",
    ]) {
      expect(bundle.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect(Object.keys(packageJson.dependencies ?? {})).toEqual([
      "@workspace/module-runtime-contract",
      "@workspace/tf-download-contract",
      "bullmq",
      "ioredis",
    ]);
  });

  it("keeps worker engine and storage out of the API runtime while retaining the signed client", async () => {
    const apiBundle = await text(
      path.join(repositoryRoot, "artifacts/api-server/dist/index.mjs"),
    );
    const apiDockerfile = await text(
      path.join(repositoryRoot, "artifacts/api-server/Dockerfile"),
    );

    expect(apiBundle).toContain("/v1/files");
    expect(apiBundle).toContain("TF_DOWNLOAD_WORKER_ORIGIN");
    expect(apiBundle).not.toContain("class DownloadStorage");
    expect(apiBundle).not.toContain("spawnYtDlpDownload");
    expect(apiBundle).not.toContain("createDownloadProcessor");
    expect(apiDockerfile).toContain("lib/tf-download-contract");
    expect(apiDockerfile).not.toContain("artifacts/tf-download-worker");
  });

  it("defines a pinned least-privilege image with no retained package manager", async () => {
    const dockerfile = await text(path.join(artifactRoot, "Dockerfile"));

    expect(dockerfile).toContain("pnpm@10.33.2");
    expect(dockerfile).toContain("YT_DLP_VERSION=2026.7.4");
    expect(dockerfile).toContain(
      "YT_DLP_SHA256=f11f2b11d5a8ac4059f9bdf29fa4407dc7c6bb00c5097e95ca22a7a9db518266",
    );
    expect(dockerfile).toContain("--require-hashes");
    expect(dockerfile).toContain("ffmpeg");
    expect(dockerfile).toContain("10001:10001");
    expect(dockerfile).toContain("/var/lib/apollo-tf/downloads");
    expect(dockerfile).toMatch(/chown\s+-R\s+10001:10001/);
    expect(dockerfile).toMatch(/chmod\s+0700/);
    expect(dockerfile).toContain("chmod -R a-w /app");
    expect(dockerfile).toMatch(
      /rm -rf[\s\S]*\/usr\/local\/lib\/node_modules\/npm/,
    );
    expect(dockerfile).toMatch(/rm -f[\s\S]*\/usr\/bin\/apt-get/);
    expect(dockerfile).toMatch(/rm -f[\s\S]*\/usr\/local\/bin\/pip/);
    expect(dockerfile).toMatch(/rm -f[\s\S]*\/usr\/bin\/pip/);
    expect(dockerfile).toMatch(/rm -f[\s\S]*\/usr\/local\/bin\/yarn/);
    expect(dockerfile).toContain("test ! -e /usr/bin/apt-get");
    expect(dockerfile).toContain("test ! -e /usr/bin/pip");
    expect(dockerfile).toContain("test ! -e /usr/local/bin/yarn");
    expect(dockerfile).toContain("USER 10001:10001");
  });

  it("starts only after checking file-backed inputs and owned storage without printing values", async () => {
    const script = await text(
      path.join(artifactRoot, "container/start-worker.sh"),
    );

    expect(script).toContain("TF_DOWNLOAD_QUEUE_REDIS_URL_FILE");
    expect(script).toContain("TF_DOWNLOAD_INTERNAL_AUTH_SECRET_FILE");
    expect(script).toContain("TF_DOWNLOAD_HEARTBEAT_SECRET_FILE");
    expect(script).toContain('stat -c "%u:%g"');
    expect(script).toContain("10001:10001");
    expect(script).toContain('exec "$@"');
    expect(script).not.toContain("set -x");
    expect(script).not.toMatch(/cat\s+.*SECRET/);
    expect(script).not.toMatch(/echo\s+.*TF_DOWNLOAD_/);
  });
});

describe("TF download worker Compose and queue Redis contract", () => {
  it("keeps root and nested worker stacks identical except for build context", async () => {
    const [root, nested] = await Promise.all([
      composeTemplate(rootComposePath),
      composeTemplate(nestedComposePath),
    ]);

    for (const serviceName of ["tf-download-redis", "tf-download-worker"]) {
      expect(withoutBuildContext(service(root, serviceName))).toEqual(
        withoutBuildContext(service(nested, serviceName)),
      );
    }
    expect(service(root, "tf-download-redis").build?.context).toBe(".");
    expect(service(root, "tf-download-worker").build?.context).toBe(".");
    expect(service(nested, "tf-download-redis").build?.context).toBe("../..");
    expect(service(nested, "tf-download-worker").build?.context).toBe("../..");
  });

  it.each([
    ["root", rootComposePath],
    ["nested", nestedComposePath],
  ])(
    "assigns exact isolated download networks in %s Compose",
    async (_label, composePath) => {
      const template = await composeTemplate(composePath);
      const api = service(template, "api");
      const queue = service(template, "tf-download-redis");
      const worker = service(template, "tf-download-worker");

      expect(template.networks?.["tf-download-queue"]).toEqual({
        internal: true,
      });
      expect(template.networks?.["tf-download-control"]).toEqual({
        internal: true,
      });
      expect(template.networks?.["tf-download-egress"]).toEqual({});
      expect(
        owners(
          template,
          (candidate) => networkNames(candidate.networks),
          "tf-download-queue",
        ),
      ).toEqual(["api", "tf-download-redis", "tf-download-worker"]);
      expect(
        owners(
          template,
          (candidate) => networkNames(candidate.networks),
          "tf-download-control",
        ),
      ).toEqual(["api", "tf-download-worker"]);
      expect(
        owners(
          template,
          (candidate) => networkNames(candidate.networks),
          "tf-download-egress",
        ),
      ).toEqual(["tf-download-worker"]);
      expect(networkNames(queue.networks)).toEqual(["tf-download-queue"]);
      expect(networkNames(worker.networks)).toEqual([
        "tf-download-queue",
        "tf-download-control",
        "tf-download-egress",
      ]);
      expect(networkNames(api.networks)).toEqual(
        expect.arrayContaining([
          "tf-data",
          "tf-edge",
          "tf-integrations-control",
          "tf-search-control",
          "tf-download-queue",
          "tf-download-control",
        ]),
      );
      expect(networkNames(worker.networks)).not.toEqual(
        expect.arrayContaining([
          "tf-data",
          "tf-edge",
          "tf-integrations-data",
          "tf-integrations-control",
          "tf-search-control",
        ]),
      );
      const workerNetworks = worker.networks as Readonly<
        Record<string, { readonly gw_priority?: number }>
      >;
      expect(workerNetworks["tf-download-egress"]?.gw_priority).toBeGreaterThan(
        workerNetworks["tf-download-queue"]?.gw_priority ?? 0,
      );
      expect(workerNetworks["tf-download-egress"]?.gw_priority).toBeGreaterThan(
        workerNetworks["tf-download-control"]?.gw_priority ?? 0,
      );
    },
  );

  it.each([
    ["root", rootComposePath],
    ["nested", nestedComposePath],
  ])(
    "assigns exact file secrets and owned volumes in %s Compose",
    async (_label, composePath) => {
      const template = await composeTemplate(composePath);
      const api = service(template, "api");
      const queue = service(template, "tf-download-redis");
      const worker = service(template, "tf-download-worker");
      const expectedOwners = {
        tf_download_queue_password: ["tf-download-redis"],
        tf_download_queue_redis_url: ["api", "tf-download-worker"],
        tf_download_internal_auth_secret: ["api", "tf-download-worker"],
        tf_download_heartbeat_secret: ["tf-download-worker"],
      };

      for (const [secretName, expected] of Object.entries(expectedOwners)) {
        expect(template.secrets?.[secretName]?.file).toBe(
          `\${TF_SECRET_DIRECTORY:-/var/lib/apollo-tf/secrets}/${secretName}`,
        );
        expect(owners(template, secretSources, secretName)).toEqual(
          expected.sort(),
        );
      }
      expect(secretSources(api)).toContain("tf_module_heartbeat_keys");
      expect(secretSources(api)).not.toContain("tf_download_heartbeat_secret");
      expect(secretSources(queue)).toEqual(["tf_download_queue_password"]);
      expect(secretSources(worker)).toEqual([
        "tf_download_queue_redis_url",
        "tf_download_internal_auth_secret",
        "tf_download_heartbeat_secret",
      ]);
      expect(queue.secrets).toEqual([
        {
          source: "tf_download_queue_password",
          target: "tf_download_queue_password",
          uid: "999",
          gid: "999",
          mode: "0400",
        },
      ]);
      expect(worker.secrets).toEqual([
        {
          source: "tf_download_queue_redis_url",
          target: "tf_download_queue_redis_url",
          uid: "10001",
          gid: "10001",
          mode: "0400",
        },
        {
          source: "tf_download_internal_auth_secret",
          target: "tf_download_internal_auth_secret",
          uid: "10001",
          gid: "10001",
          mode: "0400",
        },
        {
          source: "tf_download_heartbeat_secret",
          target: "tf_download_heartbeat_secret",
          uid: "10001",
          gid: "10001",
          mode: "0400",
        },
      ]);
      expect(Object.keys(template.volumes ?? {})).toEqual(
        expect.arrayContaining([
          "tf-download-worker-data",
          "tf-download-redis-data",
        ]),
      );
      expect(
        owners(
          template,
          (candidate) => (candidate.volumes ?? []).map(namedVolumeSource),
          "tf-download-worker-data",
        ),
      ).toEqual(["tf-download-worker"]);
      expect(
        owners(
          template,
          (candidate) => (candidate.volumes ?? []).map(namedVolumeSource),
          "tf-download-redis-data",
        ),
      ).toEqual(["tf-download-redis"]);
      expect(worker.volumes).toEqual([
        "tf-download-worker-data:/var/lib/apollo-tf/downloads",
      ]);
      expect(queue.volumes).toEqual(["tf-download-redis-data:/data"]);
    },
  );

  it.each([
    ["root", rootComposePath],
    ["nested", nestedComposePath],
  ])(
    "uses private same-node API, queue, worker, and heartbeat paths in %s Compose",
    async (_label, composePath) => {
      const template = await composeTemplate(composePath);
      const api = service(template, "api");
      const queue = service(template, "tf-download-redis");
      const worker = service(template, "tf-download-worker");

      expect(api.environment).toMatchObject({
        TF_DOWNLOAD_QUEUE_REDIS_URL_FILE:
          "/run/secrets/tf_download_queue_redis_url",
        TF_DOWNLOAD_QUEUE_ALLOW_INSECURE_REDIS: "true",
        TF_DOWNLOAD_WORKER_INTERNAL_AUTH_SECRET_FILE:
          "/run/secrets/tf_download_internal_auth_secret",
        TF_DOWNLOAD_WORKER_ORIGIN: "http://tf-download-worker:8080",
        TF_DOWNLOAD_WORKER_ALLOW_INSECURE_HTTP: "true",
      });
      expect(worker.environment).toMatchObject({
        NODE_ENV: "production",
        PORT: "8080",
        TF_DOWNLOAD_QUEUE_REDIS_URL_FILE:
          "/run/secrets/tf_download_queue_redis_url",
        TF_DOWNLOAD_QUEUE_ALLOW_INSECURE_REDIS: "true",
        TF_DOWNLOAD_INTERNAL_AUTH_SECRET_FILE:
          "/run/secrets/tf_download_internal_auth_secret",
        TF_DOWNLOAD_HEARTBEAT_SECRET_FILE:
          "/run/secrets/tf_download_heartbeat_secret",
        TF_DOWNLOAD_HEARTBEAT_API_ORIGIN: "http://api:8080",
        TF_DOWNLOAD_HEARTBEAT_ALLOW_INSECURE_HTTP: "true",
        TF_DOWNLOAD_STORAGE_ROOT: "/var/lib/apollo-tf/downloads",
      });
      expect(queue.environment).toEqual({
        TF_DOWNLOAD_QUEUE_PASSWORD_FILE:
          "/run/secrets/tf_download_queue_password",
      });
      expect(api.depends_on).toMatchObject({
        "tf-download-redis": { condition: "service_healthy" },
        "tf-download-worker": { condition: "service_healthy" },
      });
      expect(worker.depends_on).toEqual({
        "tf-download-redis": { condition: "service_healthy" },
      });
      expect(api.tmpfs).not.toContain(
        "/tmp/tf-downloads:rw,noexec,nosuid,size=256m",
      );
      for (const candidate of [api, queue, worker]) {
        expect(JSON.stringify(candidate.environment ?? {})).not.toMatch(
          /redis:\/\/[^"]+@/,
        );
      }
      expect(queue.ports).toBeUndefined();
      expect(worker.ports).toBeUndefined();
    },
  );

  it.each([
    ["root", rootComposePath],
    ["nested", nestedComposePath],
  ])(
    "hardens and bounds the %s queue and single worker",
    async (_label, composePath) => {
      const template = await composeTemplate(composePath);
      const queue = service(template, "tf-download-redis");
      const worker = service(template, "tf-download-worker");

      expect(worker.user).toBe("10001:10001");
      expect(worker.read_only).toBe(true);
      expect(worker.init).toBe(true);
      expect(worker.cap_drop).toEqual(["ALL"]);
      expect(worker.security_opt).toEqual(["no-new-privileges:true"]);
      expect(worker.tmpfs).toEqual(["/tmp:rw,noexec,nosuid,size=64m"]);
      expect(worker.stop_grace_period).toBe("45s");
      expect(worker.pids_limit).toBe(256);
      expect(worker.deploy).toEqual({
        replicas: 1,
        resources: {
          limits: { cpus: "2.0", memory: "1G", pids: 256 },
          reservations: { cpus: "0.5", memory: "256M" },
        },
      });
      expect(worker.healthcheck).toMatchObject({
        interval: "5s",
        timeout: "3s",
        retries: 20,
      });
      expect(worker.healthcheck?.test).toEqual([
        "CMD",
        "node",
        "-e",
        expect.stringContaining("http://127.0.0.1:8080/readyz"),
      ]);

      expect(queue.image).toBe(
        "${TF_DOWNLOAD_REDIS_IMAGE:-apollo-tf-download-redis:local}",
      );
      expect(queue.build).toMatchObject({
        dockerfile: "artifacts/tf-download-worker/Dockerfile",
        target: "queue-redis",
      });
      expect(queue.user).toBe("999:999");
      expect(queue.read_only).toBe(true);
      expect(queue.init).toBe(true);
      expect(queue.cap_drop).toEqual(["ALL"]);
      expect(queue.security_opt).toEqual(["no-new-privileges:true"]);
      expect(queue.tmpfs).toEqual(["/tmp:rw,noexec,nosuid,size=16m"]);
      expect(queue.stop_grace_period).toBe("20s");
      expect(queue.pids_limit).toBe(128);
      expect(queue.deploy).toEqual({
        resources: {
          limits: { cpus: "0.5", memory: "256M", pids: 128 },
          reservations: { cpus: "0.1", memory: "64M" },
        },
      });
      expect(queue.healthcheck).toEqual({
        test: ["CMD", "/usr/local/bin/queue-redis-health.sh"],
        interval: "5s",
        timeout: "3s",
        retries: 20,
        start_period: "5s",
      });
    },
  );

  it.each([
    ["root", rootComposePath],
    ["nested", nestedComposePath],
  ])(
    "keeps forbidden hosts, mounts, credentials, and control planes out of %s worker",
    async (_label, composePath) => {
      const worker = service(
        await composeTemplate(composePath),
        "tf-download-worker",
      );
      const serialized = JSON.stringify(worker);
      const forbidden =
        /DOCKER|COOLIFY|CADDY|UFW|SSH|DATABASE|POSTGRES|PLATFORM|SPOTIFY|YANDEX|PROVIDER_ACCOUNT/i;

      expect(
        Object.keys(worker.environment ?? {}).filter((name) =>
          forbidden.test(name),
        ),
      ).toEqual([]);
      expect(serialized).not.toContain("/var/run/docker.sock");
      expect(serialized).not.toContain("/home/");
      expect(worker.volumes).toEqual([
        "tf-download-worker-data:/var/lib/apollo-tf/downloads",
      ]);
      expect(secretSources(worker)).not.toEqual(
        expect.arrayContaining([
          "tf_client_secret",
          "tf_database_url",
          "tf_postgres_password",
          "tf_module_heartbeat_keys",
          "tf_integrations_runtime_database_url",
          "tf_integrations_token_keyring",
        ]),
      );
    },
  );

  it("builds an authenticated append-only Redis target with secret-safe probes", async () => {
    const [dockerfile, startup, health] = await Promise.all([
      text(path.join(artifactRoot, "Dockerfile")),
      text(path.join(artifactRoot, "container/start-queue-redis.sh")),
      text(path.join(artifactRoot, "container/queue-redis-health.sh")),
    ]);

    expect(dockerfile).toContain("FROM redis:7-bookworm AS queue-redis");
    expect(dockerfile).toContain(
      "COPY artifacts/tf-download-worker/container/start-queue-redis.sh /usr/local/bin/start-queue-redis.sh",
    );
    expect(dockerfile).toContain(
      "COPY artifacts/tf-download-worker/container/queue-redis-health.sh /usr/local/bin/queue-redis-health.sh",
    );
    expect(startup).toContain("TF_DOWNLOAD_QUEUE_PASSWORD_FILE");
    expect(startup).toContain("appendonly yes");
    expect(startup).toContain("requirepass");
    expect(startup).toContain('exec redis-server "$config_file"');
    expect(health).toContain("TF_DOWNLOAD_QUEUE_PASSWORD_FILE");
    expect(health).toContain("REDISCLI_AUTH");
    expect(health).toContain("timeout 3 redis-cli");
    for (const script of [startup, health]) {
      expect(script).not.toContain("set -x");
      expect(script).not.toMatch(/echo\s+.*password/i);
      expect(script).not.toMatch(/redis-cli\s+.*-a\s+/);
    }
  });
});
