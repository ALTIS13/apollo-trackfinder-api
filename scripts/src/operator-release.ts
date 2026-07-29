import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, readFileSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleepTimer } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  approvedImageRepositories,
  artifactImageNames,
  operatorReleaseImageTargets,
  pinnedRedisDigest,
  pinnedRedisImmutableReference,
  pinnedRedisReference,
  pinnedRedisRepository,
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
  pinnedRedisDigest,
  pinnedRedisImmutableReference,
  pinnedRedisReference,
  pinnedRedisRepository,
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

export type OperatorReleasePublicationOptions = OperatorReleaseOptions & {
  receiptPath: string;
  signal?: AbortSignal;
};

export type OperatorReleaseOutput = {
  envFragmentPath: string;
  manifestPath: string;
  releaseArtifact: ReleaseArtifact;
};

export type OperatorReleasePreparationOutput = {
  archiveSha256: string;
  receiptPath: string;
  releaseId: string;
  sourceCommit: string;
  sourceTreeSha256: string;
};

export type OperatorReleaseCommandResult = {
  status: number;
  stderr: string;
  stdout: string;
};

export type OperatorReleaseDependencies = {
  atomicRename(from: string, to: string): Promise<void>;
  command(
    executable: string,
    args: readonly string[],
    options: {
      cwd: string;
      env?: NodeJS.ProcessEnv;
      signal?: AbortSignal;
      timeoutMs?: number;
    },
  ): Promise<OperatorReleaseCommandResult>;
  publicationCheckpoint?(
    checkpoint:
      | "staged_completion_written"
      | "staged_environment_written"
      | "staged_manifest_written",
  ): Promise<void>;
  randomId(): string;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
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
const sha256Pattern = /^[a-f0-9]{64}$/;
const argumentFlags = new Set(["--mode", "--release-id", "--source-commit"]);
const publicationArgumentFlags = new Set([...argumentFlags, "--receipt"]);
const sourceRepository = "https://github.com/ALTIS13/Apollo.TF";
const builderIdPattern = /^[a-z0-9][a-z0-9-]{0,47}$/;
const absentManifestPattern = /(?:manifest unknown|not found)/i;
const windowsShimExecutables = new Set(["corepack", "pnpm"]);
const digestAttempts = 5;
const digestBackoffMilliseconds = [250, 500, 1_000, 2_000] as const;
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
  "invalid_release_receipt",
  "invalid_source_commit",
  "publication_cancelled",
  "release_error",
  "release_claim_exists",
  "release_output_exists",
  "release_receipt_reused",
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
const corepackDistributionRoot = join(
  dirname(process.execPath),
  "node_modules",
  "corepack",
  "dist",
);
const corepackCliPath = join(corepackDistributionRoot, "corepack.js");
const pnpmCliPath = join(corepackDistributionRoot, "pnpm.js");
const sourceValidationCommands: readonly {
  args: readonly string[];
  executable: string;
  timeoutMs: number;
}[] = [
  {
    args: [corepackCliPath, "enable"],
    executable: process.execPath,
    timeoutMs: 60_000,
  },
  {
    args: [pnpmCliPath, "install", "--frozen-lockfile"],
    executable: process.execPath,
    timeoutMs: 10 * 60_000,
  },
  {
    args: [pnpmCliPath, "--filter", "@workspace/scripts", "test"],
    executable: process.execPath,
    timeoutMs: 20 * 60_000,
  },
  {
    args: [
      pnpmCliPath,
      "--filter",
      "@workspace/platform-api",
      "exec",
      "vitest",
      "run",
      "--maxWorkers=2",
    ],
    executable: process.execPath,
    timeoutMs: 20 * 60_000,
  },
  {
    args: [
      pnpmCliPath,
      "--filter",
      "@workspace/api-server",
      "exec",
      "vitest",
      "run",
      "--maxWorkers=1",
    ],
    executable: process.execPath,
    timeoutMs: 20 * 60_000,
  },
  {
    args: [
      pnpmCliPath,
      "--filter",
      "@workspace/admin-dashboard",
      "exec",
      "vitest",
      "run",
      "--maxWorkers=2",
    ],
    executable: process.execPath,
    timeoutMs: 20 * 60_000,
  },
  {
    args: [
      pnpmCliPath,
      "--filter",
      "@workspace/music-player",
      "exec",
      "vitest",
      "run",
      "--maxWorkers=2",
    ],
    executable: process.execPath,
    timeoutMs: 20 * 60_000,
  },
  {
    args: [
      pnpmCliPath,
      "--filter",
      "@workspace/tf-search",
      "exec",
      "vitest",
      "run",
      "--maxWorkers=2",
    ],
    executable: process.execPath,
    timeoutMs: 20 * 60_000,
  },
  {
    args: [
      pnpmCliPath,
      "--filter",
      "@workspace/tf-integrations",
      "exec",
      "vitest",
      "run",
      "--maxWorkers=2",
    ],
    executable: process.execPath,
    timeoutMs: 20 * 60_000,
  },
  {
    args: [
      pnpmCliPath,
      "--filter",
      "@workspace/tf-download-worker",
      "exec",
      "vitest",
      "run",
      "--maxWorkers=2",
    ],
    executable: process.execPath,
    timeoutMs: 20 * 60_000,
  },
  {
    args: [pnpmCliPath, "run", "typecheck"],
    executable: process.execPath,
    timeoutMs: 20 * 60_000,
  },
];

export function runOperatorReleaseCommand(
  executable: string,
  args: readonly string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<OperatorReleaseCommandResult> {
  let spawnedExecutable = executable;
  let spawnedArgs = [...args];
  if (process.platform === "win32" && windowsShimExecutables.has(executable)) {
    spawnedExecutable = process.execPath;
    spawnedArgs = [
      executable === "corepack" ? corepackCliPath : pnpmCliPath,
      ...args,
    ];
  }

  return new Promise((complete) => {
    let stderr = "";
    let stdout = "";
    let completed = false;
    const finish = (result: OperatorReleaseCommandResult): void => {
      if (completed) return;
      completed = true;
      complete(result);
    };
    const child = spawn(spawnedExecutable, spawnedArgs, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      signal: options.signal,
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
}

const defaultOperatorReleaseDependencies: OperatorReleaseDependencies = {
  atomicRename: rename,
  command: runOperatorReleaseCommand,
  randomId: randomUUID,
  sleep: async (milliseconds, signal) => {
    await sleepTimer(milliseconds, undefined, { signal });
  },
  temporaryRoot: () =>
    join(tmpdir(), `apollo-operator-release-${randomUUID()}`),
};

export async function prepareOperatorRelease(
  options: OperatorReleaseOptions,
  dependencies: OperatorReleaseDependencies = defaultOperatorReleaseDependencies,
): Promise<OperatorReleasePreparationOutput> {
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

  const environment = isolatedOperatorEnvironment();
  const claimDirectory = operatorReleaseClaimDirectory(
    options.repositoryRoot,
    options.releaseId,
  );
  const receiptPath = join(claimDirectory, "prepare-receipt.json");
  const releaseDirectory = operatorReleaseOutputDirectory(
    options.repositoryRoot,
    options.releaseId,
  );
  let output: OperatorReleasePreparationOutput | undefined;
  let primaryError: Error | undefined;
  let temporaryRoot: string | undefined;
  let temporaryRootOwned = false;

  try {
    const worktree = await checkedCommand(
      dependencies,
      "dirty_worktree",
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      {
        cwd: options.repositoryRoot,
        env: environment,
        timeoutMs: 60_000,
      },
    );
    if (worktree.stdout.trim() !== "") throw operatorError("dirty_worktree");
    await checkedCommand(
      dependencies,
      "invalid_source_commit",
      "git",
      ["cat-file", "-e", `${options.sourceCommit}^{commit}`],
      {
        cwd: options.repositoryRoot,
        env: environment,
        timeoutMs: 60_000,
      },
    );
    if (await pathExists(releaseDirectory)) {
      throw operatorError("release_output_exists");
    }

    await mkdir(dirname(claimDirectory), { mode: 0o700, recursive: true });
    try {
      await mkdir(claimDirectory, { mode: 0o700 });
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "EEXIST" ||
        (await pathExists(claimDirectory))
      ) {
        throw operatorError("release_claim_exists");
      }
      throw error;
    }
    await writeDurableExclusive(
      join(claimDirectory, "claim.json"),
      `${JSON.stringify(
        {
          formatVersion: 1,
          protocolVersion: 2,
          releaseId: options.releaseId,
          sourceCommit: options.sourceCommit,
        },
        null,
        2,
      )}\n`,
    );

    temporaryRoot = dependencies.temporaryRoot();
    const validationRoot = join(temporaryRoot, "validation-source");
    const temporaryArchivePath = join(temporaryRoot, "source.tar");
    await mkdir(temporaryRoot);
    temporaryRootOwned = true;
    await mkdir(validationRoot);

    await checkedCommand(
      dependencies,
      "source_validation_failed",
      "git",
      [
        "archive",
        "--format=tar",
        "--output",
        temporaryArchivePath,
        options.sourceCommit,
      ],
      {
        cwd: options.repositoryRoot,
        env: environment,
        timeoutMs: 5 * 60_000,
      },
    );
    const archiveSha256 = await sha256File(temporaryArchivePath);
    await checkedCommand(
      dependencies,
      "source_validation_failed",
      "tar",
      ["-xf", temporaryArchivePath, "-C", validationRoot],
      {
        cwd: options.repositoryRoot,
        env: environment,
        timeoutMs: 5 * 60_000,
      },
    );
    const sourceTreeSha256 = await sha256Directory(validationRoot);
    for (const validation of sourceValidationCommands) {
      await checkedCommand(
        dependencies,
        "source_validation_failed",
        validation.executable,
        validation.args,
        {
          cwd: validationRoot,
          env: environment,
          timeoutMs: validation.timeoutMs,
        },
      );
    }
    if ((await sha256File(temporaryArchivePath)) !== archiveSha256) {
      throw operatorError("source_validation_failed");
    }

    const claimedArchivePath = join(claimDirectory, "source.tar");
    await copyFile(
      temporaryArchivePath,
      claimedArchivePath,
      constants.COPYFILE_EXCL,
    );
    const archiveHandle = await open(claimedArchivePath, "r+");
    try {
      await archiveHandle.sync();
    } finally {
      await archiveHandle.close();
    }
    if ((await sha256File(claimedArchivePath)) !== archiveSha256) {
      throw operatorError("source_validation_failed");
    }
    await writeDurableExclusive(
      receiptPath,
      `${JSON.stringify(
        {
          archiveFile: "source.tar",
          archiveSha256,
          formatVersion: 1,
          imageCatalog: releaseImageCatalog,
          protocolVersion: 2,
          releaseId: options.releaseId,
          sourceCommit: options.sourceCommit,
          sourceTreeSha256,
        },
        null,
        2,
      )}\n`,
    );
    output = {
      archiveSha256,
      receiptPath,
      releaseId: options.releaseId,
      sourceCommit: options.sourceCommit,
      sourceTreeSha256,
    };
  } catch (error) {
    primaryError = sanitizedOperatorError(error);
  }

  let cleanupFailed = false;
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
  const values = parsePairwiseArguments(argv, argumentFlags);
  return parseReleaseIdentity(values);
}

function parsePairwiseArguments(
  argv: readonly string[],
  allowedFlags: ReadonlySet<string>,
): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      flag === undefined ||
      value === undefined ||
      !allowedFlags.has(flag) ||
      values.has(flag) ||
      value.startsWith("--")
    ) {
      throw new Error("invalid_arguments");
    }
    values.set(flag, value);
  }
  if (values.size !== allowedFlags.size) {
    throw new Error("invalid_arguments");
  }
  return values;
}

function parseReleaseIdentity(values: ReadonlyMap<string, string>): {
  mode: OperatorReleaseMode;
  releaseId: string;
  sourceCommit: string;
} {
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

export function parseOperatorReleasePublicationArguments(
  argv: readonly string[],
): {
  mode: OperatorReleaseMode;
  receiptPath: string;
  releaseId: string;
  sourceCommit: string;
} {
  const values = parsePairwiseArguments(argv, publicationArgumentFlags);
  const identity = parseReleaseIdentity(values);
  const receiptPath = values.get("--receipt");
  if (receiptPath === undefined || receiptPath.trim() === "") {
    throw operatorError("invalid_arguments");
  }
  return { ...identity, receiptPath };
}

export function operatorReleaseOutputDirectory(
  repositoryRoot: string,
  releaseId: string,
): string {
  assertReleaseId(releaseId);
  return resolve(repositoryRoot, ".ops-private", "releases", releaseId);
}

export function operatorReleaseClaimDirectory(
  repositoryRoot: string,
  releaseId: string,
): string {
  assertReleaseId(releaseId);
  return resolve(repositoryRoot, ".ops-private", "release-claims", releaseId);
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

function isolatedOperatorEnvironment(
  ambient: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    CI: "1",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  };
  for (const name of [
    "APPDATA",
    "HOME",
    "LANG",
    "LC_ALL",
    "LOCALAPPDATA",
    "PATH",
    "Path",
    "PATHEXT",
    "SYSTEMROOT",
    "SystemRoot",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
  ]) {
    const value = ambient[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw operatorError("publication_cancelled");
}

async function checkedCommand(
  dependencies: OperatorReleaseDependencies,
  code: string,
  executable: string,
  args: readonly string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<OperatorReleaseCommandResult> {
  throwIfCancelled(options.signal);
  let result: OperatorReleaseCommandResult;
  try {
    result = await dependencies.command(executable, args, options);
  } catch {
    throwIfCancelled(options.signal);
    throw operatorError(code);
  }
  throwIfCancelled(options.signal);
  if (result.status !== 0) throw operatorError(code);
  return result;
}

function parseDigest(stdout: string): string | undefined {
  const value = stdout.trim().replace(/^"|"$/g, "");
  return digestPattern.test(value) && value !== zeroDigest ? value : undefined;
}

async function readBuildMetadataDigest(path: string): Promise<string> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isRecord(value)) throw operatorError("image_build_failed");
    const digest = value["containerimage.digest"];
    if (
      typeof digest !== "string" ||
      !digestPattern.test(digest) ||
      digest === zeroDigest
    ) {
      throw operatorError("image_build_failed");
    }
    return digest;
  } catch {
    throw operatorError("image_build_failed");
  }
}

function pinnedRedisArtifactImage(): ReleaseArtifactImage {
  const entry = releaseImageCatalog.find(
    (candidate) => candidate.kind === "external",
  );
  if (entry === undefined) throw operatorError("artifact_validation_failed");
  if (
    entry.repository !== pinnedRedisRepository ||
    !pinnedRedisReference.startsWith(`${pinnedRedisRepository}:`) ||
    !digestPattern.test(pinnedRedisDigest) ||
    pinnedRedisDigest === zeroDigest
  ) {
    throw operatorError("artifact_validation_failed");
  }
  return {
    imageDigest: pinnedRedisDigest,
    imageReference: pinnedRedisImmutableReference,
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
        image.imageReference !== `${image.repository}@${image.imageDigest}` ||
        (image.name === "redis" &&
          (image.repository !== pinnedRedisRepository ||
            image.imageDigest !== pinnedRedisDigest ||
            image.imageReference !== pinnedRedisImmutableReference))
      );
    })
  ) {
    throw operatorError("artifact_validation_failed");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
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

async function writeDurableExclusive(
  path: string,
  contents: string,
): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function sha256(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

export function verifyOperatorReleaseEvidence(
  manifestPath: string,
): ReleaseArtifact {
  try {
    const resolvedManifestPath = resolve(manifestPath);
    if (basename(resolvedManifestPath) !== "apollo-release-manifest.json") {
      throw operatorError("invalid_release_manifest");
    }
    const releaseDirectory = dirname(resolvedManifestPath);
    const releaseId = basename(releaseDirectory);
    assertReleaseId(releaseId);

    const completionPath = join(
      releaseDirectory,
      "apollo-release-complete.json",
    );
    const completionValue = JSON.parse(
      readFileSync(completionPath, "utf8"),
    ) as unknown;
    if (
      !isRecord(completionValue) ||
      !hasExactKeys(completionValue, [
        "environmentSha256",
        "formatVersion",
        "manifestSha256",
        "releaseId",
        "sourceCommit",
      ]) ||
      completionValue.formatVersion !== 1 ||
      completionValue.releaseId !== releaseId ||
      completionValue.sourceCommit === zeroSourceCommit ||
      typeof completionValue.sourceCommit !== "string" ||
      !sourceCommitPattern.test(completionValue.sourceCommit) ||
      typeof completionValue.manifestSha256 !== "string" ||
      !sha256Pattern.test(completionValue.manifestSha256) ||
      typeof completionValue.environmentSha256 !== "string" ||
      !sha256Pattern.test(completionValue.environmentSha256)
    ) {
      throw operatorError("invalid_release_manifest");
    }

    const manifestContents = readFileSync(resolvedManifestPath, "utf8");
    const environmentContents = readFileSync(
      join(releaseDirectory, "release-images.env"),
      "utf8",
    );
    if (
      sha256(manifestContents) !== completionValue.manifestSha256 ||
      sha256(environmentContents) !== completionValue.environmentSha256
    ) {
      throw operatorError("invalid_release_manifest");
    }

    const artifactValue = JSON.parse(manifestContents) as unknown;
    if (
      !isRecord(artifactValue) ||
      !hasExactKeys(artifactValue, [
        "formatVersion",
        "images",
        "sourceCommit",
      ]) ||
      artifactValue.formatVersion !== 1 ||
      typeof artifactValue.sourceCommit !== "string" ||
      !Array.isArray(artifactValue.images) ||
      artifactValue.images.some(
        (image) =>
          !isRecord(image) ||
          !hasExactKeys(image, [
            "imageDigest",
            "imageReference",
            "name",
            "repository",
          ]) ||
          typeof image.imageDigest !== "string" ||
          typeof image.imageReference !== "string" ||
          typeof image.name !== "string" ||
          typeof image.repository !== "string",
      )
    ) {
      throw operatorError("invalid_release_manifest");
    }
    const artifact = artifactValue as ReleaseArtifact;
    validateReleaseArtifact(artifact);
    if (
      artifact.sourceCommit !== completionValue.sourceCommit ||
      environmentContents !== renderReleaseEnvironment(artifact)
    ) {
      throw operatorError("invalid_release_manifest");
    }
    return artifact;
  } catch {
    throw operatorError("invalid_release_manifest");
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function sha256Directory(root: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update("apollo-source-tree-v1\0");

  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort(({ name: left }, { name: right }) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    for (const entry of entries) {
      const relativeName =
        prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        hash.update(`directory\0${relativeName}\0`);
        await visit(path, relativeName);
      } else if (entry.isFile()) {
        hash.update(`file\0${relativeName}\0`);
        for await (const chunk of createReadStream(path)) hash.update(chunk);
        hash.update("\0");
      } else if (entry.isSymbolicLink()) {
        hash.update(`symlink\0${relativeName}\0${await readlink(path)}\0`);
      } else {
        throw operatorError("source_validation_failed");
      }
    }
  };

  await visit(root, "");
  return hash.digest("hex");
}

async function writeReleaseOutput(
  stagingDirectory: string,
  releaseDirectory: string,
  releaseId: string,
  releaseArtifact: ReleaseArtifact,
  dependencies: OperatorReleaseDependencies,
): Promise<OperatorReleaseOutput> {
  const stagedManifestPath = join(
    stagingDirectory,
    "apollo-release-manifest.json",
  );
  const stagedEnvFragmentPath = join(stagingDirectory, "release-images.env");
  const stagedCompletionPath = join(
    stagingDirectory,
    "apollo-release-complete.json",
  );
  const manifestContents = `${JSON.stringify(releaseArtifact, null, 2)}\n`;
  const renderedEnvironment = renderReleaseEnvironment(releaseArtifact);
  const completionContents = `${JSON.stringify(
    {
      environmentSha256: sha256(renderedEnvironment),
      formatVersion: 1,
      manifestSha256: sha256(manifestContents),
      releaseId,
      sourceCommit: releaseArtifact.sourceCommit,
    },
    null,
    2,
  )}\n`;
  try {
    await writeDurableExclusive(stagedManifestPath, manifestContents);
    await dependencies.publicationCheckpoint?.("staged_manifest_written");
    await writeDurableExclusive(stagedEnvFragmentPath, renderedEnvironment);
    await dependencies.publicationCheckpoint?.("staged_environment_written");
    await writeDurableExclusive(stagedCompletionPath, completionContents);
    await dependencies.publicationCheckpoint?.("staged_completion_written");
    validateReleaseArtifact(
      JSON.parse(await readFile(stagedManifestPath, "utf8")) as ReleaseArtifact,
    );
    const completion = JSON.parse(
      await readFile(stagedCompletionPath, "utf8"),
    ) as unknown;
    if (
      (await readFile(stagedManifestPath, "utf8")) !== manifestContents ||
      (await readFile(stagedEnvFragmentPath, "utf8")) !== renderedEnvironment ||
      !isRecord(completion) ||
      !hasExactKeys(completion, [
        "environmentSha256",
        "formatVersion",
        "manifestSha256",
        "releaseId",
        "sourceCommit",
      ]) ||
      completion.environmentSha256 !== sha256(renderedEnvironment) ||
      completion.formatVersion !== 1 ||
      completion.manifestSha256 !== sha256(manifestContents) ||
      completion.releaseId !== releaseId ||
      completion.sourceCommit !== releaseArtifact.sourceCommit
    ) {
      throw operatorError("artifact_validation_failed");
    }
    if (await pathExists(releaseDirectory)) {
      throw operatorError("release_output_exists");
    }
    await dependencies.atomicRename(stagingDirectory, releaseDirectory);
  } catch (error) {
    if (error instanceof Error && error.message === "release_output_exists") {
      throw error;
    }
    throw operatorError("artifact_validation_failed");
  }

  return {
    envFragmentPath: join(releaseDirectory, "release-images.env"),
    manifestPath: join(releaseDirectory, "apollo-release-manifest.json"),
    releaseArtifact,
  };
}

type OperatorReleaseReceipt = {
  archiveFile: "source.tar";
  archiveSha256: string;
  formatVersion: 1;
  imageCatalog: unknown;
  protocolVersion: 2;
  releaseId: string;
  sourceCommit: string;
  sourceTreeSha256: string;
};

async function loadOperatorReleaseReceipt(
  options: OperatorReleasePublicationOptions,
  claimDirectory: string,
): Promise<OperatorReleaseReceipt> {
  try {
    const expectedReceiptPath = join(claimDirectory, "prepare-receipt.json");
    if (resolve(options.receiptPath) !== expectedReceiptPath) {
      throw operatorError("invalid_release_receipt");
    }
    const receiptStat = await lstat(expectedReceiptPath);
    if (!receiptStat.isFile() || receiptStat.isSymbolicLink()) {
      throw operatorError("invalid_release_receipt");
    }
    const value = JSON.parse(
      await readFile(expectedReceiptPath, "utf8"),
    ) as unknown;
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        "archiveFile",
        "archiveSha256",
        "formatVersion",
        "imageCatalog",
        "protocolVersion",
        "releaseId",
        "sourceCommit",
        "sourceTreeSha256",
      ]) ||
      value.archiveFile !== "source.tar" ||
      typeof value.archiveSha256 !== "string" ||
      !sha256Pattern.test(value.archiveSha256) ||
      value.formatVersion !== 1 ||
      JSON.stringify(value.imageCatalog) !==
        JSON.stringify(releaseImageCatalog) ||
      value.protocolVersion !== 2 ||
      value.releaseId !== options.releaseId ||
      value.sourceCommit !== options.sourceCommit ||
      typeof value.sourceTreeSha256 !== "string" ||
      !sha256Pattern.test(value.sourceTreeSha256)
    ) {
      throw operatorError("invalid_release_receipt");
    }
    return value as OperatorReleaseReceipt;
  } catch {
    throw operatorError("invalid_release_receipt");
  }
}

