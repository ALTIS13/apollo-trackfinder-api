import { describe, expect, it } from "vitest";

import {
  validateCoolifyRelease,
  type ComposeSecretMount,
  type ComposeService,
  type ReleaseStackInput,
  type ReleaseValidationInput,
} from "./coolify-release.js";

const platformDigest = `sha256:${"1".repeat(64)}`;
const tfDigest = `sha256:${"2".repeat(64)}`;
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
    mount("admin_dashboard_token", "0"),
    mount("admin_access_user", "0"),
    mount("admin_access_password", "0"),
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
    ADMIN_ACCESS_PASSWORD_FILE: "/run/secrets/admin_access_password",
    ADMIN_ACCESS_USER_FILE: "/run/secrets/admin_access_user",
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

function serviceFixture(
  stackName: ReleaseStackInput["name"],
  name: ServiceName,
): ComposeService {
  const isLongRunning = longRunningServices.has(name);
  const network = stackName === "apollo-platform" ? "platform-edge" : "tf-edge";
  const digest = stackName === "apollo-platform" ? platformDigest : tfDigest;
  const service: ComposeService = {
    image: `ghcr.io/altis13/apollo-${name}@${digest}`,
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
    environment: { ...(exactSecretFileEnvironment[name] ?? {}) },
    networks: { [network]: null },
    secrets: exactSecretMounts[name].map((secret) => ({ ...secret })),
  };

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
): Record<string, ComposeService> {
  return Object.fromEntries(
    names.map((name) => [name, serviceFixture(stackName, name)]),
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
    [...sources]
      .sort()
      .map((source) => [source, { file: `${directory}/${source}` }]),
  );
}

function validInput(): ReleaseValidationInput {
  const platform = serviceMap("apollo-platform", platformServices);
  const tf = serviceMap("apollo-tf", tfServices);
  platform["platform-postgres"].volumes = [
    "platform-runtime-data:/var/lib/postgresql/data",
  ];
  tf["tf-postgres"].volumes = ["tf-runtime-data:/var/lib/postgresql/data"];

  return {
    environment: {
      PLATFORM_API_PORT: "18200",
      PLATFORM_PUBLIC_ORIGIN: "https://api.apollot.ru",
      PLATFORM_SECRET_DIRECTORY: "/var/lib/apollo-platform/secrets",
      TF_ADMIN_PUBLIC_ORIGIN: "https://admin.apollot.ru",
      TF_API_PORT: "18201",
      TF_API_PUBLIC_ORIGIN: "https://api.tf.apollot.ru",
      TF_PUBLIC_ORIGIN: "https://tf.apollot.ru",
      TF_SECRET_DIRECTORY: "/var/lib/apollo-tf/secrets",
    },
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
          networks: {
            "platform-edge": { name: "apollo-platform-edge-v1" },
          },
          volumes: {
            "platform-runtime-data": {
              name: "apollo-platform-runtime-v1",
            },
          },
        },
      },
      {
        name: "apollo-tf",
        compose: {
          name: "apollo-tf",
          services: tf,
          secrets: secretDefinitions(tfServices, "/var/lib/apollo-tf/secrets"),
          networks: {
            "tf-edge": { name: "apollo-tf-edge-v1" },
          },
          volumes: {
            "tf-runtime-data": { name: "apollo-tf-runtime-v1" },
          },
        },
      },
    ],
  };
}

function errorCodes(input: ReleaseValidationInput): readonly string[] {
  const result = validateCoolifyRelease(input);
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.errors.map(({ code }) => code);
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
        source: "platform-runtime-data",
        target: "/var/lib/postgresql/data",
        volume: {},
      },
    ];
    expect(validateCoolifyRelease(input).ok).toBe(true);
  });

  it("accepts documented non-secret runtime controls with sensitive-looking names", () => {
    const input = validInput();
    const platformEnvironment =
      input.stacks[0].compose.services["platform-api"].environment!;
    platformEnvironment["APOLLO_DEVELOPMENT_TOKEN_ECHO"] = "false";
    platformEnvironment["APOLLO_REDIS_URL"] = "redis://platform-redis:6379";
    const tfEnvironment =
      input.stacks[1].compose.services["tf-api"].environment!;
    tfEnvironment["APOLLO_TF_AUTH_REDIS_URL"] = "redis://tf-redis:6379/1";
    tfEnvironment["REDIS_URL"] = "redis://tf-redis:6379/0";
    expect(validateCoolifyRelease(input).ok).toBe(true);
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
      ["apollo-tf", "tf-admin", "ADMIN_ACCESS_PASSWORD_FILE"],
      ["apollo-tf", "tf-admin", "ADMIN_ACCESS_USER_FILE"],
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
    input.stacks[1].compose.volumes!["tf-runtime-data"].name =
      "apollo-platform-runtime-v1";
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
});
