import { describe, expect, it, vi } from "vitest";

import * as coolifyReleaseModule from "./coolify-release.js";
import {
  validateCoolifyRelease,
  type ComposeSecretMount,
  type ComposeService,
  type ReleaseStackInput,
  type ReleaseValidationInput,
} from "./coolify-release.js";

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
type ServiceName =
  | (typeof platformServices)[number]
  | (typeof tfServices)[number];

const longRunningServices = new Set<ServiceName>([
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
const publishedPorts: Readonly<
  Partial<Record<ServiceName, { published: number; target: number }>>
> = {
  "platform-api": { published: 18200, target: 8080 },
  "tf-api": { published: 18201, target: 8080 },
  "tf-web": { published: 18202, target: 80 },
  "tf-admin": { published: 18203, target: 80 },
};
const sourceCommit = "a".repeat(40);
const imageNames = [
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
type ImageName = (typeof imageNames)[number];

const serviceImageNames: Readonly<Record<ServiceName, ImageName>> = {
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
const imageRepositories = Object.fromEntries(
  imageNames.map((name) => [
    name,
    name === "redis"
      ? "docker.io/library/redis"
      : `ghcr.io/altis13/apollo-${name}`,
  ]),
) as Record<ImageName, string>;
const imageDigests = Object.fromEntries(
  imageNames.map((name, index) => [
    name,
    `sha256:${(index + 1).toString(16).repeat(64)}`,
  ]),
) as Record<ImageName, string>;

const exactNetworks: Readonly<
  Record<
    ReleaseStackInput["name"],
    Record<string, { external?: boolean; internal?: boolean; name: string }>
  >
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
const exactVolumes: Readonly<
  Record<ReleaseStackInput["name"], Record<string, { name: string }>>
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
const exactServiceNetworks: Readonly<
  Record<ServiceName, Record<string, { gw_priority?: number } | null>>
> = {
  "platform-api": {
    "platform-bridge": null,
    "platform-data": null,
    "platform-edge": null,
  },
  "platform-migrate": { "platform-data": null },
  "platform-postgres": { "platform-data": null },
  "platform-redis": { "platform-data": null },
  "tf-admin": { "tf-edge": null },
  "tf-api": {
    "platform-bridge": null,
    "tf-data": null,
    "tf-download-control": null,
    "tf-download-queue": null,
    "tf-edge": null,
    "tf-integrations-control": null,
    "tf-search-control": null,
  },
  "tf-baseline": { "tf-data": null },
  "tf-download-redis": { "tf-download-queue": null },
  "tf-download-worker": {
    "tf-download-control": null,
    "tf-download-egress": { gw_priority: 1 },
    "tf-download-queue": null,
  },
  "tf-integrations": {
    "tf-integrations-control": null,
    "tf-integrations-data": null,
    "tf-integrations-egress": { gw_priority: 1 },
  },
  "tf-integrations-migrate": { "tf-integrations-data": null },
  "tf-integrations-postgres": { "tf-integrations-data": null },
  "tf-migrate": { "tf-data": null },
  "tf-postgres": { "tf-data": null },
  "tf-redis": { "tf-data": null },
  "tf-role-bootstrap": { "tf-data": null },
  "tf-search": {
    "tf-search-control": null,
    "tf-search-egress": { gw_priority: 1 },
  },
  "tf-web": { "tf-edge": null },
};
const exactPersistentMounts: Readonly<
  Record<ServiceName, readonly [string, string][]>
> = {
  "platform-api": [],
  "platform-migrate": [],
  "platform-postgres": [["platform-postgres-data", "/var/lib/postgresql/data"]],
  "platform-redis": [["platform-redis-data", "/data"]],
  "tf-admin": [],
  "tf-api": [],
  "tf-baseline": [],
  "tf-download-redis": [["tf-download-redis-data", "/data"]],
  "tf-download-worker": [["tf-downloads", "/var/lib/apollo-tf/downloads"]],
  "tf-integrations": [],
  "tf-integrations-migrate": [],
  "tf-integrations-postgres": [
    ["tf-integrations-postgres-data", "/var/lib/postgresql/data"],
  ],
  "tf-migrate": [],
  "tf-postgres": [["tf-postgres-data", "/var/lib/postgresql/data"]],
  "tf-redis": [["tf-redis-data", "/data"]],
  "tf-role-bootstrap": [],
  "tf-search": [],
  "tf-web": [],
};
const exactDependencies: Readonly<
  Record<ServiceName, Record<string, { condition: string; required: boolean }>>
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
const exactProfiles: Readonly<Partial<Record<ServiceName, string[]>>> = {
  "tf-baseline": ["baseline"],
  "tf-role-bootstrap": ["baseline"],
};
const hardenedServices: Readonly<
  Partial<
    Record<
      ServiceName,
      {
        group_add?: string[];
        tmpfs: string[];
        user: string;
      }
    >
  >
> = {
  "platform-api": {
    tmpfs: ["/tmp:rw,noexec,nosuid,size=16m"],
    user: "10001:10001",
  },
  "platform-migrate": {
    tmpfs: ["/tmp:rw,noexec,nosuid,size=16m"],
    user: "10001:10001",
  },
  "platform-redis": {
    tmpfs: ["/tmp:rw,noexec,nosuid,size=16m"],
    user: "999:999",
  },
  "tf-api": {
    tmpfs: ["/tmp:rw,noexec,nosuid,size=32m"],
    user: "10001:10001",
  },
  "tf-baseline": {
    group_add: ["10002"],
    tmpfs: ["/tmp:rw,noexec,nosuid,size=16m"],
    user: "10001:10001",
  },
  "tf-download-redis": {
    tmpfs: ["/tmp:rw,noexec,nosuid,size=16m"],
    user: "999:999",
  },
  "tf-download-worker": {
    tmpfs: ["/tmp:rw,noexec,nosuid,size=64m"],
    user: "10001:10001",
  },
  "tf-integrations": {
    tmpfs: ["/tmp:rw,noexec,nosuid,size=16m"],
    user: "10001:10001",
  },
  "tf-integrations-migrate": {
    tmpfs: ["/tmp:rw,noexec,nosuid,size=16m"],
    user: "10001:10001",
  },
  "tf-migrate": {
    tmpfs: ["/tmp:rw,noexec,nosuid,size=16m"],
    user: "10001:10001",
  },
  "tf-redis": {
    tmpfs: ["/tmp:rw,noexec,nosuid,size=16m"],
    user: "999:999",
  },
  "tf-role-bootstrap": {
    group_add: ["10002"],
    tmpfs: ["/tmp:rw,noexec,nosuid,size=16m"],
    user: "999:999",
  },
  "tf-search": {
    tmpfs: [
      "/tmp:rw,noexec,nosuid,size=32m",
      "/tmp/yt-dlp:rw,noexec,nosuid,size=64m",
    ],
    user: "10001:10001",
  },
};

function mount(
  source: string,
  uid = "10001",
  gid = uid,
  mode = "0400",
): ComposeSecretMount {
  return { source, target: source, uid, gid, mode };
}

const exactSecretMounts = {
  "platform-api": [
    mount("platform_assertion_private_jwk"),
    mount("platform_assertion_public_jwks"),
    mount("platform_oauth_clients"),
    mount("platform_operator_bootstrap_token"),
    mount("platform_runtime_database_url"),
  ],
  "platform-migrate": [mount("platform_migrator_database_url")],
  "platform-postgres": [
    mount("platform_postgres_admin_password", "999"),
    mount("platform_migrator_password", "999"),
    mount("platform_runtime_password", "999"),
  ],
  "platform-redis": [],
  "tf-admin": [
    mount("admin_dashboard_token"),
    mount("admin_access_htpasswd", "0"),
  ],
  "tf-api": [
    mount("admin_dashboard_token"),
    mount("tf_client_secret"),
    mount("tf_runtime_database_url"),
    mount("tf_integrations_internal_auth_secret"),
    mount("tf_download_queue_redis_url"),
    mount("tf_download_internal_auth_secret"),
    mount("tf_module_heartbeat_keys"),
    mount("tf_search_internal_auth_secret"),
  ],
  "tf-baseline": [mount("tf_admin_database_url", "0", "10002", "0440")],
  "tf-download-redis": [mount("tf_download_queue_password", "999")],
  "tf-download-worker": [
    mount("tf_download_queue_redis_url"),
    mount("tf_download_internal_auth_secret"),
    mount("tf_download_heartbeat_secret"),
  ],
  "tf-integrations": [
    mount("tf_integrations_runtime_database_url"),
    mount("tf_integrations_token_keyring"),
    mount("tf_integrations_spotify_client_id"),
    mount("tf_integrations_spotify_client_secret"),
    mount("tf_integrations_internal_auth_secret"),
    mount("tf_integrations_heartbeat_secret"),
  ],
  "tf-integrations-migrate": [mount("tf_integrations_migrator_database_url")],
  "tf-integrations-postgres": [
    mount("tf_integrations_postgres_admin_password", "999"),
    mount("tf_integrations_migrator_password", "999"),
    mount("tf_integrations_runtime_password", "999"),
  ],
  "tf-migrate": [mount("tf_migrator_database_url")],
  "tf-postgres": [
    mount("tf_postgres_admin_password", "999"),
    mount("tf_migrator_password", "999"),
    mount("tf_runtime_password", "999"),
  ],
  "tf-redis": [],
  "tf-role-bootstrap": [
    mount("tf_admin_database_url", "0", "10002", "0440"),
    mount("tf_migrator_password", "999"),
    mount("tf_runtime_password", "999"),
  ],
  "tf-search": [
    mount("tf_search_internal_auth_secret"),
    mount("tf_search_heartbeat_secret"),
  ],
  "tf-web": [],
} satisfies Record<ServiceName, ComposeSecretMount[]>;
const exactSecretFileEnvironment: Readonly<
  Partial<Record<ServiceName, Record<string, string>>>
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

function exactPlainEnvironment(
  releaseEnvironment: Readonly<Record<string, string>>,
): Readonly<Record<ServiceName, Record<string, string>>> {
  return {
    "platform-api": {
      APOLLO_ALLOWED_ORIGINS: releaseEnvironment["PLATFORM_ALLOWED_ORIGINS"]!,
      APOLLO_API_VERSION: releaseEnvironment["PLATFORM_API_VERSION"]!,
      APOLLO_DEPLOYED_AT: releaseEnvironment["PLATFORM_DEPLOYED_AT"]!,
      APOLLO_DEVELOPMENT_TOKEN_ECHO: "false",
      APOLLO_INTROSPECTION_CLIENT_ID: "apollo-tf-api",
      APOLLO_ISSUER: releaseEnvironment["PLATFORM_PUBLIC_ORIGIN"]!,
      APOLLO_REDIS_URL: "redis://platform-redis:6379",
      APOLLO_TRUST_PROXY_HOPS: "1",
      NODE_ENV: "production",
      PORT: "8080",
    },
    "platform-migrate": {},
    "platform-postgres": {
      POSTGRES_DB: "apollo_platform",
      POSTGRES_USER: "postgres",
    },
    "platform-redis": {},
    "tf-admin": { APOLLO_API_UPSTREAM: "http://tf-api:8080" },
    "tf-api": {
      APOLLO_API_VERSION: releaseEnvironment["TF_API_VERSION"]!,
      APOLLO_DEPLOYED_AT: releaseEnvironment["TF_DEPLOYED_AT"]!,
      APOLLO_PLATFORM_API_ORIGIN: "http://platform-api:8080",
      APOLLO_PLATFORM_ISSUER: releaseEnvironment["PLATFORM_PUBLIC_ORIGIN"]!,
      APOLLO_TF_AUTH_REDIS_URL: "redis://tf-redis:6379/1",
      APOLLO_TF_BRIDGE_ALLOW_INTERNAL_HTTP: "true",
      APOLLO_TF_CALLBACK_URL: `${releaseEnvironment["TF_API_PUBLIC_ORIGIN"]!}/api/auth/callback`,
      APOLLO_TF_CLIENT_ID: "apollo-tf-api",
      APOLLO_TF_WEB_ORIGIN: releaseEnvironment["TF_PUBLIC_ORIGIN"]!,
      NODE_ENV: "production",
      PORT: "8080",
      REDIS_URL: "redis://tf-redis:6379/0",
      SERVER_URL: releaseEnvironment["TF_API_PUBLIC_ORIGIN"]!,
      TF_DOWNLOAD_QUEUE_ALLOW_INSECURE_REDIS: "true",
      TF_DOWNLOAD_WORKER_ALLOW_INSECURE_HTTP: "true",
      TF_DOWNLOAD_WORKER_ORIGIN: "http://tf-download-worker:8080",
      TF_INTEGRATIONS_ALLOW_INSECURE_HTTP: "true",
      TF_INTEGRATIONS_ORIGIN: "http://tf-integrations:8080",
      TF_SEARCH_ALLOW_INSECURE_HTTP: "true",
      TF_SEARCH_ORIGIN: "http://tf-search:8080",
      WEB_URL: releaseEnvironment["TF_PUBLIC_ORIGIN"]!,
    },
    "tf-baseline": {},
    "tf-download-redis": {},
    "tf-download-worker": {
      APOLLO_API_VERSION: releaseEnvironment["TF_DOWNLOAD_VERSION"]!,
      APOLLO_DEPLOYED_AT: releaseEnvironment["TF_DOWNLOAD_DEPLOYED_AT"]!,
      NODE_ENV: "production",
      PORT: "8080",
      TF_DOWNLOAD_HEARTBEAT_ALLOW_INSECURE_HTTP: "true",
      TF_DOWNLOAD_HEARTBEAT_API_ORIGIN: "http://tf-api:8080",
      TF_DOWNLOAD_QUEUE_ALLOW_INSECURE_REDIS: "true",
      TF_DOWNLOAD_STORAGE_ROOT: "/var/lib/apollo-tf/downloads",
    },
    "tf-integrations": {
      APOLLO_API_VERSION: releaseEnvironment["TF_INTEGRATIONS_VERSION"]!,
      APOLLO_DEPLOYED_AT:
        releaseEnvironment["TF_INTEGRATIONS_DEPLOYED_AT"]!,
      NODE_ENV: "production",
      PORT: "8080",
      TF_INTEGRATIONS_HEARTBEAT_ALLOW_INSECURE_HTTP: "true",
      TF_INTEGRATIONS_HEARTBEAT_API_ORIGIN: "http://tf-api:8080",
      TF_INTEGRATIONS_SPOTIFY_CALLBACK_URI: `${releaseEnvironment["TF_API_PUBLIC_ORIGIN"]!}/api/spotify/callback`,
    },
    "tf-integrations-migrate": {},
    "tf-integrations-postgres": {
      POSTGRES_DB: "apollo_tf_integrations",
      POSTGRES_USER: "postgres",
    },
    "tf-migrate": {},
    "tf-postgres": {
      POSTGRES_DB: "apollo_trackfinder",
      POSTGRES_USER: "postgres",
    },
    "tf-redis": {},
    "tf-role-bootstrap": {},
    "tf-search": {
      APOLLO_API_VERSION: releaseEnvironment["TF_SEARCH_VERSION"]!,
      APOLLO_DEPLOYED_AT: releaseEnvironment["TF_SEARCH_DEPLOYED_AT"]!,
      NODE_ENV: "production",
      PORT: "8080",
      TF_SEARCH_HEARTBEAT_ALLOW_INSECURE_HTTP: "true",
      TF_SEARCH_HEARTBEAT_API_ORIGIN: "http://tf-api:8080",
    },
    "tf-web": {},
  };
}

function serviceFixture(
  stackName: ReleaseStackInput["name"],
  name: ServiceName,
  releaseEnvironment: Readonly<Record<string, string>>,
): ComposeService {
  const isLongRunning = longRunningServices.has(name);
  const imageName = serviceImageNames[name];
  const service: ComposeService = {
    image: `${imageRepositories[imageName]}@${imageDigests[imageName]}`,
    init: true,
    restart: isLongRunning ? "unless-stopped" : "no",
    stop_grace_period: "20s",
    pids_limit: 128,
    deploy: {
      resources: {
        limits: { cpus: "1.0", memory: "512M", pids: 128 },
      },
    },
    logging: {
      driver: "json-file",
      options: { "max-file": "5", "max-size": "10m" },
    },
    environment: {
      ...exactPlainEnvironment(releaseEnvironment)[name],
      ...(exactSecretFileEnvironment[name] ?? {}),
    },
    networks: structuredClone(exactServiceNetworks[name]),
    secrets: exactSecretMounts[name].map((secret) => ({ ...secret })),
  };
  Object.assign(service, {
    depends_on: structuredClone(exactDependencies[name]),
    profiles: structuredClone(exactProfiles[name] ?? []),
    volumes: exactPersistentMounts[name].map(([source, target]) => ({
      source,
      target,
      type: "volume",
      volume: {},
    })),
  });
  const hardened = hardenedServices[name];
  if (hardened !== undefined) {
    Object.assign(service, {
      cap_drop: ["ALL"],
      group_add: structuredClone(hardened.group_add ?? []),
      read_only: true,
      security_opt: ["no-new-privileges:true"],
      tmpfs: structuredClone(hardened.tmpfs),
      user: hardened.user,
    });
  }

  if (isLongRunning) {
    service.healthcheck = {
      test: ["CMD", "node", "-e", "process.exit(0)"],
      interval: "5s",
      timeout: "3s",
      retries: 20,
      start_period: "5s",
    };
  }
  const port = publishedPorts[name];
  if (port !== undefined) {
    service.ports = [
      {
        mode: "ingress",
        target: port.target,
        published: String(port.published),
        host_ip: "127.0.0.1",
        protocol: "tcp",
      },
    ];
  }
  return service;
}

function serviceMap(
  stackName: ReleaseStackInput["name"],
  names: readonly ServiceName[],
  releaseEnvironment: Readonly<Record<string, string>>,
): Record<string, ComposeService> {
  return Object.fromEntries(
    names.map((name) => [name, serviceFixture(stackName, name, releaseEnvironment)]),
  );
}

function secretDefinitions(
  names: readonly ServiceName[],
  directory: string,
): Record<string, { file: string }> {
  const sources = new Set(
    names.flatMap((name) =>
      exactSecretMounts[name].map(({ source }) => source ?? ""),
    ),
  );
  sources.delete("");
  return Object.fromEntries(
    [...sources].sort().map((source) => [
      source,
      {
        file:
          source === "admin_access_htpasswd"
            ? "/var/lib/apollo-tf/admin-credentials/generation-1/admin_access_htpasswd"
            : `${directory}/${source}`,
      },
    ]),
  );
}

function validInput(): ReleaseValidationInput {
  const environment = {
    PLATFORM_API_PORT: "18200",
    PLATFORM_ALLOWED_ORIGINS: "https://apollot.ru,https://admin.apollot.ru",
    PLATFORM_PUBLIC_ORIGIN: "https://api.apollot.ru",
    PLATFORM_API_VERSION: "release-a",
    PLATFORM_DEPLOYED_AT: "2026-07-28T00:00:00Z",
    PLATFORM_SECRET_DIRECTORY: "/var/lib/apollo-platform/secrets",
    RELEASE_SOURCE_COMMIT: sourceCommit,
    TF_ADMIN_PUBLIC_ORIGIN: "https://admin.apollot.ru",
    TF_ADMIN_CREDENTIAL_DIRECTORY:
      "/var/lib/apollo-tf/admin-credentials/generation-1",
    TF_ADMIN_PORT: "18203",
    TF_API_PORT: "18201",
    TF_API_PUBLIC_ORIGIN: "https://api.tf.apollot.ru",
    TF_API_VERSION: "release-a",
    TF_DEPLOYED_AT: "2026-07-28T00:00:00Z",
    TF_DOWNLOAD_DEPLOYED_AT: "2026-07-28T00:00:00Z",
    TF_DOWNLOAD_VERSION: "release-a",
    TF_INTEGRATIONS_DEPLOYED_AT: "2026-07-28T00:00:00Z",
    TF_INTEGRATIONS_VERSION: "release-a",
    TF_PUBLIC_ORIGIN: "https://tf.apollot.ru",
    TF_SEARCH_DEPLOYED_AT: "2026-07-28T00:00:00Z",
    TF_SEARCH_VERSION: "release-a",
    TF_SECRET_DIRECTORY: "/var/lib/apollo-tf/secrets",
    TF_WEB_PORT: "18202",
    PLATFORM_API_IMAGE: `${imageRepositories["platform-api"]}@${imageDigests["platform-api"]}`,
    PLATFORM_POSTGRES_IMAGE: `${imageRepositories["platform-postgres"]}@${imageDigests["platform-postgres"]}`,
    PLATFORM_REDIS_IMAGE: `${imageRepositories.redis}@${imageDigests.redis}`,
    TF_ADMIN_IMAGE: `${imageRepositories["tf-admin"]}@${imageDigests["tf-admin"]}`,
    TF_API_IMAGE: `${imageRepositories["tf-api"]}@${imageDigests["tf-api"]}`,
    TF_DOWNLOAD_REDIS_IMAGE: `${imageRepositories["tf-download-redis"]}@${imageDigests["tf-download-redis"]}`,
    TF_DOWNLOAD_WORKER_IMAGE: `${imageRepositories["tf-download-worker"]}@${imageDigests["tf-download-worker"]}`,
    TF_INTEGRATIONS_IMAGE: `${imageRepositories["tf-integrations"]}@${imageDigests["tf-integrations"]}`,
    TF_INTEGRATIONS_POSTGRES_IMAGE: `${imageRepositories["tf-integrations-postgres"]}@${imageDigests["tf-integrations-postgres"]}`,
    TF_POSTGRES_IMAGE: `${imageRepositories["tf-postgres"]}@${imageDigests["tf-postgres"]}`,
    TF_REDIS_IMAGE: `${imageRepositories.redis}@${imageDigests.redis}`,
    TF_SEARCH_IMAGE: `${imageRepositories["tf-search"]}@${imageDigests["tf-search"]}`,
    TF_WEB_IMAGE: `${imageRepositories["tf-web"]}@${imageDigests["tf-web"]}`,
  };
  const platform = serviceMap("apollo-platform", platformServices, environment);
  const tf = serviceMap("apollo-tf", tfServices, environment);

  return {
    mode: "production",
    releaseArtifact: {
      formatVersion: 1,
      sourceCommit,
      images: imageNames.map((name) => ({
        imageDigest: imageDigests[name],
        imageReference: `${imageRepositories[name]}@${imageDigests[name]}`,
        name,
        repository: imageRepositories[name],
      })),
    },
    environment,
    stacks: [
      {
        name: "apollo-platform",
        compose: {
          name: "apollo-platform",
          services: platform,
          secrets: secretDefinitions(
            platformServices,
            "/var/lib/apollo-platform/secrets",
          ),
          networks: structuredClone(exactNetworks["apollo-platform"]),
          volumes: structuredClone(exactVolumes["apollo-platform"]),
        },
      },
      {
        name: "apollo-tf",
        compose: {
          name: "apollo-tf",
          services: tf,
          secrets: secretDefinitions(tfServices, "/var/lib/apollo-tf/secrets"),
          networks: structuredClone(exactNetworks["apollo-tf"]),
          volumes: structuredClone(exactVolumes["apollo-tf"]),
        },
      },
    ],
  } as ReleaseValidationInput;
}

function errorCodes(input: ReleaseValidationInput): readonly string[] {
  const result = validateCoolifyRelease(input);
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.errors.map(({ code }) => code);
}

type ExactValidationInput = ReleaseValidationInput;

function exactInput(): ExactValidationInput {
  return validInput() as ExactValidationInput;
}

describe("validateCoolifyRelease", () => {
  it("returns only deterministic redacted release manifest fields", () => {
    const result = validateCoolifyRelease(validInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(Object.keys(result).sort()).toEqual(["ok", "stacks"]);
    expect(result.stacks.map(({ name }) => name)).toEqual([
      "apollo-platform",
      "apollo-tf",
    ]);
    expect(result.stacks[0].services.map(({ name }) => name)).toEqual([
      ...platformServices,
    ]);
    expect(result.stacks[1].services.map(({ name }) => name)).toEqual([
      ...tfServices,
    ]);
    for (const stack of result.stacks) {
      expect(Object.keys(stack).sort()).toEqual([
        "name",
        "publicOrigins",
        "services",
        "volumes",
      ]);
      for (const service of stack.services) {
        expect(Object.keys(service).sort()).toEqual([
          "imageDigest",
          "name",
          "ports",
        ]);
      }
    }
    expect(JSON.stringify(result)).not.toContain("/run/secrets/");
    expect(JSON.stringify(result)).not.toContain("/var/lib/");
  });

  it("accepts Docker Compose JSON object volume mounts", () => {
    const input = validInput();
    input.stacks[0].compose.services["platform-postgres"].volumes = [
      {
        type: "volume",
        source: "platform-postgres-data",
        target: "/var/lib/postgresql/data",
        volume: {},
      },
    ];
    expect(validateCoolifyRelease(input).ok).toBe(true);
  });

  it("accepts documented non-secret runtime controls with sensitive-looking names", () => {
    const input = validInput();
    expect(validateCoolifyRelease(input).ok).toBe(true);
  });

  it.each([
    ["apollo-platform", "platform-api", "APOLLO_ISSUER"],
    ["apollo-platform", "platform-api", "APOLLO_ALLOWED_ORIGINS"],
    ["apollo-platform", "platform-api", "NODE_ENV"],
    [
      "apollo-tf",
      "tf-integrations",
      "TF_INTEGRATIONS_HEARTBEAT_API_ORIGIN",
    ],
    [
      "apollo-tf",
      "tf-integrations",
      "TF_INTEGRATIONS_SPOTIFY_CALLBACK_URI",
    ],
    [
      "apollo-tf",
      "tf-search",
      "TF_SEARCH_HEARTBEAT_ALLOW_INSECURE_HTTP",
    ],
    [
      "apollo-tf",
      "tf-download-worker",
      "TF_DOWNLOAD_HEARTBEAT_API_ORIGIN",
    ],
    ["apollo-tf", "tf-api", "APOLLO_PLATFORM_API_ORIGIN"],
    ["apollo-tf", "tf-api", "APOLLO_PLATFORM_ISSUER"],
    ["apollo-tf", "tf-api", "APOLLO_TF_BRIDGE_ALLOW_INTERNAL_HTTP"],
    ["apollo-tf", "tf-api", "APOLLO_TF_CALLBACK_URL"],
    ["apollo-tf", "tf-api", "SERVER_URL"],
    ["apollo-tf", "tf-api", "WEB_URL"],
    ["apollo-tf", "tf-api", "TF_DOWNLOAD_WORKER_ORIGIN"],
    ["apollo-tf", "tf-api", "TF_INTEGRATIONS_ORIGIN"],
    ["apollo-tf", "tf-api", "TF_SEARCH_ORIGIN"],
    ["apollo-tf", "tf-admin", "APOLLO_API_UPSTREAM"],
  ] as const)(
    "rejects rendered environment drift for %s.%s.%s without leaking values",
    (stackName, serviceName, environmentName) => {
      const input = validInput();
      const hostileValue = `https://hostile.invalid/${environmentName.toLowerCase()}`;
      const stack = input.stacks.find(({ name }) => name === stackName)!;
      stack.compose.services[serviceName].environment![environmentName] =
        hostileValue;

      const result = validateCoolifyRelease(input);
      expect(result).toEqual({
        ok: false,
        errors: [
          {
            code: "environment_contract",
            field: "environment",
            service: serviceName,
            stack: stackName,
          },
        ],
      });

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(hostileValue);
      for (const expectedOrigin of [
        "https://apollot.ru,https://admin.apollot.ru",
        "https://api.apollot.ru",
        "https://admin.apollot.ru",
        "https://api.tf.apollot.ru",
        "https://tf.apollot.ru",
      ]) {
        expect(serialized).not.toContain(expectedOrigin);
      }
    },
  );

  it("rejects missing rendered environment keys with one redacted contract error", () => {
    const input = validInput();
    delete input.stacks[0].compose.services["platform-api"].environment![
      "NODE_ENV"
    ];

    expect(validateCoolifyRelease(input)).toEqual({
      ok: false,
      errors: [
        {
          code: "environment_contract",
          field: "environment",
          service: "platform-api",
          stack: "apollo-platform",
        },
      ],
    });
  });

  it("rejects unexpected rendered environment keys for an otherwise empty service", () => {
    const input = validInput();
    const hostileValue = "https://hostile.invalid/unexpected-environment";
    input.stacks[0].compose.services["platform-redis"].environment![
      "UNEXPECTED_ENVIRONMENT"
    ] = hostileValue;

    const result = validateCoolifyRelease(input);
    expect(result).toEqual({
      ok: false,
      errors: [
        {
          code: "environment_contract",
          field: "environment",
          service: "platform-redis",
          stack: "apollo-platform",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(hostileValue);
  });

  it("requires every credential consumer to use its exact mounted secret file key", () => {
    const required = [
      ["apollo-platform", "platform-api", "APOLLO_ASSERTION_PRIVATE_JWK_FILE"],
      ["apollo-platform", "platform-api", "APOLLO_OAUTH_CLIENTS_FILE"],
      [
        "apollo-platform",
        "platform-api",
        "APOLLO_OPERATOR_BOOTSTRAP_TOKEN_FILE",
      ],
      ["apollo-platform", "platform-api", "DATABASE_URL_FILE"],
      ["apollo-platform", "platform-migrate", "MIGRATOR_DATABASE_URL_FILE"],
      ["apollo-platform", "platform-postgres", "POSTGRES_PASSWORD_FILE"],
      ["apollo-tf", "tf-admin", "ADMIN_ACCESS_HTPASSWD_FILE"],
      ["apollo-tf", "tf-admin", "ADMIN_DASHBOARD_TOKEN_FILE"],
      ["apollo-tf", "tf-api", "ADMIN_DASHBOARD_TOKEN_FILE"],
      ["apollo-tf", "tf-api", "APOLLO_TF_CLIENT_SECRET_FILE"],
      ["apollo-tf", "tf-api", "DATABASE_URL_FILE"],
      ["apollo-tf", "tf-download-redis", "TF_DOWNLOAD_QUEUE_PASSWORD_FILE"],
      [
        "apollo-tf",
        "tf-download-worker",
        "TF_DOWNLOAD_INTERNAL_AUTH_SECRET_FILE",
      ],
      ["apollo-tf", "tf-download-worker", "TF_DOWNLOAD_QUEUE_REDIS_URL_FILE"],
      ["apollo-tf", "tf-integrations", "TF_INTEGRATIONS_DATABASE_URL_FILE"],
      [
        "apollo-tf",
        "tf-integrations",
        "TF_INTEGRATIONS_INTERNAL_AUTH_SECRET_FILE",
      ],
      [
        "apollo-tf",
        "tf-integrations",
        "TF_INTEGRATIONS_SPOTIFY_CLIENT_SECRET_FILE",
      ],
      ["apollo-tf", "tf-integrations", "TF_INTEGRATIONS_TOKEN_KEYRING_FILE"],
      [
        "apollo-tf",
        "tf-integrations-migrate",
        "TF_INTEGRATIONS_DATABASE_URL_FILE",
      ],
      ["apollo-tf", "tf-migrate", "TF_MIGRATOR_DATABASE_URL_FILE"],
      ["apollo-tf", "tf-postgres", "POSTGRES_PASSWORD_FILE"],
      ["apollo-tf", "tf-search", "TF_SEARCH_INTERNAL_AUTH_SECRET_FILE"],
    ] as const;

    for (const [stackName, serviceName, key] of required) {
      const missing = validInput();
      const stack = missing.stacks.find(({ name }) => name === stackName)!;
      delete stack.compose.services[serviceName].environment![key];
      expect(errorCodes(missing)).toContain("missing_secret_file_environment");
    }
  });

  it.each([
    ["missing image", undefined, "missing_image"],
    [
      "mutable image",
      "ghcr.io/altis13/apollo-platform-api:latest",
      "mutable_image",
    ],
    [
      "image default",
      "${PLATFORM_API_IMAGE:-apollo-platform-api:local}",
      "image_default",
    ],
    [
      "zero digest",
      `ghcr.io/altis13/apollo-platform-api@sha256:${"0".repeat(64)}`,
      "placeholder_image_digest",
    ],
  ])("rejects a %s", (_name, image, code) => {
    const input = validInput();
    input.stacks[0].compose.services["platform-api"].image = image;
    expect(errorCodes(input)).toContain(code);
  });

  it("rejects missing, duplicate, and unexpected stacks", () => {
    const missing = validInput();
    missing.stacks.pop();
    expect(errorCodes(missing)).toContain("missing_stack");

    const duplicate = validInput();
    duplicate.stacks.push(structuredClone(duplicate.stacks[0]));
    expect(errorCodes(duplicate)).toContain("duplicate_stack");

    const unexpected = validInput();
    const extra = structuredClone(unexpected.stacks[0]);
    extra.name = "apollo-extra" as ReleaseStackInput["name"];
    extra.compose.name = "apollo-extra";
    unexpected.stacks.push(extra);
    expect(errorCodes(unexpected)).toContain("unexpected_stack");
  });

  it("rejects missing and unexpected services", () => {
    const missing = validInput();
    delete missing.stacks[1].compose.services["tf-search"];
    expect(errorCodes(missing)).toContain("missing_service");

    const unexpected = validInput();
    unexpected.stacks[0].compose.services["platform-extra"] = serviceFixture(
      "apollo-platform",
      "platform-redis",
      unexpected.environment,
    );
    expect(errorCodes(unexpected)).toContain("unexpected_service");
  });

  it("rejects missing and unexpected secret mounts and definitions", () => {
    const missingMount = validInput();
    missingMount.stacks[1].compose.services["tf-api"].secrets!.pop();
    expect(errorCodes(missingMount)).toContain("missing_secret_mount");

    const unexpectedMount = validInput();
    unexpectedMount.stacks[1].compose.services["tf-api"].secrets!.push(
      mount("tf_unexpected_secret"),
    );
    unexpectedMount.stacks[1].compose.secrets!["tf_unexpected_secret"] = {
      file: "/var/lib/apollo-tf/secrets/tf_unexpected_secret",
    };
    expect(errorCodes(unexpectedMount)).toContain("unexpected_secret_mount");

    const missingDefinition = validInput();
    delete missingDefinition.stacks[0].compose.secrets![
      "platform_runtime_password"
    ];
    expect(errorCodes(missingDefinition)).toContain(
      "missing_secret_definition",
    );

    const unexpectedDefinition = validInput();
    unexpectedDefinition.stacks[0].compose.secrets!["platform_unused_secret"] =
      { file: "/var/lib/apollo-platform/secrets/platform_unused_secret" };
    expect(errorCodes(unexpectedDefinition)).toContain(
      "unexpected_secret_definition",
    );
  });

  it("rejects long-running services classified as one-shot or without an active healthcheck", () => {
    const restartNo = validInput();
    restartNo.stacks[1].compose.services["tf-search"].restart = "no";
    expect(errorCodes(restartNo)).toContain("service_classification");

    const disabledHealth = validInput();
    disabledHealth.stacks[1].compose.services["tf-search"].healthcheck = {
      disable: true,
    };
    expect(errorCodes(disabledHealth)).toContain("missing_health_policy");

    const noneHealth = validInput();
    noneHealth.stacks[1].compose.services["tf-search"].healthcheck = {
      test: ["NONE"],
      interval: "5s",
      timeout: "3s",
      retries: 20,
      start_period: "5s",
    };
    expect(errorCodes(noneHealth)).toContain("missing_health_policy");
  });

  it("rejects one-shot services classified as long-running", () => {
    const input = validInput();
    const service = input.stacks[0].compose.services["platform-migrate"];
    service.restart = "unless-stopped";
    service.healthcheck = {
      test: ["CMD", "true"],
      interval: "5s",
      timeout: "3s",
      retries: 20,
      start_period: "5s",
    };
    expect(errorCodes(input)).toContain("service_classification");
  });

  it.each([
    [
      "zero CPU",
      (service: ComposeService) => {
        service.deploy!.resources!.limits!.cpus = "0";
      },
      "missing_resource_policy",
    ],
    [
      "negative PID limit",
      (service: ComposeService) => {
        service.pids_limit = -1;
      },
      "missing_resource_policy",
    ],
    [
      "zero stop grace",
      (service: ComposeService) => {
        service.stop_grace_period = "0s";
      },
      "missing_resource_policy",
    ],
    [
      "zero log rotation",
      (service: ComposeService) => {
        service.logging!.options!["max-file"] = "0";
      },
      "missing_log_policy",
    ],
    [
      "zero health retries",
      (service: ComposeService) => {
        service.healthcheck!["retries"] = 0;
      },
      "missing_health_policy",
    ],
  ] as const)("rejects %s", (_name, mutate, code) => {
    const input = validInput();
    mutate(input.stacks[0].compose.services["platform-api"]);
    expect(errorCodes(input)).toContain(code);
  });

  it("rejects build entries and proxy integration labels", () => {
    const input = validInput();
    const service = input.stacks[0].compose.services["platform-api"];
    service.build = { context: "." };
    service.labels = {
      "traefik.http.routers.platform.rule": "Host(`api.apollot.ru`)",
    };
    expect(errorCodes(input)).toEqual(
      expect.arrayContaining(["build_entry", "proxy_label"]),
    );
  });

  it("rejects public, duplicate, and contract-drifted ingress ports", () => {
    const input = validInput();
    const platformPort =
      input.stacks[0].compose.services["platform-api"].ports![0];
    platformPort.host_ip = "0.0.0.0";
    input.stacks[1].compose.services["tf-api"].ports![0].published = "18200";
    expect(errorCodes(input)).toEqual(
      expect.arrayContaining([
        "duplicate_published_port",
        "non_loopback_port",
        "unexpected_published_port",
      ]),
    );
  });

  it("rejects environment-delivered credentials without echoing values", () => {
    const input = validInput();
    const rawCredential = "postgres://operator:do-not-print@db/apollo";
    input.stacks[0].compose.services["platform-api"].environment![
      "DATABASE_URL"
    ] = rawCredential;
    const result = validateCoolifyRelease(input);
    expect(result).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({
          code: "secret_environment",
          service: "platform-api",
          stack: "apollo-platform",
        }),
      ]),
    });
    expect(JSON.stringify(result)).not.toContain(rawCredential);
    expect(JSON.stringify(result)).not.toContain("/run/secrets/");
  });

  it("rejects unknown secret-like release environment names", () => {
    const input = validInput();
    input.environment["RELEASE_PRIVATE_TOKEN"] = "do-not-print";
    expect(errorCodes(input)).toContain("secret_release_environment");
    expect(JSON.stringify(validateCoolifyRelease(input))).not.toContain(
      "do-not-print",
    );
  });

  it("rejects an unknown secret-like file environment even when mounted", () => {
    const input = validInput();
    const service = input.stacks[0].compose.services["platform-api"];
    service.environment!["UNKNOWN_TOKEN_FILE"] = "/run/secrets/unknown_token";
    service.secrets!.push(mount("unknown_token"));
    input.stacks[0].compose.secrets!["unknown_token"] = {
      file: "/var/lib/apollo-platform/secrets/unknown_token",
    };
    expect(errorCodes(input)).toContain("secret_environment");
  });

  it.each([
    ["healthcheck", "missing_health_policy"],
    ["deploy", "missing_resource_policy"],
    ["logging", "missing_log_policy"],
  ] as const)("rejects a missing %s", (field, code) => {
    const input = validInput();
    delete input.stacks[0].compose.services["platform-api"][field];
    expect(errorCodes(input)).toContain(code);
  });

  it("rejects shared Platform and TF volume and network identities", () => {
    const input = validInput();
    input.stacks[1].compose.networks!["tf-edge"].name =
      "apollo-platform-edge-v1";
    input.stacks[1].compose.volumes!["tf-postgres-data"].name =
      "apollo-platform-postgres-v1";
    expect(errorCodes(input)).toEqual(
      expect.arrayContaining(["shared_network", "shared_volume"]),
    );
  });

  it("allows only the owner-defined internal Platform bridge", () => {
    const input = validInput();
    input.stacks[0].compose.networks!["platform-bridge"] = {
      internal: true,
      name: "apollo-platform-bridge-v1",
    };
    input.stacks[1].compose.networks!["platform-bridge"] = {
      external: true,
      name: "apollo-platform-bridge-v1",
    };
    expect(validateCoolifyRelease(input)).toMatchObject({ ok: true });

    input.stacks[1].compose.networks!["platform-bridge"] = {
      name: "apollo-platform-bridge-v1",
    };
    expect(errorCodes(input)).toContain("shared_network");
  });

  it.each(["uid", "gid", "mode"] as const)(
    "rejects exact secret mount %s drift",
    (field) => {
      const input = validInput();
      input.stacks[1].compose.services["tf-api"].secrets![0][field] = "0777";
      expect(errorCodes(input)).toContain("secret_mount_metadata");
    },
  );

  it("rejects an omitted explicit validation mode", () => {
    const input = exactInput();
    delete (input as Partial<Pick<ReleaseValidationInput, "mode">>).mode;
    expect(errorCodes(input)).toContain("invalid_validation_mode");
  });

  it("rejects an omitted or unexpected release environment key", () => {
    const missing = exactInput();
    delete missing.environment["TF_DOWNLOAD_DEPLOYED_AT"];
    expect(errorCodes(missing)).toContain("release_environment_keys");

    const unexpected = exactInput();
    unexpected.environment["UNRELATED_AMBIENT_VALUE"] = "sentinel";
    expect(errorCodes(unexpected)).toContain("release_environment_keys");
  });

  it("rejects an all-zero source commit in both environment and artifact", () => {
    const input = exactInput();
    input.environment["RELEASE_SOURCE_COMMIT"] = "0".repeat(40);
    input.releaseArtifact!.sourceCommit = "0".repeat(40);
    expect(errorCodes(input)).toContain("release_environment_value");
  });

  it("requires every production origin and ingress value to equal the approved contract", () => {
    const input = exactInput();
    input.environment["PLATFORM_ALLOWED_ORIGINS"] = "https://api.apollot.ru";
    input.environment["TF_API_PORT"] = "19201";
    expect(errorCodes(input)).toEqual(
      expect.arrayContaining([
        "invalid_public_origin",
        "release_environment_value",
      ]),
    );
  });

  it("rejects an approved service image from an unapproved repository", () => {
    const input = exactInput();
    input.stacks[0].compose.services["platform-api"].image =
      `registry.invalid/platform-api@${imageDigests["platform-api"]}`;
    expect(errorCodes(input)).toContain("image_repository");
  });

  it("rejects exact network and volume definition drift", () => {
    const input = exactInput();
    input.stacks[0].compose.networks!["platform-data"].internal = false;
    input.stacks[1].compose.volumes!["tf-downloads"].name =
      "apollo-tf-other-v1";
    expect(errorCodes(input)).toEqual(
      expect.arrayContaining(["network_contract", "volume_contract"]),
    );
  });

  it("rejects unexpected network, volume, and secret definition options", () => {
    const input = exactInput();
    Object.assign(input.stacks[0].compose.networks!["platform-edge"], {
      attachable: true,
    });
    Object.assign(input.stacks[0].compose.volumes!["platform-postgres-data"], {
      driver: "local",
    });
    Object.assign(
      input.stacks[0].compose.secrets!["platform_runtime_database_url"],
      { external: true },
    );
    expect(errorCodes(input)).toEqual(
      expect.arrayContaining([
        "network_contract",
        "secret_definition_path",
        "volume_contract",
      ]),
    );
  });

  it("rejects exact service network membership and route-priority drift", () => {
    const missing = exactInput();
    delete (
      missing.stacks[1].compose.services["tf-api"].networks as Record<
        string,
        unknown
      >
    )["tf-data"];
    expect(errorCodes(missing)).toContain("service_network_contract");

    const priority = exactInput();
    (
      priority.stacks[1].compose.services["tf-search"].networks as Record<
        string,
        { gw_priority?: number }
      >
    )["tf-search-egress"].gw_priority = 2;
    expect(errorCodes(priority)).toContain("service_network_contract");

    const aliases = exactInput();
    (
      aliases.stacks[1].compose.services["tf-search"].networks as Record<
        string,
        unknown
      >
    )["tf-search-control"] = { aliases: ["unexpected"] };
    expect(errorCodes(aliases)).toContain("service_network_contract");
  });

  it("rejects exact persistent mount drift and additions", () => {
    const input = exactInput();
    const postgresMount =
      input.stacks[0].compose.services["platform-postgres"].volumes![0];
    if (typeof postgresMount !== "string") {
      postgresMount.target = "/var/lib/postgresql/other";
    }
    input.stacks[1].compose.services["tf-api"].volumes!.push({
      source: "tf-downloads",
      target: "/unexpected",
      type: "volume",
    });
    expect(errorCodes(input)).toContain("persistent_mount_contract");

    const options = exactInput();
    Object.assign(
      options.stacks[1].compose.services["tf-postgres"].volumes![0],
      { read_only: true },
    );
    expect(errorCodes(options)).toContain("persistent_mount_contract");
  });

  it("rejects exact dependency and profile drift", () => {
    const input = exactInput();
    const api = input.stacks[1].compose.services["tf-api"] as ComposeService & {
      depends_on: Record<string, unknown>;
    };
    delete api.depends_on["tf-search"];
    const baseline = input.stacks[1].compose.services[
      "tf-baseline"
    ] as ComposeService & { profiles: string[] };
    baseline.profiles = [];
    expect(errorCodes(input)).toEqual(
      expect.arrayContaining(["dependency_contract", "profile_contract"]),
    );

    const optionDrift = exactInput();
    const dependency = optionDrift.stacks[0].compose.services[
      "platform-api"
    ] as ComposeService & {
      depends_on: Record<string, { restart?: boolean }>;
    };
    dependency.depends_on["platform-redis"]!.restart = false;
    expect(errorCodes(optionDrift)).toContain("dependency_contract");
  });

  it("rejects exact user, filesystem, capability, tmpfs, and group controls", () => {
    const input = exactInput();
    Object.assign(input.stacks[1].compose.services["tf-api"], {
      cap_drop: [],
      read_only: false,
      security_opt: [],
      tmpfs: ["/tmp:rw"],
      user: "0:0",
    });
    Object.assign(input.stacks[1].compose.services["tf-baseline"], {
      group_add: [],
    });
    expect(errorCodes(input)).toContain("security_contract");

    const namespace = exactInput();
    Object.assign(namespace.stacks[0].compose.services["platform-postgres"], {
      network_mode: "host",
    });
    expect(errorCodes(namespace)).toContain("security_contract");
  });

  it("rejects every secret definition outside its exact approved source path", () => {
    const input = exactInput();
    input.stacks[1].compose.secrets!["admin_access_htpasswd"].file =
      "/tmp/sentinel-admin-access";
    input.stacks[0].compose.secrets!["platform_runtime_database_url"].file =
      "/tmp/sentinel-platform-runtime";
    expect(errorCodes(input)).toContain("secret_definition_path");
    expect(JSON.stringify(validateCoolifyRelease(input))).not.toContain(
      "sentinel",
    );
  });

  it("matches the release source commit and every immutable image to the workflow artifact", () => {
    const commitMismatch = exactInput();
    commitMismatch.releaseArtifact!.sourceCommit = "b".repeat(40);
    expect(errorCodes(commitMismatch)).toContain("source_commit_mismatch");

    const imageMismatch = exactInput();
    imageMismatch.releaseArtifact!.images.find(
      ({ name }) => name === "tf-api",
    )!.imageReference =
      `ghcr.io/altis13/apollo-tf-api@sha256:${"f".repeat(64)}`;
    expect(errorCodes(imageMismatch)).toContain("image_provenance");
  });

  it("requires the complete exact release artifact image inventory in production", () => {
    const missing = exactInput();
    missing.releaseArtifact!.images.pop();
    expect(errorCodes(missing)).toContain("release_artifact");

    const repository = exactInput();
    repository.releaseArtifact!.images[0].repository =
      "ghcr.io/other/platform-api";
    expect(errorCodes(repository)).toContain("release_artifact");
  });

  it("accepts local repositories only in explicit loopback-local-smoke mode", () => {
    const input = exactInput();
    input.mode = "loopback-local-smoke";
    delete input.releaseArtifact;
    for (const stack of input.stacks) {
      for (const [serviceName, service] of Object.entries(
        stack.compose.services,
      )) {
        const imageName = serviceImageNames[serviceName as ServiceName];
        service.image = `127.0.0.1:5000/${imageName}@${imageDigests[imageName]}`;
      }
    }
    for (const [name, value] of Object.entries(input.environment)) {
      if (!name.endsWith("_IMAGE")) continue;
      const imageName = Object.entries(serviceImageNames).find(
        ([serviceName]) =>
          name === `${serviceName.replaceAll("-", "_").toUpperCase()}_IMAGE`,
      )?.[1];
      if (imageName !== undefined) {
        input.environment[name] =
          `127.0.0.1:5000/${imageName}@${imageDigests[imageName]}`;
      }
    }
    input.environment["PLATFORM_REDIS_IMAGE"] =
      `127.0.0.1:5000/redis@${imageDigests.redis}`;
    input.environment["TF_REDIS_IMAGE"] =
      `127.0.0.1:5000/redis@${imageDigests.redis}`;
    expect(validateCoolifyRelease(input)).toMatchObject({ ok: true });

    input.mode = "production";
    expect(errorCodes(input)).toContain("release_artifact");
  });
});

describe("validator process boundaries", () => {
  it("excludes ambient Compose and release values from the render environment", () => {
    const isolate = (
      coolifyReleaseModule as typeof coolifyReleaseModule & {
        isolatedComposeEnvironment?: (
          release: Record<string, string>,
          ambient: NodeJS.ProcessEnv,
        ) => NodeJS.ProcessEnv;
      }
    ).isolatedComposeEnvironment;
    const result = isolate?.(
      { TF_API_IMAGE: "reviewed" },
      {
        COMPOSE_FILE: "C:\\sentinel\\compose.yml",
        ProgramFiles: "C:\\Program Files",
        TF_API_IMAGE: "ambient",
        PATH: "C:\\Windows\\System32",
      },
    );
    expect(result).toEqual({
      PATH: "C:\\Windows\\System32",
      ProgramFiles: "C:\\Program Files",
      TF_API_IMAGE: "reviewed",
    });
  });

  it.each([
    "ENOENT: no such file or directory, open '/private/sentinel/release.env'",
    "ENOENT: no such file or directory, open 'C:\\Users\\sentinel\\release.env'",
  ])(
    "sanitizes arbitrary validator exceptions without a path leak",
    (message) => {
      const sanitize = (
        coolifyReleaseModule as typeof coolifyReleaseModule & {
          sanitizeCoolifyReleaseError?: (error: unknown) => {
            code: string;
            stack?: string;
          };
        }
      ).sanitizeCoolifyReleaseError;
      const result = sanitize?.(new Error(message));
      expect(result).toEqual({ code: "release_error" });
      expect(JSON.stringify(result)).not.toContain("sentinel");
    },
  );

  it("keeps only exact allowlisted validator errors", () => {
    const sanitize = (
      coolifyReleaseModule as typeof coolifyReleaseModule & {
        sanitizeCoolifyReleaseError?: (error: unknown) => {
          code: string;
          stack?: string;
        };
      }
    ).sanitizeCoolifyReleaseError;
    expect(sanitize?.(new Error("compose_render_failed:apollo-tf"))).toEqual({
      code: "compose_render_failed",
      stack: "apollo-tf",
    });
    expect(sanitize?.(new Error("missing_env_file"))).toEqual({
      code: "missing_env_file",
    });
  });

  it.each([
    "/private/posix-sentinel/release.env",
    "C:\\Users\\windows-sentinel\\release.env",
  ])("does not disclose a sentinel env path through the CLI", (path) => {
    const output: string[] = [];
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });
    try {
      expect(
        coolifyReleaseModule.runCoolifyReleaseCli([
          "--env-file",
          path,
          "--mode",
          "loopback-local-smoke",
        ]),
      ).toBe(1);
    } finally {
      write.mockRestore();
    }
    expect(JSON.parse(output.join(""))).toEqual({
      errors: [{ code: "release_error" }],
      ok: false,
    });
    expect(output.join("")).not.toContain("sentinel");
  });
});
