import { describe, expect, it } from "vitest";

import {
  validateCoolifyRelease,
  type ReleaseValidationInput,
} from "./coolify-release.js";

const platformDigest = `sha256:${"1".repeat(64)}`;
const tfDigest = `sha256:${"2".repeat(64)}`;

function runtimeService(
  name: "platform-api" | "tf-api",
  image: string,
  published: number,
  network: string,
  volume: string,
) {
  const secret =
    name === "platform-api"
      ? "platform_runtime_database_url"
      : "tf_runtime_database_url";

  return {
    image,
    init: true,
    restart: "unless-stopped",
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
    healthcheck: {
      test: ["CMD", "node", "-e", "process.exit(0)"],
      interval: "5s",
      timeout: "3s",
      retries: 20,
    },
    environment: {
      DATABASE_URL_FILE: `/run/secrets/${secret}`,
      NODE_ENV: "production",
      PORT: "8080",
    },
    secrets: [
      {
        source: secret,
        target: secret,
        uid: "10001",
        gid: "10001",
        mode: "0400",
      },
    ],
    ports: [
      {
        mode: "ingress",
        target: 8080,
        published: String(published),
        host_ip: "127.0.0.1",
        protocol: "tcp",
      },
    ],
    networks: { [network]: null },
    volumes: [`${volume}:/data`],
  };
}

function validInput(): ReleaseValidationInput {
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
          services: {
            "platform-api": runtimeService(
              "platform-api",
              `ghcr.io/altis13/apollo-platform-api@${platformDigest}`,
              18200,
              "platform-edge",
              "platform-runtime-data",
            ),
          },
          secrets: {
            platform_runtime_database_url: {
              file: "/var/lib/apollo-platform/secrets/platform_runtime_database_url",
            },
          },
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
          services: {
            "tf-api": runtimeService(
              "tf-api",
              `ghcr.io/altis13/apollo-tf-api@${tfDigest}`,
              18201,
              "tf-edge",
              "tf-runtime-data",
            ),
          },
          secrets: {
            tf_runtime_database_url: {
              file: "/var/lib/apollo-tf/secrets/tf_runtime_database_url",
            },
          },
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
  it("returns only the deterministic redacted release manifest fields", () => {
    expect(validateCoolifyRelease(validInput())).toEqual({
      ok: true,
      stacks: [
        {
          name: "apollo-platform",
          publicOrigins: ["https://api.apollot.ru"],
          services: [
            {
              imageDigest: platformDigest,
              name: "platform-api",
              ports: [18200],
            },
          ],
          volumes: ["apollo-platform-runtime-v1"],
        },
        {
          name: "apollo-tf",
          publicOrigins: [
            "https://admin.apollot.ru",
            "https://api.tf.apollot.ru",
            "https://tf.apollot.ru",
          ],
          services: [
            {
              imageDigest: tfDigest,
              name: "tf-api",
              ports: [18201],
            },
          ],
          volumes: ["apollo-tf-runtime-v1"],
        },
      ],
    });
  });

  it("accepts Docker Compose JSON object volume mounts", () => {
    const input = validInput();
    input.stacks[0].compose.services["platform-api"].volumes = [
      {
        type: "volume",
        source: "platform-runtime-data",
        target: "/data",
        volume: {},
      },
    ] as unknown as string[];
    expect(validateCoolifyRelease(input).ok).toBe(true);
  });

  it("accepts documented non-secret runtime controls with sensitive-looking names", () => {
    const input = validInput();
    const platformEnvironment =
      input.stacks[0].compose.services["platform-api"].environment!;
    platformEnvironment["APOLLO_DEVELOPMENT_TOKEN_ECHO"] = "false";
    const tfEnvironment =
      input.stacks[1].compose.services["tf-api"].environment!;
    tfEnvironment["APOLLO_TF_AUTH_REDIS_URL"] = "redis://tf-redis:6379/1";
    expect(validateCoolifyRelease(input).ok).toBe(true);
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
    service.secrets!.push({
      source: "unknown_token",
      target: "unknown_token",
      uid: "10001",
      gid: "10001",
      mode: "0400",
    });
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

  it.each(["uid", "gid", "mode"] as const)(
    "rejects exact secret mount %s drift",
    (field) => {
      const input = validInput();
      input.stacks[1].compose.services["tf-api"].secrets![0][field] = "0777";
      expect(errorCodes(input)).toContain("secret_mount_metadata");
    },
  );
});
