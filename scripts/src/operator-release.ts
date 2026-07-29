import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  approvedImageRepositories,
  artifactImageNames,
  operatorReleaseImageTargets,
  pinnedRedisReference,
  releaseImageCatalog,
  releaseImageEnvironmentNames,
  type ArtifactImageName,
  type ReleaseArtifact,
  type ReleaseArtifactImage,
} from "./release-images.js";

export {
  approvedImageRepositories,
  artifactImageNames,
  operatorReleaseImageTargets,
  pinnedRedisReference,
  releaseImageCatalog,
  releaseImageEnvironmentNames,
  type ArtifactImageName,
  type OperatorReleaseImageTarget,
  type ReleaseArtifact,
  type ReleaseArtifactImage,
  type ReleaseImageCatalogEntry,
} from "./release-images.js";

export type OperatorReleaseMode = "production" | "loopback-local-smoke";

export type OperatorReleaseOptions = {
  mode: OperatorReleaseMode;
  releaseId: string;
  sourceCommit: string;
  repositoryRoot: string;
};

export type OperatorReleaseOutput = {
  envFragmentPath: string;
  manifestPath: string;
  releaseArtifact: ReleaseArtifact;
};

export type OperatorReleaseCommandResult = {
  status: number;
  stderr: string;
  stdout: string;
};

export type OperatorReleaseDependencies = {
  command(
    executable: string,
    args: readonly string[],
    options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
  ): Promise<OperatorReleaseCommandResult>;
  randomId(): string;
  temporaryRoot(): string;
};

export type OperatorReleaseCliIo = {
  repositoryRoot: string;
  stderr(value: string): void;
  stdout(value: string): void;
};

const releaseIdPattern =
  /^v[0-9]+[.][0-9]+[.][0-9]+(?:-[a-z0-9][a-z0-9.-]{0,63})?$/;
const sourceCommitPattern = /^[a-f0-9]{40}$/;
const zeroSourceCommit = "0".repeat(40);
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const zeroDigest = `sha256:${"0".repeat(64)}`;
const argumentFlags = new Set(["--mode", "--release-id", "--source-commit"]);
const sourceRepository = "https://github.com/ALTIS13/Apollo.TF";
const builderIdPattern = /^[a-z0-9][a-z0-9-]{0,47}$/;
const absentManifestPattern = /(?:manifest unknown|not found)/i;
const digestAttempts = 5;
const publicOperatorErrorCodes = new Set([
  "artifact_validation_failed",
  "builder_create_failed",
  "cleanup_failed",
  "digest_resolution_failed",
  "dirty_worktree",
  "image_build_failed",
  "invalid_arguments",
  "invalid_release_id",
  "invalid_release_mode",
  "invalid_source_commit",
  "release_error",
  "release_output_exists",
  "release_tag_check_failed",
  "release_tag_exists",
  "source_validation_failed",
]);
const releaseEnvironmentOrder = [
  "PLATFORM_POSTGRES_IMAGE",
  "PLATFORM_REDIS_IMAGE",
  "PLATFORM_API_IMAGE",
  "TF_POSTGRES_IMAGE",
  "TF_REDIS_IMAGE",
  "TF_API_IMAGE",
  "TF_WEB_IMAGE",
  "TF_ADMIN_IMAGE",
  "TF_SEARCH_IMAGE",
  "TF_INTEGRATIONS_POSTGRES_IMAGE",
  "TF_INTEGRATIONS_IMAGE",
  "TF_DOWNLOAD_REDIS_IMAGE",
  "TF_DOWNLOAD_WORKER_IMAGE",
] as const;
const sourceValidationCommands: readonly {
  args: readonly string[];
  executable: "corepack" | "pnpm";
  timeoutMs: number;
}[] = [
  { args: ["enable"], executable: "corepack", timeoutMs: 60_000 },
  {
    args: ["install", "--frozen-lockfile"],
    executable: "pnpm",
    timeoutMs: 10 * 60_000,
  },
  {
    args: ["--filter", "@workspace/scripts", "test"],
    executable: "pnpm",
    timeoutMs: 20 * 60_000,
  },
  {
    args: [
      "--filter",
      "@workspace/platform-api",
      "exec",
      "vitest",
      "run",
      "--maxWorkers=2",
    ],
    executable: "pnpm",
    timeoutMs: 20 * 60_000,
  },
  {
    args: [
      "--filter",
      "@workspace/api-server",
      "exec",
      "vitest",
      "run",
      "--maxWorkers=1",
    ],
    executable: "pnpm",
    timeoutMs: 20 * 60_000,
  },
  {
    args: [
      "--filter",
      "@workspace/admin-dashboard",
      "exec",
      "vitest",
      "run",
      "--maxWorkers=2",
    ],
    executable: "pnpm",
    timeoutMs: 20 * 60_000,
  },
  {
    args: [
      "--filter",
      "@workspace/music-player",
      "exec",
      "vitest",
      "run",
      "--maxWorkers=2",
    ],
    executable: "pnpm",
    timeoutMs: 20 * 60_000,
  },
  {
    args: [
      "--filter",
      "@workspace/tf-search",
      "exec",
      "vitest",
      "run",
      "--maxWorkers=2",
    ],
    executable: "pnpm",
    timeoutMs: 20 * 60_000,
  },
  {
    args: [
      "--filter",
      "@workspace/tf-integrations",
      "exec",
      "vitest",
      "run",
      "--maxWorkers=2",
    ],
    executable: "pnpm",
    timeoutMs: 20 * 60_000,
  },
  {
    args: [
      "--filter",
      "@workspace/tf-download-worker",
      "exec",
      "vitest",
      "run",
      "--maxWorkers=2",
    ],
    executable: "pnpm",
    timeoutMs: 20 * 60_000,
  },
  {
    args: ["run", "typecheck"],
    executable: "pnpm",
    timeoutMs: 20 * 60_000,
  },
];