export async function publishOperatorRelease(
  options: OperatorReleasePublicationOptions,
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
  const claimDirectory = operatorReleaseClaimDirectory(
    options.repositoryRoot,
    options.releaseId,
  );
  const environment = isolatedOperatorEnvironment();
  let archivePath: string | undefined;
  let buildRoot: string | undefined;
  let builderName: string | undefined;
  let builderRemovalRequired = false;
  let output: OperatorReleaseOutput | undefined;
  let primaryError: Error | undefined;
  let releaseStagingDirectory: string | undefined;
  let releaseStagingOwned = false;
  let temporaryRoot: string | undefined;
  let temporaryRootOwned = false;

  try {
    throwIfCancelled(options.signal);
    const receipt = await loadOperatorReleaseReceipt(options, claimDirectory);
    archivePath = join(claimDirectory, receipt.archiveFile);
    try {
      const archiveStat = await lstat(archivePath);
      if (
        !archiveStat.isFile() ||
        archiveStat.isSymbolicLink() ||
        (await sha256File(archivePath)) !== receipt.archiveSha256
      ) {
        throw operatorError("invalid_release_receipt");
      }
    } catch {
      throw operatorError("invalid_release_receipt");
    }

    try {
      throwIfCancelled(options.signal);
      await writeDurableExclusive(
        join(claimDirectory, "publication-started.json"),
        `${JSON.stringify(
          {
            formatVersion: 1,
            protocolVersion: 2,
            releaseId: options.releaseId,
            sourceCommit: options.sourceCommit,
          },
          null,
          2,
        )}\n`,
      );
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "EEXIST" ||
        (await pathExists(join(claimDirectory, "publication-started.json")))
      ) {
        throw operatorError("release_receipt_reused");
      }
      throw operatorError("invalid_release_receipt");
    }
    if (await pathExists(releaseDirectory)) {
      throw operatorError("release_output_exists");
    }

    temporaryRoot = dependencies.temporaryRoot();
    buildRoot = join(temporaryRoot, "build-source");
    try {
      await mkdir(temporaryRoot);
      temporaryRootOwned = true;
      await mkdir(buildRoot);
    } catch {
      throw operatorError("source_validation_failed");
    }
    await checkedCommand(
      dependencies,
      "source_validation_failed",
      "tar",
      ["-xf", archivePath, "-C", buildRoot],
      {
        cwd: options.repositoryRoot,
        env: environment,
        signal: options.signal,
        timeoutMs: 5 * 60_000,
      },
    );
    if (
      (await sha256File(archivePath)) !== receipt.archiveSha256 ||
      (await sha256Directory(buildRoot)) !== receipt.sourceTreeSha256
    ) {
      throw operatorError("invalid_release_receipt");
    }

    for (const target of operatorReleaseImageTargets) {
      throwIfCancelled(options.signal);
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
          {
            cwd: buildRoot,
            env: environment,
            signal: options.signal,
            timeoutMs: 60_000,
          },
        );
      } catch {
        throwIfCancelled(options.signal);
        throw operatorError("release_tag_check_failed");
      }
      throwIfCancelled(options.signal);
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
    try {
      await writeDurableExclusive(
        join(claimDirectory, "builder-claim.json"),
        `${JSON.stringify(
          {
            builderName,
            formatVersion: 1,
            protocolVersion: 2,
            releaseId: options.releaseId,
            sourceCommit: options.sourceCommit,
          },
          null,
          2,
        )}\n`,
      );
    } catch {
      throw operatorError("builder_create_failed");
    }
    builderRemovalRequired = true;
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
      {
        cwd: buildRoot,
        env: environment,
        signal: options.signal,
        timeoutMs: 5 * 60_000,
      },
    );

    const metadataRoot = join(temporaryRoot, "build-metadata");
    try {
      await mkdir(metadataRoot);
    } catch {
      throw operatorError("image_build_failed");
    }
    const buildDigests = new Map<string, string>();
    for (const target of operatorReleaseImageTargets) {
      const metadataPath = join(metadataRoot, `${target.name}.json`);
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
          join(buildRoot, target.dockerfile),
          "--target",
          target.target,
          "--tag",
          `${target.repository}:${options.releaseId}`,
          "--metadata-file",
          metadataPath,
          "--push",
          buildRoot,
        ],
        {
          cwd: buildRoot,
          env: environment,
          signal: options.signal,
          timeoutMs: 60 * 60_000,
        },
      );
      buildDigests.set(
        target.name,
        await readBuildMetadataDigest(metadataPath),
      );
    }

    const images: ReleaseArtifactImage[] = [];
    for (const target of operatorReleaseImageTargets) {
      const reference = `${target.repository}:${options.releaseId}`;
      const buildDigest = buildDigests.get(target.name);
      if (buildDigest === undefined) throw operatorError("image_build_failed");
      let resolved = false;
      for (let attempt = 0; attempt < digestAttempts; attempt += 1) {
        throwIfCancelled(options.signal);
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
            {
              cwd: buildRoot,
              env: environment,
              signal: options.signal,
              timeoutMs: 60_000,
            },
          );
        } catch {
          throwIfCancelled(options.signal);
          inspection = { status: -1, stderr: "", stdout: "" };
        }
        const inspectedDigest =
          inspection.status === 0 ? parseDigest(inspection.stdout) : undefined;
        if (inspectedDigest !== undefined) {
          if (inspectedDigest !== buildDigest) {
            throw operatorError("digest_resolution_failed");
          }
          resolved = true;
          break;
        }
        if (attempt < digestAttempts - 1) {
          try {
            await dependencies.sleep(
              digestBackoffMilliseconds[attempt]!,
              options.signal,
            );
          } catch {
            throwIfCancelled(options.signal);
            throw operatorError("digest_resolution_failed");
          }
        }
      }
      if (!resolved) {
        throw operatorError("digest_resolution_failed");
      }
      images.push({
        imageDigest: buildDigest,
        imageReference: `${target.repository}@${buildDigest}`,
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
      options.releaseId,
      releaseArtifact,
      dependencies,
    );
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
      const inspection = await dependencies.command(
        "docker",
        ["buildx", "inspect", builderName!],
        {
          cwd: buildRoot!,
          env: environment,
          timeoutMs: 5 * 60_000,
        },
      );
      if (inspection.status === 0) {
        const removal = await dependencies.command(
          "docker",
          ["buildx", "rm", builderName!],
          {
            cwd: buildRoot!,
            env: environment,
            timeoutMs: 5 * 60_000,
          },
        );
        if (removal.status !== 0) cleanupFailed = true;
      }
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
  repositoryRoot: fileURLToPath(new URL("../..", import.meta.url)),
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
  operation: "prepare" | "publish",
  argv: readonly string[],
  dependencies: OperatorReleaseDependencies = defaultOperatorReleaseDependencies,
  io: OperatorReleaseCliIo = defaultOperatorReleaseCliIo,
  signal?: AbortSignal,
): Promise<number> {
  try {
    const output =
      operation === "prepare"
        ? await prepareOperatorRelease(
            {
              ...parseOperatorReleaseArguments(argv),
              repositoryRoot: io.repositoryRoot,
            },
            dependencies,
          )
        : await publishOperatorRelease(
            {
              ...parseOperatorReleasePublicationArguments(argv),
              repositoryRoot: io.repositoryRoot,
              signal,
            },
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
  const operation = process.argv[2];
  if (operation !== "prepare" && operation !== "publish") {
    process.stderr.write(`${JSON.stringify({ error: "invalid_arguments" })}\n`);
    process.exitCode = 1;
  } else {
    const cancellation = new AbortController();
    const cancel = (): void => cancellation.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    void runOperatorReleaseCli(
      operation,
      process.argv.slice(3),
      defaultOperatorReleaseDependencies,
      defaultOperatorReleaseCliIo,
      cancellation.signal,
    )
      .then((status) => {
        process.exitCode = status;
      })
      .finally(() => {
        process.removeListener("SIGINT", cancel);
        process.removeListener("SIGTERM", cancel);
      });
  }
}
