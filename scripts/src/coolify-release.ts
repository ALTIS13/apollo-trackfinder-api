import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ComposePort = {
  host_ip?: string;
  mode?: string;
  protocol?: string;
  published?: number | string;
  target?: number;
};

export type ComposeSecretMount = {
  source?: string;
  target?: string;
  uid?: string;
  gid?: string;
  mode?: string;
};

export type ComposeVolumeMount =
  | string
  | {
      source?: string;
      target?: string;
      type?: string;
      volume?: Record<string, unknown>;
    };

export type ComposeService = {
  build?: unknown;
  deploy?: {
    resources?: {
      limits?: {
        cpus?: number | string;
        memory?: number | string;
        pids?: number;
      };
    };
  };
  environment?: Record<string, string>;
  healthcheck?: Record<string, unknown>;
  image?: string;
  init?: boolean;
  labels?: Record<string, string> | string[];
  logging?: {
    driver?: string;
    options?: Record<string, string>;
  };
  networks?: Record<string, unknown> | string[];
  pids_limit?: number;
  ports?: ComposePort[];
  restart?: string;
  secrets?: ComposeSecretMount[];
  stop_grace_period?: string;
  volumes?: ComposeVolumeMount[];
};

export type ComposeDocument = {
  name?: string;
  networks?: Record<string, { internal?: boolean; name?: string }>;
  secrets?: Record<string, { file?: string }>;
  services: Record<string, ComposeService>;
  volumes?: Record<string, { name?: string }>;
};

export type ReleaseStackInput = {
  name: "apollo-platform" | "apollo-tf";
  compose: ComposeDocument;
};

export type ReleaseValidationInput = {
  environment: Record<string, string>;
  stacks: ReleaseStackInput[];
};

export type ReleaseValidationError = {
  code: string;
  field?: string;
  service?: string;
  stack?: string;
};

export type ReleaseManifestService = {
  imageDigest: string;
  name: string;
  ports: number[];
};

export type ReleaseManifestStack = {
  name: string;
  publicOrigins: string[];
  services: ReleaseManifestService[];
  volumes: string[];
};

export type ReleaseValidationResult =
  | { ok: true; stacks: ReleaseManifestStack[] }
  | { ok: false; errors: ReleaseValidationError[] };

const digestPattern = /@(?<digest>sha256:[a-f0-9]{64})$/;
const zeroDigest = `sha256:${"0".repeat(64)}`;
const secretLikeName =
  /(?:PASSWORD|TOKEN|SECRET|PRIVATE|DATABASE_URL|REDIS_URL)/i;