const defaultOperatorReleaseDependencies: OperatorReleaseDependencies = {
  command(executable, args, options) {
    return new Promise((complete) => {
      let stderr = "";
      let stdout = "";
      let completed = false;
      const finish = (result: OperatorReleaseCommandResult): void => {
        if (completed) return;
        completed = true;
        complete(result);
      };
      const child = spawn(executable, [...args], {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        timeout: options.timeoutMs,
        windowsHide: true,
      });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", () => {
        finish({ status: -1, stderr: "", stdout: "" });
      });
      child.on("close", (status) => {
        finish({ status: status ?? -1, stderr, stdout });
      });
    });
  },
  randomId: randomUUID,
  temporaryRoot: () =>
    join(tmpdir(), `apollo-operator-release-${randomUUID()}`),
};

function assertReleaseId(releaseId: string): void {
  if (!releaseIdPattern.test(releaseId)) {
    throw new Error("invalid_release_id");
  }
}

export function parseOperatorReleaseArguments(argv: readonly string[]): {
  mode: OperatorReleaseMode;
  releaseId: string;
  sourceCommit: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      flag === undefined ||
      value === undefined ||
      !argumentFlags.has(flag) ||
      values.has(flag) ||
      value.startsWith("--")
    ) {
      throw new Error("invalid_arguments");
    }
    values.set(flag, value);
  }
  if (values.size !== argumentFlags.size) {
    throw new Error("invalid_arguments");
  }

  const mode = values.get("--mode");
  if (mode !== "production") {
    throw new Error("invalid_release_mode");
  }

  const releaseId = values.get("--release-id");
  const sourceCommit = values.get("--source-commit");
  if (releaseId === undefined || sourceCommit === undefined) {
    throw new Error("invalid_arguments");
  }
  assertReleaseId(releaseId);
  if (
    !sourceCommitPattern.test(sourceCommit) ||
    sourceCommit === zeroSourceCommit
  ) {
    throw new Error("invalid_source_commit");
  }

  return { mode, releaseId, sourceCommit };
}

export function operatorReleaseOutputDirectory(
  repositoryRoot: string,
  releaseId: string,
): string {
  assertReleaseId(releaseId);
  return resolve(repositoryRoot, ".ops-private", "releases", releaseId);
}

function operatorError(code: string): Error {
  return new Error(code);
}

function sanitizedOperatorError(error: unknown): Error {
  if (error instanceof Error && publicOperatorErrorCodes.has(error.message)) {
    return error;
  }
  return operatorError("release_error");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function checkedCommand(
  dependencies: OperatorReleaseDependencies,
  code: string,
  executable: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs?: number },
): Promise<OperatorReleaseCommandResult> {
  let result: OperatorReleaseCommandResult;
  try {
    result = await dependencies.command(executable, args, options);
  } catch {
    throw operatorError(code);
  }
  if (result.status !== 0) throw operatorError(code);
  return result;
}

