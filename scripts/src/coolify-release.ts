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
  networks?: Record<
    string,
    { external?: boolean; internal?: boolean; name?: string }
  >;
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
const expectedStackNames = ["apollo-platform", "apollo-tf"] as const;
const expectedServiceNames: Readonly<
  Record<ReleaseStackInput["name"], readonly string[]>
> = {
  "apollo-platform": [
    "platform-api",
    "platform-migrate",
    "platform-postgres",
    "platform-redis",
  ],
  "apollo-tf": [
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
  ],
};
const longRunningServices = new Set([
  "platform-api",
  "platform-postgres",
  "platform-redis",
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
]);
const oneShotServices = new Set([
  "platform-migrate",
  "tf-baseline",
  "tf-integrations-migrate",
  "tf-migrate",
  "tf-role-bootstrap",
]);

type SecretMountContract = {
  source: string;
  target: string;
  uid: string;
  gid: string;
  mode: string;
};

function secretMountContract(
  source: string,
  uid = "10001",
  gid = uid,
  mode = "0400",
): SecretMountContract {
  return { source, target: source, uid, gid, mode };
}

const expectedSecretMounts: Readonly<
  Record<string, readonly SecretMountContract[]>
> = {
  "platform-api": [
    secretMountContract("platform_assertion_private_jwk"),
    secretMountContract("platform_assertion_public_jwks"),
    secretMountContract("platform_oauth_clients"),
    secretMountContract("platform_operator_bootstrap_token"),
    secretMountContract("platform_runtime_database_url"),
  ],
  "platform-migrate": [secretMountContract("platform_migrator_database_url")],
  "platform-postgres": [
    secretMountContract("platform_postgres_admin_password", "999"),
    secretMountContract("platform_migrator_password", "999"),
    secretMountContract("platform_runtime_password", "999"),
  ],
  "platform-redis": [],
  "tf-admin": [
    secretMountContract("admin_dashboard_token"),
    secretMountContract("admin_access_htpasswd", "0"),
  ],
  "tf-api": [
    secretMountContract("admin_dashboard_token"),
    secretMountContract("tf_client_secret"),
    secretMountContract("tf_runtime_database_url"),
    secretMountContract("tf_integrations_internal_auth_secret"),
    secretMountContract("tf_download_queue_redis_url"),
    secretMountContract("tf_download_internal_auth_secret"),
    secretMountContract("tf_module_heartbeat_keys"),
    secretMountContract("tf_search_internal_auth_secret"),
  ],
  "tf-baseline": [
    secretMountContract("tf_admin_database_url", "0", "10002", "0440"),
  ],
  "tf-download-redis": [
    secretMountContract("tf_download_queue_password", "999"),
  ],
  "tf-download-worker": [
    secretMountContract("tf_download_queue_redis_url"),
    secretMountContract("tf_download_internal_auth_secret"),
    secretMountContract("tf_download_heartbeat_secret"),
  ],
  "tf-integrations": [
    secretMountContract("tf_integrations_runtime_database_url"),
    secretMountContract("tf_integrations_token_keyring"),
    secretMountContract("tf_integrations_spotify_client_id"),
    secretMountContract("tf_integrations_spotify_client_secret"),
    secretMountContract("tf_integrations_internal_auth_secret"),
    secretMountContract("tf_integrations_heartbeat_secret"),
  ],
  "tf-integrations-migrate": [
    secretMountContract("tf_integrations_migrator_database_url"),
  ],
  "tf-integrations-postgres": [
    secretMountContract("tf_integrations_postgres_admin_password", "999"),
    secretMountContract("tf_integrations_migrator_password", "999"),
    secretMountContract("tf_integrations_runtime_password", "999"),
  ],
  "tf-migrate": [secretMountContract("tf_migrator_database_url")],
  "tf-postgres": [
    secretMountContract("tf_postgres_admin_password", "999"),
    secretMountContract("tf_migrator_password", "999"),
    secretMountContract("tf_runtime_password", "999"),
  ],
  "tf-redis": [],
  "tf-role-bootstrap": [
    secretMountContract("tf_admin_database_url", "0", "10002", "0440"),
    secretMountContract("tf_migrator_password", "999"),
    secretMountContract("tf_runtime_password", "999"),
  ],
  "tf-search": [
    secretMountContract("tf_search_internal_auth_secret"),
    secretMountContract("tf_search_heartbeat_secret"),
  ],
  "tf-web": [],
};
const expectedSecretFileEnvironment: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  "platform-api": {
    APOLLO_ASSERTION_PRIVATE_JWK_FILE:
      "/run/secrets/platform_assertion_private_jwk",
    APOLLO_ASSERTION_PUBLIC_JWKS_FILE:
      "/run/secrets/platform_assertion_public_jwks",
    APOLLO_OAUTH_CLIENTS_FILE: "/run/secrets/platform_oauth_clients",
    APOLLO_OPERATOR_BOOTSTRAP_TOKEN_FILE:
      "/run/secrets/platform_operator_bootstrap_token",
    DATABASE_URL_FILE: "/run/secrets/platform_runtime_database_url",
  },
  "platform-migrate": {
    MIGRATOR_DATABASE_URL_FILE: "/run/secrets/platform_migrator_database_url",
  },
  "platform-postgres": {
    POSTGRES_PASSWORD_FILE: "/run/secrets/platform_postgres_admin_password",
  },
  "tf-admin": {
    ADMIN_ACCESS_HTPASSWD_FILE: "/run/secrets/admin_access_htpasswd",
    ADMIN_DASHBOARD_TOKEN_FILE: "/run/secrets/admin_dashboard_token",
  },
  "tf-api": {
    ADMIN_DASHBOARD_TOKEN_FILE: "/run/secrets/admin_dashboard_token",
    APOLLO_MODULE_HEARTBEAT_KEYS_FILE: "/run/secrets/tf_module_heartbeat_keys",
    APOLLO_TF_CLIENT_SECRET_FILE: "/run/secrets/tf_client_secret",
    DATABASE_URL_FILE: "/run/secrets/tf_runtime_database_url",
    TF_DOWNLOAD_QUEUE_REDIS_URL_FILE:
      "/run/secrets/tf_download_queue_redis_url",
    TF_DOWNLOAD_WORKER_INTERNAL_AUTH_SECRET_FILE:
      "/run/secrets/tf_download_internal_auth_secret",
    TF_INTEGRATIONS_INTERNAL_AUTH_SECRET_FILE:
      "/run/secrets/tf_integrations_internal_auth_secret",
    TF_SEARCH_INTERNAL_AUTH_SECRET_FILE:
      "/run/secrets/tf_search_internal_auth_secret",
  },
  "tf-baseline": {
    TF_BASELINE_DATABASE_URL_FILE: "/run/secrets/tf_admin_database_url",
  },
  "tf-download-redis": {
    TF_DOWNLOAD_QUEUE_PASSWORD_FILE: "/run/secrets/tf_download_queue_password",
  },
  "tf-download-worker": {
    TF_DOWNLOAD_HEARTBEAT_SECRET_FILE:
      "/run/secrets/tf_download_heartbeat_secret",
    TF_DOWNLOAD_INTERNAL_AUTH_SECRET_FILE:
      "/run/secrets/tf_download_internal_auth_secret",
    TF_DOWNLOAD_QUEUE_REDIS_URL_FILE:
      "/run/secrets/tf_download_queue_redis_url",
  },
  "tf-integrations": {
    TF_INTEGRATIONS_DATABASE_URL_FILE:
      "/run/secrets/tf_integrations_runtime_database_url",
    TF_INTEGRATIONS_HEARTBEAT_SECRET_FILE:
      "/run/secrets/tf_integrations_heartbeat_secret",
    TF_INTEGRATIONS_INTERNAL_AUTH_SECRET_FILE:
      "/run/secrets/tf_integrations_internal_auth_secret",
    TF_INTEGRATIONS_SPOTIFY_CLIENT_ID_FILE:
      "/run/secrets/tf_integrations_spotify_client_id",
    TF_INTEGRATIONS_SPOTIFY_CLIENT_SECRET_FILE:
      "/run/secrets/tf_integrations_spotify_client_secret",
    TF_INTEGRATIONS_TOKEN_KEYRING_FILE:
      "/run/secrets/tf_integrations_token_keyring",
  },
  "tf-integrations-migrate": {
    TF_INTEGRATIONS_DATABASE_URL_FILE:
      "/run/secrets/tf_integrations_migrator_database_url",
  },
  "tf-integrations-postgres": {
    POSTGRES_PASSWORD_FILE:
      "/run/secrets/tf_integrations_postgres_admin_password",
  },
  "tf-migrate": {
    TF_MIGRATOR_DATABASE_URL_FILE: "/run/secrets/tf_migrator_database_url",
  },
  "tf-postgres": {
    POSTGRES_PASSWORD_FILE: "/run/secrets/tf_postgres_admin_password",
  },
  "tf-role-bootstrap": {
    TF_ROLE_BOOTSTRAP_DATABASE_URL_FILE: "/run/secrets/tf_admin_database_url",
  },
  "tf-search": {
    TF_SEARCH_HEARTBEAT_SECRET_FILE: "/run/secrets/tf_search_heartbeat_secret",
    TF_SEARCH_INTERNAL_AUTH_SECRET_FILE:
      "/run/secrets/tf_search_internal_auth_secret",
  },
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