const allowedReleaseSecretLikeNames = new Set([
  "PLATFORM_SECRET_DIRECTORY",
  "TF_SECRET_DIRECTORY",
]);
const allowedPlainRedisUrlNames = new Set([
  "APOLLO_REDIS_URL",
  "APOLLO_TF_AUTH_REDIS_URL",
  "REDIS_URL",
]);
const allowedSensitiveLookingControls: Readonly<Record<string, string>> = {
  APOLLO_DEVELOPMENT_TOKEN_ECHO: "false",
};
const sensitiveEnvironmentAllowlist: Readonly<Record<string, Set<string>>> = {
  "platform-api": new Set([
    "APOLLO_ASSERTION_PRIVATE_JWK_FILE",
    "APOLLO_DEVELOPMENT_TOKEN_ECHO",
    "APOLLO_OPERATOR_BOOTSTRAP_TOKEN_FILE",
    "APOLLO_REDIS_URL",
    "DATABASE_URL_FILE",
  ]),
  "platform-migrate": new Set(["MIGRATOR_DATABASE_URL_FILE"]),
  "platform-postgres": new Set(["POSTGRES_PASSWORD_FILE"]),
  "tf-admin": new Set([
    "ADMIN_ACCESS_PASSWORD_FILE",
    "ADMIN_DASHBOARD_TOKEN_FILE",
  ]),
  "tf-api": new Set([
    "ADMIN_DASHBOARD_TOKEN_FILE",
    "APOLLO_TF_AUTH_REDIS_URL",
    "APOLLO_TF_CLIENT_SECRET_FILE",
    "DATABASE_URL_FILE",
    "REDIS_URL",
    "TF_DOWNLOAD_QUEUE_REDIS_URL_FILE",
    "TF_DOWNLOAD_WORKER_INTERNAL_AUTH_SECRET_FILE",
    "TF_INTEGRATIONS_INTERNAL_AUTH_SECRET_FILE",
    "TF_SEARCH_INTERNAL_AUTH_SECRET_FILE",
  ]),
  "tf-baseline": new Set(["TF_BASELINE_DATABASE_URL_FILE"]),
  "tf-download-redis": new Set(["TF_DOWNLOAD_QUEUE_PASSWORD_FILE"]),
  "tf-download-worker": new Set([
    "TF_DOWNLOAD_HEARTBEAT_SECRET_FILE",
    "TF_DOWNLOAD_INTERNAL_AUTH_SECRET_FILE",
    "TF_DOWNLOAD_QUEUE_REDIS_URL_FILE",
  ]),
  "tf-integrations": new Set([
    "TF_INTEGRATIONS_DATABASE_URL_FILE",
    "TF_INTEGRATIONS_HEARTBEAT_SECRET_FILE",
    "TF_INTEGRATIONS_INTERNAL_AUTH_SECRET_FILE",
    "TF_INTEGRATIONS_SPOTIFY_CLIENT_SECRET_FILE",
    "TF_INTEGRATIONS_TOKEN_KEYRING_FILE",
  ]),
  "tf-integrations-migrate": new Set(["TF_INTEGRATIONS_DATABASE_URL_FILE"]),
  "tf-integrations-postgres": new Set(["POSTGRES_PASSWORD_FILE"]),
  "tf-migrate": new Set(["TF_MIGRATOR_DATABASE_URL_FILE"]),
  "tf-postgres": new Set(["POSTGRES_PASSWORD_FILE"]),
  "tf-role-bootstrap": new Set(["TF_ROLE_BOOTSTRAP_DATABASE_URL_FILE"]),
  "tf-search": new Set([
    "TF_SEARCH_HEARTBEAT_SECRET_FILE",
    "TF_SEARCH_INTERNAL_AUTH_SECRET_FILE",
  ]),
};
const expectedPorts: Readonly<
  Record<string, { published: number; target: number }>
> = {
  "platform-api": { published: 18200, target: 8080 },
  "tf-api": { published: 18201, target: 8080 },
  "tf-web": { published: 18202, target: 80 },
  "tf-admin": { published: 18203, target: 80 },
};
const originKeys: Readonly<Record<ReleaseStackInput["name"], string[]>> = {
  "apollo-platform": ["PLATFORM_PUBLIC_ORIGIN"],
  "apollo-tf": [
    "TF_ADMIN_PUBLIC_ORIGIN",
    "TF_API_PUBLIC_ORIGIN",
    "TF_PUBLIC_ORIGIN",
  ],
};

function addError(
  errors: ReleaseValidationError[],
  code: string,
  context: Omit<ReleaseValidationError, "code"> = {},
): void {
  errors.push({ code, ...context });
}

function sortErrors(
  errors: ReleaseValidationError[],
): ReleaseValidationError[] {
  const unique = new Map<string, ReleaseValidationError>();
  for (const error of errors) {
    unique.set(JSON.stringify(error), error);
  }
  return [...unique.values()].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
}

function networkKeys(service: ComposeService): string[] {
  if (Array.isArray(service.networks)) return [...service.networks];
  return Object.keys(service.networks ?? {});
}