function parseDigest(stdout: string): string | undefined {
  const value = stdout.trim().replace(/^"|"$/g, "");
  return digestPattern.test(value) && value !== zeroDigest ? value : undefined;
}

function pinnedRedisArtifactImage(): ReleaseArtifactImage {
  const entry = releaseImageCatalog.find(
    (candidate) => candidate.kind === "external",
  );
  if (entry === undefined) throw operatorError("artifact_validation_failed");
  const separator = pinnedRedisReference.lastIndexOf("@");
  const digest = pinnedRedisReference.slice(separator + 1);
  if (
    separator < 0 ||
    !pinnedRedisReference.startsWith(`${entry.repository}:`) ||
    !digestPattern.test(digest) ||
    digest === zeroDigest
  ) {
    throw operatorError("artifact_validation_failed");
  }
  return {
    imageDigest: digest,
    imageReference: `${entry.repository}@${digest}`,
    name: entry.name,
    repository: entry.repository,
  };
}

function validateReleaseArtifact(artifact: ReleaseArtifact): void {
  if (
    artifact.formatVersion !== 1 ||
    artifact.sourceCommit === zeroSourceCommit ||
    !sourceCommitPattern.test(artifact.sourceCommit) ||
    artifact.images.length !== artifactImageNames.length
  ) {
    throw operatorError("artifact_validation_failed");
  }
  const expectedNames = [...artifactImageNames].sort();
  if (
    artifact.images.some((image, index) => {
      const expectedName = expectedNames[index];
      return (
        image.name !== expectedName ||
        approvedImageRepositories[image.name as ArtifactImageName] !==
          image.repository ||
        !digestPattern.test(image.imageDigest) ||
        image.imageDigest === zeroDigest ||
        image.imageReference !== `${image.repository}@${image.imageDigest}`
      );
    })
  ) {
    throw operatorError("artifact_validation_failed");
  }
}

function renderReleaseEnvironment(artifact: ReleaseArtifact): string {
  const references = new Map(
    artifact.images.map(({ imageReference, name }) => [name, imageReference]),
  );
  const lines = [`RELEASE_SOURCE_COMMIT=${artifact.sourceCommit}`];
  for (const environmentName of releaseEnvironmentOrder) {
    const imageName = releaseImageEnvironmentNames[environmentName];
    const reference = references.get(imageName);
    if (reference === undefined) {
      throw operatorError("artifact_validation_failed");
    }
    lines.push(`${environmentName}=${reference}`);
  }
  return `${lines.join("\n")}\n`;
}

async function writeReleaseOutput(
  stagingDirectory: string,
  releaseDirectory: string,
  releaseArtifact: ReleaseArtifact,
): Promise<OperatorReleaseOutput> {
  const stagedManifestPath = join(
    stagingDirectory,
    "apollo-release-manifest.json",
  );
  const stagedEnvFragmentPath = join(stagingDirectory, "release-images.env");
  const renderedEnvironment = renderReleaseEnvironment(releaseArtifact);
  try {
    const manifestHandle = await open(stagedManifestPath, "wx", 0o600);
    try {
      await manifestHandle.writeFile(
        `${JSON.stringify(releaseArtifact, null, 2)}\n`,
        "utf8",
      );
      await manifestHandle.sync();
    } finally {
      await manifestHandle.close();
    }

    const environmentHandle = await open(stagedEnvFragmentPath, "wx", 0o600);
    try {
      await environmentHandle.writeFile(renderedEnvironment, "utf8");
      await environmentHandle.sync();
    } finally {
      await environmentHandle.close();
    }

    validateReleaseArtifact(
      JSON.parse(await readFile(stagedManifestPath, "utf8")) as ReleaseArtifact,
    );
    if (
      (await readFile(stagedEnvFragmentPath, "utf8")) !== renderedEnvironment
    ) {
      throw operatorError("artifact_validation_failed");
    }
    if (await pathExists(releaseDirectory)) {
      throw operatorError("artifact_validation_failed");
    }
    await rename(stagingDirectory, releaseDirectory);
  } catch {
    throw operatorError("artifact_validation_failed");
  }
  return {
    envFragmentPath: join(releaseDirectory, "release-images.env"),
    manifestPath: join(releaseDirectory, "apollo-release-manifest.json"),
    releaseArtifact,
  };
}

