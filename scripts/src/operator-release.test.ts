import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  pinnedRedisReference as validatorPinnedRedisReference,
  releaseImageCatalog as validatorReleaseImageCatalog,
} from "./coolify-release.js";
import {
  operatorReleaseImageTargets,
  operatorReleaseOutputDirectory,
  parseOperatorReleaseArguments,
  pinnedRedisReference as operatorPinnedRedisReference,
  releaseImageCatalog as operatorReleaseImageCatalog,
} from "./operator-release.js";
import {
  artifactImageNames,
  pinnedRedisReference,
  releaseImageCatalog,
} from "./release-images.js";

const validArguments = [
  "--mode",
  "production",
  "--release-id",
  "v0.1.0-rc.1",
  "--source-commit",
  "a".repeat(40),
] as const;

const exactArtifactImageNames: readonly [
  "platform-api",
  "platform-postgres",
  "tf-api",
  "tf-postgres",
  "tf-web",
  "tf-admin",
  "tf-search",
  "tf-integrations",
  "tf-integrations-postgres",
  "tf-download-worker",
  "tf-download-redis",
  "redis",
] = artifactImageNames;

describe("operator release arguments", () => {
  it("parses the production publisher contract", () => {
    expect(parseOperatorReleaseArguments(validArguments)).toEqual({
      mode: "production",
      releaseId: "v0.1.0-rc.1",
      sourceCommit: "a".repeat(40),
    });
  });

  it.each(["--registry", "--token", "--password"])(
    "rejects forbidden %s input without disclosing its value",
    (flag) => {
      const credential = "sentinel-operator-credential";

      expect(() =>
        parseOperatorReleaseArguments([...validArguments, flag, credential]),
      ).toThrowError(/^invalid_arguments$/);

      try {
        parseOperatorReleaseArguments([...validArguments, flag, credential]);
      } catch (error) {
        expect(String(error)).not.toContain(credential);
      }
    },
  );

  it.each(["v0.1.0/escape", "v0.1.0\\escape", "../v0.1.0"])(
    "rejects a release ID containing a path separator: %s",
    (releaseId) => {
      expect(() =>
        parseOperatorReleaseArguments([
          "--mode",
          "production",
          "--release-id",
          releaseId,
          "--source-commit",
          "a".repeat(40),
        ]),
      ).toThrowError(/^invalid_release_id$/);
    },
  );

  it.each([
    "0".repeat(40),
    "A".repeat(40),
    "a".repeat(39),
    `${"a".repeat(39)}g`,
  ])("rejects an invalid source commit", (sourceCommit) => {
    expect(() =>
      parseOperatorReleaseArguments([
        "--mode",
        "production",
        "--release-id",
        "v0.1.0",
        "--source-commit",
        sourceCommit,
      ]),
    ).toThrowError(/^invalid_source_commit$/);
  });

  it("rejects duplicate flags", () => {
    expect(() =>
      parseOperatorReleaseArguments([
        ...validArguments,
        "--release-id",
        "v0.1.1",
      ]),
    ).toThrowError(/^invalid_arguments$/);
  });

  it.each(["preview", "loopback-local-smoke"])(
    "rejects unsupported publisher mode %s",
    (mode) => {
      expect(() =>
        parseOperatorReleaseArguments([
          "--mode",
          mode,
          "--release-id",
          "v0.1.0",
          "--source-commit",
          "a".repeat(40),
        ]),
      ).toThrowError(/^invalid_release_mode$/);
    },
  );

  it.each([
    ["unknown flag", [...validArguments, "--unexpected", "value"]],
    ["missing flag value", [...validArguments, "--release-id"]],
    [
      "next flag used as a value",
      [
        "--mode",
        "production",
        "--release-id",
        "--source-commit",
        "a".repeat(40),
      ],
    ],
    [
      "missing required flag",
      ["--mode", "production", "--release-id", "v0.1.0"],
    ],
  ] as const)("rejects %s", (_name, argv) => {
    expect(() => parseOperatorReleaseArguments(argv)).toThrowError(
      /^invalid_arguments$/,
    );
  });
});

