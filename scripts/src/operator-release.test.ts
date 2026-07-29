import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  publishOperatorRelease,
  releaseImageCatalog as operatorReleaseImageCatalog,
  runOperatorReleaseCommand,
  runOperatorReleaseCli,
  verifyOperatorReleaseEvidence,
  type OperatorReleaseCommandResult,
  type OperatorReleaseDependencies,
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

const sourceCommit = "a".repeat(40);
const releaseId = "v0.1.0-rc.1";
const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));
const digestFor = (index: number): string =>
  `sha256:${String(index + 1).padStart(64, "0")}`;

type RecordedCommand = {
  args: readonly string[];
  cwd: string;
  executable: string;
};

async function publisherHarness(options?: {
  command?: (
    command: RecordedCommand,
    defaultResult: () => OperatorReleaseCommandResult,
  ) => OperatorReleaseCommandResult | Promise<OperatorReleaseCommandResult>;
  publicationCheckpoint?: (
    checkpoint:
      | "completion_written"
      | "final_environment_written"
      | "final_manifest_written",
  ) => Promise<void>;
  randomId?: () => string;
  temporaryRoot?: () => string;
}) {
  const root = await mkdtemp(join(tmpdir(), "apollo-operator-release-test-"));
  const repositoryRoot = join(root, "repository");
  const temporaryRoot = join(root, "owned-temporary-root");
  const commands: RecordedCommand[] = [];
  const publishedTags = new Set<string>();
  await mkdir(repositoryRoot);

  const dependencies: OperatorReleaseDependencies = {
    async command(executable, args, commandOptions) {
      const recorded = {
        args: [...args],
        cwd: commandOptions.cwd,
        executable,
      };
      commands.push(recorded);
      if (executable === "git" && args[0] === "archive") {
        const outputIndex = args.indexOf("--output");
        await writeFile(
          args[outputIndex + 1]!,
          "synthetic-source-archive\n",
          "utf8",
        );
      }
      const defaultResult = (): OperatorReleaseCommandResult => {
        if (
          executable === "docker" &&
          args[0] === "buildx" &&
          args[1] === "imagetools" &&
          args[2] === "inspect"
        ) {
          const reference = args[3] ?? "";
          const targetIndex = operatorReleaseImageTargets.findIndex(
            ({ repository }) => reference.startsWith(`${repository}:`),
          );
          return publishedTags.has(reference)
            ? {
                status: 0,
                stderr: "",
                stdout: `${JSON.stringify(digestFor(targetIndex))}\n`,
              }
            : { status: 1, stderr: "manifest unknown", stdout: "" };
        }
        if (
          executable === "docker" &&
          args[0] === "buildx" &&
          args[1] === "build"
        ) {
          publishedTags.add(args[args.indexOf("--tag") + 1] ?? "");
        }
        return { status: 0, stderr: "", stdout: "" };
      };
      return options?.command?.(recorded, defaultResult) ?? defaultResult();
    },
    publicationCheckpoint: options?.publicationCheckpoint,
    randomId: options?.randomId ?? (() => "task-2-owned"),
    temporaryRoot: options?.temporaryRoot ?? (() => temporaryRoot),
  };

  return {
    commands,
    dependencies,
    publishedTags,
    releaseCompletion: join(
      repositoryRoot,
      ".ops-private",
      "releases",
      releaseId,
      "apollo-release-complete.json",
    ),
    releaseOutput: join(repositoryRoot, ".ops-private", "releases", releaseId),
    releaseStaging: join(
      repositoryRoot,
      ".ops-private",
      "releases",
      `.${releaseId}.staging-task-2-owned`,
    ),
    repositoryRoot,
    root,
    buildRoot: join(temporaryRoot, "build-source"),
    temporaryRoot,
    validationRoot: join(temporaryRoot, "validation-source"),
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "ENOTDIR"
    ) {
      return false;
    }
    throw error;
  }
}

async function expectIncompleteReleaseEvidence(
  harness: Awaited<ReturnType<typeof publisherHarness>>,
): Promise<void> {
  expect(
    await pathExists(
      join(harness.releaseOutput, "apollo-release-manifest.json"),
    ),
  ).toBe(false);
  expect(
    await pathExists(join(harness.releaseOutput, "release-images.env")),
  ).toBe(false);
  expect(await pathExists(harness.releaseCompletion)).toBe(false);
  expect(await pathExists(harness.releaseStaging)).toBe(false);
}