export async function publishOperatorRelease(
  options: OperatorReleaseOptions,
  dependencies: OperatorReleaseDependencies = defaultOperatorReleaseDependencies,
): Promise<OperatorReleaseOutput> {
  if (options.mode !== "production") {
    throw operatorError("invalid_release_mode");
  }
  assertReleaseId(options.releaseId);
  if (
    !sourceCommitPattern.test(options.sourceCommit) ||
    options.sourceCommit === zeroSourceCommit
  ) {
    throw operatorError("invalid_source_commit");
  }

  const releaseDirectory = operatorReleaseOutputDirectory(
    options.repositoryRoot,
    options.releaseId,
  );
  let archivePath: string | undefined;
  let builderName: string | undefined;
  let builderRemovalRequired = false;
  let output: OperatorReleaseOutput | undefined;
  let primaryError: Error | undefined;
  let releaseStagingDirectory: string | undefined;
  let releaseStagingOwned = false;
  let sourceRoot: string | undefined;
  let temporaryRoot: string | undefined;
  let temporaryRootOwned = false;

  try {
    const worktree = await checkedCommand(
      dependencies,
      "dirty_worktree",
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd: options.repositoryRoot, timeoutMs: 60_000 },
    );
    if (worktree.stdout.trim() !== "") throw operatorError("dirty_worktree");

    await checkedCommand(
      dependencies,
      "invalid_source_commit",
      "git",
      ["cat-file", "-e", `${options.sourceCommit}^{commit}`],
      { cwd: options.repositoryRoot, timeoutMs: 60_000 },
    );
    if (await pathExists(releaseDirectory)) {
      throw operatorError("release_output_exists");
    }

    temporaryRoot = dependencies.temporaryRoot();
    sourceRoot = join(temporaryRoot, "source");
    archivePath = join(temporaryRoot, "source.tar");
    try {
      await mkdir(temporaryRoot);
      temporaryRootOwned = true;
      await mkdir(sourceRoot);
    } catch {
      throw operatorError("source_validation_failed");
    }
    await checkedCommand(
      dependencies,
      "source_validation_failed",
      "git",
      [
        "archive",
        "--format=tar",
        "--output",
        archivePath,
        options.sourceCommit,
      ],
      { cwd: options.repositoryRoot, timeoutMs: 5 * 60_000 },
    );
    await checkedCommand(
      dependencies,
      "source_validation_failed",
      "tar",
      ["-xf", archivePath, "-C", sourceRoot],
      { cwd: options.repositoryRoot, timeoutMs: 5 * 60_000 },
    );
    for (const validation of sourceValidationCommands) {
      await checkedCommand(
        dependencies,
        "source_validation_failed",
        validation.executable,
        validation.args,
        { cwd: sourceRoot, timeoutMs: validation.timeoutMs },
      );
    }

    for (const target of operatorReleaseImageTargets) {
      let inspection: OperatorReleaseCommandResult;
      try {
        inspection = await dependencies.command(
          "docker",
          [
            "buildx",
            "imagetools",
            "inspect",
            `${target.repository}:${options.releaseId}`,
            "--format",
            "{{json .Manifest.Digest}}",
          ],
          { cwd: sourceRoot, timeoutMs: 60_000 },
        );
      } catch {
        throw operatorError("release_tag_check_failed");
      }
      if (inspection.status === 0) throw operatorError("release_tag_exists");
      if (!absentManifestPattern.test(inspection.stderr)) {
        throw operatorError("release_tag_check_failed");
      }
    }

    let runId: string;
    try {
      runId = dependencies.randomId();
    } catch {
      throw operatorError("builder_create_failed");
    }
    if (!builderIdPattern.test(runId)) {
      throw operatorError("builder_create_failed");
    }
    builderName = `apollo-release-${runId}`;
    releaseStagingDirectory = join(
      dirname(releaseDirectory),
      `.${options.releaseId}.staging-${runId}`,
    );
    await checkedCommand(
      dependencies,
      "builder_create_failed",
      "docker",
      [
        "buildx",
        "create",
        "--name",
        builderName,
        "--driver",
        "docker-container",
      ],
      { cwd: sourceRoot, timeoutMs: 5 * 60_000 },
    );
    builderRemovalRequired = true;

    for (const target of operatorReleaseImageTargets) {
      await checkedCommand(
        dependencies,
        "image_build_failed",
        "docker",
        [
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
          `org.opencontainers.image.source=${sourceRepository}`,
          "--label",
          `org.opencontainers.image.revision=${options.sourceCommit}`,
          "--label",
          `org.opencontainers.image.version=${options.releaseId}`,
          "--file",
          join(sourceRoot, target.dockerfile),
          "--target",
          target.target,
          "--tag",
          `${target.repository}:${options.releaseId}`,
          "--push",
          sourceRoot,
        ],
        { cwd: sourceRoot, timeoutMs: 60 * 60_000 },
      );
    }

    const images: ReleaseArtifactImage[] = [];
    for (const target of operatorReleaseImageTargets) {
      const reference = `${target.repository}:${options.releaseId}`;
      let digest: string | undefined;
      for (let attempt = 0; attempt < digestAttempts; attempt += 1) {
        let inspection: OperatorReleaseCommandResult;
        try {
          inspection = await dependencies.command(
            "docker",
            [
              "buildx",
              "imagetools",
              "inspect",
              reference,
              "--format",
              "{{json .Manifest.Digest}}",
            ],
            { cwd: sourceRoot, timeoutMs: 60_000 },
          );
        } catch {
          inspection = { status: -1, stderr: "", stdout: "" };
        }
        if (inspection.status === 0) digest = parseDigest(inspection.stdout);
        if (digest !== undefined) break;
      }
      if (digest === undefined) {
        throw operatorError("digest_resolution_failed");
      }
      images.push({
        imageDigest: digest,
        imageReference: `${target.repository}@${digest}`,
        name: target.name,
        repository: target.repository,
      });
    }
    images.push(pinnedRedisArtifactImage());
    images.sort(({ name: left }, { name: right }) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    const releaseArtifact: ReleaseArtifact = {
      formatVersion: 1,
      images,
      sourceCommit: options.sourceCommit,
    };
    validateReleaseArtifact(releaseArtifact);
    try {
      await mkdir(dirname(releaseDirectory), { recursive: true });
      await mkdir(releaseStagingDirectory, { mode: 0o700 });
      releaseStagingOwned = true;
    } catch {
      throw operatorError("artifact_validation_failed");
    }
    output = await writeReleaseOutput(
      releaseStagingDirectory,
      releaseDirectory,
      releaseArtifact,
    );
    releaseStagingOwned = false;
  } catch (error) {
    primaryError = sanitizedOperatorError(error);
  }

  let cleanupFailed = false;
  if (releaseStagingOwned) {
    try {
      await rm(releaseStagingDirectory!, { force: true, recursive: true });
    } catch {
      cleanupFailed = true;
    }
  }
  if (builderRemovalRequired) {
    try {
      const removal = await dependencies.command(
        "docker",
        ["buildx", "rm", builderName!],
        { cwd: sourceRoot!, timeoutMs: 5 * 60_000 },
      );
      if (removal.status !== 0) cleanupFailed = true;
    } catch {
      cleanupFailed = true;
    }
  }
  if (temporaryRootOwned) {
    try {
      await rm(temporaryRoot!, { force: true, recursive: true });
    } catch {
      cleanupFailed = true;
    }
  }

  if (primaryError !== undefined) throw primaryError;
  if (cleanupFailed) throw operatorError("cleanup_failed");
  if (output === undefined) throw operatorError("release_error");
  return output;
}

