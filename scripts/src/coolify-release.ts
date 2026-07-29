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
      read_only?: boolean;
      source?: string;
      target?: string;
      type?: string;
      volume?: Record<string, unknown>;
    };

export type ComposeService = {
  build?: unknown;
  cap_add?: string[];
  cap_drop?: string[];
  deploy?: {
    resources?: {
      limits?: {
        cpus?: number | string;
        memory?: number | string;
        pids?: number;
      };
    };
  };
  depends_on?: Record<
    string,
    { condition?: string; required?: boolean; restart?: boolean }
  >;
  devices?: unknown[];
  environment?: Record<string, string>;
  group_add?: string[];
  healthcheck?: Record<string, unknown>;
  image?: string;
  ipc?: string;
  init?: boolean;
  labels?: Record<string, string> | string[];
  logging?: {
    driver?: string;
    options?: Record<string, string>;
  };
  network_mode?: string;
  networks?: Record<string, unknown> | string[];
  pid?: string;
  pids_limit?: number;
  ports?: ComposePort[];
  privileged?: boolean;
  profiles?: string[];
  read_only?: boolean;
  restart?: string;
  secrets?: ComposeSecretMount[];
  security_opt?: string[];
  stop_grace_period?: string;
  sysctls?: Record<string, string>;
  tmpfs?: string[];
  user?: string;
  uts?: string;
  volumes?: ComposeVolumeMount[];
};

export type ComposeDocument = {
  name?: string;
  networks?: Record<
    string,
    { external?: boolean; internal?: boolean; name?: string }
  >;
  secrets?: Record<string, { file?: string; name?: string }>;
  services: Record<string, ComposeService>;
  volumes?: Record<string, { name?: string }>;
};

export type ReleaseStackInput = {
  name: "apollo-platform" | "apollo-tf";
  compose: ComposeDocument;
};

export type ReleaseValidationInput = {
  environment: Record<string, string>;
  mode: ReleaseValidationMode;
  releaseArtifact?: ReleaseArtifact;
  stacks: ReleaseStackInput[];
};

export type ReleaseValidationMode = "production" | "loopback-local-smoke";

export type ReleaseArtifactImage = {
  imageDigest: string;
  imageReference: string;
  name: string;
  repository: string;
};

