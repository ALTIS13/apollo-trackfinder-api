import { resolve } from "node:path";

import { type ReleaseArtifact } from "./release-images.js";

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

const releaseIdPattern =
  /^v[0-9]+[.][0-9]+[.][0-9]+(?:-[a-z0-9][a-z0-9.-]{0,63})?$/;
const sourceCommitPattern = /^[a-f0-9]{40}$/;
const zeroSourceCommit = "0".repeat(40);
const argumentFlags = new Set(["--mode", "--release-id", "--source-commit"]);

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