function expectedSecretMetadata(
  serviceName: string,
  source: string,
): { uid: string; gid: string; mode: string } {
  if (serviceName === "tf-admin") {
    return { uid: "0", gid: "0", mode: "0400" };
  }
  if (
    (serviceName === "tf-role-bootstrap" || serviceName === "tf-baseline") &&
    source === "tf_admin_database_url"
  ) {
    return { uid: "0", gid: "10002", mode: "0440" };
  }
  if (
    serviceName.endsWith("postgres") ||
    serviceName === "tf-role-bootstrap" ||
    serviceName === "tf-download-redis"
  ) {
    return { uid: "999", gid: "999", mode: "0400" };
  }
  return { uid: "10001", gid: "10001", mode: "0400" };
}

function validateImage(
  image: string | undefined,
  errors: ReleaseValidationError[],
  context: Omit<ReleaseValidationError, "code">,
): string | undefined {
  if (image === undefined || image.length === 0) {
    addError(errors, "missing_image", context);
    return undefined;
  }
  if (image.includes("${") || image.includes(":-")) {
    addError(errors, "image_default", context);
    return undefined;
  }
  const match = image.match(digestPattern);
  if (
    match?.groups?.digest === undefined ||
    (!image.includes("/") && !image.startsWith("redis@"))
  ) {
    addError(errors, "mutable_image", context);
    return undefined;
  }
  if (match.groups.digest === zeroDigest) {
    addError(errors, "placeholder_image_digest", context);
    return undefined;
  }
  return match.groups.digest;
}

function validatePolicies(
  service: ComposeService,
  errors: ReleaseValidationError[],
  context: Omit<ReleaseValidationError, "code">,
): void {
  const limits = service.deploy?.resources?.limits;
  if (
    limits?.cpus === undefined ||
    limits.memory === undefined ||
    limits.pids === undefined ||
    service.pids_limit === undefined ||
    service.init !== true ||
    !/^\d+s$/.test(service.stop_grace_period ?? "")
  ) {
    addError(errors, "missing_resource_policy", context);
  }
  if (
    service.logging?.driver !== "json-file" ||
    service.logging.options?.["max-file"] !== "5" ||
    service.logging.options?.["max-size"] !== "10m"
  ) {
    addError(errors, "missing_log_policy", context);
  }
  if (
    service.restart !== "no" &&
    (service.restart !== "unless-stopped" || service.healthcheck === undefined)
  ) {
    addError(errors, "missing_health_policy", context);
  }
}

function validateEnvironment(
  serviceName: string,
  service: ComposeService,
  mountedTargets: Set<string>,
  errors: ReleaseValidationError[],
  context: Omit<ReleaseValidationError, "code">,
): void {
  for (const [name, value] of Object.entries(service.environment ?? {})) {
    if (!secretLikeName.test(name)) continue;
    if (!sensitiveEnvironmentAllowlist[serviceName]?.has(name)) {
      addError(errors, "secret_environment", {
        ...context,
        field: "environment",
      });
      continue;
    }
    if (allowedSensitiveLookingControls[name] === value) continue;
    if (
      allowedPlainRedisUrlNames.has(name) &&
      /^redis:\/\/[a-z0-9-]+:\d+(?:\/\d+)?$/i.test(value)
    ) {
      continue;
    }
    if (name.endsWith("_FILE")) {
      const target = value.match(/^\/run\/secrets\/([a-z0-9_]+)$/)?.[1];
      if (target !== undefined && mountedTargets.has(target)) continue;
    }
    addError(errors, "secret_environment", {
      ...context,
      field: "environment",
    });
  }
}

function validateSecrets(
  serviceName: string,
  service: ComposeService,
  document: ComposeDocument,
  errors: ReleaseValidationError[],
  context: Omit<ReleaseValidationError, "code">,
): Set<string> {
  const targets = new Set<string>();
  for (const mount of service.secrets ?? []) {
    const source = mount.source ?? "";
    const target = mount.target ?? "";
    const expected = expectedSecretMetadata(serviceName, source);
    if (
      source.length === 0 ||
      target !== source ||
      document.secrets?.[source] === undefined ||
      mount.uid !== expected.uid ||
      mount.gid !== expected.gid ||
      mount.mode !== expected.mode
    ) {
      addError(errors, "secret_mount_metadata", {
        ...context,
        field: "secrets",
      });
    }
    if (target.length > 0) targets.add(target);
  }
  return targets;
}