export type ReleaseArtifact = {
  formatVersion: 1;
  images: ReleaseArtifactImage[];
  sourceCommit: string;
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
  "tf-admin": new Set(["ADMIN_DASHBOARD_TOKEN_FILE"]),
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
const expectedReleaseEnvironmentNames = [
  "PLATFORM_ALLOWED_ORIGINS",
  "PLATFORM_API_IMAGE",
  "PLATFORM_API_PORT",
  "PLATFORM_API_VERSION",
  "PLATFORM_DEPLOYED_AT",
  "PLATFORM_POSTGRES_IMAGE",
  "PLATFORM_PUBLIC_ORIGIN",
  "PLATFORM_REDIS_IMAGE",
  "PLATFORM_SECRET_DIRECTORY",
  "RELEASE_SOURCE_COMMIT",
  "TF_ADMIN_CREDENTIAL_DIRECTORY",
  "TF_ADMIN_IMAGE",
  "TF_ADMIN_PORT",
  "TF_ADMIN_PUBLIC_ORIGIN",
  "TF_API_IMAGE",
  "TF_API_PORT",
  "TF_API_PUBLIC_ORIGIN",
  "TF_API_VERSION",
  "TF_DEPLOYED_AT",
  "TF_DOWNLOAD_DEPLOYED_AT",
  "TF_DOWNLOAD_REDIS_IMAGE",
  "TF_DOWNLOAD_VERSION",
  "TF_DOWNLOAD_WORKER_IMAGE",
  "TF_INTEGRATIONS_DEPLOYED_AT",
  "TF_INTEGRATIONS_IMAGE",
  "TF_INTEGRATIONS_POSTGRES_IMAGE",
  "TF_INTEGRATIONS_VERSION",
  "TF_POSTGRES_IMAGE",
  "TF_PUBLIC_ORIGIN",
  "TF_REDIS_IMAGE",
  "TF_SEARCH_DEPLOYED_AT",
  "TF_SEARCH_IMAGE",
  "TF_SEARCH_VERSION",
  "TF_SECRET_DIRECTORY",
  "TF_WEB_IMAGE",
  "TF_WEB_PORT",
] as const;
const expectedReleaseValues: Readonly<Record<string, string>> = {
  PLATFORM_ALLOWED_ORIGINS: "https://apollot.ru,https://admin.apollot.ru",
  PLATFORM_API_PORT: "18200",
  PLATFORM_PUBLIC_ORIGIN: "https://api.apollot.ru",
  TF_ADMIN_PORT: "18203",
  TF_ADMIN_PUBLIC_ORIGIN: "https://admin.apollot.ru",
  TF_API_PORT: "18201",
  TF_API_PUBLIC_ORIGIN: "https://api.tf.apollot.ru",
  TF_PUBLIC_ORIGIN: "https://tf.apollot.ru",
  TF_WEB_PORT: "18202",
};
const publicOriginEnvironmentNames = new Set([
  "PLATFORM_ALLOWED_ORIGINS",
  "PLATFORM_PUBLIC_ORIGIN",
  "TF_ADMIN_PUBLIC_ORIGIN",
  "TF_API_PUBLIC_ORIGIN",
  "TF_PUBLIC_ORIGIN",
]);
const versionEnvironmentNames = [
  "PLATFORM_API_VERSION",
  "TF_API_VERSION",
  "TF_DOWNLOAD_VERSION",
  "TF_INTEGRATIONS_VERSION",
  "TF_SEARCH_VERSION",
] as const;
const deployedAtEnvironmentNames = [
  "PLATFORM_DEPLOYED_AT",
  "TF_DEPLOYED_AT",
  "TF_DOWNLOAD_DEPLOYED_AT",
  "TF_INTEGRATIONS_DEPLOYED_AT",
  "TF_SEARCH_DEPLOYED_AT",
] as const;
const sourceCommitPattern = /^[a-f0-9]{40}$/;
const zeroSourceCommit = "0".repeat(40);
const artifactImageNames = [
  "platform-api",
  "platform-postgres",
  "redis",
  "tf-admin",
  "tf-api",
  "tf-download-redis",
  "tf-download-worker",
  "tf-integrations",
  "tf-integrations-postgres",
  "tf-postgres",
  "tf-search",
  "tf-web",
] as const;
type ArtifactImageName = (typeof artifactImageNames)[number];
const approvedImageRepositories: Readonly<Record<ArtifactImageName, string>> = {
  "platform-api": "ghcr.io/altis13/apollo-platform-api",
  "platform-postgres": "ghcr.io/altis13/apollo-platform-postgres",
  redis: "docker.io/library/redis",
  "tf-admin": "ghcr.io/altis13/apollo-tf-admin",
  "tf-api": "ghcr.io/altis13/apollo-tf-api",
  "tf-download-redis": "ghcr.io/altis13/apollo-tf-download-redis",
  "tf-download-worker": "ghcr.io/altis13/apollo-tf-download-worker",
  "tf-integrations": "ghcr.io/altis13/apollo-tf-integrations",
  "tf-integrations-postgres": "ghcr.io/altis13/apollo-tf-integrations-postgres",
  "tf-postgres": "ghcr.io/altis13/apollo-tf-postgres",
  "tf-search": "ghcr.io/altis13/apollo-tf-search",
  "tf-web": "ghcr.io/altis13/apollo-tf-web",
};
const serviceArtifactImages: Readonly<Record<string, ArtifactImageName>> = {
  "platform-api": "platform-api",
  "platform-migrate": "platform-api",
  "platform-postgres": "platform-postgres",
  "platform-redis": "redis",
  "tf-admin": "tf-admin",
  "tf-api": "tf-api",
  "tf-baseline": "tf-api",
  "tf-download-redis": "tf-download-redis",
  "tf-download-worker": "tf-download-worker",
  "tf-integrations": "tf-integrations",
  "tf-integrations-migrate": "tf-integrations",
  "tf-integrations-postgres": "tf-integrations-postgres",
  "tf-migrate": "tf-api",
  "tf-postgres": "tf-postgres",
  "tf-redis": "redis",
  "tf-role-bootstrap": "tf-postgres",
  "tf-search": "tf-search",
  "tf-web": "tf-web",
};
const releaseImageEnvironmentNames: Readonly<
  Record<string, ArtifactImageName>
> = {
  PLATFORM_API_IMAGE: "platform-api",
  PLATFORM_POSTGRES_IMAGE: "platform-postgres",
  PLATFORM_REDIS_IMAGE: "redis",
  TF_ADMIN_IMAGE: "tf-admin",
  TF_API_IMAGE: "tf-api",
  TF_DOWNLOAD_REDIS_IMAGE: "tf-download-redis",
  TF_DOWNLOAD_WORKER_IMAGE: "tf-download-worker",
  TF_INTEGRATIONS_IMAGE: "tf-integrations",
  TF_INTEGRATIONS_POSTGRES_IMAGE: "tf-integrations-postgres",
  TF_POSTGRES_IMAGE: "tf-postgres",
  TF_REDIS_IMAGE: "redis",
  TF_SEARCH_IMAGE: "tf-search",
  TF_WEB_IMAGE: "tf-web",
};

type NetworkContract = {
  external?: boolean;
  internal?: boolean;
  name: string;
};
const expectedNetworks: Readonly<
  Record<ReleaseStackInput["name"], Readonly<Record<string, NetworkContract>>>
> = {
  "apollo-platform": {
    "platform-bridge": {
      internal: true,
      name: "apollo-platform-bridge-v1",
    },
    "platform-data": { internal: true, name: "apollo-platform-data-v1" },
    "platform-edge": { name: "apollo-platform-edge-v1" },
  },
  "apollo-tf": {
    "platform-bridge": {
      external: true,
      name: "apollo-platform-bridge-v1",
    },
    "tf-data": { internal: true, name: "apollo-tf-data-v1" },
    "tf-download-control": {
      internal: true,
      name: "apollo-tf-download-control-v1",
    },
    "tf-download-egress": { name: "apollo-tf-download-egress-v1" },
    "tf-download-queue": {
      internal: true,
      name: "apollo-tf-download-queue-v1",
    },
    "tf-edge": { name: "apollo-tf-edge-v1" },
    "tf-integrations-control": {
      internal: true,
      name: "apollo-tf-integrations-control-v1",
    },
    "tf-integrations-data": {
      internal: true,
      name: "apollo-tf-integrations-data-v1",
    },
    "tf-integrations-egress": {
      name: "apollo-tf-integrations-egress-v1",
    },
    "tf-search-control": {
      internal: true,
      name: "apollo-tf-search-control-v1",
    },
    "tf-search-egress": { name: "apollo-tf-search-egress-v1" },
  },
};
const expectedVolumes: Readonly<
  Record<ReleaseStackInput["name"], Readonly<Record<string, { name: string }>>>
> = {
  "apollo-platform": {
    "platform-postgres-data": { name: "apollo-platform-postgres-v1" },
    "platform-redis-data": { name: "apollo-platform-redis-v1" },
  },
  "apollo-tf": {
    "tf-download-redis-data": { name: "apollo-tf-download-redis-v1" },
    "tf-downloads": { name: "apollo-tf-downloads-v1" },
    "tf-integrations-postgres-data": {
      name: "apollo-tf-integrations-postgres-v1",
    },
    "tf-postgres-data": { name: "apollo-tf-postgres-v1" },
    "tf-redis-data": { name: "apollo-tf-redis-v1" },
  },
};
const expectedServiceNetworks: Readonly<
  Record<string, Readonly<Record<string, number | undefined>>>
> = {
  "platform-api": {
    "platform-bridge": undefined,
    "platform-data": undefined,
    "platform-edge": undefined,
  },
  "platform-migrate": { "platform-data": undefined },
  "platform-postgres": { "platform-data": undefined },
  "platform-redis": { "platform-data": undefined },
  "tf-admin": { "tf-edge": undefined },
  "tf-api": {
    "platform-bridge": undefined,
    "tf-data": undefined,
    "tf-download-control": undefined,
    "tf-download-queue": undefined,
    "tf-edge": undefined,
    "tf-integrations-control": undefined,
    "tf-search-control": undefined,
  },
  "tf-baseline": { "tf-data": undefined },
  "tf-download-redis": { "tf-download-queue": undefined },
  "tf-download-worker": {
    "tf-download-control": undefined,
    "tf-download-egress": 1,
    "tf-download-queue": undefined,
  },
  "tf-integrations": {
    "tf-integrations-control": undefined,
    "tf-integrations-data": undefined,
    "tf-integrations-egress": 1,
  },
  "tf-integrations-migrate": { "tf-integrations-data": undefined },
  "tf-integrations-postgres": { "tf-integrations-data": undefined },
  "tf-migrate": { "tf-data": undefined },
  "tf-postgres": { "tf-data": undefined },
  "tf-redis": { "tf-data": undefined },
  "tf-role-bootstrap": { "tf-data": undefined },
  "tf-search": {
    "tf-search-control": undefined,
    "tf-search-egress": 1,
  },
  "tf-web": { "tf-edge": undefined },
};
type PersistentMountContract = {
  source: string;
  target: string;
};
const expectedPersistentMounts: Readonly<
  Record<string, readonly PersistentMountContract[]>
> = {
  "platform-api": [],
  "platform-migrate": [],
  "platform-postgres": [
    {
      source: "platform-postgres-data",
      target: "/var/lib/postgresql/data",
    },
  ],
  "platform-redis": [{ source: "platform-redis-data", target: "/data" }],
  "tf-admin": [],
  "tf-api": [],
  "tf-baseline": [],
  "tf-download-redis": [{ source: "tf-download-redis-data", target: "/data" }],
  "tf-download-worker": [
    { source: "tf-downloads", target: "/var/lib/apollo-tf/downloads" },
  ],
  "tf-integrations": [],
  "tf-integrations-migrate": [],
  "tf-integrations-postgres": [
    {
      source: "tf-integrations-postgres-data",
      target: "/var/lib/postgresql/data",
    },
  ],
  "tf-migrate": [],
  "tf-postgres": [
    { source: "tf-postgres-data", target: "/var/lib/postgresql/data" },
  ],
  "tf-redis": [{ source: "tf-redis-data", target: "/data" }],
  "tf-role-bootstrap": [],
  "tf-search": [],
  "tf-web": [],
};
type DependencyContract = {
  condition: string;
  required: boolean;
};
const expectedDependencies: Readonly<
  Record<string, Readonly<Record<string, DependencyContract>>>
> = {
  "platform-api": {
    "platform-migrate": {
      condition: "service_completed_successfully",
      required: true,
    },
    "platform-redis": { condition: "service_healthy", required: true },
  },
  "platform-migrate": {
    "platform-postgres": { condition: "service_healthy", required: true },
  },
  "platform-postgres": {},
  "platform-redis": {},
  "tf-admin": {
    "tf-api": { condition: "service_healthy", required: true },
  },
  "tf-api": {
    "tf-download-redis": { condition: "service_healthy", required: true },
    "tf-download-worker": { condition: "service_healthy", required: true },
    "tf-integrations": { condition: "service_healthy", required: true },
    "tf-migrate": {
      condition: "service_completed_successfully",
      required: true,
    },
    "tf-postgres": { condition: "service_healthy", required: true },
    "tf-redis": { condition: "service_healthy", required: true },
    "tf-search": { condition: "service_healthy", required: true },
  },
  "tf-baseline": {
    "tf-role-bootstrap": {
      condition: "service_completed_successfully",
      required: true,
    },
  },
  "tf-download-redis": {},
  "tf-download-worker": {
    "tf-download-redis": { condition: "service_healthy", required: true },
  },
  "tf-integrations": {
    "tf-integrations-migrate": {
      condition: "service_completed_successfully",
      required: true,
    },
    "tf-integrations-postgres": {
      condition: "service_healthy",
      required: true,
    },
  },
  "tf-integrations-migrate": {
    "tf-integrations-postgres": {
      condition: "service_healthy",
      required: true,
    },
  },
  "tf-integrations-postgres": {},
  "tf-migrate": {
    "tf-postgres": { condition: "service_healthy", required: true },
  },
  "tf-postgres": {},
  "tf-redis": {},
  "tf-role-bootstrap": {
    "tf-postgres": { condition: "service_healthy", required: true },
  },
  "tf-search": {},
  "tf-web": {},
};
const expectedProfiles: Readonly<Record<string, readonly string[]>> = {
  "platform-api": [],
  "platform-migrate": [],
  "platform-postgres": [],
  "platform-redis": [],
  "tf-admin": [],
  "tf-api": [],
  "tf-baseline": ["baseline"],
  "tf-download-redis": [],
  "tf-download-worker": [],
  "tf-integrations": [],
  "tf-integrations-migrate": [],
  "tf-integrations-postgres": [],
  "tf-migrate": [],
  "tf-postgres": [],
  "tf-redis": [],
  "tf-role-bootstrap": ["baseline"],
  "tf-search": [],
  "tf-web": [],
};
type SecurityContract = {
  capDrop: readonly string[];
  groupAdd: readonly string[];
  readOnly: boolean | undefined;
  securityOpt: readonly string[];
  tmpfs: readonly string[];
  user: string | undefined;
};
function hardenedSecurity(
  user: string,
  tmpfs: readonly string[],
  groupAdd: readonly string[] = [],
): SecurityContract {
  return {
    capDrop: ["ALL"],
    groupAdd,
    readOnly: true,
    securityOpt: ["no-new-privileges:true"],
    tmpfs,
    user,
  };
}
const defaultSecurity: SecurityContract = {
  capDrop: [],
  groupAdd: [],
  readOnly: undefined,
  securityOpt: [],
  tmpfs: [],
  user: undefined,
};
const expectedSecurity: Readonly<Record<string, SecurityContract>> = {
  "platform-api": hardenedSecurity("10001:10001", [
    "/tmp:rw,noexec,nosuid,size=16m",
  ]),
  "platform-migrate": hardenedSecurity("10001:10001", [
    "/tmp:rw,noexec,nosuid,size=16m",
  ]),
  "platform-postgres": defaultSecurity,
  "platform-redis": hardenedSecurity("999:999", [
    "/tmp:rw,noexec,nosuid,size=16m",
  ]),
  "tf-admin": defaultSecurity,
  "tf-api": hardenedSecurity("10001:10001", ["/tmp:rw,noexec,nosuid,size=32m"]),
  "tf-baseline": hardenedSecurity(
    "10001:10001",
    ["/tmp:rw,noexec,nosuid,size=16m"],
    ["10002"],
  ),
  "tf-download-redis": hardenedSecurity("999:999", [
    "/tmp:rw,noexec,nosuid,size=16m",
  ]),
  "tf-download-worker": hardenedSecurity("10001:10001", [
    "/tmp:rw,noexec,nosuid,size=64m",
  ]),
  "tf-integrations": hardenedSecurity("10001:10001", [
    "/tmp:rw,noexec,nosuid,size=16m",
  ]),
  "tf-integrations-migrate": hardenedSecurity("10001:10001", [
    "/tmp:rw,noexec,nosuid,size=16m",
  ]),
  "tf-integrations-postgres": defaultSecurity,
  "tf-migrate": hardenedSecurity("10001:10001", [
    "/tmp:rw,noexec,nosuid,size=16m",
  ]),
  "tf-postgres": defaultSecurity,
  "tf-redis": hardenedSecurity("999:999", ["/tmp:rw,noexec,nosuid,size=16m"]),
  "tf-role-bootstrap": hardenedSecurity(
    "999:999",
    ["/tmp:rw,noexec,nosuid,size=16m"],
    ["10002"],
  ),
  "tf-search": hardenedSecurity("10001:10001", [
    "/tmp:rw,noexec,nosuid,size=32m",
    "/tmp/yt-dlp:rw,noexec,nosuid,size=64m",
  ]),
  "tf-web": defaultSecurity,
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

type RuntimeEnvironment = Readonly<Record<string, string>>;
type RuntimeEnvironmentResolver = (
  releaseEnvironment: Readonly<Record<string, string>>,
) => RuntimeEnvironment;

const expectedPlainEnvironment: Readonly<
  Record<string, RuntimeEnvironmentResolver>
> = {
  "platform-api": (releaseEnvironment) => ({
    APOLLO_ALLOWED_ORIGINS: releaseEnvironment["PLATFORM_ALLOWED_ORIGINS"],
    APOLLO_API_VERSION: releaseEnvironment["PLATFORM_API_VERSION"],
    APOLLO_DEPLOYED_AT: releaseEnvironment["PLATFORM_DEPLOYED_AT"],
    APOLLO_DEVELOPMENT_TOKEN_ECHO: "false",
    APOLLO_INTROSPECTION_CLIENT_ID: "apollo-tf-api",
    APOLLO_ISSUER: releaseEnvironment["PLATFORM_PUBLIC_ORIGIN"],
    APOLLO_REDIS_URL: "redis://platform-redis:6379",
    APOLLO_TRUST_PROXY_HOPS: "1",
    NODE_ENV: "production",
    PORT: "8080",
  }),
  "platform-migrate": () => ({}),
  "platform-postgres": () => ({
    POSTGRES_DB: "apollo_platform",
    POSTGRES_USER: "postgres",
  }),
  "platform-redis": () => ({}),
  "tf-admin": () => ({ APOLLO_API_UPSTREAM: "http://tf-api:8080" }),
  "tf-api": (releaseEnvironment) => ({
    APOLLO_API_VERSION: releaseEnvironment["TF_API_VERSION"],
    APOLLO_DEPLOYED_AT: releaseEnvironment["TF_DEPLOYED_AT"],
    APOLLO_PLATFORM_API_ORIGIN: "http://platform-api:8080",
    APOLLO_PLATFORM_ISSUER: releaseEnvironment["PLATFORM_PUBLIC_ORIGIN"],
    APOLLO_TF_AUTH_REDIS_URL: "redis://tf-redis:6379/1",
    APOLLO_TF_BRIDGE_ALLOW_INTERNAL_HTTP: "true",
    APOLLO_TF_CALLBACK_URL: `${releaseEnvironment["TF_API_PUBLIC_ORIGIN"]}/api/auth/callback`,
    APOLLO_TF_CLIENT_ID: "apollo-tf-api",
    APOLLO_TF_WEB_ORIGIN: releaseEnvironment["TF_PUBLIC_ORIGIN"],
    NODE_ENV: "production",
    PORT: "8080",
    REDIS_URL: "redis://tf-redis:6379/0",
    SERVER_URL: releaseEnvironment["TF_API_PUBLIC_ORIGIN"],
    TF_DOWNLOAD_QUEUE_ALLOW_INSECURE_REDIS: "true",
    TF_DOWNLOAD_WORKER_ALLOW_INSECURE_HTTP: "true",
    TF_DOWNLOAD_WORKER_ORIGIN: "http://tf-download-worker:8080",
    TF_INTEGRATIONS_ALLOW_INSECURE_HTTP: "true",
    TF_INTEGRATIONS_ORIGIN: "http://tf-integrations:8080",
    TF_SEARCH_ALLOW_INSECURE_HTTP: "true",
    TF_SEARCH_ORIGIN: "http://tf-search:8080",
    WEB_URL: releaseEnvironment["TF_PUBLIC_ORIGIN"],
  }),
  "tf-baseline": () => ({}),
  "tf-download-redis": () => ({}),
  "tf-download-worker": (releaseEnvironment) => ({
    APOLLO_API_VERSION: releaseEnvironment["TF_DOWNLOAD_VERSION"],
    APOLLO_DEPLOYED_AT: releaseEnvironment["TF_DOWNLOAD_DEPLOYED_AT"],
    NODE_ENV: "production",
    PORT: "8080",
    TF_DOWNLOAD_HEARTBEAT_ALLOW_INSECURE_HTTP: "true",
    TF_DOWNLOAD_HEARTBEAT_API_ORIGIN: "http://tf-api:8080",
    TF_DOWNLOAD_QUEUE_ALLOW_INSECURE_REDIS: "true",
    TF_DOWNLOAD_STORAGE_ROOT: "/var/lib/apollo-tf/downloads",
  }),
  "tf-integrations": (releaseEnvironment) => ({
    APOLLO_API_VERSION: releaseEnvironment["TF_INTEGRATIONS_VERSION"],
    APOLLO_DEPLOYED_AT: releaseEnvironment["TF_INTEGRATIONS_DEPLOYED_AT"],
    NODE_ENV: "production",
    PORT: "8080",
    TF_INTEGRATIONS_HEARTBEAT_ALLOW_INSECURE_HTTP: "true",
    TF_INTEGRATIONS_HEARTBEAT_API_ORIGIN: "http://tf-api:8080",
    TF_INTEGRATIONS_SPOTIFY_CALLBACK_URI: `${releaseEnvironment["TF_API_PUBLIC_ORIGIN"]}/api/spotify/callback`,
  }),
  "tf-integrations-migrate": () => ({}),
  "tf-integrations-postgres": () => ({
    POSTGRES_DB: "apollo_tf_integrations",
    POSTGRES_USER: "postgres",
  }),
  "tf-migrate": () => ({}),
  "tf-postgres": () => ({
    POSTGRES_DB: "apollo_trackfinder",
    POSTGRES_USER: "postgres",
  }),
  "tf-redis": () => ({}),
  "tf-role-bootstrap": () => ({}),
  "tf-search": (releaseEnvironment) => ({
    APOLLO_API_VERSION: releaseEnvironment["TF_SEARCH_VERSION"],
    APOLLO_DEPLOYED_AT: releaseEnvironment["TF_SEARCH_DEPLOYED_AT"],
    NODE_ENV: "production",
    PORT: "8080",
    TF_SEARCH_HEARTBEAT_ALLOW_INSECURE_HTTP: "true",
    TF_SEARCH_HEARTBEAT_API_ORIGIN: "http://tf-api:8080",
  }),
  "tf-web": () => ({}),
};

function expectedEnvironmentForService(
  serviceName: string,
  releaseEnvironment: Readonly<Record<string, string>>,
): RuntimeEnvironment {
  return {
    ...(expectedSecretFileEnvironment[serviceName] ?? {}),
    ...(expectedPlainEnvironment[serviceName]?.(releaseEnvironment) ?? {}),
  };
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((name, index) => name === wanted[index])
  );
}

function exactRuntimeEnvironment(
  actual: Readonly<Record<string, string>> | undefined,
  expected: RuntimeEnvironment,
): boolean {
  const observed = Object.entries(actual ?? {}).sort(
    ([leftName, leftValue], [rightName, rightValue]) =>
      leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue),
  );
  const wanted = Object.entries(expected).sort(
    ([leftName, leftValue], [rightName, rightValue]) =>
      leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue),
  );
  return (
    observed.length === wanted.length &&
    observed.every(
      ([name, value], index) =>
        name === wanted[index]?.[0] && value === wanted[index]?.[1],
    )
  );
}