const defaultOperatorReleaseCliIo: OperatorReleaseCliIo = {
  repositoryRoot: process.cwd(),
  stderr: (value) => {
    process.stderr.write(value);
  },
  stdout: (value) => {
    process.stdout.write(value);
  },
};

function publicErrorCode(error: unknown): string {
  return sanitizedOperatorError(error).message;
}

export async function runOperatorReleaseCli(
  argv: readonly string[],
  dependencies: OperatorReleaseDependencies = defaultOperatorReleaseDependencies,
  io: OperatorReleaseCliIo = defaultOperatorReleaseCliIo,
): Promise<number> {
  try {
    const parsed = parseOperatorReleaseArguments(argv);
    const output = await publishOperatorRelease(
      { ...parsed, repositoryRoot: io.repositoryRoot },
      dependencies,
    );
    io.stdout(`${JSON.stringify(output)}\n`);
    return 0;
  } catch (error) {
    io.stderr(`${JSON.stringify({ error: publicErrorCode(error) })}\n`);
    return 1;
  }
}

const entryPath = process.argv[1];
if (
  entryPath !== undefined &&
  import.meta.url === pathToFileURL(resolve(entryPath)).href
) {
  void runOperatorReleaseCli(process.argv.slice(2)).then((status) => {
    process.exitCode = status;
  });
}