function validatePorts(
  serviceName: string,
  service: ComposeService,
  publishedPorts: Map<number, string>,
  errors: ReleaseValidationError[],
  context: Omit<ReleaseValidationError, "code">,
): number[] {
  const result: number[] = [];
  const expected = expectedPorts[serviceName];
  for (const port of service.ports ?? []) {
    const published = Number(port.published);
    if (!Number.isInteger(published)) {
      addError(errors, "unexpected_published_port", context);
      continue;
    }
    result.push(published);
    if (port.host_ip !== "127.0.0.1") {
      addError(errors, "non_loopback_port", context);
    }
    if (
      expected === undefined ||
      published !== expected.published ||
      port.target !== expected.target ||
      port.protocol !== "tcp"
    ) {
      addError(errors, "unexpected_published_port", context);
    }
    const owner = publishedPorts.get(published);
    if (owner !== undefined && owner !== `${context.stack}/${serviceName}`) {
      addError(errors, "duplicate_published_port", context);
    } else {
      publishedPorts.set(published, `${context.stack}/${serviceName}`);
    }
  }
  if (expected !== undefined && result.length !== 1) {
    addError(errors, "unexpected_published_port", context);
  }
  return result.sort((left, right) => left - right);
}

function explicitResourceNames(
  values: Record<string, { name?: string }> | undefined,
): string[] {
  return Object.entries(values ?? {})
    .map(([key, value]) => value.name ?? key)
    .sort();
}

export function validateCoolifyRelease(
  input: ReleaseValidationInput,
): ReleaseValidationResult {
  const errors: ReleaseValidationError[] = [];
  const manifests: ReleaseManifestStack[] = [];
  const publishedPorts = new Map<number, string>();
  const resourcesByStack = new Map<
    string,
    { networks: Set<string>; volumes: Set<string> }
  >();

  for (const name of Object.keys(input.environment).sort()) {
    if (secretLikeName.test(name) && !allowedReleaseSecretLikeNames.has(name)) {
      addError(errors, "secret_release_environment", {
        field: "environment",
      });
    }
  }

  for (const stack of [...input.stacks].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (stack.compose.name !== stack.name) {
      addError(errors, "stack_name", { stack: stack.name });
    }
    const networkNames = explicitResourceNames(stack.compose.networks);
    const volumeNames = explicitResourceNames(stack.compose.volumes);
    resourcesByStack.set(stack.name, {
      networks: new Set(networkNames),
      volumes: new Set(volumeNames),
    });

    const services: ReleaseManifestService[] = [];
    for (const [serviceName, service] of Object.entries(
      stack.compose.services,
    ).sort(([left], [right]) => left.localeCompare(right))) {
      const context = { stack: stack.name, service: serviceName };
      const digest = validateImage(service.image, errors, context);
      if (service.build !== undefined) {
        addError(errors, "build_entry", context);
      }
      if (
        Object.keys(
          Array.isArray(service.labels)
            ? Object.fromEntries(service.labels.map((label) => [label, ""]))
            : (service.labels ?? {}),
        ).some((label) => /(?:traefik|caddy|nginx|coolify)\./i.test(label))
      ) {
        addError(errors, "proxy_label", context);
      }
      validatePolicies(service, errors, context);
      const mountedTargets = validateSecrets(
        serviceName,
        service,
        stack.compose,
        errors,
        context,
      );
      validateEnvironment(
        serviceName,
        service,
        mountedTargets,
        errors,
        context,
      );
      const ports = validatePorts(
        serviceName,
        service,
        publishedPorts,
        errors,
        context,
      );

      for (const network of networkKeys(service)) {
        if (stack.compose.networks?.[network] === undefined) {
          addError(errors, "foreign_network", context);
        }
      }
      for (const volume of service.volumes ?? []) {
        const source =
          typeof volume === "string"
            ? volume.split(":", 1)[0]
            : volume.type === "volume"
              ? volume.source
              : undefined;
        if (
          source !== undefined &&
          !source.startsWith("/") &&
          !/^[A-Za-z]:[\\/]/.test(source) &&
          stack.compose.volumes?.[source] === undefined
        ) {
          addError(errors, "foreign_volume", context);
        }
      }

      if (digest !== undefined) {
        services.push({ imageDigest: digest, name: serviceName, ports });
      }
    }

    const publicOrigins = originKeys[stack.name]
      .map((key) => input.environment[key])
      .filter((value): value is string => value !== undefined)
      .sort();
    if (
      publicOrigins.length !== originKeys[stack.name].length ||
      publicOrigins.some(
        (origin) =>
          !/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(origin) ||
          origin.includes("@"),
      )
    ) {
      addError(errors, "invalid_public_origin", { stack: stack.name });
    }
    manifests.push({
      name: stack.name,
      publicOrigins,
      services,
      volumes: volumeNames,
    });
  }

  const platformResources = resourcesByStack.get("apollo-platform");
  const tfResources = resourcesByStack.get("apollo-tf");
  if (platformResources !== undefined && tfResources !== undefined) {
    if (
      [...platformResources.networks].some((name) =>
        tfResources.networks.has(name),
      )
    ) {
      addError(errors, "shared_network");
    }
    if (
      [...platformResources.volumes].some((name) =>
        tfResources.volumes.has(name),
      )
    ) {
      addError(errors, "shared_volume");
    }
  }

  if (errors.length > 0) return { ok: false, errors: sortErrors(errors) };
  return { ok: true, stacks: manifests };
}