function exactStringArray(
  actual: readonly string[] | undefined,
  expected: readonly string[],
): boolean {
  const observed = [...(actual ?? [])].sort();
  const wanted = [...expected].sort();
  return (
    observed.length === wanted.length &&
    observed.every((value, index) => value === wanted[index])
  );
}

function validDirectory(value: string | undefined): boolean {
  return (
    value !== undefined &&
    /^(?:\/|[A-Za-z]:\/)/.test(value) &&
    !value.includes("\\") &&
    !value.split("/").includes("..") &&
    !value.endsWith("/")
  );
}

function isValidSourceCommit(value: string | undefined): value is string {
  return (
    value !== undefined &&
    sourceCommitPattern.test(value) &&
    value !== zeroSourceCommit
  );
}

type ParsedImage = {
  digest: string;
  repository: string;
};

function parseImmutableImage(
  image: string | undefined,
): ParsedImage | undefined {
  if (image === undefined || image.includes("${") || image.includes(":-")) {
    return undefined;
  }
  const match = image.match(
    /^(?<repository>[a-z0-9.-]+(?::\d+)?\/[a-z0-9._/-]+)@(?<digest>sha256:[a-f0-9]{64})$/,
  );
  if (
    match?.groups?.repository === undefined ||
    match.groups.digest === undefined ||
    match.groups.digest === zeroDigest
  ) {
    return undefined;
  }
  return {
    digest: match.groups.digest,
    repository: match.groups.repository,
  };
}

