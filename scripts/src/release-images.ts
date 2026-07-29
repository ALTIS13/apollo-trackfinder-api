export type OperatorReleaseImageTarget = {
  dockerfile: string;
  environmentNames: readonly string[];
  name: string;
  repository: string;
  target: string;
};

export type ReleaseImageCatalogEntry =
  | (OperatorReleaseImageTarget & { kind: "custom" })
  | {
      environmentNames: readonly ["PLATFORM_REDIS_IMAGE", "TF_REDIS_IMAGE"];
      kind: "external";
      name: "redis";
      reference: string;
      repository: "docker.io/library/redis";
    };

export const releaseImageCatalog = [
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
] as const satisfies readonly ReleaseImageCatalogEntry[];

export type ArtifactImageName = (typeof releaseImageCatalog)[number]["name"];

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

type CatalogImageNames<Catalog extends readonly { readonly name: string }[]> = {
  readonly [Index in keyof Catalog]: Catalog[Index] extends {
    readonly name: infer Name;
  }
    ? Name
    : never;
};

export const artifactImageNames = releaseImageCatalog.map(
  ({ name }) => name,
) as unknown as CatalogImageNames<typeof releaseImageCatalog>;

export const approvedImageRepositories: Readonly<
  Record<ArtifactImageName, string>
> = Object.fromEntries(
  releaseImageCatalog.map(({ name, repository }) => [name, repository]),
) as Record<ArtifactImageName, string>;

export const releaseImageEnvironmentNames: Readonly<
  Record<string, ArtifactImageName>
> = Object.fromEntries(
  releaseImageCatalog.flatMap(({ environmentNames, name }) =>
    environmentNames.map((environmentName) => [environmentName, name]),
  ),
) as Record<string, ArtifactImageName>;

export const operatorReleaseImageTargets: readonly OperatorReleaseImageTarget[] =
  releaseImageCatalog.flatMap((entry) => {
    if (entry.kind === "external") return [];
    const { kind: _kind, ...target } = entry;
    return [target];
  });

export const pinnedRedisReference = releaseImageCatalog.find(
  (
    entry,
  ): entry is Extract<
    (typeof releaseImageCatalog)[number],
    { kind: "external" }
  > => entry.kind === "external",
)!.reference;