function parseEnvironment(path: string): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error("invalid_release_environment");
    const name = line.slice(0, separator);
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || environment[name] !== undefined) {
      throw new Error("invalid_release_environment");
    }
    environment[name] = line.slice(separator + 1);
  }
  return environment;
}

function renderCompose(
  repositoryRoot: string,
  envFile: string,
  stack: ReleaseStackInput["name"],
  composeFile: string,
  environment: Record<string, string>,
): ReleaseStackInput {
  const rendered = spawnSync(
    "docker",
    [
      "compose",
      "--env-file",
      envFile,
      "-f",
      composeFile,
      "config",
      "--format",
      "json",
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, ...environment },
      windowsHide: true,
    },
  );
  if (rendered.status !== 0) throw new Error(`compose_render_failed:${stack}`);
  return {
    name: stack,
    compose: JSON.parse(rendered.stdout) as ComposeDocument,
  };
}

export function runCoolifyReleaseCli(argv: string[]): number {
  try {
    const envFlag = argv.indexOf("--env-file");
    const envArgument = envFlag >= 0 ? argv[envFlag + 1] : undefined;
    if (envArgument === undefined) throw new Error("missing_env_file");

    const sourcePath = fileURLToPath(import.meta.url);
    const repositoryRoot = resolve(dirname(sourcePath), "../..");
    const envFile = resolve(repositoryRoot, envArgument);
    const environment = parseEnvironment(envFile);
    const stacks = [
      renderCompose(
        repositoryRoot,
        envFile,
        "apollo-platform",
        resolve(repositoryRoot, "deploy/coolify/apollo-platform.compose.yml"),
        environment,
      ),
      renderCompose(
        repositoryRoot,
        envFile,
        "apollo-tf",
        resolve(repositoryRoot, "deploy/coolify/apollo-tf.compose.yml"),
        environment,
      ),
    ];
    const result = validateCoolifyRelease({ environment, stacks });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : "release_error";
    const [code, stack] = message.split(":", 2);
    const result: ReleaseValidationResult = {
      ok: false,
      errors: [{ code, ...(stack === undefined ? {} : { stack }) }],
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 1;
  }
}

const executablePath = process.argv[1];
if (
  executablePath !== undefined &&
  resolve(executablePath) === fileURLToPath(import.meta.url)
) {
  process.exitCode = runCoolifyReleaseCli(process.argv.slice(2));
}