function validateReleaseEnvironment(
  input: ReleaseValidationInput,
  errors: ReleaseValidationError[],
): void {
  if (input.mode !== "production" && input.mode !== "loopback-local-smoke") {
    addError(errors, "invalid_validation_mode");
  }
  if (!exactKeys(input.environment, expectedReleaseEnvironmentNames)) {
    addError(errors, "release_environment_keys", { field: "environment" });
  }
  for (const [name, expected] of Object.entries(expectedReleaseValues)) {
    if (input.environment[name] === expected) continue;
    addError(
      errors,
      publicOriginEnvironmentNames.has(name)
        ? "invalid_public_origin"
        : "release_environment_value",
      { field: "environment" },
    );
  }
  for (const name of versionEnvironmentNames) {
    if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.environment[name] ?? "")) {
      continue;
    }
    addError(errors, "release_environment_value", { field: "environment" });
  }
  for (const name of deployedAtEnvironmentNames) {
    const value = input.environment[name] ?? "";
    if (
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) &&
      Number.isFinite(Date.parse(value))
    ) {
      continue;
    }
    addError(errors, "release_environment_value", { field: "environment" });
  }
  if (!isValidSourceCommit(input.environment.RELEASE_SOURCE_COMMIT)) {
    addError(errors, "release_environment_value", { field: "environment" });
  }

  const platformDirectory = input.environment.PLATFORM_SECRET_DIRECTORY;
  const tfDirectory = input.environment.TF_SECRET_DIRECTORY;
  const adminDirectory = input.environment.TF_ADMIN_CREDENTIAL_DIRECTORY;
  if (
    !validDirectory(platformDirectory) ||
    !validDirectory(tfDirectory) ||
    !validDirectory(adminDirectory)
  ) {
    addError(errors, "release_environment_value", { field: "environment" });
  }
  if (
    input.mode === "production" &&
    (platformDirectory !== "/var/lib/apollo-platform/secrets" ||
      tfDirectory !== "/var/lib/apollo-tf/secrets" ||
      !/^\/var\/lib\/apollo-tf\/admin-credentials\/[A-Za-z0-9._-]+$/.test(
        adminDirectory ?? "",
      ) ||
      adminDirectory?.endsWith("/replace-with-generation") === true)
  ) {
    addError(errors, "release_environment_value", { field: "environment" });
  }
}

