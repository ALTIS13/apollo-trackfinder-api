import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rename,
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
  prepareOperatorRelease,
  publishOperatorRelease,
  releaseImageCatalog as operatorReleaseImageCatalog,
  runOperatorReleaseCommand,
  runOperatorReleaseCli,
  verifyOperatorReleaseEvidence,
  type OperatorReleaseCommandResult,
  type OperatorReleaseDependencies,
} from "./operator-release.js";
import * as operatorReleaseModule from "./operator-release.js";
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
const corepackCliPath = join(
  dirname(process.execPath),
  "node_modules",
  "corepack",
  "dist",
  "corepack.js",
);
const pnpmCliPath = join(
  dirname(process.execPath),
  "node_modules",
  "corepack",
  "dist",
  "pnpm.js",
);
const digestFor = (index: number): string =>
  `sha256:${String(index + 1).padStart(64, "0")}`;

type RecordedCommand = {
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv | undefined;
  executable: string;
  signal: AbortSignal | undefined;
};

async function publisherHarness(options?: {
  atomicRename?: (from: string, to: string) => Promise<void>;
  command?: (
    command: RecordedCommand,
    defaultResult: () => OperatorReleaseCommandResult,
  ) => OperatorReleaseCommandResult | Promise<OperatorReleaseCommandResult>;
  publicationCheckpoint?: (
    checkpoint:
      | "staged_completion_written"
      | "staged_environment_written"
      | "staged_manifest_written",
  ) => Promise<void>;
  randomId?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
  temporaryRoot?: () => string;
}) {
  const root = await mkdtemp(join(tmpdir(), "apollo-operator-release-test-"));
  const repositoryRoot = join(root, "repository");
  const temporaryRoot = join(root, "owned-temporary-root");
  const atomicRenames: { from: string; to: string }[] = [];
  const builders = new Set<string>();
  const commands: RecordedCommand[] = [];
  const publishedTags = new Set<string>();
  const sleeps: number[] = [];
  await mkdir(repositoryRoot);

  const dependencies: OperatorReleaseDependencies = {
    async atomicRename(from, to) {
      atomicRenames.push({ from, to });
      if (options?.atomicRename !== undefined) {
        await options.atomicRename(from, to);
      } else {
        await rename(from, to);
      }
    },
    async command(executable, args, commandOptions) {
      const recorded = {
        args: [...args],
        cwd: commandOptions.cwd,
        env: commandOptions.env,
        executable,
        signal: commandOptions.signal,
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
          args[1] === "create"
        ) {
          builders.add(args[args.indexOf("--name") + 1] ?? "");
        }
        if (
          executable === "docker" &&
          args[0] === "buildx" &&
          args[1] === "inspect"
        ) {
          return builders.has(args[2] ?? "")
            ? { status: 0, stderr: "", stdout: "" }
            : { status: 1, stderr: "builder not found", stdout: "" };
        }
        if (
          executable === "docker" &&
          args[0] === "buildx" &&
          args[1] === "rm"
        ) {
          builders.delete(args[2] ?? "");
        }
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
          const tag = args[args.indexOf("--tag") + 1] ?? "";
          publishedTags.add(tag);
          const targetIndex = operatorReleaseImageTargets.findIndex(
            ({ repository }) => tag.startsWith(`${repository}:`),
          );
          const metadataIndex = args.indexOf("--metadata-file");
          if (metadataIndex >= 0) {
            writeFileSync(
              args[metadataIndex + 1]!,
              `${JSON.stringify({
                "containerimage.digest": digestFor(targetIndex),
              })}\n`,
              "utf8",
            );
          }
        }
        return { status: 0, stderr: "", stdout: "" };
      };
      return options?.command?.(recorded, defaultResult) ?? defaultResult();
    },
    publicationCheckpoint: options?.publicationCheckpoint,
    randomId: options?.randomId ?? (() => "task-2-owned"),
    async sleep(milliseconds) {
      sleeps.push(milliseconds);
      await options?.sleep?.(milliseconds);
    },
    temporaryRoot: options?.temporaryRoot ?? (() => temporaryRoot),
  };

  return {
    atomicRenames,
    builders,
    commands,
    dependencies,
    publishedTags,
    releaseArchive: join(
      repositoryRoot,
      ".ops-private",
      "release-claims",
      releaseId,
      "source.tar",
    ),
    releaseClaim: join(
      repositoryRoot,
      ".ops-private",
      "release-claims",
      releaseId,
    ),
    releaseCompletion: join(
      repositoryRoot,
      ".ops-private",
      "releases",
      releaseId,
      "apollo-release-complete.json",
    ),
    releaseOutput: join(repositoryRoot, ".ops-private", "releases", releaseId),
    releaseReceipt: join(
      repositoryRoot,
      ".ops-private",
      "release-claims",
      releaseId,
      "prepare-receipt.json",
    ),
    releaseStaging: join(
      repositoryRoot,
      ".ops-private",
      "releases",
      `.${releaseId}.staging-task-2-owned`,
    ),
    repositoryRoot,
    root,
    sleeps,
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

async function prepareHarness(
  harness: Awaited<ReturnType<typeof publisherHarness>>,
): Promise<void> {
  await prepareOperatorRelease(
    {
      mode: "production",
      releaseId,
      repositoryRoot: harness.repositoryRoot,
      sourceCommit,
    },
    harness.dependencies,
  );
  harness.commands.length = 0;
}

function publicationOptions(
  harness: Awaited<ReturnType<typeof publisherHarness>>,
  overrides?: { signal?: AbortSignal; sourceCommit?: string },
) {
  return {
    mode: "production" as const,
    receiptPath: harness.releaseReceipt,
    releaseId,
    repositoryRoot: harness.repositoryRoot,
    signal: overrides?.signal,
    sourceCommit: overrides?.sourceCommit ?? sourceCommit,
  };
}

describe("operator release arguments", () => {
  it("exposes a distinct source-preparation operation", () => {
    expect(operatorReleaseModule).toHaveProperty("prepareOperatorRelease");
    expect(
      (
        operatorReleaseModule as typeof operatorReleaseModule & {
          prepareOperatorRelease?: unknown;
        }
      ).prepareOperatorRelease,
    ).toBeTypeOf("function");
  });

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

describe("operator release preparation", () => {
  it("claims the release and publishes a receipt only after the complete archived-source gate", async () => {
    const sentinelName = "APOLLO_OPERATOR_SENTINEL_SECRET";
    const previousSentinel = process.env[sentinelName];
    process.env[sentinelName] = "must-not-cross-child-boundary";
    const harness = await publisherHarness();
    try {
      const output = await prepareOperatorRelease(
        {
          mode: "production",
          releaseId,
          repositoryRoot: harness.repositoryRoot,
          sourceCommit,
        },
        harness.dependencies,
      );

      expect(output).toMatchObject({
        archiveSha256: sha256("synthetic-source-archive\n"),
        receiptPath: harness.releaseReceipt,
        releaseId,
        sourceCommit,
      });
      expect(output.sourceTreeSha256).toMatch(/^[a-f0-9]{64}$/);
      const receipt = JSON.parse(
        await readFile(harness.releaseReceipt, "utf8"),
      ) as Record<string, unknown>;
      expect(Object.keys(receipt).sort()).toEqual(
        [
          "archiveFile",
          "archiveSha256",
          "formatVersion",
          "imageCatalog",
          "protocolVersion",
          "releaseId",
          "sourceCommit",
          "sourceTreeSha256",
        ].sort(),
      );
      expect(receipt).toMatchObject({
        archiveFile: "source.tar",
        archiveSha256: output.archiveSha256,
        formatVersion: 1,
        imageCatalog: releaseImageCatalog,
        protocolVersion: 2,
        releaseId,
        sourceCommit,
        sourceTreeSha256: output.sourceTreeSha256,
      });
      expect(await readFile(harness.releaseArchive, "utf8")).toBe(
        "synthetic-source-archive\n",
      );
      expect(
        harness.commands.some(({ executable }) => executable === "docker"),
      ).toBe(false);

      const sourceGate = harness.commands.filter(({ cwd }) =>
        cwd.endsWith("validation-source"),
      );
      expect(sourceGate).toHaveLength(11);
      expect(
        sourceGate.every(({ executable }) => executable === process.execPath),
      ).toBe(true);
      expect(sourceGate[0]?.args.at(-1)).toBe("enable");
      expect(sourceGate[1]?.args.slice(-2)).toEqual([
        "install",
        "--frozen-lockfile",
      ]);
      expect(sourceGate.at(-1)?.args.slice(-2)).toEqual(["run", "typecheck"]);
      for (const command of harness.commands) {
        expect(command.env).toBeDefined();
        expect(command.env).not.toHaveProperty(sentinelName);
        expect(command.env).not.toHaveProperty("CR_PAT");
        expect(command.env).not.toHaveProperty("GHCR_TOKEN");
      }
      expect(
        harness.commands.some(({ executable }) =>
          executable.toLowerCase().endsWith("cmd.exe"),
        ),
      ).toBe(false);
    } finally {
      if (previousSentinel === undefined) {
        delete process.env[sentinelName];
      } else {
        process.env[sentinelName] = previousSentinel;
      }
      await rm(harness.root, { force: true, recursive: true });
    }
  });

  it("allows only one same-ID preparation claimant", async () => {
    const harness = await publisherHarness();
    const options = {
      mode: "production" as const,
      releaseId,
      repositoryRoot: harness.repositoryRoot,
      sourceCommit,
    };
    try {
      const results = await Promise.allSettled([
        prepareOperatorRelease(options, harness.dependencies),
        prepareOperatorRelease(options, harness.dependencies),
      ]);

      expect(
        results.filter(({ status }) => status === "fulfilled"),
      ).toHaveLength(1);
      const rejection = results.find(({ status }) => status === "rejected");
      expect(rejection).toMatchObject({
        reason: new Error("release_claim_exists"),
        status: "rejected",
      });
      expect(await pathExists(harness.releaseClaim)).toBe(true);
      expect(await pathExists(harness.releaseReceipt)).toBe(true);
    } finally {
      await rm(harness.root, { force: true, recursive: true });
    }
  });

  it("retains the exclusive claim but no receipt when source validation fails", async () => {
    const harness = await publisherHarness({
      command(command, defaultResult) {
        if (command.args.includes("@workspace/api-server")) {
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
        prepareOperatorRelease(
          {
            mode: "production",
            releaseId,
            repositoryRoot: harness.repositoryRoot,
            sourceCommit,
          },
          harness.dependencies,
        ),
      ).rejects.toThrowError(/^source_validation_failed$/);
      expect(await pathExists(harness.releaseClaim)).toBe(true);
      expect(await pathExists(harness.releaseReceipt)).toBe(false);
      expect(
        harness.commands.some(({ executable }) => executable === "docker"),
      ).toBe(false);
      expect(await pathExists(harness.temporaryRoot)).toBe(false);
    } finally {
      await rm(harness.root, { force: true, recursive: true });
    }
  });
});

describe("operator release publication", () => {
  it.each([
    "missing",
    "malformed",
    "moved",
    "changed",
    "changed-archive",
    "wrong-source",
  ] as const)(
    "rejects a %s preparation receipt before registry access",
    async (scenario) => {
      const harness = await publisherHarness();
      try {
        await prepareOperatorRelease(
          {
            mode: "production",
            releaseId,
            repositoryRoot: harness.repositoryRoot,
            sourceCommit,
          },
          harness.dependencies,
        );
        let receiptPath = harness.releaseReceipt;
        let publicationSourceCommit = sourceCommit;
        if (scenario === "missing") {
          await rm(harness.releaseReceipt);
        } else if (scenario === "malformed") {
          await writeFile(harness.releaseReceipt, "{\n", "utf8");
        } else if (scenario === "moved") {
          receiptPath = join(harness.root, "moved-prepare-receipt.json");
          await copyFile(harness.releaseReceipt, receiptPath);
        } else if (scenario === "changed") {
          const receipt = JSON.parse(
            await readFile(harness.releaseReceipt, "utf8"),
          ) as Record<string, unknown>;
          await writeFile(
            harness.releaseReceipt,
            `${JSON.stringify({ ...receipt, protocolVersion: 3 }, null, 2)}\n`,
            "utf8",
          );
        } else if (scenario === "changed-archive") {
          await writeFile(harness.releaseArchive, "changed-archive\n", "utf8");
        } else {
          publicationSourceCommit = "b".repeat(40);
        }
        harness.commands.length = 0;

        await expect(
          publishOperatorRelease(
            {
              mode: "production",
              receiptPath,
              releaseId,
              repositoryRoot: harness.repositoryRoot,
              sourceCommit: publicationSourceCommit,
            },
            harness.dependencies,
          ),
        ).rejects.toThrowError(/^invalid_release_receipt$/);
        expect(
          harness.commands.some(({ executable }) => executable === "docker"),
        ).toBe(false);
        expect(
          await pathExists(
            join(harness.releaseClaim, "publication-started.json"),
          ),
        ).toBe(false);
      } finally {
        await rm(harness.root, { force: true, recursive: true });
      }
    },
  );

  it("resumes only the validated archive with an isolated environment and consumes the receipt once", async () => {
    const sentinelName = "APOLLO_PUBLICATION_SENTINEL_SECRET";
    const previousSentinel = process.env[sentinelName];
    process.env[sentinelName] = "must-not-cross-child-boundary";
    const harness = await publisherHarness();
    try {
      await prepareOperatorRelease(
        {
          mode: "production",
          releaseId,
          repositoryRoot: harness.repositoryRoot,
          sourceCommit,
        },
        harness.dependencies,
      );
      harness.commands.length = 0;
      const publicationOptions = {
        mode: "production" as const,
        receiptPath: harness.releaseReceipt,
        releaseId,
        repositoryRoot: harness.repositoryRoot,
        sourceCommit,
      };

      await expect(
        publishOperatorRelease(publicationOptions, harness.dependencies),
      ).resolves.toMatchObject({
        releaseArtifact: { sourceCommit },
      });
      expect(
        harness.commands.some(
          ({ args, executable }) =>
            executable === "git" ||
            args.some((argument) => argument.includes("pnpm.js")),
        ),
      ).toBe(false);
      expect(
        harness.commands.filter(
          ({ args, executable }) => executable === "tar" && args[0] === "-xf",
        ),
      ).toHaveLength(1);
      for (const command of harness.commands) {
        expect(command.env).toBeDefined();
        expect(command.env).not.toHaveProperty(sentinelName);
        expect(command.env).not.toHaveProperty("CR_PAT");
        expect(command.env).not.toHaveProperty("GHCR_TOKEN");
      }
      expect(
        JSON.parse(
          await readFile(
            join(harness.releaseClaim, "publication-started.json"),
            "utf8",
          ),
        ),
      ).toMatchObject({
        formatVersion: 1,
        protocolVersion: 2,
        releaseId,
        sourceCommit,
      });
      expect(await pathExists(harness.releaseReceipt)).toBe(true);
      expect(await pathExists(harness.releaseArchive)).toBe(true);

      const dockerCommandCount = harness.commands.filter(
        ({ executable }) => executable === "docker",
      ).length;
      await expect(
        publishOperatorRelease(publicationOptions, harness.dependencies),
      ).rejects.toThrowError(/^release_receipt_reused$/);
      expect(
        harness.commands.filter(({ executable }) => executable === "docker"),
      ).toHaveLength(dockerCommandCount);
    } finally {
      if (previousSentinel === undefined) {
        delete process.env[sentinelName];
      } else {
        process.env[sentinelName] = previousSentinel;
      }
      await rm(harness.root, { force: true, recursive: true });
    }
  });

  it("allows only one concurrent publication to consume a prepared receipt", async () => {
    const harness = await publisherHarness();
    try {
      await prepareOperatorRelease(
        {
          mode: "production",
          releaseId,
          repositoryRoot: harness.repositoryRoot,
          sourceCommit,
        },
        harness.dependencies,
      );
      harness.commands.length = 0;
      const publicationOptions = {
        mode: "production" as const,
        receiptPath: harness.releaseReceipt,
        releaseId,
        repositoryRoot: harness.repositoryRoot,
        sourceCommit,
      };
      const results = await Promise.allSettled([
        publishOperatorRelease(publicationOptions, harness.dependencies),
        publishOperatorRelease(publicationOptions, harness.dependencies),
      ]);

      expect(
        results.filter(({ status }) => status === "fulfilled"),
      ).toHaveLength(1);
      const rejected = results.find(
        ({ status }) => status === "rejected",
      ) as PromiseRejectedResult;
      expect(rejected.reason).toMatchObject({
        message: "release_receipt_reused",
      });
      expect(
        harness.commands.filter(
          ({ args, executable }) =>
            executable === "docker" &&
            args[0] === "buildx" &&
            args[1] === "create",
        ),
      ).toHaveLength(1);
    } finally {
      await rm(harness.root, { force: true, recursive: true });
    }
  });

  it("uses each owned Buildx metadata digest and verifies the release tag resolves to it", async () => {
    const harness = await publisherHarness();
    try {
      await prepareHarness(harness);
      const output = await publishOperatorRelease(
        publicationOptions(harness),
        harness.dependencies,
      );
      const builds = harness.commands.filter(
        ({ args, executable }) =>
          executable === "docker" &&
          args[0] === "buildx" &&
          args[1] === "build",
      );

      expect(builds).toHaveLength(operatorReleaseImageTargets.length);
      for (const [index, build] of builds.entries()) {
        const metadataIndex = build.args.indexOf("--metadata-file");
        expect(metadataIndex).toBeGreaterThan(0);
        expect(build.args[metadataIndex + 1]).toBe(
          join(
            harness.temporaryRoot,
            "build-metadata",
            `${operatorReleaseImageTargets[index]!.name}.json`,
          ),
        );
        expect(
          output.releaseArtifact.images.find(
            ({ name }) => name === operatorReleaseImageTargets[index]!.name,
          )?.imageDigest,
        ).toBe(digestFor(index));
      }
      expect(
        harness.commands.filter(
          ({ args, executable }) =>
            executable === "docker" &&
            args[0] === "buildx" &&
            args[1] === "imagetools" &&
            args[2] === "inspect",
        ),
      ).toHaveLength(operatorReleaseImageTargets.length * 2);
    } finally {
      await rm(harness.root, { force: true, recursive: true });
    }
  });

  it("fails when a release tag resolves to a digest other than its build metadata", async () => {
    const harness = await publisherHarness({
      command(command, defaultResult) {
        const result = defaultResult();
        if (
          command.executable === "docker" &&
          command.args[0] === "buildx" &&
          command.args[1] === "imagetools" &&
          command.args[2] === "inspect" &&
          result.status === 0
        ) {
          return {
            status: 0,
            stderr: "",
            stdout: `${JSON.stringify(digestFor(40))}\n`,
          };
        }
        return result;
      },
    });
    try {
      await prepareHarness(harness);
      await expect(
        publishOperatorRelease(
          publicationOptions(harness),
          harness.dependencies,
        ),
      ).rejects.toThrowError(/^digest_resolution_failed$/);
      await expectIncompleteReleaseEvidence(harness);
      expect(await pathExists(harness.releaseClaim)).toBe(true);
    } finally {
      await rm(harness.root, { force: true, recursive: true });
    }
  });

  it("uses deterministic increasing backoff between bounded digest inspections", async () => {
    let postBuildAttempts = 0;
    const firstReference = `${operatorReleaseImageTargets[0]!.repository}:${releaseId}`;
    const harness = await publisherHarness({
      command(command, defaultResult) {
        const result = defaultResult();
        if (
          command.executable === "docker" &&
          command.args[0] === "buildx" &&
          command.args[1] === "imagetools" &&
          command.args[2] === "inspect" &&
          command.args[3] === firstReference &&
          result.status === 0
        ) {
          postBuildAttempts += 1;
          if (postBuildAttempts < 5) {
            return { status: 1, stderr: "manifest unknown", stdout: "" };
          }
        }
        return result;
      },
    });
    try {
      await prepareHarness(harness);
      await expect(
        publishOperatorRelease(
          publicationOptions(harness),
          harness.dependencies,
        ),
      ).resolves.toMatchObject({ releaseArtifact: { sourceCommit } });
      expect(postBuildAttempts).toBe(5);
      expect(harness.sleeps).toEqual([250, 500, 1_000, 2_000]);
    } finally {
      await rm(harness.root, { force: true, recursive: true });
    }
  });

  it("atomically renames one complete validated staging directory into final evidence", async () => {
    let stagedFiles: string[] = [];
    const harness = await publisherHarness({
      async atomicRename(from, to) {
        stagedFiles = (
          await Promise.all(
            [
              "apollo-release-manifest.json",
              "release-images.env",
              "apollo-release-complete.json",
            ].map(async (name) => {
              expect(await pathExists(join(from, name))).toBe(true);
              return name;
            }),
          )
        ).sort();
        const manifest = await readFile(
          join(from, "apollo-release-manifest.json"),
          "utf8",
        );
        const environment = await readFile(
          join(from, "release-images.env"),
          "utf8",
        );
        const completion = JSON.parse(
          await readFile(join(from, "apollo-release-complete.json"), "utf8"),
        ) as Record<string, unknown>;
        expect(completion).toMatchObject({
          environmentSha256: sha256(environment),
          manifestSha256: sha256(manifest),
          releaseId,
          sourceCommit,
        });
        expect(await pathExists(to)).toBe(false);
        await rename(from, to);
      },
    });
    try {
      await prepareHarness(harness);
      const output = await publishOperatorRelease(
        publicationOptions(harness),
        harness.dependencies,
      );

      expect(stagedFiles).toEqual([
        "apollo-release-complete.json",
        "apollo-release-manifest.json",
        "release-images.env",
      ]);
      expect(harness.atomicRenames).toEqual([
        { from: harness.releaseStaging, to: harness.releaseOutput },
      ]);
      expect(output.manifestPath).toBe(
        join(harness.releaseOutput, "apollo-release-manifest.json"),
      );
      expect(await pathExists(harness.releaseStaging)).toBe(false);
    } finally {
      await rm(harness.root, { force: true, recursive: true });
    }
  });

  it("leaves final evidence absent and the claim retained when atomic rename fails", async () => {
    const harness = await publisherHarness({
      async atomicRename() {
        throw new Error("sentinel-atomic-rename-failure");
      },
    });
    try {
      await prepareHarness(harness);
      await expect(
        publishOperatorRelease(
          publicationOptions(harness),
          harness.dependencies,
        ),
      ).rejects.toThrowError(/^artifact_validation_failed$/);
      await expectIncompleteReleaseEvidence(harness);
      expect(await pathExists(harness.releaseClaim)).toBe(true);
      expect(harness.atomicRenames).toHaveLength(1);
    } finally {
      await rm(harness.root, { force: true, recursive: true });
    }
  });

  it("rejects a different Redis digest even when all evidence hashes are recomputed", async () => {
    const harness = await publisherHarness();
    try {
      await prepareHarness(harness);
      const output = await publishOperatorRelease(
        publicationOptions(harness),
        harness.dependencies,
      );
      const manifest = JSON.parse(
        await readFile(output.manifestPath, "utf8"),
      ) as typeof output.releaseArtifact;
      const tamperedDigest = `sha256:${"f".repeat(64)}`;
      const tamperedReference = `docker.io/library/redis@${tamperedDigest}`;
      const redis = manifest.images.find(({ name }) => name === "redis")!;
      redis.imageDigest = tamperedDigest;
      redis.imageReference = tamperedReference;
      const manifestContents = `${JSON.stringify(manifest, null, 2)}\n`;
      const environmentPath = join(harness.releaseOutput, "release-images.env");
      const environmentContents = (
        await readFile(environmentPath, "utf8")
      ).replaceAll(
        "docker.io/library/redis@sha256:595cc6f2bb3af6e03347b90deb6123c6aa2c81dea05ce08128de8a174b6ac67b",
        tamperedReference,
      );
      await writeFile(output.manifestPath, manifestContents, "utf8");
      await writeFile(environmentPath, environmentContents, "utf8");
      await writeFile(
        harness.releaseCompletion,
        `${JSON.stringify(
          {
            environmentSha256: sha256(environmentContents),
            formatVersion: 1,
            manifestSha256: sha256(manifestContents),
            releaseId,
            sourceCommit,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      expect(() =>
        verifyOperatorReleaseEvidence(output.manifestPath),
      ).toThrowError(/^invalid_release_manifest$/);
    } finally {
      await rm(harness.root, { force: true, recursive: true });
    }
  });

  it("persists builder ownership before create and reconciles an ambiguous create by exact name", async () => {
    let claimExistedAtCreate = false;
    const harness = await publisherHarness({
      async command(command, defaultResult) {
        if (
          command.executable === "docker" &&
          command.args[0] === "buildx" &&
          command.args[1] === "create"
        ) {
          claimExistedAtCreate = await pathExists(
            join(
              command.cwd,
              "..",
              "..",
              "repository",
              ".ops-private",
              "release-claims",
              releaseId,
              "builder-claim.json",
            ),
          );
          defaultResult();
          throw new Error("sentinel-ambiguous-create");
        }
        return defaultResult();
      },
    });
    try {
      await prepareHarness(harness);
      await expect(
        publishOperatorRelease(
          publicationOptions(harness),
          harness.dependencies,
        ),
      ).rejects.toThrowError(/^builder_create_failed$/);
      expect(claimExistedAtCreate).toBe(true);
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
      expect(harness.builders).toEqual(new Set());
      expect(JSON.stringify(harness.commands)).not.toContain("ambient-builder");
    } finally {
      await rm(harness.root, { force: true, recursive: true });
    }
  });

  it("awaits cancellation cleanup and removes only the owned builder", async () => {
    const controller = new AbortController();
    let buildCount = 0;
    const harness = await publisherHarness({
      command(command, defaultResult) {
        const result = defaultResult();
        if (
          command.executable === "docker" &&
          command.args[0] === "buildx" &&
          command.args[1] === "build"
        ) {
          buildCount += 1;
          if (buildCount === 6) controller.abort();
        }
        return result;
      },
    });
    try {
      await prepareHarness(harness);
      await expect(
        publishOperatorRelease(
          publicationOptions(harness, { signal: controller.signal }),
          harness.dependencies,
        ),
      ).rejects.toThrowError(/^publication_cancelled$/);
      expect(buildCount).toBe(6);
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
      expect(await pathExists(harness.releaseClaim)).toBe(true);
    } finally {
      await rm(harness.root, { force: true, recursive: true });
    }
  });

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
        prepareOperatorRelease(
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
    try {
      await prepareHarness(harness);
      harness.publishedTags.add(`${existingTarget.repository}:${releaseId}`);
      await expect(
        publishOperatorRelease(
          publicationOptions(harness),
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
      await prepareHarness(harness);
      await expect(
        publishOperatorRelease(
          publicationOptions(harness),
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
    const harness = await publisherHarness();
    try {
      await prepareHarness(harness);
      harness.dependencies.temporaryRoot = () => {
        throw new Error("private_secret_value");
      };
      await expect(
        publishOperatorRelease(
          publicationOptions(harness),
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
        if (validationRoot === undefined && command.args.includes("install")) {
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
      await prepareHarness(harness);
      await expect(
        publishOperatorRelease(
          publicationOptions(harness),
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
        if (!archiveMutated && command.args.includes("install")) {
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
        prepareOperatorRelease(
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
      await prepareOperatorRelease(
        {
          mode: "production",
          releaseId,
          repositoryRoot: harness.repositoryRoot,
          sourceCommit,
        },
        harness.dependencies,
      );
      const output = await publishOperatorRelease(
        publicationOptions(harness),
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
        [process.execPath, corepackCliPath, "enable"],
        [process.execPath, pnpmCliPath, "install", "--frozen-lockfile"],
        [
          process.execPath,
          pnpmCliPath,
          "--filter",
          "@workspace/scripts",
          "test",
        ],
        [
          process.execPath,
          pnpmCliPath,
          "--filter",
          "@workspace/platform-api",
          "exec",
          "vitest",
          "run",
          "--maxWorkers=2",
        ],
        [
          process.execPath,
          pnpmCliPath,
          "--filter",
          "@workspace/api-server",
          "exec",
          "vitest",
          "run",
          "--maxWorkers=1",
        ],
        [
          process.execPath,
          pnpmCliPath,
          "--filter",
          "@workspace/admin-dashboard",
          "exec",
          "vitest",
          "run",
          "--maxWorkers=2",
        ],
        [
          process.execPath,
          pnpmCliPath,
          "--filter",
          "@workspace/music-player",
          "exec",
          "vitest",
          "run",
          "--maxWorkers=2",
        ],
        [
          process.execPath,
          pnpmCliPath,
          "--filter",
          "@workspace/tf-search",
          "exec",
          "vitest",
          "run",
          "--maxWorkers=2",
        ],
        [
          process.execPath,
          pnpmCliPath,
          "--filter",
          "@workspace/tf-integrations",
          "exec",
          "vitest",
          "run",
          "--maxWorkers=2",
        ],
        [
          process.execPath,
          pnpmCliPath,
          "--filter",
          "@workspace/tf-download-worker",
          "exec",
          "vitest",
          "run",
          "--maxWorkers=2",
        ],
        [process.execPath, pnpmCliPath, "run", "typecheck"],
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
        harness.releaseArchive,
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
          "--metadata-file",
          join(harness.temporaryRoot, "build-metadata", `${target!.name}.json`),
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
        if (command.args.includes("@workspace/api-server")) {
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
        prepareOperatorRelease(
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
      publishOperatorRelease(publicationOptions(harness), harness.dependencies);
    try {
      await prepareHarness(harness);
      await expect(publish()).rejects.toThrowError(/^image_build_failed$/);
      expect(buildCount).toBe(6);
      expect(harness.publishedTags.size).toBe(5);
      await expectIncompleteReleaseEvidence(harness);
      expect(await pathExists(harness.temporaryRoot)).toBe(false);

      await expect(publish()).rejects.toThrowError(/^release_receipt_reused$/);
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
      await prepareHarness(harness);
      await expect(
        publishOperatorRelease(
          publicationOptions(harness),
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
    try {
      await prepareHarness(harness);
      const sentinelPath = join(harness.releaseStaging, "unrelated-sentinel");
      await mkdir(harness.releaseStaging, { recursive: true });
      await writeFile(sentinelPath, "unrelated\n", "utf8");
      await expect(
        publishOperatorRelease(
          publicationOptions(harness),
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
      await prepareHarness(harness);
      const publish = () =>
        publishOperatorRelease(
          publicationOptions(harness),
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

      await expect(publish()).rejects.toThrowError(/^release_receipt_reused$/);
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
      await prepareHarness(harness);
      const output = await publishOperatorRelease(
        publicationOptions(harness),
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
    "staged_manifest_written",
    "staged_environment_written",
    "staged_completion_written",
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
        await prepareHarness(harness);
        const publish = () =>
          publishOperatorRelease(
            publicationOptions(harness),
            harness.dependencies,
          );

        await expect(publish()).rejects.toThrowError(
          /^artifact_validation_failed$/,
        );
        expect(await pathExists(harness.releaseOutput)).toBe(false);
        await expectIncompleteReleaseEvidence(harness);
        expect(await pathExists(harness.releaseClaim)).toBe(true);
        const dockerCommandCount = harness.commands.filter(
          ({ executable }) => executable === "docker",
        ).length;

        await expect(publish()).rejects.toThrowError(
          /^release_receipt_reused$/,
        );
        expect(await pathExists(harness.releaseOutput)).toBe(false);
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
      await prepareHarness(harness);
      await expect(
        publishOperatorRelease(
          publicationOptions(harness),
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

  it.runIf(process.platform === "win32")(
    "preserves pnpm child arguments without command-string reconstruction",
    async () => {
      const sentinel = "sentinel with spaces & shell | metacharacters";
      const result = await runOperatorReleaseCommand(
        "pnpm",
        [
          "exec",
          "node",
          "-e",
          "process.stdout.write(process.argv[1])",
          sentinel,
        ],
        { cwd: workspaceRoot, timeoutMs: 30_000 },
      );

      expect(result).toEqual({
        status: 0,
        stderr: "",
        stdout: sentinel,
      });
    },
  );
});

describe("operator release CLI", () => {
  it.each([
    ["release:prepare", ["--mode", "invalid"]],
    ["release:publish", ["--mode", "invalid"]],
    ["release:validate", ["--mode", "invalid"]],
  ] as const)(
    "starts the real root %s entrypoint and fails invalid input with sanitized JSON",
    (script, argv) => {
      const result = spawnSync(
        process.execPath,
        [pnpmCliPath, "--reporter=silent", script, "--", ...argv],
        {
          cwd: workspaceRoot,
          encoding: "utf8",
          env: process.env,
          shell: false,
          timeout: 30_000,
          windowsHide: true,
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr.trim().split(/\r?\n/)).toHaveLength(1);
      expect(JSON.parse(result.stderr)).toEqual(
        script === "release:validate"
          ? { errors: [{ code: "invalid_arguments" }], ok: false }
          : { error: "invalid_arguments" },
      );
      expect(result.stderr).not.toContain(workspaceRoot);
      expect(result.stderr).not.toMatch(
        /(?:ERR_MODULE_NOT_FOUND|at \S+|node:internal|file:\/\/\/)/,
      );
    },
  );

  it("prepares and then publishes through distinct injected CLI operations", async () => {
    const harness = await publisherHarness();
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
      await expect(
        runOperatorReleaseCli(
          "prepare",
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
        archiveSha256: sha256("synthetic-source-archive\n"),
        receiptPath: harness.releaseReceipt,
        releaseId,
        sourceCommit,
      });

      stdout.length = 0;
      await expect(
        runOperatorReleaseCli(
          "publish",
          [
            "--mode",
            "production",
            "--release-id",
            releaseId,
            "--source-commit",
            sourceCommit,
            "--receipt",
            harness.releaseReceipt,
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
        if (command.args.includes("@workspace/api-server")) {
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
          "prepare",
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

  it("exposes the split publisher and validator through executable root scripts", async () => {
    const packageJson = JSON.parse(
      await readFile(join(workspaceRoot, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.["release:prepare"]).toBe(
      "pnpm --filter @workspace/scripts exec tsx src/operator-release.ts prepare",
    );
    expect(packageJson.scripts?.["release:publish"]).toBe(
      "pnpm --filter @workspace/scripts exec tsx src/operator-release.ts publish",
    );
    expect(packageJson.scripts?.["release:validate"]).toBe(
      "pnpm --filter @workspace/scripts exec tsx src/coolify-release.ts",
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
    expect(rolloutRunbook).toContain("$releaseId = 'v0.1.0-rc.1'");
    expect(rolloutRunbook).toContain(
      "$preparation = pnpm --silent release:prepare -- --mode production --release-id $releaseId --source-commit $approvedSourceCommit | ConvertFrom-Json",
    );
    expect(rolloutRunbook).toContain(
      "$env:CR_PAT | docker login ghcr.io -u ALTIS13 --password-stdin",
    );
    expect(rolloutRunbook).toContain(
      "if ($LASTEXITCODE -ne 0) { throw 'GHCR login failed' }",
    );
    expect(rolloutRunbook).toContain(
      "pnpm --silent release:publish -- --mode production --release-id $releaseId --source-commit $approvedSourceCommit --receipt $preparation.receiptPath",
    );
    expect(rolloutRunbook).toContain(
      "Remove-Item Env:\\CR_PAT -ErrorAction SilentlyContinue",
    );
    expect(rolloutRunbook).toContain(
      "pnpm --silent release:validate -- --env-file '<PRIVATE_RELEASE_ENV>' --mode production --release-manifest '.ops-private/releases/v0.1.0-rc.1/apollo-release-manifest.json'",
    );
    const prepareIndex = rolloutRunbook.indexOf(
      "pnpm --silent release:prepare",
    );
    const tryIndex = rolloutRunbook.indexOf("try {", prepareIndex);
    const loginIndex = rolloutRunbook.indexOf("docker login ghcr.io");
    const publishIndex = rolloutRunbook.indexOf(
      "pnpm --silent release:publish",
    );
    const finallyIndex = rolloutRunbook.indexOf("finally {", publishIndex);
    const credentialRemovalIndex = rolloutRunbook.indexOf(
      "Remove-Item Env:\\CR_PAT",
      finallyIndex,
    );
    expect([
      prepareIndex,
      tryIndex,
      loginIndex,
      publishIndex,
      finallyIndex,
      credentialRemovalIndex,
    ]).toEqual(
      [
        ...[
          prepareIndex,
          tryIndex,
          loginIndex,
          publishIndex,
          finallyIndex,
          credentialRemovalIndex,
        ],
      ].sort((left, right) => left - right),
    );
    expect(prepareIndex).toBeGreaterThan(-1);
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