function sha256(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

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

describe("operator release publication", () => {
  it("checks the worktree and source commit before claiming an archive root", async () => {
    let temporaryRootCalls = 0;
    const harness = await publisherHarness({
      command(command, defaultResult) {
        if (command.executable === "git" && command.args[0] === "cat-file") {
          return {
            status: 1,
            stderr: "sentinel-private-invalid-commit",
            stdout: "",
          };
        }
        return defaultResult();
      },
      temporaryRoot() {
        temporaryRootCalls += 1;
        throw new Error("archive root requested before source validation");
      },
    });
    try {
      await expect(
        publishOperatorRelease(
          {
            mode: "production",
            releaseId,
            repositoryRoot: harness.repositoryRoot,
            sourceCommit,
          },
          harness.dependencies,
        ),
      ).rejects.toThrowError(/^invalid_source_commit$/);
      expect(
        harness.commands.map(({ args, executable }) => [executable, ...args]),
      ).toEqual([
        ["git", "status", "--porcelain=v1", "--untracked-files=all"],
        ["git", "cat-file", "-e", `${sourceCommit}^{commit}`],
      ]);
      expect(temporaryRootCalls).toBe(0);
      expect(
        harness.commands.some(({ executable }) => executable === "docker"),
      ).toBe(false);
    } finally {
      await rm(harness.root, { force: true, recursive: true });
    }
  });

  it("rejects release-tag reuse before requesting or creating a builder", async () => {
    let randomIdCalls = 0;
    const harness = await publisherHarness({
      randomId() {
        randomIdCalls += 1;
        throw new Error("builder identity requested for a reused release tag");
      },
    });
    const existingTarget = operatorReleaseImageTargets[0]!;
    harness.publishedTags.add(`${existingTarget.repository}:${releaseId}`);
    try {
      await expect(
        publishOperatorRelease(
          {
            mode: "production",
            releaseId,
            repositoryRoot: harness.repositoryRoot,
            sourceCommit,
          },
          harness.dependencies,
        ),
      ).rejects.toThrowError(/^release_tag_exists$/);
      expect(randomIdCalls).toBe(0);
      expect(
        harness.commands.filter(
          ({ args, executable }) =>
            executable === "docker" &&
            args[0] === "buildx" &&
            args[1] === "imagetools" &&
            args[2] === "inspect",
        ),
      ).toHaveLength(1);
      expect(
        harness.commands.some(
          ({ args, executable }) =>
            executable === "docker" &&
            args[0] === "buildx" &&
            (args[1] === "create" || args[1] === "build" || args[1] === "rm"),
        ),
      ).toBe(false);
    } finally {
      await rm(harness.root, { force: true, recursive: true });
    }
  });

  it("does not remove a builder when creation never established ownership", async () => {
    const harness = await publisherHarness({
      command(command, defaultResult) {
        if (
          command.executable === "docker" &&
          command.args[0] === "buildx" &&
          command.args[1] === "create"
        ) {
          return {
            status: 1,
            stderr: "sentinel-private-builder-collision",
            stdout: "",
          };
        }
        return defaultResult();
      },
    });
    try {
      await expect(
        publishOperatorRelease(
          {
            mode: "production",
            releaseId,
            repositoryRoot: harness.repositoryRoot,
            sourceCommit,
          },
          harness.dependencies,
        ),
      ).rejects.toThrowError(/^builder_create_failed$/);
      expect(
        harness.commands.some(
          ({ args, executable }) =>
            executable === "docker" && args[0] === "buildx" && args[1] === "rm",
        ),
      ).toBe(false);
      expect(await pathExists(harness.temporaryRoot)).toBe(false);
    } finally {
      await rm(harness.root, { force: true, recursive: true });
    }
  });

  it("sanitizes unexpected dependency failures from the publication API", async () => {
    const harness = await publisherHarness({
      temporaryRoot() {
        throw new Error("private_secret_value");
      },
    });
    try {
      await expect(
        publishOperatorRelease(
          {
            mode: "production",
            releaseId,
            repositoryRoot: harness.repositoryRoot,
            sourceCommit,
          },
          harness.dependencies,
        ),
      ).rejects.toThrowError(/^release_error$/);
    } finally {
      await rm(harness.root, { force: true, recursive: true });
    }
  });

  it("keeps validation mutations out of the clean build extraction", async () => {
    const mutationName = "validation-only-mutation";
    let registryRoot: string | undefined;
    let registrySawMutation: boolean | undefined;
    let validationRoot: string | undefined;
    const harness = await publisherHarness({
      async command(command, defaultResult) {
        if (
          validationRoot === undefined &&
          command.executable === "pnpm" &&
          command.args[0] === "install"
        ) {
          validationRoot = command.cwd;
          await writeFile(join(command.cwd, mutationName), "mutated\n", "utf8");
        }
        if (
          registryRoot === undefined &&
          command.executable === "docker" &&
          command.args[0] === "buildx" &&
          command.args[1] === "imagetools" &&
          command.args[2] === "inspect"
        ) {
          registryRoot = command.cwd;
          registrySawMutation = await pathExists(
            join(command.cwd, mutationName),
          );
        }
        return defaultResult();
      },
    });
    try {
      await expect(
        publishOperatorRelease(
          {
            mode: "production",
            releaseId,
            repositoryRoot: harness.repositoryRoot,
            sourceCommit,
          },
          harness.dependencies,
        ),
      ).resolves.toMatchObject({
        releaseArtifact: { sourceCommit },
      });
      expect(validationRoot).toBe(harness.validationRoot);
      expect(registryRoot).toBe(harness.buildRoot);
      expect(registryRoot).not.toBe(validationRoot);
      expect(registrySawMutation).toBe(false);
    } finally {
      await rm(harness.root, { force: true, recursive: true });
    }
  });

  it("rejects validation that mutates the exact source archive", async () => {
    let archiveMutated = false;
    const harness = await publisherHarness({
      async command(command, defaultResult) {
        if (
          !archiveMutated &&
          command.executable === "pnpm" &&
          command.args[0] === "install"
        ) {
          await writeFile(
            join(dirname(command.cwd), "source.tar"),
            "mutated-source-archive\n",
            "utf8",
          );
          archiveMutated = true;
        }
        return defaultResult();
      },
    });
    try {
      await expect(
        publishOperatorRelease(
          {
            mode: "production",
            releaseId,
            repositoryRoot: harness.repositoryRoot,
            sourceCommit,
          },
          harness.dependencies,
        ),
      ).rejects.toThrowError(/^source_validation_failed$/);
      expect(archiveMutated).toBe(true);
      expect(await pathExists(harness.buildRoot)).toBe(false);
      expect(
        harness.commands.some(({ executable }) => executable === "docker"),
      ).toBe(false);
      expect(await pathExists(harness.temporaryRoot)).toBe(false);
    } finally {
      await rm(harness.root, { force: true, recursive: true });
    }
  });

  it("validates the archived commit before publishing every custom image with an owned builder", async () => {
    const harness = await publisherHarness();
    try {
      const output = await publishOperatorRelease(
        {
          mode: "production",
          releaseId,
          repositoryRoot: harness.repositoryRoot,
          sourceCommit,
        },
        harness.dependencies,
      );

      const commandLines = harness.commands.map(
        ({ args, executable }) => [executable, ...args] as const,
      );
      const builderName = "apollo-release-task-2-owned";
      const builderCreateIndex = commandLines.findIndex(
        (line) =>
          line[0] === "docker" && line[1] === "buildx" && line[2] === "create",
      );
      const registryInspections = harness.commands.filter(
        ({ args, executable }) =>
          executable === "docker" &&
          args[0] === "buildx" &&
          args[1] === "imagetools" &&
          args[2] === "inspect",
      );
      const pushedDigestInspections = harness.commands
        .slice(builderCreateIndex + 1)
        .filter(
          ({ args, executable }) =>
            executable === "docker" &&
            args[0] === "buildx" &&
            args[1] === "imagetools" &&
            args[2] === "inspect",
        );
      const expectedCustomTags = operatorReleaseImageTargets.map(
        ({ repository }) => `${repository}:${releaseId}`,
      );
      const builds = harness.commands.filter(
        ({ args, executable }) =>
          executable === "docker" &&
          args[0] === "buildx" &&
          args[1] === "build",
      );
      const validationCommands = [
        ["corepack", "enable"],
        ["pnpm", "install", "--frozen-lockfile"],
        ["pnpm", "--filter", "@workspace/scripts", "test"],
        [
          "pnpm",
          "--filter",
          "@workspace/platform-api",
          "exec",
          "vitest",
          "run",
          "--maxWorkers=2",
        ],
        [
          "pnpm",
          "--filter",
          "@workspace/api-server",
          "exec",
          "vitest",
          "run",
          "--maxWorkers=1",
        ],
        [
          "pnpm",
          "--filter",
          "@workspace/admin-dashboard",
          "exec",
          "vitest",
          "run",
          "--maxWorkers=2",
        ],
        [
          "pnpm",
          "--filter",
          "@workspace/music-player",
          "exec",
          "vitest",
          "run",
          "--maxWorkers=2",
        ],
        [
          "pnpm",
          "--filter",
          "@workspace/tf-search",
          "exec",
          "vitest",
          "run",
          "--maxWorkers=2",
        ],
        [
          "pnpm",
          "--filter",
          "@workspace/tf-integrations",
          "exec",
          "vitest",
          "run",
          "--maxWorkers=2",
        ],
        [
          "pnpm",
          "--filter",
          "@workspace/tf-download-worker",
          "exec",
          "vitest",
          "run",
          "--maxWorkers=2",
        ],
        ["pnpm", "run", "typecheck"],
      ];

      expect(commandLines.slice(0, 4)).toEqual([
        ["git", "status", "--porcelain=v1", "--untracked-files=all"],
        ["git", "cat-file", "-e", `${sourceCommit}^{commit}`],
        [
          "git",
          "archive",
          "--format=tar",
          "--output",
          join(harness.temporaryRoot, "source.tar"),
          sourceCommit,
        ],
        [
          "tar",
          "-xf",
          join(harness.temporaryRoot, "source.tar"),
          "-C",
          harness.validationRoot,
        ],
      ]);
      expect(commandLines.slice(4, 4 + validationCommands.length)).toEqual(
        validationCommands,
      );
      expect(
        harness.commands
          .slice(4, 4 + validationCommands.length)
          .every(({ cwd }) => cwd === harness.validationRoot),
      ).toBe(true);
      expect(commandLines[4 + validationCommands.length]).toEqual([
        "tar",
        "-xf",
        join(harness.temporaryRoot, "source.tar"),
        "-C",
        harness.buildRoot,
      ]);
      expect(
        harness.commands
          .slice(0, builderCreateIndex)
          .filter(({ executable }) => executable === "docker"),
      ).toHaveLength(11);
      expect(builderCreateIndex).toBe(5 + validationCommands.length + 11);
      expect(commandLines[builderCreateIndex]).toEqual([
        "docker",
        "buildx",
        "create",
        "--name",
        builderName,
        "--driver",
        "docker-container",
      ]);

      expect(builds).toHaveLength(11);
      for (const [index, build] of builds.entries()) {
        const target = operatorReleaseImageTargets[index];
        expect(build.cwd).toBe(harness.buildRoot);
        expect(build.args).toEqual([
          "buildx",
          "build",
          "--builder",
          builderName,
          "--platform",
          "linux/amd64",
          "--provenance",
          "mode=max",
          "--sbom",
          "true",
          "--label",
          "org.opencontainers.image.source=https://github.com/ALTIS13/Apollo.TF",
          "--label",
          `org.opencontainers.image.revision=${sourceCommit}`,
          "--label",
          `org.opencontainers.image.version=${releaseId}`,
          "--file",
          join(harness.buildRoot, target!.dockerfile),
          "--target",
          target!.target,
          "--tag",
          `${target!.repository}:${releaseId}`,
          "--push",
          harness.buildRoot,
        ]);
      }
      expect(registryInspections).toHaveLength(22);
      expect(pushedDigestInspections).toHaveLength(11);
      expect(
        registryInspections
          .slice(0, operatorReleaseImageTargets.length)
          .map(({ args }) => args[3]),
      ).toEqual(expectedCustomTags);
      expect(pushedDigestInspections.map(({ args }) => args[3])).toEqual(
        expectedCustomTags,
      );
      expect(
        commandLines.filter(
          (line) =>
            line[0] === "docker" && line[1] === "buildx" && line[2] === "rm",
        ),
      ).toEqual([["docker", "buildx", "rm", builderName]]);
      expect(commandLines.flat().join("\n")).not.toMatch(
        /(?:credential|password|secret|token)/i,
      );
      expect(commandLines.flat()).not.toContain("prune");
      expect(commandLines.flat()).not.toContain("--use");
      expect(commandLines.flat()).not.toContain(pinnedRedisReference);
      expect(commandLines.flat().join("\n")).not.toContain(
        "docker.io/library/redis",
      );

      const manifestContents = await readFile(output.manifestPath, "utf8");
      const manifest = JSON.parse(
        manifestContents,
      ) as typeof output.releaseArtifact;
      expect(manifest).toEqual(output.releaseArtifact);
      expect(manifest.images.map(({ name }) => name)).toEqual(
        [...exactArtifactImageNames].sort(),
      );
      expect(manifest.images.find(({ name }) => name === "redis")).toEqual({
        imageDigest:
          "sha256:595cc6f2bb3af6e03347b90deb6123c6aa2c81dea05ce08128de8a174b6ac67b",
        imageReference:
          "docker.io/library/redis@sha256:595cc6f2bb3af6e03347b90deb6123c6aa2c81dea05ce08128de8a174b6ac67b",
        name: "redis",
        repository: "docker.io/library/redis",
      });
      const environmentContents = [
        `RELEASE_SOURCE_COMMIT=${sourceCommit}`,
        `PLATFORM_POSTGRES_IMAGE=ghcr.io/altis13/apollo-platform-postgres@${digestFor(1)}`,
        "PLATFORM_REDIS_IMAGE=docker.io/library/redis@sha256:595cc6f2bb3af6e03347b90deb6123c6aa2c81dea05ce08128de8a174b6ac67b",
        `PLATFORM_API_IMAGE=ghcr.io/altis13/apollo-platform-api@${digestFor(0)}`,
        `TF_POSTGRES_IMAGE=ghcr.io/altis13/apollo-tf-postgres@${digestFor(3)}`,
        "TF_REDIS_IMAGE=docker.io/library/redis@sha256:595cc6f2bb3af6e03347b90deb6123c6aa2c81dea05ce08128de8a174b6ac67b",
        `TF_API_IMAGE=ghcr.io/altis13/apollo-tf-api@${digestFor(2)}`,
        `TF_WEB_IMAGE=ghcr.io/altis13/apollo-tf-web@${digestFor(4)}`,
        `TF_ADMIN_IMAGE=ghcr.io/altis13/apollo-tf-admin@${digestFor(5)}`,
        `TF_SEARCH_IMAGE=ghcr.io/altis13/apollo-tf-search@${digestFor(6)}`,
        `TF_INTEGRATIONS_POSTGRES_IMAGE=ghcr.io/altis13/apollo-tf-integrations-postgres@${digestFor(8)}`,
        `TF_INTEGRATIONS_IMAGE=ghcr.io/altis13/apollo-tf-integrations@${digestFor(7)}`,
        `TF_DOWNLOAD_REDIS_IMAGE=ghcr.io/altis13/apollo-tf-download-redis@${digestFor(10)}`,
        `TF_DOWNLOAD_WORKER_IMAGE=ghcr.io/altis13/apollo-tf-download-worker@${digestFor(9)}`,
        "",
      ].join("\n");
      expect(await readFile(output.envFragmentPath, "utf8")).toBe(
        environmentContents,
      );
      expect(
        JSON.parse(await readFile(harness.releaseCompletion, "utf8")),
      ).toEqual({
        environmentSha256: sha256(environmentContents),
        formatVersion: 1,
        manifestSha256: sha256(manifestContents),
        releaseId,
        sourceCommit,
      });
      await expect(readFile(harness.temporaryRoot, "utf8")).rejects.toThrow();
    } finally {
      await rm(harness.root, { force: true, recursive: true });
    }
  });

  it("stops before registry inspection when the archived source gate fails", async () => {
    const harness = await publisherHarness({
      command(command, defaultResult) {
        if (
          command.executable === "pnpm" &&
          command.args.includes("@workspace/api-server")
        ) {
          return {
            status: 1,
            stderr: "sentinel-private-source-failure",
            stdout: "",
          };
        }
        return defaultResult();
      },
    });
    try {
      await expect(
        publishOperatorRelease(
          {
            mode: "production",
            releaseId,
            repositoryRoot: harness.repositoryRoot,
            sourceCommit,
          },
          harness.dependencies,
        ),
      ).rejects.toThrowError(/^source_validation_failed$/);
      expect(
        harness.commands.some(({ executable }) => executable === "docker"),
      ).toBe(false);
      expect(JSON.stringify(harness.commands)).not.toContain(
        "sentinel-private-source-failure",
      );
    } finally {
      await rm(harness.root, { force: true, recursive: true });
    }
  });

  it("keeps build 6 as the primary failure and refuses the partially published release on retry", async () => {
    let buildCount = 0;
    const harness = await publisherHarness({
      command(command, defaultResult) {
        if (
          command.executable === "docker" &&
          command.args[0] === "buildx" &&
          command.args[1] === "build"
        ) {
          buildCount += 1;
          if (buildCount === 6) {
            return {
              status: 1,
              stderr: "sentinel-private-build-failure",
              stdout: "",
            };
          }
        }
        if (
          command.executable === "docker" &&
          command.args[0] === "buildx" &&
          command.args[1] === "rm"
        ) {
          return {
            status: 1,
            stderr: "sentinel-private-cleanup-failure",
            stdout: "",
          };
        }
        return defaultResult();
      },
    });
    const publish = () =>
      publishOperatorRelease(
        {
          mode: "production",
          releaseId,
          repositoryRoot: harness.repositoryRoot,
          sourceCommit,
        },
        harness.dependencies,
      );
    try {
      await expect(publish()).rejects.toThrowError(/^image_build_failed$/);
      expect(buildCount).toBe(6);
      expect(harness.publishedTags.size).toBe(5);
      await expectIncompleteReleaseEvidence(harness);
      expect(await pathExists(harness.temporaryRoot)).toBe(false);

      await expect(publish()).rejects.toThrowError(/^release_tag_exists$/);
      expect(buildCount).toBe(6);
      expect(
        harness.commands.filter(
          ({ args, executable }) =>
            executable === "docker" &&
            args[0] === "buildx" &&
            args[1] === "create",
        ),
      ).toHaveLength(1);
      expect(
        harness.commands
          .filter(
            ({ args, executable }) =>
              executable === "docker" &&
              args[0] === "buildx" &&
              args[1] === "rm",
          )
          .map(({ args }) => args),
      ).toEqual([["buildx", "rm", "apollo-release-task-2-owned"]]);
      await expectIncompleteReleaseEvidence(harness);
      expect(await pathExists(harness.temporaryRoot)).toBe(false);
      expect(JSON.stringify(harness.commands)).not.toContain(
        "sentinel-private",
      );
    } finally {
      await rm(harness.root, { force: true, recursive: true });
    }
  });

  it("fails closed when pushed-digest inspection 12 exhausts bounded retries", async () => {
    let failedDigestInspections = 0;
    const firstReference = `${operatorReleaseImageTargets[0]!.repository}:${releaseId}`;
    const harness = await publisherHarness({
      command(command, defaultResult) {
        if (
          command.executable === "docker" &&
          command.args[0] === "buildx" &&
          command.args[1] === "imagetools" &&
          command.args[2] === "inspect" &&
          command.args[3] === firstReference &&
          failedDigestInspections > 0
        ) {
          failedDigestInspections += 1;
          return { status: 1, stderr: "manifest unknown", stdout: "" };
        }
        const result = defaultResult();
        if (
          command.executable === "docker" &&
          command.args[0] === "buildx" &&
          command.args[1] === "imagetools" &&
          command.args[2] === "inspect" &&
          command.args[3] === firstReference &&
          result.status === 0
        ) {
          failedDigestInspections = 1;
          return { status: 1, stderr: "manifest unknown", stdout: "" };
        }
        return result;
      },
    });
    try {
      await expect(
        publishOperatorRelease(
          {
            mode: "production",
            releaseId,
            repositoryRoot: harness.repositoryRoot,
            sourceCommit,
          },
          harness.dependencies,
        ),
      ).rejects.toThrowError(/^digest_resolution_failed$/);
      expect(failedDigestInspections).toBe(5);
      expect(
        harness.commands.filter(
          ({ args, executable }) =>
            executable === "docker" &&
            args[0] === "buildx" &&
            args[1] === "imagetools" &&
            args[2] === "inspect",
        ),
      ).toHaveLength(16);
      await expectIncompleteReleaseEvidence(harness);
      expect(await pathExists(harness.temporaryRoot)).toBe(false);
    } finally {
      await rm(harness.root, { force: true, recursive: true });
    }
  });

  it("claims an exclusive staging directory before publishing evidence", async () => {
    const harness = await publisherHarness();
    const sentinelPath = join(harness.releaseStaging, "unrelated-sentinel");
    await mkdir(harness.releaseStaging, { recursive: true });
    await writeFile(sentinelPath, "unrelated\n", "utf8");
    try {
      await expect(
        publishOperatorRelease(
          {
            mode: "production",
            releaseId,
            repositoryRoot: harness.repositoryRoot,
            sourceCommit,
          },
          harness.dependencies,
        ),
      ).rejects.toThrowError(/^artifact_validation_failed$/);
      expect(await readFile(sentinelPath, "utf8")).toBe("unrelated\n");
      expect(
        await pathExists(
          join(harness.releaseOutput, "apollo-release-manifest.json"),
        ),
      ).toBe(false);
      expect(
        await pathExists(join(harness.releaseOutput, "release-images.env")),
      ).toBe(false);
      expect(await pathExists(harness.temporaryRoot)).toBe(false);
    } finally {
      await rm(harness.root, { force: true, recursive: true });
    }
  });

  it("preserves a late incomplete release claim and refuses to overwrite it on retry", async () => {
    let collisionCreated = false;
    let releaseOutput = "";
    const lastReference = `${
      operatorReleaseImageTargets.at(-1)!.repository
    }:${releaseId}`;
    const harness = await publisherHarness({
      async command(command, defaultResult) {
        const result = defaultResult();
        if (
          !collisionCreated &&
          command.executable === "docker" &&
          command.args[0] === "buildx" &&
          command.args[1] === "imagetools" &&
          command.args[2] === "inspect" &&
          command.args[3] === lastReference &&
          result.status === 0
        ) {
          await mkdir(dirname(releaseOutput), { recursive: true });
          await mkdir(releaseOutput);
          await writeFile(
            join(releaseOutput, "unrelated-sentinel"),
            "unrelated-collision\n",
            "utf8",
          );
          collisionCreated = true;
        }
        return result;
      },
    });
    releaseOutput = harness.releaseOutput;
    try {
      const publish = () =>
        publishOperatorRelease(
          {
            mode: "production",
            releaseId,
            repositoryRoot: harness.repositoryRoot,
            sourceCommit,
          },
          harness.dependencies,
        );
      await expect(publish()).rejects.toThrowError(/^release_output_exists$/);
      expect(collisionCreated).toBe(true);
      expect(
        await readFile(
          join(harness.releaseOutput, "unrelated-sentinel"),
          "utf8",
        ),
      ).toBe("unrelated-collision\n");
      await expectIncompleteReleaseEvidence(harness);
      expect(await pathExists(harness.temporaryRoot)).toBe(false);
      const dockerCommandCount = harness.commands.filter(
        ({ executable }) => executable === "docker",
      ).length;

      await expect(publish()).rejects.toThrowError(/^release_output_exists$/);
      expect(
        await readFile(
          join(harness.releaseOutput, "unrelated-sentinel"),
          "utf8",
        ),
      ).toBe("unrelated-collision\n");
      expect(
        harness.commands.filter(({ executable }) => executable === "docker"),
      ).toHaveLength(dockerCommandCount);
    } finally {
      await rm(harness.root, { force: true, recursive: true });
    }
  });

  it("requires exact complete evidence with matching hashes, identity, and env order", async () => {
    const harness = await publisherHarness();
    try {
      const output = await publishOperatorRelease(
        {
          mode: "production",
          releaseId,
          repositoryRoot: harness.repositoryRoot,
          sourceCommit,
        },
        harness.dependencies,
      );
      const manifestContents = await readFile(output.manifestPath, "utf8");
      const envContents = await readFile(output.envFragmentPath, "utf8");
      const completionContents = await readFile(
        harness.releaseCompletion,
        "utf8",
      );
      const completion = JSON.parse(completionContents) as Record<
        string,
        unknown
      >;

      expect(verifyOperatorReleaseEvidence(output.manifestPath)).toEqual(
        output.releaseArtifact,
      );

      await rm(harness.releaseCompletion);
      expect(() =>
        verifyOperatorReleaseEvidence(output.manifestPath),
      ).toThrowError(/^invalid_release_manifest$/);
      await writeFile(harness.releaseCompletion, completionContents, "utf8");

      await writeFile(
        harness.releaseCompletion,
        `${JSON.stringify({ ...completion, unexpected: true }, null, 2)}\n`,
        "utf8",
      );
      expect(() =>
        verifyOperatorReleaseEvidence(output.manifestPath),
      ).toThrowError(/^invalid_release_manifest$/);

      await writeFile(
        harness.releaseCompletion,
        `${JSON.stringify(
          { ...completion, releaseId: "v0.1.0-wrong" },
          null,
          2,
        )}\n`,
        "utf8",
      );
      expect(() =>
        verifyOperatorReleaseEvidence(output.manifestPath),
      ).toThrowError(/^invalid_release_manifest$/);

      await writeFile(
        harness.releaseCompletion,
        `${JSON.stringify(
          { ...completion, sourceCommit: "b".repeat(40) },
          null,
          2,
        )}\n`,
        "utf8",
      );
      expect(() =>
        verifyOperatorReleaseEvidence(output.manifestPath),
      ).toThrowError(/^invalid_release_manifest$/);

      await writeFile(
        harness.releaseCompletion,
        `${JSON.stringify(
          { ...completion, manifestSha256: "f".repeat(64) },
          null,
          2,
        )}\n`,
        "utf8",
      );
      expect(() =>
        verifyOperatorReleaseEvidence(output.manifestPath),
      ).toThrowError(/^invalid_release_manifest$/);

      const reorderedEnvironment = envContents.split("\n");
      [reorderedEnvironment[1], reorderedEnvironment[2]] = [
        reorderedEnvironment[2]!,
        reorderedEnvironment[1]!,
      ];
      const reorderedEnvironmentContents = reorderedEnvironment.join("\n");
      await writeFile(
        output.envFragmentPath,
        reorderedEnvironmentContents,
        "utf8",
      );
      await writeFile(
        harness.releaseCompletion,
        `${JSON.stringify(
          {
            ...completion,
            environmentSha256: sha256(reorderedEnvironmentContents),
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      expect(() =>
        verifyOperatorReleaseEvidence(output.manifestPath),
      ).toThrowError(/^invalid_release_manifest$/);

      await writeFile(output.manifestPath, manifestContents, "utf8");
      await writeFile(output.envFragmentPath, envContents, "utf8");
      await writeFile(harness.releaseCompletion, completionContents, "utf8");
      expect(verifyOperatorReleaseEvidence(output.manifestPath)).toEqual(
        output.releaseArtifact,
      );
    } finally {
      await rm(harness.root, { force: true, recursive: true });
    }
  });

  it.each([
    "final_manifest_written",
    "final_environment_written",
    "completion_written",
  ] as const)(
    "removes consumable evidence after handled %s failure but retains the claim",
    async (failedCheckpoint) => {
      const harness = await publisherHarness({
        async publicationCheckpoint(checkpoint) {
          if (checkpoint === failedCheckpoint) {
            throw new Error("sentinel-final-write-failure");
          }
        },
      });
      try {
        const publish = () =>
          publishOperatorRelease(
            {
              mode: "production",
              releaseId,
              repositoryRoot: harness.repositoryRoot,
              sourceCommit,
            },
            harness.dependencies,
          );

        await expect(publish()).rejects.toThrowError(
          /^artifact_validation_failed$/,
        );
        expect(await pathExists(harness.releaseOutput)).toBe(true);
        await expectIncompleteReleaseEvidence(harness);
        const dockerCommandCount = harness.commands.filter(
          ({ executable }) => executable === "docker",
        ).length;

        await expect(publish()).rejects.toThrowError(/^release_output_exists$/);
        expect(await pathExists(harness.releaseOutput)).toBe(true);
        await expectIncompleteReleaseEvidence(harness);
        expect(
          harness.commands.filter(({ executable }) => executable === "docker"),
        ).toHaveLength(dockerCommandCount);
      } finally {
        await rm(harness.root, { force: true, recursive: true });
      }
    },
  );

  it("returns cleanup_failed after complete evidence when owned builder removal fails", async () => {
    const harness = await publisherHarness({
      command(command, defaultResult) {
        if (
          command.executable === "docker" &&
          command.args[0] === "buildx" &&
          command.args[1] === "rm"
        ) {
          return {
            status: 1,
            stderr: "sentinel-private-cleanup-only-failure",
            stdout: "",
          };
        }
        return defaultResult();
      },
    });
    try {
      await expect(
        publishOperatorRelease(
          {
            mode: "production",
            releaseId,
            repositoryRoot: harness.repositoryRoot,
            sourceCommit,
          },
          harness.dependencies,
        ),
      ).rejects.toThrowError(/^cleanup_failed$/);
      expect(
        JSON.parse(
          await readFile(
            join(harness.releaseOutput, "apollo-release-manifest.json"),
            "utf8",
          ),
        ),
      ).toMatchObject({ sourceCommit });
      expect(
        await readFile(
          join(harness.releaseOutput, "release-images.env"),
          "utf8",
        ),
      ).toContain(`RELEASE_SOURCE_COMMIT=${sourceCommit}\n`);
      expect(
        JSON.parse(await readFile(harness.releaseCompletion, "utf8")),
      ).toMatchObject({ formatVersion: 1, releaseId, sourceCommit });
      expect(await pathExists(harness.releaseStaging)).toBe(false);
      expect(await pathExists(harness.temporaryRoot)).toBe(false);
      expect(
        harness.commands
          .filter(
            ({ args, executable }) =>
              executable === "docker" &&
              args[0] === "buildx" &&
              args[1] === "rm",
          )
          .map(({ args }) => args),
      ).toEqual([["buildx", "rm", "apollo-release-task-2-owned"]]);
    } finally {
      await rm(harness.root, { force: true, recursive: true });
    }
  });
});

describe("operator release default command runner", () => {
  it.runIf(process.platform === "win32")(
    "launches the fixed Corepack and pnpm Windows shims",
    async () => {
      for (const executable of ["corepack", "pnpm"] as const) {
        const result = await runOperatorReleaseCommand(
          executable,
          ["--version"],
          { cwd: workspaceRoot, timeoutMs: 30_000 },
        );

        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout.trim()).toMatch(/^[0-9]+[.][0-9]+[.][0-9]+/);
      }
    },
  );
});

describe("operator release CLI", () => {
  it("publishes through injected dependencies and emits one JSON success record", async () => {
    const harness = await publisherHarness();
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
      await expect(
        runOperatorReleaseCli(
          [
            "--mode",
            "production",
            "--release-id",
            releaseId,
            "--source-commit",
            sourceCommit,
          ],
          harness.dependencies,
          {
            repositoryRoot: harness.repositoryRoot,
            stderr: (value) => stderr.push(value),
            stdout: (value) => stdout.push(value),
          },
        ),
      ).resolves.toBe(0);
      expect(stderr).toEqual([]);
      expect(stdout).toHaveLength(1);
      expect(JSON.parse(stdout[0]!)).toMatchObject({
        envFragmentPath: join(harness.releaseOutput, "release-images.env"),
        manifestPath: join(
          harness.releaseOutput,
          "apollo-release-manifest.json",
        ),
        releaseArtifact: { sourceCommit },
      });
    } finally {
      await rm(harness.root, { force: true, recursive: true });
    }
  });

  it("returns nonzero JSON errors without rejected values or command output", async () => {
    const harness = await publisherHarness({
      command(command, defaultResult) {
        if (
          command.executable === "pnpm" &&
          command.args.includes("@workspace/api-server")
        ) {
          return {
            status: 1,
            stderr: "sentinel-private-cli-failure",
            stdout: "",
          };
        }
        return defaultResult();
      },
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
      await expect(
        runOperatorReleaseCli(
          [
            "--mode",
            "production",
            "--release-id",
            releaseId,
            "--source-commit",
            sourceCommit,
          ],
          harness.dependencies,
          {
            repositoryRoot: harness.repositoryRoot,
            stderr: (value) => stderr.push(value),
            stdout: (value) => stdout.push(value),
          },
        ),
      ).resolves.toBe(1);
      expect(stdout).toEqual([]);
      expect(stderr).toEqual([
        `${JSON.stringify({ error: "source_validation_failed" })}\n`,
      ]);
      expect(stderr.join("")).not.toContain("sentinel-private");
      expect(await pathExists(harness.temporaryRoot)).toBe(false);
    } finally {
      await rm(harness.root, { force: true, recursive: true });
    }
  });

  it("exposes the complete publisher through the root package script", async () => {
    const packageJson = JSON.parse(
      await readFile(join(workspaceRoot, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.["release:publish"]).toBe(
      "node --experimental-strip-types -- scripts/src/operator-release.ts",
    );
  });

  it("pins the complete scripts source gate", async () => {
    const scriptsPackageJson = JSON.parse(
      await readFile(join(workspaceRoot, "scripts", "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(scriptsPackageJson.scripts?.test).toBe(
      "vitest run --maxWorkers=1 --testTimeout=10000",
    );
  });

  it("binds production publication guidance to the operator publisher", async () => {
    const releaseWorkflow = join(
      workspaceRoot,
      ".github",
      "workflows",
      "apollo-release-images.yml",
    );
    const rolloutRunbook = await readFile(
      join(workspaceRoot, "docs", "operations", "apollo-production-rollout.md"),
      "utf8",
    );
    const guidanceSources = await Promise.all(
      [
        "IMPLEMENTATION_STATUS.md",
        "docs/operations/apollo-production-rollout.md",
        "docs/operations/homenode-coolify-preflight.md",
        "docs/operations/apollo-backup-restore.md",
      ].map((path) => readFile(join(workspaceRoot, path), "utf8")),
    );
    const musicPlayerDockerfile = await readFile(
      join(workspaceRoot, "artifacts", "music-player", "Dockerfile"),
      "utf8",
    );

    expect(await pathExists(releaseWorkflow)).toBe(false);
    expect(rolloutRunbook).toContain(
      "$env:CR_PAT | docker login ghcr.io -u ALTIS13 --password-stdin",
    );
    expect(rolloutRunbook).toContain("Remove-Item Env:\\CR_PAT");
    expect(rolloutRunbook).toContain(
      "pnpm release:publish -- --mode production --release-id v0.1.0-rc.1 --source-commit $approvedSourceCommit",
    );
    expect(rolloutRunbook).toContain(
      "pnpm release:validate -- --env-file '<PRIVATE_RELEASE_ENV>' --mode production --release-manifest '.ops-private/releases/v0.1.0-rc.1/apollo-release-manifest.json'",
    );
    expect(rolloutRunbook).toContain(
      "public GHCR images allow anonymous HomeNode/Coolify pulls",
    );
    expect(rolloutRunbook).toMatch(
      /package\s+visibility checked after first publication/,
    );
    expect(rolloutRunbook).toContain("classic PAT with `write:packages`");
    expect(rolloutRunbook).not.toMatch(/ghp_[A-Za-z0-9_]+/);
    expect(guidanceSources.join("\n")).not.toMatch(/workflow-produced/i);
    expect(musicPlayerDockerfile).toContain("RUN npm install -g pnpm@10.33.2");
    expect(musicPlayerDockerfile).not.toContain("RUN npm install -g pnpm\n");
  });
});