function isArtifactImageName(value: string): value is ArtifactImageName {
  return (artifactImageNames as readonly string[]).includes(value);
}

function validateReleaseArtifact(
  input: ReleaseValidationInput,
  errors: ReleaseValidationError[],
): Map<ArtifactImageName, string> {
  const references = new Map<ArtifactImageName, string>();
  const artifact = input.releaseArtifact as unknown;
  if (input.mode === "loopback-local-smoke") {
    if (artifact !== undefined) addError(errors, "release_artifact");
    return references;
  }
  if (
    !isRecord(artifact) ||
    !exactKeys(artifact, ["formatVersion", "images", "sourceCommit"]) ||
    artifact.formatVersion !== 1 ||
    !Array.isArray(artifact.images) ||
    typeof artifact.sourceCommit !== "string" ||
    !isValidSourceCommit(artifact.sourceCommit)
  ) {
    addError(errors, "release_artifact");
    return references;
  }
  if (artifact.sourceCommit !== input.environment.RELEASE_SOURCE_COMMIT) {
    addError(errors, "source_commit_mismatch");
  }

  const observedNames = new Set<string>();
  for (const value of artifact.images) {
    if (
      !isRecord(value) ||
      !exactKeys(value, [
        "imageDigest",
        "imageReference",
        "name",
        "repository",
      ]) ||
      typeof value.name !== "string" ||
      !isArtifactImageName(value.name) ||
      observedNames.has(value.name) ||
      typeof value.repository !== "string" ||
      typeof value.imageDigest !== "string" ||
      typeof value.imageReference !== "string"
    ) {
      addError(errors, "release_artifact");
      continue;
    }
    observedNames.add(value.name);
    const parsed = parseImmutableImage(value.imageReference);
    if (
      value.repository !== approvedImageRepositories[value.name] ||
      parsed?.repository !== value.repository ||
      parsed.digest !== value.imageDigest
    ) {
      addError(
        errors,
        value.repository !== approvedImageRepositories[value.name]
          ? "release_artifact"
          : "image_provenance",
      );
      continue;
    }
    references.set(value.name, value.imageReference);
  }
  if (
    observedNames.size !== artifactImageNames.length ||
    artifactImageNames.some((name) => !observedNames.has(name))
  ) {
    addError(errors, "release_artifact");
  }
  return references;
}