function isPositiveNumber(value: number | string | undefined): boolean {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function isPositiveInteger(value: number | string | undefined): boolean {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0;
}

function isPositiveDuration(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = value.match(/^(?<amount>\d+(?:\.\d+)?)(?:ns|us|µs|ms|s|m|h)$/);
  return match?.groups?.amount !== undefined && Number(match.groups.amount) > 0;
}

function isPositiveSize(value: number | string | undefined): boolean {
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  if (typeof value !== "string") return false;
  const match = value.match(
    /^(?<amount>\d+(?:\.\d+)?)(?:b|k|kb|kib|m|mb|mib|g|gb|gib)?$/i,
  );
  return match?.groups?.amount !== undefined && Number(match.groups.amount) > 0;
}

function hasActiveHealthcheck(service: ComposeService): boolean {
  const healthcheck = service.healthcheck;
  const test = healthcheck?.test;
  return (
    healthcheck !== undefined &&
    healthcheck.disable !== true &&
    Array.isArray(test) &&
    test.length > 0 &&
    String(test[0]).toUpperCase() !== "NONE" &&
    isPositiveDuration(healthcheck.interval) &&
    isPositiveDuration(healthcheck.timeout) &&
    isPositiveDuration(healthcheck.start_period) &&
    isPositiveInteger(
      typeof healthcheck.retries === "number" ||
        typeof healthcheck.retries === "string"
        ? healthcheck.retries
        : undefined,
    )
  );
}

function validatePolicies(
  serviceName: string,
  service: ComposeService,
  errors: ReleaseValidationError[],
  context: Omit<ReleaseValidationError, "code">,
): void {
  const limits = service.deploy?.resources?.limits;
  if (
    !isPositiveNumber(limits?.cpus) ||
    !isPositiveSize(limits?.memory) ||
    !isPositiveInteger(limits?.pids) ||
    !isPositiveInteger(service.pids_limit) ||
    limits?.pids !== service.pids_limit ||
    service.init !== true ||
    !isPositiveDuration(service.stop_grace_period)
  ) {
    addError(errors, "missing_resource_policy", context);
  }
  if (
    service.logging?.driver !== "json-file" ||
    !isPositiveInteger(service.logging.options?.["max-file"]) ||
    !isPositiveSize(service.logging.options?.["max-size"])
  ) {
    addError(errors, "missing_log_policy", context);
  }

  if (longRunningServices.has(serviceName)) {
    if (service.restart !== "unless-stopped") {
      addError(errors, "service_classification", context);
    }
    if (!hasActiveHealthcheck(service)) {
      addError(errors, "missing_health_policy", context);
    }
    return;
  }
  if (
    !oneShotServices.has(serviceName) ||
    service.restart !== "no" ||
    service.healthcheck !== undefined
  ) {
    addError(errors, "service_classification", context);
  }
}

function validateEnvironment(
  serviceName: string,
  service: ComposeService,
  mountedTargets: Set<string>,
  errors: ReleaseValidationError[],
  context: Omit<ReleaseValidationError, "code">,
): void {
  for (const [name, value] of Object.entries(
    expectedSecretFileEnvironment[serviceName] ?? {},
  )) {
    if (
      service.environment?.[name] !== value ||
      !mountedTargets.has(value.slice("/run/secrets/".length))
    ) {
      addError(errors, "missing_secret_file_environment", {
        ...context,
        field: "environment",
      });
    }
  }
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
  const expected = new Map(
    (expectedSecretMounts[serviceName] ?? []).map((mount) => [
      mount.source,
      mount,
    ]),
  );
  const observedSources = new Set<string>();

  for (const mount of service.secrets ?? []) {
    const source = mount.source ?? "";
    const target = mount.target ?? "";
    const contract = expected.get(source);
    if (contract === undefined || observedSources.has(source)) {
      addError(errors, "unexpected_secret_mount", {
        ...context,
        field: "secrets",
      });
    }
    observedSources.add(source);
    if (
      contract === undefined ||
      target !== contract.target ||
      document.secrets?.[source] === undefined ||
      mount.uid !== contract.uid ||
      mount.gid !== contract.gid ||
      mount.mode !== contract.mode
    ) {
      addError(errors, "secret_mount_metadata", {
        ...context,
        field: "secrets",
      });
    }
    if (target.length > 0) targets.add(target);
  }
  for (const source of expected.keys()) {
    if (!observedSources.has(source)) {
      addError(errors, "missing_secret_mount", {
        ...context,
        field: "secrets",
      });
    }
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

function isExpectedStackName(
  value: string,
): value is ReleaseStackInput["name"] {
  return (expectedStackNames as readonly string[]).includes(value);
}

function expectedSecretDefinitionNames(
  stackName: ReleaseStackInput["name"],
): Set<string> {
  return new Set(
    expectedServiceNames[stackName].flatMap((serviceName) =>
      (expectedSecretMounts[serviceName] ?? []).map(({ source }) => source),
    ),
  );
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
  const stacksByName = new Map<ReleaseStackInput["name"], ReleaseStackInput>();

  for (const name of Object.keys(input.environment).sort()) {
    if (secretLikeName.test(name) && !allowedReleaseSecretLikeNames.has(name)) {
      addError(errors, "secret_release_environment", {
        field: "environment",
      });
    }
  }

  for (const stack of input.stacks) {
    const name = String(stack.name);
    if (!isExpectedStackName(name)) {
      addError(errors, "unexpected_stack", { stack: name });
      continue;
    }
    if (stacksByName.has(name)) {
      addError(errors, "duplicate_stack", { stack: name });
      continue;
    }
    stacksByName.set(name, stack);
  }
  for (const name of expectedStackNames) {
    if (!stacksByName.has(name)) {
      addError(errors, "missing_stack", { stack: name });
    }
  }

  for (const stackName of expectedStackNames) {
    const stack = stacksByName.get(stackName);
    if (stack === undefined) continue;
    if (stack.compose.name !== stack.name) {
      addError(errors, "stack_name", { stack: stack.name });
    }
    const expectedServices = new Set(expectedServiceNames[stackName]);
    const actualServiceNames = Object.keys(stack.compose.services);
    for (const serviceName of expectedServices) {
      if (stack.compose.services[serviceName] === undefined) {
        addError(errors, "missing_service", {
          stack: stackName,
          service: serviceName,
        });
      }
    }
    for (const serviceName of actualServiceNames) {
      if (!expectedServices.has(serviceName)) {
        addError(errors, "unexpected_service", {
          stack: stackName,
          service: serviceName,
        });
      }
    }

    const expectedDefinitions = expectedSecretDefinitionNames(stackName);
    const actualDefinitions = new Set(Object.keys(stack.compose.secrets ?? {}));
    for (const source of expectedDefinitions) {
      if (!actualDefinitions.has(source)) {
        addError(errors, "missing_secret_definition", {
          stack: stackName,
          field: "secrets",
        });
      }
    }
    for (const source of actualDefinitions) {
      if (!expectedDefinitions.has(source)) {
        addError(errors, "unexpected_secret_definition", {
          stack: stackName,
          field: "secrets",
        });
      }
    }

    const networkNames = explicitResourceNames(stack.compose.networks);
    const volumeNames = explicitResourceNames(stack.compose.volumes);
    resourcesByStack.set(stackName, {
      networks: new Set(networkNames),
      volumes: new Set(volumeNames),
    });

    const services: ReleaseManifestService[] = [];
    for (const serviceName of expectedServiceNames[stackName]) {
      const service = stack.compose.services[serviceName];
      if (service === undefined) continue;
      const context = { stack: stackName, service: serviceName };
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
      validatePolicies(serviceName, service, errors, context);
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

    const publicOrigins = originKeys[stackName]
      .map((key) => input.environment[key])
      .filter((value): value is string => value !== undefined)
      .sort();
    if (
      publicOrigins.length !== originKeys[stackName].length ||
      publicOrigins.some(
        (origin) =>
          !/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(origin) ||
          origin.includes("@"),
      )
    ) {
      addError(errors, "invalid_public_origin", { stack: stackName });
    }
    manifests.push({
      name: stackName,
      publicOrigins,
      services,
      volumes: volumeNames,
    });
  }

  const platformResources = resourcesByStack.get("apollo-platform");
  const tfResources = resourcesByStack.get("apollo-tf");
  if (platformResources !== undefined && tfResources !== undefined) {
    const sharedNetworks = [...platformResources.networks].filter((name) =>
      tfResources.networks.has(name),
    );
    const platformBridge = input.stacks.find(
      ({ name }) => name === "apollo-platform",
    )?.compose.networks?.["platform-bridge"];
    const tfBridge = input.stacks.find(({ name }) => name === "apollo-tf")
      ?.compose.networks?.["platform-bridge"];
    const validPlatformBridge =
      sharedNetworks.length === 1 &&
      sharedNetworks[0] === "apollo-platform-bridge-v1" &&
      platformBridge?.name === "apollo-platform-bridge-v1" &&
      platformBridge.internal === true &&
      platformBridge.external !== true &&
      tfBridge?.name === "apollo-platform-bridge-v1" &&
      tfBridge.external === true &&
      tfBridge.internal !== true;
    if (sharedNetworks.length > 0 && !validPlatformBridge) {
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
  profiles: readonly string[] = [],
): ReleaseStackInput {
  const rendered = spawnSync(
    "docker",
    [
      "compose",
      ...profiles.flatMap((profile) => ["--profile", profile]),
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
        ["baseline"],
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