describe("operator release inventory", () => {
  it("shares the exact custom and pinned external image catalog", () => {
    expect(artifactImageNames).toEqual(exactArtifactImageNames);
    expect(releaseImageCatalog).toEqual([
      {
        dockerfile: "artifacts/platform-api/Dockerfile",
        environmentNames: ["PLATFORM_API_IMAGE"],
        kind: "custom",
        name: "platform-api",
        repository: "ghcr.io/altis13/apollo-platform-api",
        target: "runtime",
      },
      {
        dockerfile: "artifacts/platform-api/Dockerfile",
        environmentNames: ["PLATFORM_POSTGRES_IMAGE"],
        kind: "custom",
        name: "platform-postgres",
        repository: "ghcr.io/altis13/apollo-platform-postgres",
        target: "postgres-role-init",
      },
      {
        dockerfile: "artifacts/api-server/Dockerfile",
        environmentNames: ["TF_API_IMAGE"],
        kind: "custom",
        name: "tf-api",
        repository: "ghcr.io/altis13/apollo-tf-api",
        target: "runner",
      },
      {
        dockerfile: "artifacts/api-server/Dockerfile",
        environmentNames: ["TF_POSTGRES_IMAGE"],
        kind: "custom",
        name: "tf-postgres",
        repository: "ghcr.io/altis13/apollo-tf-postgres",
        target: "postgres-role-init",
      },
      {
        dockerfile: "artifacts/music-player/Dockerfile",
        environmentNames: ["TF_WEB_IMAGE"],
        kind: "custom",
        name: "tf-web",
        repository: "ghcr.io/altis13/apollo-tf-web",
        target: "runner",
      },
      {
        dockerfile: "artifacts/admin-dashboard/Dockerfile",
        environmentNames: ["TF_ADMIN_IMAGE"],
        kind: "custom",
        name: "tf-admin",
        repository: "ghcr.io/altis13/apollo-tf-admin",
        target: "default",
      },
      {
        dockerfile: "artifacts/tf-search/Dockerfile",
        environmentNames: ["TF_SEARCH_IMAGE"],
        kind: "custom",
        name: "tf-search",
        repository: "ghcr.io/altis13/apollo-tf-search",
        target: "runner",
      },
      {
        dockerfile: "artifacts/tf-integrations/Dockerfile",
        environmentNames: ["TF_INTEGRATIONS_IMAGE"],
        kind: "custom",
        name: "tf-integrations",
        repository: "ghcr.io/altis13/apollo-tf-integrations",
        target: "runner",
      },
      {
        dockerfile: "artifacts/tf-integrations/Dockerfile",
        environmentNames: ["TF_INTEGRATIONS_POSTGRES_IMAGE"],
        kind: "custom",
        name: "tf-integrations-postgres",
        repository: "ghcr.io/altis13/apollo-tf-integrations-postgres",
        target: "postgres-role-init",
      },
      {
        dockerfile: "artifacts/tf-download-worker/Dockerfile",
        environmentNames: ["TF_DOWNLOAD_WORKER_IMAGE"],
        kind: "custom",
        name: "tf-download-worker",
        repository: "ghcr.io/altis13/apollo-tf-download-worker",
        target: "runner",
      },
      {
        dockerfile: "artifacts/tf-download-worker/Dockerfile",
        environmentNames: ["TF_DOWNLOAD_REDIS_IMAGE"],
        kind: "custom",
        name: "tf-download-redis",
        repository: "ghcr.io/altis13/apollo-tf-download-redis",
        target: "queue-redis",
      },
      {
        environmentNames: ["PLATFORM_REDIS_IMAGE", "TF_REDIS_IMAGE"],
        kind: "external",
        name: "redis",
        reference:
          "docker.io/library/redis:7-bookworm@sha256:595cc6f2bb3af6e03347b90deb6123c6aa2c81dea05ce08128de8a174b6ac67b",
        repository: "docker.io/library/redis",
      },
    ]);
    expect(operatorReleaseImageCatalog).toBe(releaseImageCatalog);
    expect(validatorReleaseImageCatalog).toBe(releaseImageCatalog);
    expect(pinnedRedisReference).toBe(
      "docker.io/library/redis:7-bookworm@sha256:595cc6f2bb3af6e03347b90deb6123c6aa2c81dea05ce08128de8a174b6ac67b",
    );
    expect(operatorPinnedRedisReference).toBe(pinnedRedisReference);
    expect(validatorPinnedRedisReference).toBe(pinnedRedisReference);
  });

  it("defines the exact custom image build targets", () => {
    expect(operatorReleaseImageTargets).toEqual([
      {
        dockerfile: "artifacts/platform-api/Dockerfile",
        environmentNames: ["PLATFORM_API_IMAGE"],
        name: "platform-api",
        repository: "ghcr.io/altis13/apollo-platform-api",
        target: "runtime",
      },
      {
        dockerfile: "artifacts/platform-api/Dockerfile",
        environmentNames: ["PLATFORM_POSTGRES_IMAGE"],
        name: "platform-postgres",
        repository: "ghcr.io/altis13/apollo-platform-postgres",
        target: "postgres-role-init",
      },
      {
        dockerfile: "artifacts/api-server/Dockerfile",
        environmentNames: ["TF_API_IMAGE"],
        name: "tf-api",
        repository: "ghcr.io/altis13/apollo-tf-api",
        target: "runner",
      },
      {
        dockerfile: "artifacts/api-server/Dockerfile",
        environmentNames: ["TF_POSTGRES_IMAGE"],
        name: "tf-postgres",
        repository: "ghcr.io/altis13/apollo-tf-postgres",
        target: "postgres-role-init",
      },
      {
        dockerfile: "artifacts/music-player/Dockerfile",
        environmentNames: ["TF_WEB_IMAGE"],
        name: "tf-web",
        repository: "ghcr.io/altis13/apollo-tf-web",
        target: "runner",
      },
      {
        dockerfile: "artifacts/admin-dashboard/Dockerfile",
        environmentNames: ["TF_ADMIN_IMAGE"],
        name: "tf-admin",
        repository: "ghcr.io/altis13/apollo-tf-admin",
        target: "default",
      },
      {
        dockerfile: "artifacts/tf-search/Dockerfile",
        environmentNames: ["TF_SEARCH_IMAGE"],
        name: "tf-search",
        repository: "ghcr.io/altis13/apollo-tf-search",
        target: "runner",
      },
      {
        dockerfile: "artifacts/tf-integrations/Dockerfile",
        environmentNames: ["TF_INTEGRATIONS_IMAGE"],
        name: "tf-integrations",
        repository: "ghcr.io/altis13/apollo-tf-integrations",
        target: "runner",
      },
      {
        dockerfile: "artifacts/tf-integrations/Dockerfile",
        environmentNames: ["TF_INTEGRATIONS_POSTGRES_IMAGE"],
        name: "tf-integrations-postgres",
        repository: "ghcr.io/altis13/apollo-tf-integrations-postgres",
        target: "postgres-role-init",
      },
      {
        dockerfile: "artifacts/tf-download-worker/Dockerfile",
        environmentNames: ["TF_DOWNLOAD_WORKER_IMAGE"],
        name: "tf-download-worker",
        repository: "ghcr.io/altis13/apollo-tf-download-worker",
        target: "runner",
      },
      {
        dockerfile: "artifacts/tf-download-worker/Dockerfile",
        environmentNames: ["TF_DOWNLOAD_REDIS_IMAGE"],
        name: "tf-download-redis",
        repository: "ghcr.io/altis13/apollo-tf-download-redis",
        target: "queue-redis",
      },
    ]);
  });

  it("resolves release evidence under the fixed ignored directory", () => {
    expect(operatorReleaseOutputDirectory("C:\\repo", "v0.1.0-rc.1")).toBe(
      resolve("C:\\repo", ".ops-private", "releases", "v0.1.0-rc.1"),
    );
  });

  it.each(["../escape", "v0.1.0/escape", "v0.1.0\\escape"])(
    "rejects an unsafe output release ID: %s",
    (releaseId) => {
      expect(() =>
        operatorReleaseOutputDirectory("C:\\repo", releaseId),
      ).toThrowError(/^invalid_release_id$/);
    },
  );
});