function validateReleaseImages(
  input: ReleaseValidationInput,
  artifactReferences: ReadonlyMap<ArtifactImageName, string>,
  errors: ReleaseValidationError[],
): Map<ArtifactImageName, string> {
  const expectedReferences = new Map<ArtifactImageName, string>();
  let loopbackAuthority: string | undefined;

  for (const [environmentName, imageName] of Object.entries(
    releaseImageEnvironmentNames,
  )) {
    const reference = input.environment[environmentName];
    const parsed = parseImmutableImage(reference);
    if (parsed === undefined) {
      addError(errors, "image_provenance", { field: "environment" });
      continue;
    }
    if (input.mode === "production") {
      if (parsed.repository !== approvedImageRepositories[imageName]) {
        addError(errors, "image_repository", { field: "environment" });
      }
      if (artifactReferences.get(imageName) !== reference) {
        addError(errors, "image_provenance", { field: "environment" });
      }
    } else if (input.mode === "loopback-local-smoke") {
      const match = parsed.repository.match(
        /^(?<authority>(?:127\.0\.0\.1|localhost):[1-9][0-9]{0,4})\/(?<name>[a-z0-9-]+)$/,
      );
      const port = Number(match?.groups?.authority?.split(":").at(-1));
      if (
        match?.groups?.authority === undefined ||
        match.groups.name !== imageName ||
        !Number.isInteger(port) ||
        port > 65_535
      ) {
        addError(errors, "image_repository", { field: "environment" });
      } else if (
        loopbackAuthority !== undefined &&
        loopbackAuthority !== match.groups.authority
      ) {
        addError(errors, "image_repository", { field: "environment" });
      } else {
        loopbackAuthority = match.groups.authority;
      }
    }
    const existing = expectedReferences.get(imageName);
    if (existing !== undefined && existing !== reference) {
      addError(errors, "image_provenance", { field: "environment" });
    } else {
      expectedReferences.set(imageName, reference);
    }
  }
  return expectedReferences;
}

function validateResourceDefinitions(
  stack: ReleaseStackInput,
  errors: ReleaseValidationError[],
): void {
  const networks = stack.compose.networks ?? {};
  const expectedNetworkDefinitions = expectedNetworks[stack.name];
  if (!exactKeys(networks, Object.keys(expectedNetworkDefinitions))) {
    addError(errors, "network_contract", { stack: stack.name });
  }
  for (const [name, expected] of Object.entries(expectedNetworkDefinitions)) {
    const actual = networks[name];
    const actualRecord = actual as Record<string, unknown> | undefined;
    const ipam = actualRecord?.ipam;
    if (
      actual === undefined ||
      Object.keys(actual).some(
        (key) => !["external", "internal", "ipam", "name"].includes(key),
      ) ||
      (ipam !== undefined &&
        (!isRecord(ipam) || Object.keys(ipam).length !== 0)) ||
      actual.name !== expected.name ||
      actual.internal !== expected.internal ||
      actual.external !== expected.external
    ) {
      addError(errors, "network_contract", { stack: stack.name });
    }
  }

  const volumes = stack.compose.volumes ?? {};
  const expectedVolumeDefinitions = expectedVolumes[stack.name];
  if (!exactKeys(volumes, Object.keys(expectedVolumeDefinitions))) {
    addError(errors, "volume_contract", { stack: stack.name });
  }
  for (const [name, expected] of Object.entries(expectedVolumeDefinitions)) {
    if (
      volumes[name]?.name !== expected.name ||
      (volumes[name] !== undefined &&
        !exactKeys(volumes[name] as Record<string, unknown>, ["name"]))
    ) {
      addError(errors, "volume_contract", { stack: stack.name });
    }
  }
}

function serviceNetworkContractMatches(
  service: ComposeService,
  expected: Readonly<Record<string, number | undefined>>,
): boolean {
  const actual = service.networks;
  if (Array.isArray(actual)) {
    return (
      exactStringArray(actual, Object.keys(expected)) &&
      Object.values(expected).every((priority) => priority === undefined)
    );
  }
  const values = actual ?? {};
  if (!exactKeys(values, Object.keys(expected))) return false;
  return Object.entries(expected).every(([name, priority]) => {
    const value = values[name];
    if (value === null || value === undefined) return priority === undefined;
    if (!isRecord(value)) return false;
    if (!exactKeys(value, priority === undefined ? [] : ["gw_priority"])) {
      return false;
    }
    return (
      (value.gw_priority === undefined
        ? undefined
        : Number(value.gw_priority)) === priority
    );
  });
}

function normalizePersistentMount(
  value: ComposeVolumeMount,
): PersistentMountContract | undefined {
  if (typeof value === "string") {
    const parts = value.split(":");
    if (parts.length < 2 || parts.length > 3) return undefined;
    return { source: parts[0] ?? "", target: parts[1] ?? "" };
  }
  if (
    value.type !== "volume" ||
    typeof value.source !== "string" ||
    typeof value.target !== "string" ||
    !exactKeys(value as Record<string, unknown>, [
      "source",
      "target",
      "type",
      "volume",
    ]) ||
    !isRecord(value.volume) ||
    Object.keys(value.volume).length !== 0
  ) {
    return undefined;
  }
  return { source: value.source, target: value.target };
}

function persistentMountContractMatches(
  service: ComposeService,
  expected: readonly PersistentMountContract[],
): boolean {
  const actual = (service.volumes ?? []).map(normalizePersistentMount);
  if (actual.some((value) => value === undefined)) return false;
  const observed = (actual as PersistentMountContract[])
    .map(({ source, target }) => `${source}\u0000${target}`)
    .sort();
  const wanted = expected
    .map(({ source, target }) => `${source}\u0000${target}`)
    .sort();
  return (
    observed.length === wanted.length &&
    observed.every((value, index) => value === wanted[index])
  );
}

function dependencyContractMatches(
  service: ComposeService,
  expected: Readonly<Record<string, DependencyContract>>,
): boolean {
  const actual = service.depends_on ?? {};
  if (!exactKeys(actual, Object.keys(expected))) return false;
  return Object.entries(expected).every(([name, contract]) => {
    const dependency = actual[name];
    return (
      dependency?.condition === contract.condition &&
      dependency.required === contract.required &&
      dependency.restart === undefined
    );
  });
}

function securityContractMatches(
  service: ComposeService,
  expected: SecurityContract,
): boolean {
  return (
    service.user === expected.user &&
    service.read_only === expected.readOnly &&
    exactStringArray(service.cap_drop, expected.capDrop) &&
    exactStringArray(service.security_opt, expected.securityOpt) &&
    exactStringArray(service.tmpfs, expected.tmpfs) &&
    exactStringArray(service.group_add, expected.groupAdd) &&
    service.cap_add === undefined &&
    service.devices === undefined &&
    service.ipc === undefined &&
    service.network_mode === undefined &&
    service.pid === undefined &&
    service.privileged === undefined &&
    service.sysctls === undefined &&
    service.uts === undefined
  );
}

function expectedSecretPath(
  stackName: ReleaseStackInput["name"],
  source: string,
  environment: Readonly<Record<string, string>>,
): string {
  if (source === "admin_access_htpasswd") {
    return `${environment.TF_ADMIN_CREDENTIAL_DIRECTORY}/admin_access_htpasswd`;
  }
  const directory =
    stackName === "apollo-platform"
      ? environment.PLATFORM_SECRET_DIRECTORY
      : environment.TF_SECRET_DIRECTORY;
  return `${directory}/${source}`;
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
  if (match?.groups?.digest === undefined) {
    addError(errors, "mutable_image", context);
    return undefined;
  }
  if (match.groups.digest === zeroDigest) {
    addError(errors, "placeholder_image_digest", context);
    return undefined;
  }
  if (parseImmutableImage(image) === undefined) {
    addError(errors, "mutable_image", context);
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
  releaseEnvironment: Readonly<Record<string, string>>,
  mountedTargets: Set<string>,
  errors: ReleaseValidationError[],
  context: Omit<ReleaseValidationError, "code">,
): void {
  if (
    !exactRuntimeEnvironment(
      service.environment,
      expectedEnvironmentForService(serviceName, releaseEnvironment),
    )
  ) {
    addError(errors, "environment_contract", {
      ...context,
      field: "environment",
    });
  }
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
  validateReleaseEnvironment(input, errors);
  const artifactReferences = validateReleaseArtifact(input, errors);
  const expectedImageReferences = validateReleaseImages(
    input,
    artifactReferences,
    errors,
  );

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
    validateResourceDefinitions(stack, errors);
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
      const definition = stack.compose.secrets?.[source];
      if (!actualDefinitions.has(source)) {
        addError(errors, "missing_secret_definition", {
          stack: stackName,
          field: "secrets",
        });
      } else if (
        definition?.file !==
          expectedSecretPath(stackName, source, input.environment) ||
        !exactKeys(
          definition as Record<string, unknown>,
          definition?.name === undefined ? ["file"] : ["file", "name"],
        ) ||
        (definition.name !== undefined &&
          definition.name !== `${stackName}_${source}`)
      ) {
        addError(errors, "secret_definition_path", {
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
      const parsedImage = parseImmutableImage(service.image);
      const imageName = serviceArtifactImages[serviceName];
      if (
        parsedImage !== undefined &&
        input.mode === "production" &&
        parsedImage.repository !== approvedImageRepositories[imageName]
      ) {
        addError(errors, "image_repository", context);
      }
      if (
        imageName === undefined ||
        service.image !== expectedImageReferences.get(imageName)
      ) {
        addError(errors, "image_provenance", context);
      }
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
        input.environment,
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

      if (
        !serviceNetworkContractMatches(
          service,
          expectedServiceNetworks[serviceName] ?? {},
        )
      ) {
        addError(errors, "service_network_contract", context);
      }
      if (
        !persistentMountContractMatches(
          service,
          expectedPersistentMounts[serviceName] ?? [],
        )
      ) {
        addError(errors, "persistent_mount_contract", context);
      }
      if (
        !dependencyContractMatches(
          service,
          expectedDependencies[serviceName] ?? {},
        )
      ) {
        addError(errors, "dependency_contract", context);
      }
      if (
        !exactStringArray(service.profiles, expectedProfiles[serviceName] ?? [])
      ) {
        addError(errors, "profile_contract", context);
      }
      if (
        !securityContractMatches(
          service,
          expectedSecurity[serviceName] ?? defaultSecurity,
        )
      ) {
        addError(errors, "security_contract", context);
      }

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

const composeAmbientEnvironmentAllowlist = [
  "COMSPEC",
  "ComSpec",
  "HOME",
  "PATH",
  "PATHEXT",
  "Path",
  "ProgramFiles",
  "ProgramW6432",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
] as const;

export function isolatedComposeEnvironment(
  environment: Record<string, string>,
  ambient: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const isolated: NodeJS.ProcessEnv = {};
  for (const name of composeAmbientEnvironmentAllowlist) {
    if (ambient[name] !== undefined) isolated[name] = ambient[name];
  }
  for (const [name, value] of Object.entries(environment)) {
    isolated[name] = value;
  }
  return isolated;
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
      env: isolatedComposeEnvironment(environment),
      windowsHide: true,
    },
  );
  if (rendered.status !== 0) throw new Error(`compose_render_failed:${stack}`);
  return {
    name: stack,
    compose: JSON.parse(rendered.stdout) as ComposeDocument,
  };
}

const simpleCliErrorCodes = new Set([
  "invalid_arguments",
  "invalid_release_environment",
  "invalid_release_manifest",
  "invalid_validation_mode",
  "missing_env_file",
  "missing_release_manifest",
]);

export function sanitizeCoolifyReleaseError(
  error: unknown,
): ReleaseValidationError {
  if (!(error instanceof Error)) return { code: "release_error" };
  if (simpleCliErrorCodes.has(error.message)) {
    return { code: error.message };
  }
  const composeFailure = error.message.match(
    /^compose_render_failed:(apollo-platform|apollo-tf)$/,
  );
  if (composeFailure?.[1] !== undefined) {
    return { code: "compose_render_failed", stack: composeFailure[1] };
  }
  return { code: "release_error" };
}

function parseCliArguments(argv: string[]): {
  envFile: string;
  mode: ReleaseValidationMode;
  releaseManifest?: string;
} {
  const values = new Map<string, string>();
  const allowed = new Set(["--env-file", "--mode", "--release-manifest"]);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      flag === undefined ||
      value === undefined ||
      !allowed.has(flag) ||
      values.has(flag) ||
      value.startsWith("--")
    ) {
      throw new Error("invalid_arguments");
    }
    values.set(flag, value);
  }
  const envFile = values.get("--env-file");
  if (envFile === undefined) throw new Error("missing_env_file");
  const modeValue = values.get("--mode");
  if (modeValue !== "production" && modeValue !== "loopback-local-smoke") {
    throw new Error("invalid_validation_mode");
  }
  const releaseManifest = values.get("--release-manifest");
  if (modeValue === "production" && releaseManifest === undefined) {
    throw new Error("missing_release_manifest");
  }
  if (modeValue === "loopback-local-smoke" && releaseManifest !== undefined) {
    throw new Error("invalid_arguments");
  }
  return { envFile, mode: modeValue, releaseManifest };
}

function parseReleaseArtifact(path: string): ReleaseArtifact {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("invalid_release_manifest");
  }
  if (!isRecord(parsed)) throw new Error("invalid_release_manifest");
  return parsed as ReleaseArtifact;
}

export function runCoolifyReleaseCli(argv: string[]): number {
  try {
    const arguments_ = parseCliArguments(argv);
    const sourcePath = fileURLToPath(import.meta.url);
    const repositoryRoot = resolve(dirname(sourcePath), "../..");
    const envFile = resolve(repositoryRoot, arguments_.envFile);
    const environment = parseEnvironment(envFile);
    const releaseArtifact =
      arguments_.releaseManifest === undefined
        ? undefined
        : parseReleaseArtifact(
            resolve(repositoryRoot, arguments_.releaseManifest),
          );
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
    const result = validateCoolifyRelease({
      environment,
      mode: arguments_.mode,
      releaseArtifact,
      stacks,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 1;
  } catch (error) {
    const result: ReleaseValidationResult = {
      ok: false,
      errors: [sanitizeCoolifyReleaseError(error)],
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
