import { spawn } from "node:child_process";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  operatorReleaseImageTargets,
  pinnedRedisReference,
} from "./release-images.js";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const platformCompose = join(
  repositoryRoot,
  "deploy/coolify/apollo-platform.compose.yml",
);
const tfCompose = join(repositoryRoot, "deploy/coolify/apollo-tf.compose.yml");
const releaseExample = join(
  repositoryRoot,
  "deploy/coolify/release.env.example",
);
const caddyInclude = join(repositoryRoot, "deploy/caddy/apollo.caddyfile");
const registryImage =
  "docker.io/library/registry:2.8.3@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373";
const caddyImage =
  "docker.io/library/caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d";
const socatImage =
  "docker.io/alpine/socat:1.8.0.3@sha256:beb4a68d9e4fe6b0f21ea774a0fde6c31f580dde6368939ed70100c5385b015e";
const redisImage = pinnedRedisReference;
const nativeDockerImage =
  "docker.io/library/docker:29.1.3-dind@sha256:64d6ee47ea821c986467199baa162f5ac8cde3f57b719f18e23f3ed7a7444131";
const temporaryRootPrefix = "apollo-coolify-production-";
const temporaryRootMarkerName = ".apollo-task5-owner";
const temporaryRootRecordSuffix = ".apollo-task5-owner-record";
const temporaryRootRecordStagingName = ".apollo-task5-owner-record-active";
const temporaryRootOwner = "apollo-task5-coolify-production-smoke";
const temporaryRootNamePattern = /^apollo-coolify-production-[0-9a-f]{32}$/;

const productionTargets = operatorReleaseImageTargets.map(
  ({ dockerfile, name, target }) => ({
    dockerfile,
    image: name,
    target,
  }),
);

const fixedNetworks = [
  "apollo-platform-bridge-v1",
  "apollo-platform-edge-v1",
  "apollo-platform-data-v1",
  "apollo-tf-data-v1",
  "apollo-tf-edge-v1",
  "apollo-tf-integrations-control-v1",
  "apollo-tf-integrations-data-v1",
  "apollo-tf-integrations-egress-v1",
  "apollo-tf-search-control-v1",
  "apollo-tf-search-egress-v1",
  "apollo-tf-download-queue-v1",
  "apollo-tf-download-control-v1",
  "apollo-tf-download-egress-v1",
] as const;
const fixedVolumes = [
  "apollo-platform-postgres-v1",
  "apollo-platform-redis-v1",
  "apollo-tf-postgres-v1",
  "apollo-tf-redis-v1",
  "apollo-tf-integrations-postgres-v1",
  "apollo-tf-download-redis-v1",
  "apollo-tf-downloads-v1",
] as const;
const platformLongRunning = [
  "platform-postgres",
  "platform-redis",
  "platform-api",
] as const;
const tfLongRunning = [
  "tf-postgres",
  "tf-redis",
  "tf-integrations-postgres",
  "tf-integrations",
  "tf-search",
  "tf-download-redis",
  "tf-download-worker",
  "tf-api",
  "tf-web",
  "tf-admin",
] as const;

type CommandResult = {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
};

type CommandOptions = {
  readonly allowNonZero?: boolean;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string;
  readonly timeoutMs?: number;
};

type CommandRunner = (
  executable: string,
  args: readonly string[],
  options?: CommandOptions,
) => Promise<CommandResult>;

type DockerCommand = (
  args: readonly string[],
  options?: Omit<CommandOptions, "env">,
) => Promise<CommandResult>;

async function command(
  executable: string,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd ?? repositoryRoot,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error, exitCode = 0) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) rejectCommand(error);
      else {
        resolveCommand({
          exitCode,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      }
    };
    const collect = (target: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024 * 1024) {
        child.kill();
        finish(new Error("local command output exceeded its bound"));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", () => finish(new Error("local command failed")));
    child.once("close", (code) => {
      const exitCode = code ?? -1;
      if (exitCode === 0 || options.allowNonZero === true) {
        finish(undefined, exitCode);
      } else {
        finish(new Error(`local command exited ${String(code)}`), exitCode);
      }
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
    const timer = setTimeout(
      () => {
        child.kill();
        finish(new Error("local command timed out"));
      },
      options.timeoutMs ?? 5 * 60_000,
    );
    timer.unref?.();
  });
}

function createDocker(
  environment: NodeJS.ProcessEnv,
  runner: CommandRunner = command,
): DockerCommand {
  return (args, options = {}) =>
    runner("docker", args, { ...options, env: environment });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function pathExistsForAudit(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

type PendingOwnedTemporaryRoot = {
  readonly recordPath: string;
  readonly root: string;
  readonly rootName: string;
  readonly state: "pending";
};

type ActiveOwnedTemporaryRoot = {
  readonly birthtimeMs: number;
  readonly dev: number;
  readonly ino: number;
  readonly recordPath: string;
  readonly root: string;
  readonly rootName: string;
  readonly state: "active";
};

type OwnedTemporaryRoot = ActiveOwnedTemporaryRoot | PendingOwnedTemporaryRoot;

function serializePendingTemporaryRootOwnership(rootName: string): string {
  return `${JSON.stringify({
    owner: temporaryRootOwner,
    rootName,
    state: "pending",
    version: 2,
  })}\n`;
}

function serializeActiveTemporaryRootOwnership(
  ownership: Omit<ActiveOwnedTemporaryRoot, "recordPath" | "root" | "state">,
): string {
  return `${JSON.stringify({
    birthtimeMs: ownership.birthtimeMs,
    dev: ownership.dev,
    ino: ownership.ino,
    owner: temporaryRootOwner,
    rootName: ownership.rootName,
    state: "active",
    version: 2,
  })}\n`;
}

function parseTemporaryRootOwnership(
  raw: string,
  expectedRootName: string,
):
  | Omit<ActiveOwnedTemporaryRoot, "recordPath" | "root">
  | Omit<PendingOwnedTemporaryRoot, "recordPath" | "root"> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("temporary root ownership record is invalid");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("owner" in value) ||
    value.owner !== temporaryRootOwner ||
    !("rootName" in value) ||
    value.rootName !== expectedRootName
  ) {
    throw new Error("temporary root ownership record is invalid");
  }

  if (
    "version" in value &&
    value.version === 2 &&
    "state" in value &&
    value.state === "pending" &&
    temporaryRootNamePattern.test(expectedRootName)
  ) {
    return {
      rootName: expectedRootName,
      state: "pending",
    };
  }

  const isVersionTwoActive =
    "version" in value &&
    value.version === 2 &&
    "state" in value &&
    value.state === "active" &&
    temporaryRootNamePattern.test(expectedRootName);
  const isLegacyActive =
    "version" in value && value.version === 1 && !("state" in value);
  if (
    (!isVersionTwoActive && !isLegacyActive) ||
    !("birthtimeMs" in value) ||
    typeof value.birthtimeMs !== "number" ||
    !Number.isFinite(value.birthtimeMs) ||
    !("dev" in value) ||
    typeof value.dev !== "number" ||
    !Number.isFinite(value.dev) ||
    !("ino" in value) ||
    typeof value.ino !== "number" ||
    !Number.isFinite(value.ino)
  ) {
    throw new Error("temporary root ownership record is invalid");
  }

  return {
    birthtimeMs: value.birthtimeMs,
    dev: value.dev,
    ino: value.ino,
    rootName: expectedRootName,
    state: "active",
  };
}

async function ownedTemporaryRootInventory(
  parent: string,
): Promise<readonly OwnedTemporaryRoot[]> {
  let entries;
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const roots: OwnedTemporaryRoot[] = [];
  for (const entry of entries) {
    if (
      !entry.name.startsWith(temporaryRootPrefix) ||
      !entry.name.endsWith(temporaryRootRecordSuffix)
    ) {
      continue;
    }
    if (!entry.isFile()) {
      throw new Error("temporary root ownership record is not a file");
    }
    const rootName = entry.name.slice(0, -temporaryRootRecordSuffix.length);
    if (
      !rootName.startsWith(temporaryRootPrefix) ||
      basename(rootName) !== rootName
    ) {
      throw new Error("temporary root ownership record has an unsafe name");
    }
    const recordPath = join(parent, entry.name);
    const parsed = parseTemporaryRootOwnership(
      await readFile(recordPath, "utf8"),
      rootName,
    );
    roots.push({
      ...parsed,
      recordPath,
      root: join(parent, rootName),
    });
  }
  return roots.sort((left, right) => left.root.localeCompare(right.root));
}

async function removeOwnedTemporaryRoots(parent: string): Promise<void> {
  for (const ownership of await ownedTemporaryRootInventory(parent)) {
    let rootState;
    try {
      rootState = await lstat(ownership.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (rootState !== undefined) {
      if (!rootState.isDirectory()) {
        throw new Error("temporary root identity no longer matches ownership");
      }
      if (
        ownership.state === "active" &&
        (rootState.dev !== ownership.dev ||
          rootState.ino !== ownership.ino ||
          rootState.birthtimeMs !== ownership.birthtimeMs)
      ) {
        throw new Error("temporary root identity no longer matches ownership");
      }
      await rm(ownership.root, { recursive: true });
      try {
        await lstat(ownership.root);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          await rm(ownership.recordPath);
          continue;
        }
        throw error;
      }
      throw new Error("temporary root survived verified deletion");
    }
    await rm(ownership.recordPath);
  }
}

async function writeDurableExclusive(path: string, contents: string) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(contents, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function prepareOwnedTemporaryRoot(
  parent: string,
  options: {
    readonly afterRootCreationBeforeActiveRecord?: (ownership: {
      readonly recordPath: string;
      readonly root: string;
      readonly rootName: string;
    }) => Promise<void>;
    readonly removeOwnedRoots?: (parent: string) => Promise<void>;
  } = {},
): Promise<string> {
  await removeOwnedTemporaryRoots(parent);
  const rootName = `${temporaryRootPrefix}${randomBytes(16).toString("hex")}`;
  const root = join(parent, rootName);
  const recordPath = `${root}${temporaryRootRecordSuffix}`;
  const pendingOwnership = serializePendingTemporaryRootOwnership(rootName);
  try {
    await writeDurableExclusive(recordPath, pendingOwnership);
    await mkdir(root, { mode: 0o700 });
    await options.afterRootCreationBeforeActiveRecord?.({
      recordPath,
      root,
      rootName,
    });
    const rootState = await lstat(root);
    if (!rootState.isDirectory()) {
      throw new Error("temporary root creation did not produce a directory");
    }
    const activeOwnership = serializeActiveTemporaryRootOwnership({
      birthtimeMs: rootState.birthtimeMs,
      dev: rootState.dev,
      ino: rootState.ino,
      rootName,
    });
    const activeRecordStagingPath = join(root, temporaryRootRecordStagingName);
    await writeDurableExclusive(activeRecordStagingPath, activeOwnership);
    await rename(activeRecordStagingPath, recordPath);
    await writeDurableExclusive(
      join(root, temporaryRootMarkerName),
      activeOwnership,
    );
    return root;
  } catch (error) {
    try {
      await (options.removeOwnedRoots ?? removeOwnedTemporaryRoots)(parent);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "temporary root preparation failed",
      );
    }
    throw error;
  }
}

function secret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function findSecretDisclosure(
  logs: string,
  groups: readonly {
    readonly id: string;
    readonly values: readonly string[];
  }[],
): string | undefined {
  for (const group of groups) {
    for (const [index, value] of group.values.entries()) {
      if (value.length > 0 && logs.includes(value)) {
        return `${group.id}-${index + 1}`;
      }
    }
  }
  return undefined;
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        rejectPort(new Error("loopback port allocation failed"));
        return;
      }
      server.close((error) =>
        error === undefined ? resolvePort(address.port) : rejectPort(error),
      );
    });
  });
}

async function waitFor(
  label: string,
  probe: () => Promise<boolean>,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await probe()) return;
    } catch {
      // Retry only within the explicit deadline.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`${label} deadline exceeded`);
}

function isLocalDockerEndpoint(value: string): boolean {
  const endpoint = value.trim().toLowerCase();
  return endpoint.startsWith("npipe://") || endpoint.startsWith("unix://");
}

async function assertLocalDocker(
  inherited: NodeJS.ProcessEnv = process.env,
  runner: CommandRunner = command,
): Promise<NodeJS.ProcessEnv> {
  const environment = { ...inherited };
  for (const name of [
    "BUILDKIT_HOST",
    "BUILDX_BUILDER",
    "BUILDX_CONFIG",
    "DOCKER_CONFIG",
  ]) {
    if (environment[name]?.trim()) {
      throw new Error("unsafe inherited Docker build selector");
    }
  }
  const inheritedHost = environment.DOCKER_HOST?.trim();
  if (inheritedHost && !isLocalDockerEndpoint(inheritedHost)) {
    throw new Error("production smoke requires local Docker");
  }
  delete environment.DOCKER_HOST;
  delete environment.DOCKER_CERT_PATH;
  delete environment.DOCKER_TLS_VERIFY;
  delete environment.COMPOSE_PROJECT_NAME;
  environment.COMPOSE_BAKE = "false";
  const docker = createDocker(environment, runner);
  const context = (await docker(["context", "show"])).stdout.trim();
  environment.DOCKER_CONTEXT = context;
  const endpoint = JSON.parse(
    (
      await docker([
        "context",
        "inspect",
        context,
        "--format",
        "{{json .Endpoints.docker.Host}}",
      ])
    ).stdout.trim(),
  ) as string;
  if (!isLocalDockerEndpoint(endpoint)) {
    throw new Error("production smoke requires local Docker");
  }
  return environment;
}

type OwnedLocalBuilder = {
  readonly container: string;
  readonly context: string;
  readonly name: string;
  readonly volume: string;
};

function expectedOwnedLocalBuilder(
  context: string,
  name: string,
): OwnedLocalBuilder {
  if (
    !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(context) ||
    !/^apollo-coolify-[a-z0-9-]{1,48}$/.test(name)
  ) {
    throw new Error("invalid task-owned builder identity");
  }
  const container = `buildx_buildkit_${name}0`;
  return {
    container,
    context,
    name,
    volume: `${container}_state`,
  };
}

function assertOwnedBuilderInspection(
  stdout: string,
  ownership: OwnedLocalBuilder,
): void {
  const names = [...stdout.matchAll(/^Name:\s*(?<value>\S+)\s*$/gm)].map(
    (match) => match.groups?.value,
  );
  const driver = stdout.match(/^Driver:\s*(?<value>\S+)\s*$/m)?.groups?.value;
  const driverOptions = stdout.match(/^Driver Options:\s*(?<value>.+)\s*$/m)
    ?.groups?.value;
  const endpoints = [
    ...stdout.matchAll(/^Endpoint:\s*(?<value>\S+)\s*$/gm),
  ].map((match) => match.groups?.value);
  const statuses = [...stdout.matchAll(/^Status:\s*(?<value>\S+)\s*$/gm)].map(
    (match) => match.groups?.value,
  );
  if (
    names[0] !== ownership.name ||
    names[1] !== `${ownership.name}0` ||
    names.length !== 2 ||
    driver !== "docker-container" ||
    driverOptions !== 'network="host"' ||
    endpoints.length !== 1 ||
    endpoints[0] !== ownership.context ||
    statuses.length !== 1 ||
    statuses[0] !== "running"
  ) {
    throw new Error("task-owned builder inventory mismatch");
  }
}

async function inspectOwnedLocalBuilder(
  docker: DockerCommand,
  ownership: OwnedLocalBuilder,
): Promise<boolean> {
  const result = await docker(["buildx", "inspect", ownership.name], {
    allowNonZero: true,
  });
  if (result.exitCode === 1) return false;
  if (result.exitCode !== 0) {
    throw new Error("task-owned builder inventory failed");
  }
  assertOwnedBuilderInspection(result.stdout, ownership);
  return true;
}

async function createOwnedLocalBuilder(
  docker: DockerCommand,
  context: string,
  name: string,
): Promise<OwnedLocalBuilder> {
  const ownership = expectedOwnedLocalBuilder(context, name);
  if (await inspectOwnedLocalBuilder(docker, ownership)) {
    throw new Error("task-owned builder already exists");
  }
  await docker(
    [
      "buildx",
      "create",
      "--name",
      ownership.name,
      "--driver",
      "docker-container",
      "--driver-opt",
      "network=host",
      "--bootstrap",
      ownership.context,
    ],
    { timeoutMs: 2 * 60_000 },
  );
  if (!(await inspectOwnedLocalBuilder(docker, ownership))) {
    throw new Error("task-owned builder was not created");
  }
  const mounts = JSON.parse(
    (
      await docker([
        "container",
        "inspect",
        ownership.container,
        "--format",
        "{{json .Mounts}}",
      ])
    ).stdout.trim(),
  ) as {
    readonly Destination?: string;
    readonly Name?: string;
    readonly Type?: string;
  }[];
  if (
    mounts.length !== 1 ||
    mounts[0]?.Destination !== "/var/lib/buildkit" ||
    mounts[0]?.Name !== ownership.volume ||
    mounts[0]?.Type !== "volume"
  ) {
    throw new Error("task-owned builder cache inventory mismatch");
  }
  const networkMode = JSON.parse(
    (
      await docker([
        "container",
        "inspect",
        ownership.container,
        "--format",
        "{{json .HostConfig.NetworkMode}}",
      ])
    ).stdout.trim(),
  ) as string;
  if (networkMode !== "host") {
    throw new Error("task-owned builder network inventory mismatch");
  }
  const volume = JSON.parse(
    (
      await docker([
        "volume",
        "inspect",
        ownership.volume,
        "--format",
        "{{json .Name}}",
      ])
    ).stdout.trim(),
  ) as string;
  if (volume !== ownership.volume) {
    throw new Error("task-owned builder volume inventory mismatch");
  }
  return ownership;
}

function buildWithOwnedBuilder(
  docker: DockerCommand,
  ownership: OwnedLocalBuilder,
  args: readonly string[],
  options: Omit<CommandOptions, "env"> = {},
): Promise<CommandResult> {
  return docker(
    ["buildx", "build", "--builder", ownership.name, ...args],
    options,
  );
}

function inspectImageWithOwnedBuilder(
  docker: DockerCommand,
  ownership: OwnedLocalBuilder,
  reference: string,
): Promise<CommandResult> {
  return docker([
    "buildx",
    "imagetools",
    "inspect",
    "--builder",
    ownership.name,
    reference,
    "--format",
    "{{json .Manifest.Digest}}",
  ]);
}

async function removeOwnedLocalBuilder(
  docker: DockerCommand,
  ownership: OwnedLocalBuilder,
): Promise<void> {
  if (await inspectOwnedLocalBuilder(docker, ownership)) {
    await docker(["buildx", "rm", "--force", ownership.name], {
      timeoutMs: 2 * 60_000,
    });
  }
}

async function auditOwnedLocalBuilder(
  docker: DockerCommand,
  ownership: OwnedLocalBuilder,
): Promise<{
  readonly builders: number;
  readonly containers: number;
  readonly volumes: number;
}> {
  const builder = await inspectOwnedLocalBuilder(docker, ownership);
  const container = await docker(
    ["container", "inspect", ownership.container],
    { allowNonZero: true },
  );
  const volume = await docker(["volume", "inspect", ownership.volume], {
    allowNonZero: true,
  });
  if (
    ![0, 1].includes(container.exitCode) ||
    ![0, 1].includes(volume.exitCode)
  ) {
    throw new Error("task-owned builder resource audit failed");
  }
  return {
    builders: builder ? 1 : 0,
    containers: container.exitCode === 0 ? 1 : 0,
    volumes: volume.exitCode === 0 ? 1 : 0,
  };
}

async function imagePresent(
  docker: DockerCommand,
  image: string,
): Promise<boolean> {
  const result = await docker(["image", "inspect", image], {
    allowNonZero: true,
  });
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw new Error("Docker image inventory returned an unexpected exit");
}

async function resourcePresent(
  docker: DockerCommand,
  kind: "network" | "volume",
  name: string,
): Promise<boolean> {
  const result = await docker([kind, "inspect", name], {
    allowNonZero: true,
  });
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw new Error("Docker resource inventory returned an unexpected exit");
}

async function removeExactRegistryReferences(
  docker: DockerCommand,
  registry: string | undefined,
): Promise<void> {
  const attempted = new Set<string>();
  while (true) {
    const inventory = await registryImageInventory(docker, registry);
    const reference = inventory
      .flatMap((image) => image.references)
      .find((candidate) => !attempted.has(candidate));
    if (reference === undefined) return;
    attempted.add(reference);
    await docker(["image", "rm", "-f", reference]);
  }
}

async function assertFixedResourcesAbsent(docker: DockerCommand): Promise<{
  readonly networks: readonly (typeof fixedNetworks)[number][];
  readonly volumes: readonly (typeof fixedVolumes)[number][];
}> {
  for (const [kind, names] of [
    ["network", fixedNetworks],
    ["volume", fixedVolumes],
  ] as const) {
    for (const name of names) {
      if (await resourcePresent(docker, kind, name)) {
        throw new Error("production smoke fixed resource is already owned");
      }
    }
  }
  if (
    (
      await containerIdsForLabels(docker, [
        "com.docker.compose.project=apollo-platform",
        "com.docker.compose.project=apollo-tf",
      ])
    ).length > 0
  ) {
    throw new Error("production smoke Compose resources are already owned");
  }
  return {
    networks: [...fixedNetworks],
    volumes: [...fixedVolumes],
  };
}

async function writeSecretFile(
  directory: string,
  name: string,
  value: string,
): Promise<void> {
  if (value.includes("\n") || value.includes("\r")) {
    throw new Error("generated secret is not one safe line");
  }
  const path = join(directory, name);
  await writeFile(path, value, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o400);
}

async function prepareSecrets(root: string): Promise<{
  readonly adminCredentialDirectory: string;
  readonly adminCredentialSourceDirectory: string;
  readonly adminPassword: string;
  readonly adminUser: string;
  readonly caddyEnvironmentPath: string;
  readonly dashboardToken: string;
  readonly oauthClientSecret: string;
  readonly operatorBootstrapToken: string;
  readonly platformDirectory: string;
  readonly rawSecrets: readonly string[];
  readonly tfDirectory: string;
}> {
  const platformDirectory = join(root, "platform-secrets");
  const tfDirectory = join(root, "tf-secrets");
  const adminCredentialSourceDirectory = join(root, "admin-credential-source");
  const adminCredentialParent = join(root, "admin-credential-generations");
  const adminCredentialDirectory = join(
    adminCredentialParent,
    "local-smoke-generation",
  );
  await mkdir(platformDirectory);
  await mkdir(tfDirectory);
  await mkdir(adminCredentialSourceDirectory);
  await mkdir(adminCredentialParent);
  await chmod(platformDirectory, 0o700);
  await chmod(tfDirectory, 0o700);
  await chmod(adminCredentialSourceDirectory, 0o700);
  await chmod(adminCredentialParent, 0o700);

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateJwk = privateKey.export({ format: "jwk" });
  const publicJwk = publicKey.export({ format: "jwk" });
  const kid = `local-release-${randomBytes(8).toString("hex")}`;
  const platformAdmin = secret();
  const platformMigrator = secret();
  const platformRuntime = secret();
  const operatorBootstrapToken = secret();
  const oauthClientSecret = secret();
  const tfAdmin = secret();
  const tfMigrator = secret();
  const tfRuntime = secret();
  const integrationsAdmin = secret();
  const integrationsMigrator = secret();
  const integrationsRuntime = secret();
  const integrationKey = secret();
  const integrationsInternal = secret();
  const integrationsHeartbeat = secret();
  const searchInternal = secret();
  const searchHeartbeat = secret();
  const downloadInternal = secret();
  const downloadHeartbeat = secret();
  const queuePassword = secret();
  const dashboardToken = secret();
  const adminUser = `release-${randomBytes(6).toString("hex")}`;
  const adminPassword = secret(36);
  const spotifyClientId = secret();
  const spotifyClientSecret = secret();

  const platformFiles: Record<string, string> = {
    platform_assertion_private_jwk: JSON.stringify({
      alg: "EdDSA",
      crv: "Ed25519",
      d: privateJwk.d,
      kid,
      kty: "OKP",
      use: "sig",
      x: privateJwk.x,
    }),
    platform_assertion_public_jwks: JSON.stringify({
      keys: [
        {
          alg: "EdDSA",
          crv: "Ed25519",
          kid,
          kty: "OKP",
          use: "sig",
          x: publicJwk.x,
        },
      ],
    }),
    platform_migrator_database_url:
      `postgres://apollo_platform_migrator:${encodeURIComponent(platformMigrator)}` +
      "@platform-postgres:5432/apollo_platform",
    platform_migrator_password: platformMigrator,
    platform_oauth_clients: JSON.stringify([
      {
        audience: "apollo-tf",
        clientId: "apollo-tf-api",
        clientSecretDigest: sha256(oauthClientSecret),
        redirectUris: ["https://api.tf.apollot.ru/api/auth/callback"],
      },
    ]),
    platform_operator_bootstrap_token: operatorBootstrapToken,
    platform_postgres_admin_password: platformAdmin,
    platform_runtime_database_url:
      `postgres://apollo_platform_runtime:${encodeURIComponent(platformRuntime)}` +
      "@platform-postgres:5432/apollo_platform",
    platform_runtime_password: platformRuntime,
  };
  const queueUrl =
    `redis://default:${encodeURIComponent(queuePassword)}` +
    "@tf-download-redis:6379/0";
  const tfFiles: Record<string, string> = {
    admin_dashboard_token: dashboardToken,
    tf_admin_database_url:
      `postgres://postgres:${encodeURIComponent(tfAdmin)}` +
      "@tf-postgres:5432/apollo_trackfinder",
    tf_client_secret: oauthClientSecret,
    tf_download_heartbeat_secret: downloadHeartbeat,
    tf_download_internal_auth_secret: downloadInternal,
    tf_download_queue_password: queuePassword,
    tf_download_queue_redis_url: queueUrl,
    tf_integrations_heartbeat_secret: integrationsHeartbeat,
    tf_integrations_internal_auth_secret: integrationsInternal,
    tf_integrations_migrator_database_url:
      `postgres://apollo_tf_integrations_migrator:${encodeURIComponent(integrationsMigrator)}` +
      "@tf-integrations-postgres:5432/apollo_tf_integrations",
    tf_integrations_migrator_password: integrationsMigrator,
    tf_integrations_postgres_admin_password: integrationsAdmin,
    tf_integrations_runtime_database_url:
      `postgres://apollo_tf_integrations_runtime:${encodeURIComponent(integrationsRuntime)}` +
      "@tf-integrations-postgres:5432/apollo_tf_integrations",
    tf_integrations_runtime_password: integrationsRuntime,
    tf_integrations_spotify_client_id: spotifyClientId,
    tf_integrations_spotify_client_secret: spotifyClientSecret,
    tf_integrations_token_keyring: JSON.stringify({
      activeKeyId: "local-release-v1",
      keys: { "local-release-v1": integrationKey },
    }),
    tf_migrator_database_url:
      `postgres://apollo_tf_migrator:${encodeURIComponent(tfMigrator)}` +
      "@tf-postgres:5432/apollo_trackfinder",
    tf_migrator_password: tfMigrator,
    tf_module_heartbeat_keys: JSON.stringify({
      "account-integrations": integrationsHeartbeat,
      "download-worker": downloadHeartbeat,
      "search-media": searchHeartbeat,
    }),
    tf_postgres_admin_password: tfAdmin,
    tf_runtime_database_url:
      `postgres://apollo_tf_runtime:${encodeURIComponent(tfRuntime)}` +
      "@tf-postgres:5432/apollo_trackfinder",
    tf_runtime_password: tfRuntime,
    tf_search_heartbeat_secret: searchHeartbeat,
    tf_search_internal_auth_secret: searchInternal,
  };
  await Promise.all(
    Object.entries(platformFiles).map(([name, value]) =>
      writeSecretFile(platformDirectory, name, value),
    ),
  );
  await Promise.all(
    Object.entries(tfFiles).map(([name, value]) =>
      writeSecretFile(tfDirectory, name, value),
    ),
  );
  await Promise.all(
    [
      ["admin_access_user", adminUser],
      ["admin_access_password", adminPassword],
    ].map(async ([name, value]) => {
      const path = join(adminCredentialSourceDirectory, name);
      await writeFile(path, `${value}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await chmod(path, 0o600);
    }),
  );
  return {
    adminCredentialDirectory,
    adminCredentialSourceDirectory,
    adminPassword,
    adminUser,
    caddyEnvironmentPath: join(adminCredentialDirectory, "caddy.env"),
    dashboardToken,
    oauthClientSecret,
    operatorBootstrapToken,
    platformDirectory,
    rawSecrets: [
      ...Object.values(platformFiles),
      ...Object.values(tfFiles),
      adminUser,
      adminPassword,
      String(privateJwk.d),
      sha256(oauthClientSecret),
    ],
    tfDirectory,
  };
}

async function prepareAdminCredentialGeneration(
  docker: DockerCommand,
  secrets: Awaited<ReturnType<typeof prepareSecrets>>,
  runId: string,
): Promise<void> {
  const readSourceLine = async (
    name: "admin_access_password" | "admin_access_user",
    minimumBytes: number,
    maximumBytes: number,
  ): Promise<string> => {
    const raw = await readFile(
      join(secrets.adminCredentialSourceDirectory, name),
      "utf8",
    );
    const bytes = Buffer.byteLength(raw);
    if (
      bytes < minimumBytes ||
      bytes > maximumBytes ||
      !raw.endsWith("\n") ||
      raw.slice(0, -1).includes("\n") ||
      raw.includes("\r")
    ) {
      throw new Error("admin credential source contract failed");
    }
    return raw.slice(0, -1);
  };
  const adminUser = await readSourceLine("admin_access_user", 2, 129);
  const adminPassword = await readSourceLine("admin_access_password", 17, 4097);
  if (!/^[A-Za-z0-9_.@-]{1,128}$/.test(adminUser)) {
    throw new Error("admin credential source contract failed");
  }
  await mkdir(secrets.adminCredentialDirectory);
  await chmod(secrets.adminCredentialDirectory, 0o700);
  const passwordHash = (
    await docker(
      [
        "run",
        "--rm",
        "--name",
        `apollo-release-caddy-hash-${runId}`,
        "--label",
        `apollo.local-release.run=${runId}`,
        "--network",
        "none",
        "--read-only",
        "-i",
        caddyImage,
        "caddy",
        "hash-password",
      ],
      { input: `${adminPassword}\n` },
    )
  ).stdout.trim();
  if (!/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(passwordHash)) {
    throw new Error("admin credential generation failed");
  }
  const htpasswd = join(
    secrets.adminCredentialDirectory,
    "admin_access_htpasswd",
  );
  const htpasswdTemporary = `${htpasswd}.tmp`;
  const caddyEnvironmentTemporary = `${secrets.caddyEnvironmentPath}.tmp`;
  await writeFile(htpasswdTemporary, `${adminUser}:${passwordHash}`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await writeFile(
    caddyEnvironmentTemporary,
    `APOLLO_ADMIN_CADDY_USER='${adminUser}'\n` +
      `APOLLO_ADMIN_CADDY_PASSWORD_HASH='${passwordHash}'\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await chmod(htpasswdTemporary, 0o400);
  await chmod(caddyEnvironmentTemporary, 0o600);
  await rename(htpasswdTemporary, htpasswd);
  await rename(caddyEnvironmentTemporary, secrets.caddyEnvironmentPath);
}

function parseEnv(source: string): Map<string, string> {
  return new Map(
    source
      .split(/\r?\n/)
      .filter((line) => line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

async function writeReleaseEnvironment(
  path: string,
  registry: string,
  digests: Readonly<Record<string, string>>,
  sourceCommit: string,
  secrets: Awaited<ReturnType<typeof prepareSecrets>>,
): Promise<void> {
  const values = parseEnv(await readFile(releaseExample, "utf8"));
  values.set(
    "PLATFORM_SECRET_DIRECTORY",
    secrets.platformDirectory.replaceAll("\\", "/"),
  );
  values.set("TF_SECRET_DIRECTORY", secrets.tfDirectory.replaceAll("\\", "/"));
  values.set(
    "TF_ADMIN_CREDENTIAL_DIRECTORY",
    secrets.adminCredentialDirectory.replaceAll("\\", "/"),
  );
  values.set("RELEASE_SOURCE_COMMIT", sourceCommit);
  for (const name of [
    "PLATFORM_API_VERSION",
    "TF_API_VERSION",
    "TF_SEARCH_VERSION",
    "TF_INTEGRATIONS_VERSION",
    "TF_DOWNLOAD_VERSION",
  ]) {
    values.set(name, `local-${sourceCommit.slice(0, 12)}`);
  }
  const imageVariables: Readonly<Record<string, string>> = {
    PLATFORM_API_IMAGE: "platform-api",
    PLATFORM_POSTGRES_IMAGE: "platform-postgres",
    PLATFORM_REDIS_IMAGE: "redis",
    TF_ADMIN_IMAGE: "tf-admin",
    TF_API_IMAGE: "tf-api",
    TF_DOWNLOAD_REDIS_IMAGE: "tf-download-redis",
    TF_DOWNLOAD_WORKER_IMAGE: "tf-download-worker",
    TF_INTEGRATIONS_IMAGE: "tf-integrations",
    TF_INTEGRATIONS_POSTGRES_IMAGE: "tf-integrations-postgres",
    TF_POSTGRES_IMAGE: "tf-postgres",
    TF_REDIS_IMAGE: "redis",
    TF_SEARCH_IMAGE: "tf-search",
    TF_WEB_IMAGE: "tf-web",
  };
  for (const [variable, image] of Object.entries(imageVariables)) {
    values.set(variable, `${registry}/${image}@${digests[image]}`);
  }
  await writeFile(
    path,
    [...values].map(([name, value]) => `${name}=${value}`).join("\n") + "\n",
    { encoding: "utf8", mode: 0o600 },
  );
}

function compose(
  docker: DockerCommand,
  file: string,
  envFile: string,
  project: string,
  args: readonly string[],
): Promise<CommandResult> {
  return docker(
    ["compose", "--env-file", envFile, "-f", file, "-p", project, ...args],
    { timeoutMs: 10 * 60_000 },
  );
}

type CookieJar = Map<string, string>;

function ingestCookies(response: Response, jar: CookieJar): void {
  for (const value of response.headers.getSetCookie()) {
    const [pair] = value.split(";", 1);
    const separator = pair.indexOf("=");
    jar.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
}

function cookieHeader(jar: CookieJar): string {
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function jsonRequest(
  url: string,
  options: RequestInit & {
    readonly expected: number | readonly number[];
    readonly jar?: CookieJar;
  },
): Promise<{ readonly body: any; readonly response: Response }> {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.jar?.size ? { cookie: cookieHeader(options.jar) } : {}),
      ...options.headers,
    },
    redirect: "manual",
  });
  if (options.jar !== undefined) ingestCookies(response, options.jar);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text.length === 0 ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  const expectedStatus = Array.isArray(options.expected)
    ? options.expected.includes(response.status)
    : response.status === options.expected;
  if (!expectedStatus) {
    const errorCode =
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "string" &&
      /^[a-z_]+$/.test(body.error)
        ? ` (${body.error})`
        : "";
    throw new Error(
      `application flow returned ${response.status}${errorCode} for ${
        new URL(url).pathname
      }`,
    );
  }
  return { body, response };
}

async function exercisePlatform(
  secrets: Awaited<ReturnType<typeof prepareSecrets>>,
): Promise<{
  readonly accountId: string;
  readonly grantSearch: () => Promise<void>;
  readonly portalCookies: CookieJar;
  readonly rawSecrets: string[];
}> {
  const origin = "http://127.0.0.1:18200";
  const publicOrigin = "https://admin.apollot.ru";
  const operatorCookies: CookieJar = new Map();
  const registration = await jsonRequest(`${origin}/v1/registration`, {
    expected: 200,
  });
  expect(registration.body).toEqual({ mode: "closed" });

  const operatorEmail = `operator-${randomUUID()}@example.test`;
  const operatorPassword = secret();
  let login: Awaited<ReturnType<typeof jsonRequest>> | undefined;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await jsonRequest(`${origin}/v1/operator/bootstrap`, {
      body: JSON.stringify({
        bootstrapToken: secrets.operatorBootstrapToken,
        displayName: "Local Release Operator",
        email: operatorEmail,
        password: operatorPassword,
        reason: "Task 5 local production package",
      }),
      expected: [201, 409, 503],
      headers: { "content-type": "application/json", origin: publicOrigin },
      method: "POST",
    });
    const candidate = await jsonRequest(`${origin}/v1/operator/sessions`, {
      body: JSON.stringify({
        email: operatorEmail,
        password: operatorPassword,
      }),
      expected: [200, 401, 503],
      headers: { "content-type": "application/json", origin: publicOrigin },
      jar: operatorCookies,
      method: "POST",
    });
    if (candidate.response.status === 200) {
      login = candidate;
      break;
    }
    await new Promise((resolveRetry) =>
      setTimeout(resolveRetry, attempt * 500),
    );
  }
  if (login === undefined) {
    throw new Error("operator bootstrap did not converge");
  }
  const csrf = String(login.body.csrfToken);
  const portalCookies: CookieJar = new Map();
  const portalLogin = await jsonRequest(`${origin}/v1/sessions`, {
    body: JSON.stringify({
      email: operatorEmail,
      password: operatorPassword,
    }),
    expected: 200,
    headers: {
      "content-type": "application/json",
      origin: "https://apollot.ru",
    },
    jar: portalCookies,
    method: "POST",
  });
  const operatorAccountId = String(portalLogin.body.accountId);
  const mutateEntitlement = async (
    accountId: string,
    moduleKey: "tf.downloads" | "tf.search",
    method: "DELETE" | "PUT",
    reason: string,
  ): Promise<void> => {
    await jsonRequest(
      `${origin}/v1/operator/accounts/${accountId}/entitlements/${moduleKey}`,
      {
        body: JSON.stringify({ reason }),
        expected: 200,
        headers: {
          "content-type": "application/json",
          origin: publicOrigin,
          "x-csrf-token": csrf,
        },
        jar: operatorCookies,
        method,
      },
    );
  };
  await jsonRequest(`${origin}/v1/operator/registration-settings`, {
    body: JSON.stringify({
      mode: "invite_only",
      reason: "Task 5 local invitation proof",
    }),
    expected: 200,
    headers: {
      "content-type": "application/json",
      origin: publicOrigin,
      "x-csrf-token": csrf,
    },
    jar: operatorCookies,
    method: "PATCH",
  });
  const memberEmail = `member-${randomUUID()}@example.test`;
  const memberPassword = secret();
  const invitation = await jsonRequest(`${origin}/v1/operator/invitations`, {
    body: JSON.stringify({
      email: memberEmail,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      moduleKeys: ["tf.downloads", "tf.search"],
      reason: "Task 5 local invitation",
      usesLimit: 1,
    }),
    expected: 201,
    headers: {
      "content-type": "application/json",
      origin: publicOrigin,
      "x-csrf-token": csrf,
    },
    jar: operatorCookies,
    method: "POST",
  });
  const member = await jsonRequest(`${origin}/v1/registrations`, {
    body: JSON.stringify({
      displayName: "Local Release Member",
      email: memberEmail,
      invitationToken: invitation.body.invitationToken,
      password: memberPassword,
    }),
    expected: 202,
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const accountId = String(member.body.account.id);
  await mutateEntitlement(
    accountId,
    "tf.search",
    "DELETE",
    "Task 5 invitation denial proof",
  );
  await mutateEntitlement(
    accountId,
    "tf.search",
    "PUT",
    "Task 5 invitation grant proof",
  );
  await mutateEntitlement(
    operatorAccountId,
    "tf.downloads",
    "PUT",
    "Task 5 TF download proof",
  );
  await mutateEntitlement(
    operatorAccountId,
    "tf.search",
    "PUT",
    "Task 5 TF denial setup",
  );
  await mutateEntitlement(
    operatorAccountId,
    "tf.search",
    "DELETE",
    "Task 5 TF denial proof",
  );
  return {
    accountId: operatorAccountId,
    portalCookies,
    rawSecrets: [
      operatorPassword,
      memberPassword,
      String(invitation.body.invitationToken),
      ...operatorCookies.values(),
      ...portalCookies.values(),
    ],
    grantSearch: async () => {
      await mutateEntitlement(
        operatorAccountId,
        "tf.search",
        "PUT",
        "Task 5 TF grant proof",
      );
    },
  };
}

function localBridgeUrl(
  value: string | null,
  publicOrigin: string,
  localOrigin: string,
  rawSecrets: string[],
): string {
  if (value === null) throw new Error("authorization redirect missing");
  const url = new URL(value);
  if (url.origin !== publicOrigin || url.username || url.password || url.hash) {
    throw new Error("authorization redirect escaped its registered origin");
  }
  for (const name of ["code", "nonce", "state"]) {
    const secretValue = url.searchParams.get(name);
    if (secretValue !== null) rawSecrets.push(secretValue);
  }
  return `${localOrigin}${url.pathname}${url.search}`;
}

async function bridgeTfSession(
  platform: Awaited<ReturnType<typeof exercisePlatform>>,
  sessionCookies: CookieJar = new Map(),
): Promise<CookieJar> {
  sessionCookies.delete("__Host-apollo_tf");
  sessionCookies.delete("__Host-apollo_tf_csrf");
  const start = await jsonRequest("http://127.0.0.1:18201/api/auth/start", {
    expected: 303,
    jar: sessionCookies,
  });
  platform.rawSecrets.push(...sessionCookies.values());
  const authorize = await jsonRequest(
    localBridgeUrl(
      start.response.headers.get("location"),
      "https://api.apollot.ru",
      "http://127.0.0.1:18200",
      platform.rawSecrets,
    ),
    {
      expected: 303,
      jar: platform.portalCookies,
    },
  );
  const callback = await jsonRequest(
    localBridgeUrl(
      authorize.response.headers.get("location"),
      "https://api.tf.apollot.ru",
      "http://127.0.0.1:18201",
      platform.rawSecrets,
    ),
    {
      expected: 303,
      jar: sessionCookies,
    },
  );
  if (callback.response.headers.get("location") !== "https://tf.apollot.ru") {
    throw new Error("TF callback returned an unexpected public redirect");
  }
  if (
    !sessionCookies.has("__Host-apollo_tf") ||
    !sessionCookies.has("__Host-apollo_tf_csrf")
  ) {
    throw new Error("TF callback did not issue the secure session cookies");
  }
  platform.rawSecrets.push(...sessionCookies.values());
  return sessionCookies;
}

function tfHeaders(session: CookieJar) {
  const csrf = session.get("__Host-apollo_tf_csrf");
  if (csrf === undefined) throw new Error("TF CSRF cookie missing");
  return {
    "content-type": "application/json",
    origin: "https://tf.apollot.ru",
    "x-csrf-token": csrf,
  };
}

async function exerciseTf(
  docker: DockerCommand,
  envFile: string,
  dashboardToken: string,
  platform: Awaited<ReturnType<typeof exercisePlatform>>,
): Promise<{
  readonly jobId: string;
  readonly session: CookieJar;
}> {
  const origin = "http://127.0.0.1:18201";
  let session = await bridgeTfSession(platform);
  const denied = await jsonRequest(`${origin}/api/tracks/search`, {
    body: JSON.stringify({
      artist: "Local Release",
      maxResults: 5,
      mode: "auto",
      sources: ["yt"],
      title: "Denied",
    }),
    expected: 403,
    headers: tfHeaders(session),
    jar: session,
    method: "POST",
  });
  expect(denied.body).toEqual({ error: "module_access_denied" });
  await platform.grantSearch();
  session = await bridgeTfSession(platform, session);
  await compose(docker, tfCompose, envFile, "apollo-tf", ["stop", "tf-search"]);
  const degraded = await jsonRequest(`${origin}/api/tracks/search`, {
    body: JSON.stringify({
      artist: "Local Release",
      maxResults: 5,
      mode: "auto",
      sources: ["yt"],
      title: "Degraded",
    }),
    expected: 503,
    headers: tfHeaders(session),
    jar: session,
    method: "POST",
  });
  expect(degraded.body).toEqual({ error: "search_unavailable" });
  await compose(docker, tfCompose, envFile, "apollo-tf", [
    "up",
    "-d",
    "--no-deps",
    "tf-search",
  ]);
  await waitFor("restored granted search readiness", async () => {
    const state = await docker(
      [
        "inspect",
        "apollo-tf-tf-search-1",
        "--format",
        "{{json .State.Health.Status}}",
      ],
      { allowNonZero: true },
    );
    return state.exitCode === 0 && JSON.parse(state.stdout) === "healthy";
  });
  const moduleStatuses = async () => {
    const dashboard = await jsonRequest(`${origin}/api/admin/dashboard`, {
      expected: 200,
      headers: { "x-admin-dashboard-token": dashboardToken },
    });
    return new Map<string, string>(
      (dashboard.body.modules as any[]).map((module) => [
        String(module.id),
        String(module.status),
      ]),
    );
  };
  await waitFor("signed module heartbeats", async () => {
    const modules = await moduleStatuses();
    return ["search-media", "account-integrations", "download-worker"].every(
      (name) => modules.get(name) === "healthy",
    );
  });
  const restored = await jsonRequest(`${origin}/api/tracks/search`, {
    body: JSON.stringify({
      artist: "Local Release",
      maxResults: 5,
      mode: "manual",
      sources: ["yt"],
      title: "Restored",
    }),
    expected: 200,
    headers: tfHeaders(session),
    jar: session,
    method: "POST",
  });
  expect(restored.body).toMatchObject({
    query: "Local Release Restored",
    sources: ["yt"],
  });
  expect(Array.isArray(restored.body.results)).toBe(true);
  const heartbeatStaleDeadlineMs = 90_000;
  const heartbeatStoppedAt = Date.now();
  await compose(docker, tfCompose, envFile, "apollo-tf", [
    "stop",
    "tf-integrations",
  ]);
  await waitFor(
    "account integrations heartbeat stale",
    async () => {
      const modules = await moduleStatuses();
      return (
        Date.now() - heartbeatStoppedAt > heartbeatStaleDeadlineMs &&
        modules.get("account-integrations") === "unknown"
      );
    },
    heartbeatStaleDeadlineMs + 30_000,
  );
  await compose(docker, tfCompose, envFile, "apollo-tf", [
    "up",
    "-d",
    "--no-deps",
    "tf-integrations",
  ]);
  await waitFor("account integrations heartbeat recovery", async () => {
    const modules = await moduleStatuses();
    return modules.get("account-integrations") === "healthy";
  });
  const trackUrl =
    "https://www.youtube.com/watch?v=apollo_local_release_cancel";
  const queued = await jsonRequest(`${origin}/api/tracks/download/queue`, {
    body: JSON.stringify({
      tracks: [
        {
          artist: "Local Release",
          quality: "320",
          title: "Cancel",
          trackId: `yt_${Buffer.from(trackUrl).toString("base64url")}`,
        },
      ],
    }),
    expected: 200,
    headers: tfHeaders(session),
    jar: session,
    method: "POST",
  });
  const jobId = String(queued.body.results[0].jobId);
  await jsonRequest(`${origin}/api/tracks/download/jobs/${jobId}`, {
    expected: 200,
    headers: tfHeaders(session),
    jar: session,
    method: "DELETE",
  });
  return { jobId, session };
}

async function proveAdmin(
  docker: DockerCommand,
  image: string,
  _secrets: Awaited<ReturnType<typeof prepareSecrets>>,
  root: string,
  runId: string,
): Promise<void> {
  const malformed = join(root, `malformed-admin-${runId}`);
  await mkdir(malformed);
  const canary = secret();
  const dashboardCanary = secret();
  await writeFile(
    join(malformed, "admin_access_htpasswd"),
    `valid-user:$2a$12$${"A".repeat(53)}${canary}\nsecond-line`,
  );
  await writeFile(join(malformed, "admin_dashboard_token"), dashboardCanary);
  const name = `apollo-release-malformed-${runId}`;
  let proofError: unknown;
  try {
    const result = await docker(
      [
        "run",
        "--name",
        name,
        "--label",
        `apollo.local-release.run=${runId}`,
        "--network",
        "none",
        "--mount",
        `type=bind,source=${join(malformed, "admin_access_htpasswd")},target=/run/secrets/admin_access_htpasswd,readonly`,
        "--mount",
        `type=bind,source=${join(malformed, "admin_dashboard_token")},target=/run/secrets/admin_dashboard_token,readonly`,
        image,
      ],
      { allowNonZero: true },
    );
    if (result.exitCode === 0) {
      throw new Error("malformed admin container unexpectedly exited 0");
    }
    if (result.exitCode !== 1) {
      throw new Error("malformed admin container returned an unexpected exit");
    }
    const state = JSON.parse(
      (await docker(["inspect", name, "--format", "{{json .State}}"])).stdout,
    ) as {
      readonly ExitCode?: number;
      readonly Running?: boolean;
      readonly Status?: string;
    };
    if (
      state.ExitCode !== 1 ||
      state.Running !== false ||
      state.Status !== "exited"
    ) {
      throw new Error("malformed admin container state was unexpected");
    }
    const logs = await docker(["logs", name]);
    const disclosure = findSecretDisclosure(
      [result.stdout, result.stderr, logs.stdout, logs.stderr].join("\n"),
      [
        { id: "malformed-password", values: [canary] },
        { id: "malformed-dashboard", values: [dashboardCanary] },
      ],
    );
    if (disclosure !== undefined) {
      throw new Error(`malformed admin output disclosed [${disclosure}]`);
    }
  } catch (error) {
    proofError = error;
  }
  let cleanupError: unknown;
  try {
    await docker(["rm", "-f", name]);
  } catch (error) {
    cleanupError = error;
  }
  if (proofError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [proofError, cleanupError],
      "malformed admin proof and cleanup failed",
    );
  }
  if (proofError !== undefined) throw proofError;
  if (cleanupError !== undefined) throw cleanupError;
}

async function proveLiveAdmin(
  docker: DockerCommand,
  secrets: Awaited<ReturnType<typeof prepareSecrets>>,
): Promise<void> {
  await jsonRequest("http://127.0.0.1:18203/", { expected: 401 });
  const authorization = `Basic ${Buffer.from(
    `${secrets.adminUser}:${secrets.adminPassword}`,
  ).toString("base64")}`;
  await jsonRequest("http://127.0.0.1:18203/", {
    expected: 200,
    headers: { authorization },
  });
  await jsonRequest("http://127.0.0.1:18203/api/admin/dashboard", {
    expected: 200,
    headers: { authorization },
  });
  const stat = await docker([
    "exec",
    "apollo-tf-tf-admin-1",
    "stat",
    "-c",
    "%U:%G:%a",
    "/etc/nginx/.htpasswd",
  ]);
  expect(stat.stdout.trim()).toBe("root:nginx:640");
}

type CaddyRouteAuthorization = "approved" | "none" | "wrong";

type CaddyRouteRequest = {
  readonly authorization: CaddyRouteAuthorization;
  readonly host: string;
  readonly path: string;
};

type CaddyRouteResponse = {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly status: number;
};

const caddyRouteMatrix = [
  { host: "api.apollot.ru", path: "/healthz" },
  { host: "api.tf.apollot.ru", path: "/api/healthz" },
  { host: "tf.apollot.ru", path: "/healthz" },
  { host: "admin.apollot.ru", path: "/healthz" },
] as const;

const requiredCaddySecurityHeaders: Readonly<Record<string, string>> = {
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

async function verifyCaddyRouteMatrix(
  request: (probe: CaddyRouteRequest) => Promise<CaddyRouteResponse>,
): Promise<void> {
  for (const authorization of [
    "none",
    "wrong",
    "approved",
  ] as const satisfies readonly CaddyRouteAuthorization[]) {
    for (const route of caddyRouteMatrix) {
      const response = await request({ authorization, ...route });
      const shouldReject =
        route.host === "admin.apollot.ru" && authorization !== "approved";
      if (response.status !== (shouldReject ? 401 : 200)) {
        throw new Error("Caddy route authorization contract failed");
      }
      if (!shouldReject && !response.body.includes("ok")) {
        throw new Error("Caddy upstream acceptance contract failed");
      }
      const normalizedHeaders = Object.fromEntries(
        Object.entries(response.headers).map(([name, value]) => [
          name.toLowerCase(),
          value.trim(),
        ]),
      );
      if (
        Object.entries(requiredCaddySecurityHeaders).some(
          ([name, value]) => normalizedHeaders[name] !== value,
        ) ||
        "server" in normalizedHeaders
      ) {
        throw new Error("Caddy security header contract failed");
      }
    }
  }
}

async function proveCaddyRoutes(
  docker: DockerCommand,
  root: string,
  runId: string,
  secrets: Awaited<ReturnType<typeof prepareSecrets>>,
): Promise<void> {
  const caddyCommand = async (
    label: string,
    args: readonly string[],
    options: Parameters<DockerCommand>[1] = {},
  ): Promise<CommandResult> => {
    try {
      return await docker(args, options);
    } catch {
      throw new Error(`Caddy ${label} failed`);
    }
  };
  const forwarder = `apollo-release-forwarder-${runId}`;
  const caddy = `apollo-release-caddy-${runId}`;
  const forwards = [
    [18200, "platform-api", 8080],
    [18201, "tf-api", 8080],
    [18202, "tf-web", 80],
    [18203, "tf-admin", 80],
  ]
    .map(
      ([listenPort, host, targetPort]) =>
        `socat TCP-LISTEN:${listenPort},bind=127.0.0.1,fork,reuseaddr TCP:${host}:${targetPort}`,
    )
    .join(" & ");
  await caddyCommand("forwarder start", [
    "run",
    "-d",
    "--name",
    forwarder,
    "--label",
    `apollo.local-release.run=${runId}`,
    "--add-host",
    "api.apollot.ru:127.0.0.1",
    "--add-host",
    "api.tf.apollot.ru:127.0.0.1",
    "--add-host",
    "tf.apollot.ru:127.0.0.1",
    "--add-host",
    "admin.apollot.ru:127.0.0.1",
    "--network",
    "apollo-platform-bridge-v1",
    "--entrypoint",
    "sh",
    socatImage,
    "-eu",
    "-c",
    `${forwards} & wait`,
  ]);
  await caddyCommand("forwarder network connect", [
    "network",
    "connect",
    "apollo-tf-edge-v1",
    forwarder,
  ]);
  const wrapper = join(root, "Caddyfile");
  await writeFile(
    wrapper,
    "{\n\tadmin off\n\tlocal_certs\n}\n\nimport /etc/caddy/apollo.caddyfile\n",
  );
  await caddyCommand("start", [
    "run",
    "-d",
    "--name",
    caddy,
    "--label",
    `apollo.local-release.run=${runId}`,
    "--network",
    `container:${forwarder}`,
    "--read-only",
    "--entrypoint",
    "/bin/sh",
    "--mount",
    `type=bind,source=${secrets.caddyEnvironmentPath},target=/run/secrets/apollo-caddy.env,readonly`,
    "--mount",
    `type=bind,source=${wrapper},target=/etc/caddy/Caddyfile,readonly`,
    "--mount",
    `type=bind,source=${caddyInclude},target=/etc/caddy/apollo.caddyfile,readonly`,
    "--tmpfs",
    "/config:rw,noexec,nosuid,size=16m",
    "--tmpfs",
    "/data:rw,noexec,nosuid,size=16m",
    caddyImage,
    "-eu",
    "-c",
    "set -a; . /run/secrets/apollo-caddy.env; set +a; exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile",
  ]);
  const approvedAuthorization = `Basic ${Buffer.from(
    `${secrets.adminUser}:${secrets.adminPassword}`,
  ).toString("base64")}`;
  const wrongAuthorization = `Basic ${Buffer.from(
    `wrong-${runId}:wrong-${runId}`,
  ).toString("base64")}`;
  const probeScript = [
    'const https = require("node:https");',
    "const [connectHost, targetUrl, authState] = process.argv.slice(1);",
    "const target = new URL(targetUrl);",
    'let authorization = "";',
    "const request = () => {",
    "  const headers = { host: target.host };",
    '  if (authState !== "none") headers.authorization = authorization.trimEnd();',
    "  const probe = https.request({",
    "    hostname: connectHost,",
    "    port: 443,",
    "    path: `${target.pathname}${target.search}`,",
    '    method: "GET",',
    "    servername: target.hostname,",
    "    rejectUnauthorized: false,",
    "    headers,",
    "  }, (response) => {",
    '    let body = "";',
    '    response.setEncoding("utf8");',
    '    response.on("data", (chunk) => { body += chunk; });',
    '    response.on("end", () => {',
    "      process.stdout.write(JSON.stringify({",
    "        body,",
    "        headers: response.headers,",
    "        status: response.statusCode,",
    "      }));",
    "    });",
    "  });",
    '  probe.on("error", () => {',
    '    process.stderr.write("route probe failed\\n");',
    "    process.exitCode = 1;",
    "  });",
    "  probe.end();",
    "};",
    'if (authState === "none") request();',
    "else {",
    '  process.stdin.setEncoding("utf8");',
    '  process.stdin.on("data", (chunk) => { authorization += chunk; });',
    '  process.stdin.on("end", request);',
    "}",
  ].join("\n");
  const requestRoute = async (
    request: CaddyRouteRequest,
  ): Promise<CaddyRouteResponse> => {
    const authorization =
      request.authorization === "approved"
        ? approvedAuthorization
        : request.authorization === "wrong"
          ? wrongAuthorization
          : undefined;
    const result = await caddyCommand(
      "route probe",
      [
        "exec",
        ...(authorization === undefined ? [] : ["-i"]),
        "apollo-platform-platform-api-1",
        "node",
        "-e",
        probeScript,
        forwarder,
        `https://${request.host}${request.path}`,
        request.authorization,
      ],
      authorization === undefined ? {} : { input: `${authorization}\n` },
    );
    let parsed: {
      readonly body?: unknown;
      readonly headers?: unknown;
      readonly status?: unknown;
    };
    try {
      parsed = JSON.parse(result.stdout) as typeof parsed;
    } catch {
      throw new Error("Caddy route response failed");
    }
    if (
      typeof parsed.body !== "string" ||
      typeof parsed.status !== "number" ||
      parsed.headers === null ||
      typeof parsed.headers !== "object" ||
      Array.isArray(parsed.headers)
    ) {
      throw new Error("Caddy route response failed");
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed.headers)) {
      if (typeof value === "string") {
        headers[name] = value;
      } else if (
        Array.isArray(value) &&
        value.every((entry): entry is string => typeof entry === "string")
      ) {
        headers[name] = value.join(", ");
      }
    }
    return { body: parsed.body, headers, status: parsed.status };
  };
  await waitFor("Caddy route readiness", async () => {
    const response = await requestRoute({
      authorization: "none",
      host: "api.apollot.ru",
      path: "/healthz",
    });
    return response.status === 200 && response.body.includes("ok");
  });
  await verifyCaddyRouteMatrix(requestRoute);
}

async function proveNativeLinuxAdminTokenOwnership(
  docker: DockerCommand,
  registryContainer: string,
  runId: string,
  digests: Readonly<Record<string, string>>,
  dashboardToken: string,
): Promise<void> {
  const dind = `apollo-native-token-proof-${runId}`;
  const proofSource = await readFile(
    join(repositoryRoot, "deploy/ops/prove-admin-token-ownership.sh"),
    "utf8",
  );
  const apiImage = `127.0.0.1:5000/tf-api@${digests["tf-api"]}`;
  const adminImage = `127.0.0.1:5000/tf-admin@${digests["tf-admin"]}`;
  let proofError: unknown;
  try {
    await docker(
      [
        "run",
        "-d",
        "--name",
        dind,
        "--label",
        `apollo.local-release.run=${runId}`,
        "--privileged",
        "--network",
        `container:${registryContainer}`,
        "--env",
        "DOCKER_TLS_CERTDIR=",
        "--tmpfs",
        "/var/lib/docker:rw,nosuid,nodev,size=4g",
        "--tmpfs",
        "/proof:rw,nosuid,nodev,noexec,size=8m",
        nativeDockerImage,
        "--host=unix:///var/run/docker.sock",
        "--insecure-registry=127.0.0.1:5000",
      ],
      { timeoutMs: 10 * 60_000 },
    );
    await waitFor(
      "native Linux Docker daemon",
      async () =>
        (
          await docker(
            ["exec", dind, "docker", "info", "--format", "{{.ServerVersion}}"],
            { allowNonZero: true },
          )
        ).exitCode === 0,
      120_000,
    );
    const composeVersion = await docker(
      ["exec", dind, "docker", "compose", "version"],
      { allowNonZero: true },
    );
    if (composeVersion.exitCode !== 0) {
      throw new Error("native Linux proof Compose preflight failed");
    }
    await docker(
      [
        "exec",
        "-i",
        dind,
        "sh",
        "-eu",
        "-c",
        "umask 077; mkdir /proof/locks; " +
          "cat > /proof/prove-admin-token-ownership.sh; " +
          "chmod 0700 /proof/prove-admin-token-ownership.sh",
      ],
      { input: proofSource },
    );
    await docker(
      [
        "exec",
        "-i",
        dind,
        "sh",
        "-eu",
        "-c",
        "umask 077; cat > /proof/admin_dashboard_token; " +
          "chown 10001:10001 /proof/admin_dashboard_token; " +
          "chmod 0400 /proof/admin_dashboard_token",
      ],
      { input: dashboardToken },
    );
    await docker(
      [
        "exec",
        "-i",
        dind,
        "sh",
        "-eu",
        "-c",
        "umask 077; cat > /proof/proof.env; chmod 0600 /proof/proof.env",
      ],
      {
        input:
          "APOLLO_ADMIN_DASHBOARD_TOKEN_FILE=/proof/admin_dashboard_token\n" +
          `APOLLO_NATIVE_PROOF_ID=native-${runId}\n` +
          "APOLLO_NATIVE_PROOF_LOCK_PARENT=/proof/locks\n" +
          `APOLLO_TF_ADMIN_IMAGE=${adminImage}\n` +
          `APOLLO_TF_API_IMAGE=${apiImage}\n`,
      },
    );
    for (const image of [apiImage, adminImage]) {
      await docker(["exec", dind, "docker", "pull", image], {
        timeoutMs: 10 * 60_000,
      });
    }
    const result = await docker([
      "exec",
      dind,
      "sh",
      "-eu",
      "-c",
      "set -a; . /proof/proof.env; set +a; " +
        "exec sh /proof/prove-admin-token-ownership.sh",
    ]);
    if (
      result.stdout !== "native-admin-token-proof: complete\n" ||
      result.stderr !== ""
    ) {
      throw new Error("native Linux proof output contract failed");
    }
  } catch (error) {
    proofError = error;
  }
  let cleanupError: unknown;
  try {
    await docker(["rm", "-f", dind]);
    if (
      (
        await docker(["container", "inspect", dind], {
          allowNonZero: true,
        })
      ).exitCode === 0
    ) {
      throw new Error("native Linux proof cleanup audit failed");
    }
  } catch (error) {
    cleanupError = error;
  }
  if (proofError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [proofError, cleanupError],
      "native Linux proof and cleanup failed",
    );
  }
  if (proofError !== undefined) throw proofError;
  if (cleanupError !== undefined) throw cleanupError;
}

async function proveProfiledEntrypoints(
  docker: DockerCommand,
  root: string,
  runId: string,
  registry: string,
  digests: Readonly<Record<string, string>>,
  sourceCommit: string,
): Promise<readonly string[]> {
  const profileRoot = join(root, "profiled-entrypoints");
  await mkdir(profileRoot);
  const profileSecrets = await prepareSecrets(profileRoot);
  await prepareAdminCredentialGeneration(
    docker,
    profileSecrets,
    `profile-${runId}`,
  );
  const profileEnv = join(profileRoot, "release.env");
  await writeReleaseEnvironment(
    profileEnv,
    registry,
    digests,
    sourceCommit,
    profileSecrets,
  );
  const network = `apollo-release-profile-net-${runId}`;
  const volume = `apollo-release-profile-data-${runId}`;
  const database = `apollo-release-profile-db-${runId}`;
  const roleJob = `apollo-release-profile-role-${runId}`;
  const baselineJob = `apollo-release-profile-baseline-${runId}`;
  const project = `apollo-tf-profile-${runId}`;
  const override = join(profileRoot, "compose.override.yml");
  await writeFile(
    override,
    `networks:\n  tf-data:\n    external: true\n    name: ${network}\n`,
  );

  await docker([
    "network",
    "create",
    "--label",
    `apollo.local-release.run=${runId}`,
    network,
  ]);
  await docker([
    "volume",
    "create",
    "--label",
    `apollo.local-release.run=${runId}`,
    volume,
  ]);
  await docker([
    "run",
    "-d",
    "--name",
    database,
    "--label",
    `apollo.local-release.run=${runId}`,
    "--network",
    network,
    "--network-alias",
    "tf-postgres",
    "--mount",
    `type=volume,source=${volume},target=/var/lib/postgresql/data`,
    "--mount",
    `type=bind,source=${join(profileSecrets.tfDirectory, "tf_postgres_admin_password")},target=/run/secrets/tf_postgres_admin_password,readonly`,
    "--mount",
    `type=bind,source=${join(profileSecrets.tfDirectory, "tf_migrator_password")},target=/run/secrets/tf_migrator_password,readonly`,
    "--mount",
    `type=bind,source=${join(profileSecrets.tfDirectory, "tf_runtime_password")},target=/run/secrets/tf_runtime_password,readonly`,
    "--env",
    "POSTGRES_DB=apollo_trackfinder",
    "--env",
    "POSTGRES_USER=postgres",
    "--env",
    "POSTGRES_PASSWORD_FILE=/run/secrets/tf_postgres_admin_password",
    `${registry}/tf-postgres@${digests["tf-postgres"]}`,
  ]);
  await waitFor("profile PostgreSQL readiness", async () => {
    const ready = await docker(
      [
        "exec",
        database,
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-U",
        "postgres",
        "-d",
        "apollo_trackfinder",
      ],
      { allowNonZero: true },
    );
    return ready.exitCode === 0;
  });

  const composeRun = async (
    service: "tf-baseline" | "tf-role-bootstrap",
    name: string,
  ) =>
    docker(
      [
        "compose",
        "--profile",
        "baseline",
        "--env-file",
        profileEnv,
        "-f",
        tfCompose,
        "-f",
        override,
        "-p",
        project,
        "run",
        "--name",
        name,
        "--label",
        `apollo.local-release.run=${runId}`,
        "--no-deps",
        service,
      ],
      { allowNonZero: true, timeoutMs: 5 * 60_000 },
    );
  const assertExitedZero = async (name: string) => {
    const state = JSON.parse(
      (await docker(["inspect", name, "--format", "{{json .State}}"])).stdout,
    ) as {
      readonly ExitCode?: number;
      readonly Running?: boolean;
      readonly Status?: string;
    };
    expect(state).toMatchObject({
      ExitCode: 0,
      Running: false,
      Status: "exited",
    });
    return docker(["logs", name]);
  };

  const roleResult = await composeRun("tf-role-bootstrap", roleJob);
  if (roleResult.exitCode !== 0) {
    throw new Error("tf-role-bootstrap Compose contract failed");
  }
  const roleLogs = await assertExitedZero(roleJob);
  expect(roleLogs.stdout).toBe("");
  expect(roleLogs.stderr).toBe("");

  const startupSchema = await readFile(
    join(repositoryRoot, "lib/db/migrations/0001_tf_core_collections.sql"),
    "utf8",
  );
  const seedResult = await docker(
    [
      "exec",
      "-i",
      database,
      "psql",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      "apollo_trackfinder",
    ],
    { input: startupSchema },
  );
  expect(seedResult.stderr).toBe("");

  const baselineResult = await composeRun("tf-baseline", baselineJob);
  if (baselineResult.exitCode !== 0) {
    throw new Error("tf-baseline Compose contract failed");
  }
  const baselineLogs = await assertExitedZero(baselineJob);
  expect(baselineLogs.stderr).toBe("");
  expect(
    baselineLogs.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line)),
  ).toEqual([
    {
      alreadyApplied: 0,
      applied: 2,
      event: "tf_migrations_complete",
    },
  ]);

  const migrationState = await docker([
    "exec",
    database,
    "psql",
    "-X",
    "-At",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "postgres",
    "-d",
    "apollo_trackfinder",
    "-c",
    "select string_agg(name, ',' order by name) from apollo_tf.schema_migrations",
  ]);
  expect(migrationState.stdout.trim()).toBe(
    "0001_tf_core_collections.sql,0002_tf_runtime_privileges.sql",
  );
  const ownershipState = await docker([
    "exec",
    database,
    "psql",
    "-X",
    "-At",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "postgres",
    "-d",
    "apollo_trackfinder",
    "-c",
    "select count(*) from pg_tables where schemaname = 'public' and tableowner = 'apollo_tf_migrator' and tablename = any(array['track_search_cache','play_history','liked_tracks','playlists','playlist_tracks'])",
  ]);
  expect(ownershipState.stdout.trim()).toBe("5");

  const disclosure = findSecretDisclosure(
    [
      roleResult.stdout,
      roleResult.stderr,
      roleLogs.stdout,
      roleLogs.stderr,
      baselineResult.stdout,
      baselineResult.stderr,
      baselineLogs.stdout,
      baselineLogs.stderr,
    ].join("\n"),
    [{ id: "profile", values: profileSecrets.rawSecrets }],
  );
  if (disclosure !== undefined) {
    throw new Error(`profiled one-shot output disclosed [${disclosure}]`);
  }
  return profileSecrets.rawSecrets;
}

async function containerIdsForLabels(
  docker: DockerCommand,
  labels: readonly string[],
): Promise<readonly string[]> {
  const ids = new Set<string>();
  for (const label of labels) {
    const result = await docker(["ps", "-aq", "--filter", `label=${label}`]);
    for (const id of result.stdout.split(/\r?\n/).filter(Boolean)) {
      ids.add(id);
    }
  }
  return [...ids];
}

async function resourceIdsForRunLabel(
  docker: DockerCommand,
  kind: "network" | "volume",
  runId: string,
): Promise<readonly string[]> {
  return (
    await docker([
      kind,
      "ls",
      "-q",
      "--filter",
      `label=apollo.local-release.run=${runId}`,
    ])
  ).stdout
    .split(/\r?\n/)
    .filter(Boolean);
}

async function registryImageInventory(
  docker: DockerCommand,
  registry: string | undefined,
): Promise<
  readonly {
    readonly id: string;
    readonly references: readonly string[];
  }[]
> {
  if (registry === undefined) return [];
  const ids = [
    ...new Set(
      (await docker(["image", "ls", "-aq", "--no-trunc"])).stdout
        .split(/\r?\n/)
        .filter(Boolean),
    ),
  ];
  const inventory: { id: string; references: string[] }[] = [];
  for (const id of ids) {
    const inspected = await docker([
      "image",
      "inspect",
      id,
      "--format",
      "{{json .RepoTags}}\n{{json .RepoDigests}}",
    ]);
    const [rawTags = "null", rawDigests = "null"] = inspected.stdout
      .trim()
      .split(/\r?\n/, 2);
    const references = [
      ...((JSON.parse(rawTags) as string[] | null) ?? []),
      ...((JSON.parse(rawDigests) as string[] | null) ?? []),
    ].filter((reference) => reference.startsWith(`${registry}/`));
    if (references.length > 0) {
      inventory.push({ id, references });
    }
  }
  return inventory;
}

async function cleanupAudit(
  docker: DockerCommand,
  runId: string,
  registry: string | undefined,
  root: string | undefined,
  temporaryRootParent?: string,
  builderOwnership?: OwnedLocalBuilder,
): Promise<{
  readonly builderCacheVolumes: number;
  readonly builderContainers: number;
  readonly builderInstances: number;
  readonly containers: number;
  readonly imageReferences: number;
  readonly networks: number;
  readonly registryFiles: number;
  readonly temporarySecrets: number;
  readonly volumes: number;
}> {
  const builderAudit =
    builderOwnership === undefined
      ? { builders: 0, containers: 0, volumes: 0 }
      : await auditOwnedLocalBuilder(docker, builderOwnership);
  const containers = (
    await containerIdsForLabels(docker, [
      `apollo.local-release.run=${runId}`,
      "com.docker.compose.project=apollo-platform",
      "com.docker.compose.project=apollo-tf",
    ])
  ).length;
  let networks = 0;
  for (const name of fixedNetworks) {
    if (await resourcePresent(docker, "network", name)) {
      networks += 1;
    }
  }
  networks += (await resourceIdsForRunLabel(docker, "network", runId)).length;
  let volumes = 0;
  for (const name of fixedVolumes) {
    if (await resourcePresent(docker, "volume", name)) {
      volumes += 1;
    }
  }
  volumes += (await resourceIdsForRunLabel(docker, "volume", runId)).length;
  const imageReferences = (
    await registryImageInventory(docker, registry)
  ).reduce((total, image) => total + image.references.length, 0);
  const temporaryRootPaths = new Set<string>();
  if (root !== undefined && (await pathExistsForAudit(root))) {
    temporaryRootPaths.add(resolve(root));
  }
  if (temporaryRootParent !== undefined) {
    for (const ownership of await ownedTemporaryRootInventory(
      temporaryRootParent,
    )) {
      temporaryRootPaths.add(resolve(ownership.root));
    }
  }
  const temporaryRoots = [...temporaryRootPaths].sort();
  let registryFiles = 0;
  for (const temporaryRoot of temporaryRoots) {
    const registryPath = join(temporaryRoot, "registry");
    if (await pathExists(registryPath)) {
      registryFiles += (await readdir(registryPath)).length;
    }
  }
  return {
    builderCacheVolumes: builderAudit.volumes,
    builderContainers: builderAudit.containers,
    builderInstances: builderAudit.builders,
    containers,
    imageReferences,
    networks,
    registryFiles,
    temporarySecrets: temporaryRoots.length,
    volumes,
  };
}

async function runWithVerifiedCleanup<T, A>(options: {
  readonly audit: () => Promise<A>;
  readonly cleanup: () => Promise<void>;
  readonly isClean: (audit: A) => boolean;
  readonly run: () => Promise<T>;
  readonly stage: () => string;
}): Promise<{ readonly audit: A; readonly value: T }> {
  const errors: unknown[] = [];
  let audit!: A;
  let value!: T;
  try {
    value = await options.run();
  } catch (error) {
    errors.push(error);
  } finally {
    try {
      await options.cleanup();
    } catch (error) {
      errors.push(error);
    }
    try {
      audit = await options.audit();
      if (!options.isClean(audit)) {
        errors.push(new Error("production smoke cleanup audit was nonzero"));
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `production smoke failed at ${options.stage()}`,
    );
  }
  return { audit, value };
}

type ProductionSmokeLifecycleOperations = {
  readonly acquireResources: () => Promise<void>;
  readonly runApplicationFlows: () => Promise<void>;
  readonly startCaddy: () => Promise<void>;
  readonly startHelpers: () => Promise<void>;
  readonly startPlatform: () => Promise<void>;
  readonly startTf: () => Promise<void>;
};

async function runProductionSmokeLifecycle<A>(
  options: ProductionSmokeLifecycleOperations & {
    readonly audit: () => Promise<A>;
    readonly cleanup: () => Promise<void>;
    readonly isClean?: (audit: A) => boolean;
    readonly stage?: () => string;
  },
): Promise<{ readonly audit: A; readonly value: void }> {
  let lifecycleStage = "resource-acquisition";
  const runStage = async (
    name: string,
    operation: () => Promise<void>,
  ): Promise<void> => {
    lifecycleStage = name;
    await operation();
  };
  return runWithVerifiedCleanup({
    audit: options.audit,
    cleanup: options.cleanup,
    isClean:
      options.isClean ??
      ((audit) =>
        Object.values(audit as Record<string, unknown>).every(
          (value) => value === 0,
        )),
    run: async () => {
      await runStage("resource-acquisition", options.acquireResources);
      await runStage("helper-startup", options.startHelpers);
      await runStage("platform-compose-startup", options.startPlatform);
      await runStage("tf-compose-startup", options.startTf);
      await runStage("application-flows", options.runApplicationFlows);
      await runStage("caddy-startup", options.startCaddy);
    },
    stage: options.stage ?? (() => lifecycleStage),
  });
}

async function cleanupOwnedSmokeResources(options: {
  readonly acquiredImages: ReadonlyMap<string, boolean>;
  readonly builderOwnership?: OwnedLocalBuilder;
  readonly docker: DockerCommand;
  readonly envFile: string | undefined;
  readonly fixedResourceOwnership: {
    readonly networks: readonly string[];
    readonly volumes: readonly string[];
  };
  readonly registry: string | undefined;
  readonly removeTemporaryRoots?: (parent: string) => Promise<void>;
  readonly runId: string;
  readonly temporaryRootParent: string | undefined;
}): Promise<void> {
  const errors: unknown[] = [];
  const attempt = async (operation: () => Promise<unknown>) => {
    try {
      await operation();
    } catch (error) {
      errors.push(error);
    }
  };

  if (options.builderOwnership !== undefined) {
    await attempt(() =>
      removeOwnedLocalBuilder(
        options.docker,
        options.builderOwnership as OwnedLocalBuilder,
      ),
    );
  }
  let helpers: readonly string[] = [];
  await attempt(async () => {
    helpers = await containerIdsForLabels(options.docker, [
      `apollo.local-release.run=${options.runId}`,
    ]);
  });
  for (const container of helpers) {
    await attempt(() => options.docker(["rm", "-f", container]));
  }
  if (options.envFile !== undefined && (await pathExists(options.envFile))) {
    await attempt(() =>
      compose(
        options.docker,
        tfCompose,
        options.envFile as string,
        "apollo-tf",
        ["down", "--volumes", "--remove-orphans", "--timeout", "20"],
      ),
    );
    await attempt(() =>
      compose(
        options.docker,
        platformCompose,
        options.envFile as string,
        "apollo-platform",
        ["down", "--volumes", "--remove-orphans", "--timeout", "20"],
      ),
    );
  }
  let leftovers: readonly string[] = [];
  await attempt(async () => {
    leftovers = await containerIdsForLabels(options.docker, [
      `apollo.local-release.run=${options.runId}`,
      "com.docker.compose.project=apollo-platform",
      "com.docker.compose.project=apollo-tf",
    ]);
  });
  for (const container of leftovers) {
    await attempt(() => options.docker(["rm", "-f", container]));
  }
  for (const kind of ["network", "volume"] as const) {
    let resources: readonly string[] = [];
    await attempt(async () => {
      resources = await resourceIdsForRunLabel(
        options.docker,
        kind,
        options.runId,
      );
    });
    for (const resource of resources) {
      await attempt(() =>
        options.docker([
          kind,
          "rm",
          ...(kind === "volume" ? ["-f"] : []),
          resource,
        ]),
      );
    }
  }
  for (const [kind, names] of [
    ["network", options.fixedResourceOwnership.networks],
    ["volume", options.fixedResourceOwnership.volumes],
  ] as const) {
    for (const name of names) {
      await attempt(async () => {
        if (await resourcePresent(options.docker, kind, name)) {
          await options.docker([
            kind,
            "rm",
            ...(kind === "volume" ? ["-f"] : []),
            name,
          ]);
        }
      });
    }
  }
  await attempt(() =>
    removeExactRegistryReferences(options.docker, options.registry),
  );
  for (const [image, wasPresent] of options.acquiredImages) {
    if (!wasPresent) {
      await attempt(async () => {
        if (await imagePresent(options.docker, image)) {
          await options.docker(["image", "rm", image]);
        }
      });
    }
  }
  if (options.temporaryRootParent !== undefined) {
    await attempt(() =>
      (options.removeTemporaryRoots ?? removeOwnedTemporaryRoots)(
        options.temporaryRootParent as string,
      ),
    );
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "production smoke teardown failed");
  }
}

async function runCoolifyProductionSmoke(): Promise<unknown> {
  let stage = "local-docker";
  const environment = await assertLocalDocker();
  const docker = createDocker(environment);
  const localContext = environment.DOCKER_CONTEXT;
  if (localContext === undefined) {
    throw new Error("verified local Docker context was not retained");
  }
  stage = "clean-source";
  const status = (await command("git", ["status", "--porcelain"])).stdout;
  if (status.trim().length > 0) {
    throw new Error("exact-commit smoke requires a clean worktree");
  }
  const sourceCommit = (
    await command("git", ["rev-parse", "HEAD"])
  ).stdout.trim();
  stage = "fixed-resource-preflight";
  const fixedResourceOwnership = await assertFixedResourcesAbsent(docker);

  const runId = randomBytes(6).toString("hex");
  const intendedBuilderOwnership = expectedOwnedLocalBuilder(
    localContext,
    `apollo-coolify-${runId}`,
  );
  const temporaryRootParent = tmpdir();
  const registryContainer = `apollo-release-registry-${runId}`;
  const acquiredImages = new Map<string, boolean>();
  const localReferences: string[] = [];
  const digests: Record<string, string> = {};
  let root: string | undefined;
  let source: string | undefined;
  let registryData: string | undefined;
  let envFile: string | undefined;
  let registry: string | undefined;
  let registryPort: number | undefined;
  let secrets: Awaited<ReturnType<typeof prepareSecrets>> | undefined;
  let profileRawSecrets: readonly string[] = [];
  let builderOwnership: OwnedLocalBuilder | undefined;
  let platformEvidence:
    | Awaited<ReturnType<typeof exercisePlatform>>
    | undefined;
  let tfEvidence: Awaited<ReturnType<typeof exerciseTf>> | undefined;
  const { audit: cleanup } = await runProductionSmokeLifecycle({
    acquireResources: async () => {
      stage = "resource-acquisition";
      builderOwnership = await createOwnedLocalBuilder(
        docker,
        localContext,
        intendedBuilderOwnership.name,
      );
      root = await prepareOwnedTemporaryRoot(temporaryRootParent);
      source = join(root, "source");
      registryData = join(root, "registry");
      envFile = join(root, "release.env");
      registryPort = await freePort();
      registry = `localhost:${registryPort}`;

      stage = "image-inventory";
      for (const image of [
        registryImage,
        caddyImage,
        socatImage,
        redisImage,
        nativeDockerImage,
      ]) {
        acquiredImages.set(image, await imagePresent(docker, image));
      }
      await mkdir(source);
      await mkdir(registryData);
      stage = "source-archive";
      const archive = join(root, "source.tar");
      await command("git", [
        "archive",
        "--format=tar",
        "--output",
        archive,
        sourceCommit,
      ]);
      await command("tar", ["-xf", archive, "-C", source]);
      await rm(archive, { force: true });
      stage = "secret-preparation";
      secrets = await prepareSecrets(root);
    },
    startHelpers: async () => {
      if (
        root === undefined ||
        source === undefined ||
        registryData === undefined ||
        envFile === undefined ||
        registry === undefined ||
        registryPort === undefined ||
        secrets === undefined
      ) {
        throw new Error("production smoke resources were not acquired");
      }
      if (builderOwnership === undefined) {
        throw new Error("production smoke builder was not acquired");
      }
      stage = "registry-start";
      await docker([
        "run",
        "-d",
        "--name",
        registryContainer,
        "--label",
        `apollo.local-release.run=${runId}`,
        "-p",
        `127.0.0.1:${registryPort}:5000`,
        "--mount",
        `type=bind,source=${registryData},target=/var/lib/registry`,
        registryImage,
      ]);
      await waitFor("local registry", async () => {
        const response = await fetch(`http://${registry}/v2/`);
        return response.ok;
      });
      stage = "admin-credential-generation";
      await prepareAdminCredentialGeneration(docker, secrets, runId);

      for (const target of productionTargets) {
        stage = `build-${target.image}`;
        const reference = `${registry}/${target.image}:${sourceCommit}`;
        await buildWithOwnedBuilder(
          docker,
          builderOwnership,
          [
            "--file",
            join(source, target.dockerfile),
            "--target",
            target.target,
            "--platform",
            "linux/amd64",
            "--label",
            `org.opencontainers.image.revision=${sourceCommit}`,
            "--tag",
            reference,
            "--push",
            source,
          ],
          { timeoutMs: 20 * 60_000 },
        );
        localReferences.push(reference);
        stage = `digest-${target.image}`;
        const digest = (
          await inspectImageWithOwnedBuilder(
            docker,
            builderOwnership,
            reference,
          )
        ).stdout
          .replaceAll('"', "")
          .trim();
        if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
          throw new Error("local registry returned a malformed digest");
        }
        digests[target.image] = digest;
        localReferences.push(`${registry}/${target.image}@${digest}`);
      }
      stage = "mirror-redis";
      const redisReference = `${registry}/redis:${sourceCommit}`;
      await docker(["pull", redisImage], { timeoutMs: 10 * 60_000 });
      await docker(["tag", redisImage, redisReference]);
      await docker(["push", redisReference], { timeoutMs: 10 * 60_000 });
      localReferences.push(redisReference);
      digests.redis = (
        await inspectImageWithOwnedBuilder(
          docker,
          builderOwnership,
          redisReference,
        )
      ).stdout
        .replaceAll('"', "")
        .trim();
      localReferences.push(`${registry}/redis@${digests.redis}`);

      stage = "release-env";
      await writeReleaseEnvironment(
        envFile,
        registry,
        digests,
        sourceCommit,
        secrets,
      );
      stage = "release-validation";
      await command(
        process.execPath,
        [
          "--experimental-strip-types",
          "--",
          join(repositoryRoot, "scripts/src/coolify-release.ts"),
          "--env-file",
          envFile,
          "--mode",
          "loopback-local-smoke",
        ],
        { env: environment },
      );
      stage = "native-linux-admin-token-ownership";
      await proveNativeLinuxAdminTokenOwnership(
        docker,
        registryContainer,
        runId,
        digests,
        secrets.dashboardToken,
      );
      stage = "profiled-entrypoints";
      profileRawSecrets = await proveProfiledEntrypoints(
        docker,
        root,
        runId,
        registry,
        digests,
        sourceCommit,
      );
      stage = "admin-malformed";
      await proveAdmin(
        docker,
        `${registry}/tf-admin@${digests["tf-admin"]}`,
        secrets,
        root,
        runId,
      );
    },
    startPlatform: async () => {
      if (envFile === undefined) {
        throw new Error("production smoke release env was not acquired");
      }
      stage = "platform-start";
      await compose(docker, platformCompose, envFile, "apollo-platform", [
        "up",
        "-d",
        "--wait",
        "--wait-timeout",
        "180",
      ]);
      await waitFor(
        "Platform readiness",
        async () => (await fetch("http://127.0.0.1:18200/readyz")).ok,
      );
    },
    startTf: async () => {
      if (envFile === undefined) {
        throw new Error("production smoke release env was not acquired");
      }
      stage = "tf-start";
      await compose(docker, tfCompose, envFile, "apollo-tf", [
        "up",
        "-d",
        "--wait",
        "--wait-timeout",
        "240",
      ]);
      await waitFor(
        "TF readiness",
        async () => (await fetch("http://127.0.0.1:18201/api/readyz")).ok,
        240_000,
      );
    },
    runApplicationFlows: async () => {
      if (envFile === undefined || secrets === undefined) {
        throw new Error("production smoke runtime inputs were not acquired");
      }
      stage = "platform-flow";
      platformEvidence = await exercisePlatform(secrets);
      stage = "tf-flow";
      tfEvidence = await exerciseTf(
        docker,
        envFile,
        secrets.dashboardToken,
        platformEvidence,
      );
      stage = "admin-live";
      await proveLiveAdmin(docker, secrets);

      stage = "platform-restart";
      await compose(docker, platformCompose, envFile, "apollo-platform", [
        "restart",
        ...platformLongRunning,
      ]);
      stage = "tf-restart";
      await compose(docker, tfCompose, envFile, "apollo-tf", [
        "restart",
        ...tfLongRunning,
      ]);
      await waitFor(
        "persistent Platform readiness",
        async () => (await fetch("http://127.0.0.1:18200/readyz")).ok,
      );
      await waitFor(
        "persistent TF readiness",
        async () => (await fetch("http://127.0.0.1:18201/api/readyz")).ok,
      );
      if (tfEvidence === undefined) {
        throw new Error("TF application evidence was not produced");
      }
      const persistedTfEvidence = tfEvidence;
      stage = "persistence";
      const persistedRegistration = await jsonRequest(
        "http://127.0.0.1:18200/v1/registration",
        { expected: 200 },
      );
      expect(persistedRegistration.body).toEqual({ mode: "invite_only" });
      await waitFor("canceled download persistence", async () => {
        const status = await jsonRequest(
          `http://127.0.0.1:18201/api/tracks/download/status/${persistedTfEvidence.jobId}`,
          {
            expected: 200,
            headers: tfHeaders(persistedTfEvidence.session),
            jar: persistedTfEvidence.session,
          },
        );
        return status.body.status === "canceled";
      });
    },
    startCaddy: async () => {
      if (
        root === undefined ||
        envFile === undefined ||
        secrets === undefined ||
        platformEvidence === undefined
      ) {
        throw new Error("production smoke Caddy inputs were not produced");
      }
      stage = "caddy-routes";
      await proveCaddyRoutes(docker, root, runId, secrets);

      stage = "log-scan";
      const logs = [
        await compose(docker, platformCompose, envFile, "apollo-platform", [
          "logs",
          "--no-color",
        ]),
        await compose(docker, tfCompose, envFile, "apollo-tf", [
          "logs",
          "--no-color",
        ]),
      ]
        .flatMap(({ stdout, stderr }) => [stdout, stderr])
        .join("\n");
      const disclosure = findSecretDisclosure(logs, [
        { id: "package", values: secrets.rawSecrets },
        { id: "profile", values: profileRawSecrets },
        { id: "flow", values: platformEvidence.rawSecrets },
      ]);
      if (disclosure !== undefined) {
        throw new Error(
          `container logs disclosed a disposable secret [${disclosure}]`,
        );
      }
    },
    cleanup: () =>
      cleanupOwnedSmokeResources({
        acquiredImages,
        builderOwnership: intendedBuilderOwnership,
        docker,
        envFile,
        fixedResourceOwnership,
        registry,
        runId,
        temporaryRootParent,
      }),
    audit: () =>
      cleanupAudit(
        docker,
        runId,
        registry,
        root,
        temporaryRootParent,
        intendedBuilderOwnership,
      ),
    isClean: (audit) => Object.values(audit).every((value) => value === 0),
    stage: () => stage,
  });
  const evidence = {
    cleanup,
    digests: Object.fromEntries(
      Object.entries(digests).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    sourceCommit,
  };
  process.stdout.write(
    `COOLIFY_PRODUCTION_EVIDENCE=${JSON.stringify(evidence)}\n`,
  );
  return evidence;
}

type FakeSmokeResource = Map<string, Set<string>>;

function createFakeSmokeDocker(
  options: {
    readonly composeDownFailures?: ReadonlySet<string>;
  } = {},
) {
  const runId = "contract-run";
  const unrelatedNetwork = "unrelated-preexisting-network";
  const containers = new Map<string, Set<string>>();
  const networks: FakeSmokeResource = new Map([
    [unrelatedNetwork, new Set(["unrelated.owner=true"])],
  ]);
  const volumes: FakeSmokeResource = new Map();
  const commands: string[][] = [];
  const resourceMap = (kind: "network" | "volume") =>
    kind === "network" ? networks : volumes;
  const docker: DockerCommand = async (args) => {
    commands.push([...args]);
    if (
      (args[0] === "network" || args[0] === "volume") &&
      args[1] === "inspect"
    ) {
      return {
        exitCode: resourceMap(args[0]).has(args[2] ?? "") ? 0 : 1,
        stderr: "",
        stdout: "",
      };
    }
    if (args[0] === "ps" && args[1] === "-aq") {
      const label = args.at(-1)?.replace(/^label=/, "") ?? "";
      return {
        exitCode: 0,
        stderr: "",
        stdout:
          [...containers]
            .filter(([, labels]) => labels.has(label))
            .map(([id]) => id)
            .join("\n") + (containers.size > 0 ? "\n" : ""),
      };
    }
    if (args[0] === "rm" && args[1] === "-f") {
      for (const id of args.slice(2)) containers.delete(id);
      return { exitCode: 0, stderr: "", stdout: "" };
    }
    if (args[0] === "compose") {
      const project = args[args.indexOf("-p") + 1] ?? "";
      if (args.includes("down") && options.composeDownFailures?.has(project)) {
        throw new Error(`injected ${project} down failure`);
      }
      return { exitCode: 0, stderr: "", stdout: "" };
    }
    if ((args[0] === "network" || args[0] === "volume") && args[1] === "ls") {
      const label = args.at(-1)?.replace(/^label=/, "") ?? "";
      const resources = resourceMap(args[0]);
      return {
        exitCode: 0,
        stderr: "",
        stdout:
          [...resources]
            .filter(([, labels]) => labels.has(label))
            .map(([name]) => name)
            .join("\n") + (resources.size > 0 ? "\n" : ""),
      };
    }
    if ((args[0] === "network" || args[0] === "volume") && args[1] === "rm") {
      resourceMap(args[0]).delete(args.at(-1) ?? "");
      return { exitCode: 0, stderr: "", stdout: "" };
    }
    throw new Error(`unexpected fake Docker command: ${args.join(" ")}`);
  };

  return {
    commands,
    containers,
    docker,
    networks,
    runId,
    unrelatedNetwork,
    volumes,
  };
}

function createInjectedLifecycleOperations(
  state: ReturnType<typeof createFakeSmokeDocker>,
  failureOperation?: keyof ProductionSmokeLifecycleOperations,
): ProductionSmokeLifecycleOperations {
  let acquired = false;
  const acquireOwnedResources = () => {
    if (acquired) return;
    acquired = true;
    state.containers.set(
      "helper",
      new Set([`apollo.local-release.run=${state.runId}`]),
    );
    state.containers.set(
      "platform",
      new Set(["com.docker.compose.project=apollo-platform"]),
    );
    state.containers.set(
      "tf",
      new Set(["com.docker.compose.project=apollo-tf"]),
    );
    for (const name of fixedNetworks) state.networks.set(name, new Set());
    for (const name of fixedVolumes) state.volumes.set(name, new Set());
    state.networks.set(
      "contract-helper-network",
      new Set([`apollo.local-release.run=${state.runId}`]),
    );
    state.volumes.set(
      "contract-helper-volume",
      new Set([`apollo.local-release.run=${state.runId}`]),
    );
  };
  const operation =
    (name: keyof ProductionSmokeLifecycleOperations, stage: string) =>
    async () => {
      if (failureOperation === name) {
        acquireOwnedResources();
        throw new Error(`injected ${stage} failure`);
      }
      if (name === "startCaddy") acquireOwnedResources();
    };
  return {
    acquireResources: operation("acquireResources", "resource-acquisition"),
    runApplicationFlows: operation("runApplicationFlows", "application-flows"),
    startCaddy: operation("startCaddy", "caddy-startup"),
    startHelpers: operation("startHelpers", "helper-startup"),
    startPlatform: operation("startPlatform", "platform-compose-startup"),
    startTf: operation("startTf", "tf-compose-startup"),
  };
}

function flattenErrorMessages(error: unknown): readonly string[] {
  if (error instanceof AggregateError) {
    return error.errors.flatMap(flattenErrorMessages);
  }
  return [error instanceof Error ? error.message : String(error)];
}

describe("Coolify production smoke contract", () => {
  it.each([
    {
      environment: {
        DOCKER_CONTEXT: "default",
        DOCKER_HOST: "tcp://remote.example.invalid:2376",
      },
      label: "remote host with a local-looking context",
    },
    {
      environment: {
        DOCKER_CONTEXT: "remote-builder",
        DOCKER_HOST: "ssh://operator@remote.example.invalid",
      },
      label: "remote host with a remote context",
    },
  ])("rejects $label before any Docker command", async ({ environment }) => {
    const calls: readonly string[][] = [];
    const runner = async (
      _executable: string,
      args: readonly string[],
    ): Promise<CommandResult> => {
      (calls as string[][]).push([...args]);
      return { exitCode: 0, stderr: "", stdout: "" };
    };
    const validate = assertLocalDocker as unknown as (
      inherited: NodeJS.ProcessEnv,
      commandRunner: typeof runner,
    ) => Promise<NodeJS.ProcessEnv>;

    let error: unknown;
    await validate(environment, runner).catch((caught) => {
      error = caught;
    });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "production smoke requires local Docker",
    );
    expect(calls).toEqual([]);
  });

  it("validates the selected context through one sanitized Docker environment", async () => {
    const observed: {
      readonly args: readonly string[];
      readonly environment: NodeJS.ProcessEnv | undefined;
    }[] = [];
    const runner = async (
      _executable: string,
      args: readonly string[],
      options: Parameters<typeof command>[2] = {},
    ): Promise<CommandResult> => {
      observed.push({ args, environment: options.env });
      if (args[1] === "show") {
        return { exitCode: 0, stderr: "", stdout: "desktop-linux\n" };
      }
      return {
        exitCode: 0,
        stderr: "",
        stdout: `${JSON.stringify("npipe:////./pipe/docker_engine")}\n`,
      };
    };
    const validate = assertLocalDocker as unknown as (
      inherited: NodeJS.ProcessEnv,
      commandRunner: typeof runner,
    ) => Promise<NodeJS.ProcessEnv>;

    const environment = await validate(
      {
        DOCKER_CONTEXT: "desktop-linux",
        DOCKER_HOST: "npipe:////./pipe/docker_engine",
        SAFE_MARKER: "preserved",
      },
      runner,
    );

    expect(observed.map(({ args }) => args)).toEqual([
      ["context", "show"],
      [
        "context",
        "inspect",
        "desktop-linux",
        "--format",
        "{{json .Endpoints.docker.Host}}",
      ],
    ]);
    expect(
      observed.every(({ environment: value }) => value === environment),
    ).toBe(true);
    expect(environment.DOCKER_HOST).toBeUndefined();
    expect(environment.DOCKER_CONTEXT).toBe("desktop-linux");
    expect(environment.SAFE_MARKER).toBe("preserved");
  });

  it("rejects a selected remote context before any mutating Docker command", async () => {
    const calls: readonly string[][] = [];
    const runner = async (
      _executable: string,
      args: readonly string[],
    ): Promise<CommandResult> => {
      (calls as string[][]).push([...args]);
      return args[1] === "show"
        ? { exitCode: 0, stderr: "", stdout: "remote-builder\n" }
        : {
            exitCode: 0,
            stderr: "",
            stdout: `${JSON.stringify("tcp://remote.example.invalid:2376")}\n`,
          };
    };
    const validate = assertLocalDocker as unknown as (
      inherited: NodeJS.ProcessEnv,
      commandRunner: typeof runner,
    ) => Promise<NodeJS.ProcessEnv>;

    let error: unknown;
    await validate({ DOCKER_CONTEXT: "remote-builder" }, runner).catch(
      (caught) => {
        error = caught;
      },
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "production smoke requires local Docker",
    );
    expect(
      calls.some(
        (args) =>
          !(
            args[0] === "context" &&
            (args[1] === "show" || args[1] === "inspect")
          ),
      ),
    ).toBe(false);
  });

  it("binds source builds to an inventoried task-owned local builder even when the persistent builder is remote", async () => {
    const builderName = "apollo-coolify-contract-run";
    const builderContainer = `buildx_buildkit_${builderName}0`;
    const builderVolume = `${builderContainer}_state`;
    const commands: string[][] = [];
    let builderExists = false;
    const docker: DockerCommand = async (args) => {
      commands.push([...args]);
      if (args[0] === "buildx" && args[1] === "inspect") {
        return builderExists
          ? {
              exitCode: 0,
              stderr: "",
              stdout:
                `Name: ${builderName}\n` +
                "Driver: docker-container\n" +
                'Driver Options: network="host"\n\n' +
                "Nodes:\n" +
                `Name: ${builderName}0\n` +
                "Endpoint: desktop-linux\n" +
                "Status: running\n",
            }
          : { exitCode: 1, stderr: "", stdout: "" };
      }
      if (args[0] === "buildx" && args[1] === "create") {
        builderExists = true;
        return { exitCode: 0, stderr: "", stdout: `${builderName}\n` };
      }
      if (args[0] === "container" && args[1] === "inspect") {
        if (args.at(-1) === "{{json .HostConfig.NetworkMode}}") {
          return {
            exitCode: 0,
            stderr: "",
            stdout: '"host"\n',
          };
        }
        return {
          exitCode: 0,
          stderr: "",
          stdout: `${JSON.stringify([
            {
              Destination: "/var/lib/buildkit",
              Name: builderVolume,
              Type: "volume",
            },
          ])}\n`,
        };
      }
      if (args[0] === "volume" && args[1] === "inspect") {
        return {
          exitCode: 0,
          stderr: "",
          stdout: `${JSON.stringify(builderVolume)}\n`,
        };
      }
      if (args[0] === "buildx" && args[1] === "build") {
        expect(args.slice(0, 4)).toEqual([
          "buildx",
          "build",
          "--builder",
          builderName,
        ]);
        expect(args).not.toContain("persistently-selected-remote");
        return { exitCode: 0, stderr: "", stdout: "" };
      }
      throw new Error(`unexpected synthetic Docker command: ${args.join(" ")}`);
    };

    const ownership = await createOwnedLocalBuilder(
      docker,
      "desktop-linux",
      builderName,
    );
    await buildWithOwnedBuilder(docker, ownership, [
      "--file",
      "Dockerfile",
      "--push",
      "synthetic-source",
    ]);

    expect(ownership).toEqual({
      container: builderContainer,
      context: "desktop-linux",
      name: builderName,
      volume: builderVolume,
    });
    expect(commands).toContainEqual([
      "buildx",
      "create",
      "--name",
      builderName,
      "--driver",
      "docker-container",
      "--driver-opt",
      "network=host",
      "--bootstrap",
      "desktop-linux",
    ]);
    expect(commands).toContainEqual([
      "container",
      "inspect",
      builderContainer,
      "--format",
      "{{json .HostConfig.NetworkMode}}",
    ]);
    expect(
      commands.filter((args) => args[0] === "buildx" && args[1] === "build"),
    ).toHaveLength(1);
  });

  it("removes and audits only the exact task-owned builder container and cache volume", async () => {
    const ownership = {
      container: "buildx_buildkit_apollo-coolify-contract-run0",
      context: "desktop-linux",
      name: "apollo-coolify-contract-run",
      volume: "buildx_buildkit_apollo-coolify-contract-run0_state",
    };
    const commands: string[][] = [];
    let builderExists = true;
    const docker: DockerCommand = async (args, options) => {
      commands.push([...args]);
      if (args[0] === "buildx" && args[1] === "rm") {
        builderExists = false;
        return { exitCode: 0, stderr: "", stdout: "" };
      }
      if (args[0] === "buildx" && args[1] === "inspect") {
        return builderExists
          ? {
              exitCode: 0,
              stderr: "",
              stdout:
                `Name: ${ownership.name}\n` +
                "Driver: docker-container\n" +
                'Driver Options: network="host"\n\n' +
                "Nodes:\n" +
                `Name: ${ownership.name}0\n` +
                `Endpoint: ${ownership.context}\n` +
                "Status: running\n",
            }
          : { exitCode: 1, stderr: "", stdout: "" };
      }
      if (
        (args[0] === "container" || args[0] === "volume") &&
        args[1] === "inspect"
      ) {
        return builderExists
          ? { exitCode: 0, stderr: "", stdout: "{}\n" }
          : { exitCode: 1, stderr: "", stdout: "" };
      }
      if (options?.allowNonZero === true) {
        return { exitCode: 1, stderr: "", stdout: "" };
      }
      throw new Error(`unexpected synthetic Docker command: ${args.join(" ")}`);
    };

    await removeOwnedLocalBuilder(docker, ownership);
    await expect(auditOwnedLocalBuilder(docker, ownership)).resolves.toEqual({
      builders: 0,
      containers: 0,
      volumes: 0,
    });
    expect(commands).toContainEqual([
      "buildx",
      "rm",
      "--force",
      ownership.name,
    ]);
    expect(commands.some((args) => args.includes("prune"))).toBe(false);
    expect(
      commands.some((args) => args.includes("persistently-selected-remote")),
    ).toBe(false);
  });

  it("identifies log disclosures without returning the matched value", () => {
    expect(
      findSecretDisclosure("prefix synthetic-two suffix", [
        { id: "package", values: ["synthetic-one", "synthetic-two"] },
        { id: "flow", values: ["synthetic-three"] },
      ]),
    ).toBe("package-2");
  });

  it("fails the malformed admin proof when the container exits zero", async () => {
    const root = await mkdtemp(join(tmpdir(), "apollo-admin-exit-zero-"));
    const secrets = await prepareSecrets(root);
    const docker: DockerCommand = async (args) => {
      if (args[0] === "exec") {
        return {
          exitCode: 0,
          stderr: "",
          stdout: "root:nginx:640\n",
        };
      }
      if (args[0] === "inspect") {
        return {
          exitCode: 0,
          stderr: "",
          stdout: `${JSON.stringify({
            ExitCode: 0,
            Running: false,
            Status: "exited",
          })}\n`,
        };
      }
      return { exitCode: 0, stderr: "", stdout: "" };
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_input, init) =>
      new Response("", {
        status:
          new Headers(init?.headers).has("authorization") === true ? 200 : 401,
      });
    try {
      await expect(
        proveAdmin(
          docker,
          "example.invalid/admin@sha256:synthetic",
          secrets,
          root,
          "exit-zero",
        ),
      ).rejects.toThrow("malformed admin container unexpectedly exited 0");
    } finally {
      globalThis.fetch = originalFetch;
      await rm(root, { force: true, recursive: true });
    }
  });

  it("scans malformed admin stdout and stderr without disclosing matches", async () => {
    const root = await mkdtemp(join(tmpdir(), "apollo-admin-stderr-"));
    const secrets = await prepareSecrets(root);
    let canary = "";
    const docker: DockerCommand = async (args) => {
      if (args[0] === "run") {
        const mount = args.find((value) =>
          value.includes("admin_access_htpasswd"),
        );
        if (mount === undefined) throw new Error("htpasswd mount missing");
        const source = /source=([^,]+)/.exec(mount)?.[1];
        if (source === undefined) throw new Error("htpasswd source missing");
        canary = (await readFile(source, "utf8")).split(/\r?\n/, 1)[0];
        return { exitCode: 1, stderr: "", stdout: "" };
      }
      if (args[0] === "inspect") {
        return {
          exitCode: 0,
          stderr: "",
          stdout: `${JSON.stringify({
            ExitCode: 1,
            Running: false,
            Status: "exited",
          })}\n`,
        };
      }
      if (args[0] === "logs") {
        return {
          exitCode: 0,
          stderr: `rejected value ${canary}`,
          stdout: "",
        };
      }
      if (args[0] === "exec") {
        return {
          exitCode: 0,
          stderr: "",
          stdout: "root:nginx:640\n",
        };
      }
      return { exitCode: 0, stderr: "", stdout: "" };
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_input, init) =>
      new Response("", {
        status:
          new Headers(init?.headers).has("authorization") === true ? 200 : 401,
      });
    let error: unknown;
    try {
      await proveAdmin(
        docker,
        "example.invalid/admin@sha256:synthetic",
        secrets,
        root,
        "stderr",
      ).catch((caught) => {
        error = caught;
      });
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "malformed admin output disclosed [malformed-password-1]",
      );
      expect((error as Error).message).not.toContain(canary);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(root, { force: true, recursive: true });
    }
  });

  it.each([
    ["resource-acquisition", "acquireResources"],
    ["helper-startup", "startHelpers"],
    ["platform-compose-startup", "startPlatform"],
    ["tf-compose-startup", "startTf"],
    ["caddy-startup", "startCaddy"],
  ] as const)(
    "runs real exact cleanup after injected %s failure",
    async (stage, failureOperation) => {
      const state = createFakeSmokeDocker({
        composeDownFailures: new Set(["apollo-platform", "apollo-tf"]),
      });
      const fixedResourceOwnership = await assertFixedResourcesAbsent(
        state.docker,
      );
      let auditCalls = 0;
      let error: unknown;
      const operations = createInjectedLifecycleOperations(
        state,
        failureOperation,
      );

      await runProductionSmokeLifecycle({
        ...operations,
        audit: async () => {
          auditCalls += 1;
          return cleanupAudit(state.docker, state.runId, undefined, undefined);
        },
        cleanup: () =>
          cleanupOwnedSmokeResources({
            acquiredImages: new Map(),
            docker: state.docker,
            envFile: fileURLToPath(import.meta.url),
            fixedResourceOwnership,
            registry: undefined,
            runId: state.runId,
            temporaryRootParent: undefined,
          }),
      }).catch((caught) => {
        error = caught;
      });

      expect(error).toBeInstanceOf(AggregateError);
      expect(flattenErrorMessages(error)).toContain(
        `injected ${stage} failure`,
      );
      expect(flattenErrorMessages(error)).toContain(
        "injected apollo-platform down failure",
      );
      expect(flattenErrorMessages(error)).toContain(
        "injected apollo-tf down failure",
      );
      expect(auditCalls).toBe(1);
      await expect(
        cleanupAudit(state.docker, state.runId, undefined, undefined),
      ).resolves.toEqual({
        builderCacheVolumes: 0,
        builderContainers: 0,
        builderInstances: 0,
        containers: 0,
        imageReferences: 0,
        networks: 0,
        registryFiles: 0,
        temporarySecrets: 0,
        volumes: 0,
      });
      expect(state.networks.has(state.unrelatedNetwork)).toBe(true);
      for (const name of fixedNetworks) {
        expect(state.commands).toContainEqual(["network", "inspect", name]);
        expect(state.commands).toContainEqual(["network", "rm", name]);
      }
      for (const name of fixedVolumes) {
        expect(state.commands).toContainEqual(["volume", "inspect", name]);
        expect(state.commands).toContainEqual(["volume", "rm", "-f", name]);
      }
      expect(state.commands.some((args) => args.includes("prune"))).toBe(false);
    },
  );

  it("runs real exact cleanup for teardown failure", async () => {
    const state = createFakeSmokeDocker({
      composeDownFailures: new Set(["apollo-platform", "apollo-tf"]),
    });
    const fixedResourceOwnership = await assertFixedResourcesAbsent(
      state.docker,
    );
    const operations = createInjectedLifecycleOperations(state);
    let auditCalls = 0;
    let error: unknown;

    await runProductionSmokeLifecycle({
      ...operations,
      audit: async () => {
        auditCalls += 1;
        return cleanupAudit(state.docker, state.runId, undefined, undefined);
      },
      cleanup: () =>
        cleanupOwnedSmokeResources({
          acquiredImages: new Map(),
          docker: state.docker,
          envFile: fileURLToPath(import.meta.url),
          fixedResourceOwnership,
          registry: undefined,
          runId: state.runId,
          temporaryRootParent: undefined,
        }),
    }).catch((caught) => {
      error = caught;
    });

    expect(error).toBeInstanceOf(AggregateError);
    expect(flattenErrorMessages(error)).toContain(
      "injected apollo-platform down failure",
    );
    expect(flattenErrorMessages(error)).toContain(
      "injected apollo-tf down failure",
    );
    expect(auditCalls).toBe(1);
    await expect(
      cleanupAudit(state.docker, state.runId, undefined, undefined),
    ).resolves.toEqual({
      builderCacheVolumes: 0,
      builderContainers: 0,
      builderInstances: 0,
      containers: 0,
      imageReferences: 0,
      networks: 0,
      registryFiles: 0,
      temporarySecrets: 0,
      volumes: 0,
    });
    expect(state.networks.has(state.unrelatedNetwork)).toBe(true);
  });

  it("skips Compose teardown before the release environment is published", async () => {
    const state = createFakeSmokeDocker();
    await cleanupOwnedSmokeResources({
      acquiredImages: new Map(),
      docker: state.docker,
      envFile: join(
        tmpdir(),
        `apollo-missing-release-${randomBytes(8).toString("hex")}.env`,
      ),
      fixedResourceOwnership: { networks: [], volumes: [] },
      registry: undefined,
      runId: state.runId,
      temporaryRootParent: undefined,
    });

    expect(state.commands.some((args) => args[0] === "compose")).toBe(false);
  });

  it("rejects pre-existing fixed resources without removing them", async () => {
    const state = createFakeSmokeDocker();
    state.networks.set(fixedNetworks[0], new Set());

    await expect(assertFixedResourcesAbsent(state.docker)).rejects.toThrow(
      "production smoke fixed resource is already owned",
    );

    expect(state.networks.has(fixedNetworks[0])).toBe(true);
    expect(
      state.commands.some((args) => args[0] === "network" && args[1] === "rm"),
    ).toBe(false);
  });

  it("recovers a pending temporary root by its exact safe generated name", async () => {
    const temporaryRootParent = await mkdtemp(
      join(tmpdir(), "apollo-contract-parent-"),
    );
    const rootName = `${temporaryRootPrefix}${"1".repeat(32)}`;
    const root = join(temporaryRootParent, rootName);
    const recordPath = `${root}${temporaryRootRecordSuffix}`;
    const unrelated = join(
      temporaryRootParent,
      `${temporaryRootPrefix}${"f".repeat(32)}`,
    );
    try {
      await writeFile(
        recordPath,
        `${JSON.stringify({
          owner: temporaryRootOwner,
          rootName,
          state: "pending",
          version: 2,
        })}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      await mkdir(root);
      await mkdir(unrelated);

      await removeOwnedTemporaryRoots(temporaryRootParent);

      expect(await pathExists(root)).toBe(false);
      expect(await pathExists(recordPath)).toBe(false);
      expect(await pathExists(unrelated)).toBe(true);
    } finally {
      await rm(temporaryRootParent, { force: true, recursive: true });
    }
  });

  it("publishes an identity-bound active record before returning a temporary root", async () => {
    const temporaryRootParent = await mkdtemp(
      join(tmpdir(), "apollo-contract-parent-"),
    );
    const state = createFakeSmokeDocker();
    try {
      const root = await prepareOwnedTemporaryRoot(temporaryRootParent);
      const inventory = await ownedTemporaryRootInventory(temporaryRootParent);

      expect(inventory).toHaveLength(1);
      expect(inventory[0]).toMatchObject({
        root,
        state: "active",
      });
      expect(
        JSON.parse(await readFile(join(root, temporaryRootMarkerName), "utf8")),
      ).toMatchObject({
        state: "active",
        version: 2,
      });
      await expect(
        cleanupAudit(
          state.docker,
          state.runId,
          undefined,
          undefined,
          temporaryRootParent,
        ),
      ).resolves.toMatchObject({ temporarySecrets: 1 });

      await removeOwnedTemporaryRoots(temporaryRootParent);
      expect(await pathExists(root)).toBe(false);
      expect(await ownedTemporaryRootInventory(temporaryRootParent)).toEqual(
        [],
      );
    } finally {
      await rm(temporaryRootParent, { force: true, recursive: true });
    }
  });

  it("preserves an active root and ownership record when identity does not match", async () => {
    const temporaryRootParent = await mkdtemp(
      join(tmpdir(), "apollo-contract-parent-"),
    );
    const rootName = `${temporaryRootPrefix}${"2".repeat(32)}`;
    const root = join(temporaryRootParent, rootName);
    const recordPath = `${root}${temporaryRootRecordSuffix}`;
    try {
      await mkdir(root);
      const rootState = await lstat(root);
      await writeFile(
        recordPath,
        `${JSON.stringify({
          birthtimeMs: rootState.birthtimeMs + 1_000,
          dev: rootState.dev,
          ino: rootState.ino,
          owner: temporaryRootOwner,
          rootName,
          state: "active",
          version: 2,
        })}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );

      await expect(
        removeOwnedTemporaryRoots(temporaryRootParent),
      ).rejects.toThrow("temporary root identity no longer matches ownership");
      expect(await pathExists(root)).toBe(true);
      expect(await pathExists(recordPath)).toBe(true);
    } finally {
      await rm(temporaryRootParent, { force: true, recursive: true });
    }
  });

  it("reconciles multiple pending and active records without adopting a lookalike", async () => {
    const temporaryRootParent = await mkdtemp(
      join(tmpdir(), "apollo-contract-parent-"),
    );
    const pendingName = `${temporaryRootPrefix}${"3".repeat(32)}`;
    const pendingRoot = join(temporaryRootParent, pendingName);
    const pendingRecord = `${pendingRoot}${temporaryRootRecordSuffix}`;
    const activeName = `${temporaryRootPrefix}${"4".repeat(32)}`;
    const activeRoot = join(temporaryRootParent, activeName);
    const activeRecord = `${activeRoot}${temporaryRootRecordSuffix}`;
    const unrelated = join(
      temporaryRootParent,
      `${temporaryRootPrefix}${"e".repeat(32)}`,
    );
    const state = createFakeSmokeDocker();
    try {
      await mkdir(pendingRoot);
      await writeFile(
        pendingRecord,
        `${JSON.stringify({
          owner: temporaryRootOwner,
          rootName: pendingName,
          state: "pending",
          version: 2,
        })}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      await mkdir(activeRoot);
      const activeState = await lstat(activeRoot);
      await writeFile(
        activeRecord,
        `${JSON.stringify({
          birthtimeMs: activeState.birthtimeMs,
          dev: activeState.dev,
          ino: activeState.ino,
          owner: temporaryRootOwner,
          rootName: activeName,
          state: "active",
          version: 2,
        })}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      await mkdir(unrelated);

      await expect(
        cleanupAudit(
          state.docker,
          state.runId,
          undefined,
          undefined,
          temporaryRootParent,
        ),
      ).resolves.toMatchObject({ temporarySecrets: 2 });
      await removeOwnedTemporaryRoots(temporaryRootParent);

      expect(await pathExists(pendingRoot)).toBe(false);
      expect(await pathExists(pendingRecord)).toBe(false);
      expect(await pathExists(activeRoot)).toBe(false);
      expect(await pathExists(activeRecord)).toBe(false);
      expect(await pathExists(unrelated)).toBe(true);
    } finally {
      await rm(temporaryRootParent, { force: true, recursive: true });
    }
  });

  it("audits a known current root even when its ownership record is missing", async () => {
    const temporaryRootParent = await mkdtemp(
      join(tmpdir(), "apollo-contract-parent-"),
    );
    const root = join(
      temporaryRootParent,
      `${temporaryRootPrefix}${"5".repeat(32)}`,
    );
    const state = createFakeSmokeDocker();
    try {
      await mkdir(root);

      await expect(
        cleanupAudit(
          state.docker,
          state.runId,
          undefined,
          root,
          temporaryRootParent,
        ),
      ).resolves.toMatchObject({ temporarySecrets: 1 });
    } finally {
      await rm(temporaryRootParent, { force: true, recursive: true });
    }
  });

  it("recovers a pending temporary root on sequential retry without adopting unrelated state", async () => {
    const temporaryRootParent = await mkdtemp(
      join(tmpdir(), "apollo-contract-parent-"),
    );
    const unrelated = join(
      temporaryRootParent,
      "apollo-coolify-production-unrelated",
    );
    await mkdir(unrelated);
    const state = createFakeSmokeDocker();
    const fixedResourceOwnership = await assertFixedResourcesAbsent(
      state.docker,
    );
    const noOp = async () => {};
    let firstRoot: string | undefined;
    let firstPendingRecord: Record<string, unknown> | undefined;
    let firstError: unknown;
    try {
      await runProductionSmokeLifecycle({
        acquireResources: async () => {
          await prepareOwnedTemporaryRoot(temporaryRootParent, {
            afterRootCreationBeforeActiveRecord: async ({
              recordPath,
              root,
            }) => {
              firstRoot = root;
              firstPendingRecord = JSON.parse(
                await readFile(recordPath, "utf8"),
              ) as Record<string, unknown>;
              throw new Error("injected pre-active publication failure");
            },
            removeOwnedRoots: async () => {
              throw new Error("injected preparation cleanup failure");
            },
          });
        },
        audit: () =>
          cleanupAudit(
            state.docker,
            state.runId,
            undefined,
            undefined,
            temporaryRootParent,
          ),
        cleanup: () =>
          cleanupOwnedSmokeResources({
            acquiredImages: new Map(),
            docker: state.docker,
            envFile: undefined,
            fixedResourceOwnership,
            registry: undefined,
            removeTemporaryRoots: async () => {
              throw new Error("injected temporary-root cleanup failure");
            },
            runId: state.runId,
            temporaryRootParent,
          }),
        runApplicationFlows: noOp,
        startCaddy: noOp,
        startHelpers: noOp,
        startPlatform: noOp,
        startTf: noOp,
      }).catch((caught) => {
        firstError = caught;
      });

      expect(flattenErrorMessages(firstError)).toContain(
        "injected pre-active publication failure",
      );
      expect(flattenErrorMessages(firstError)).toContain(
        "injected preparation cleanup failure",
      );
      expect(flattenErrorMessages(firstError)).toContain(
        "injected temporary-root cleanup failure",
      );
      expect(flattenErrorMessages(firstError)).toContain(
        "production smoke cleanup audit was nonzero",
      );
      expect(firstRoot).toBeDefined();
      expect(firstPendingRecord).toEqual({
        owner: temporaryRootOwner,
        rootName: basename(firstRoot as string),
        state: "pending",
        version: 2,
      });
      await expect(
        cleanupAudit(
          state.docker,
          state.runId,
          undefined,
          firstRoot,
          temporaryRootParent,
        ),
      ).resolves.toMatchObject({ temporarySecrets: 1 });

      let secondRoot: string | undefined;
      await expect(
        runProductionSmokeLifecycle({
          acquireResources: async () => {
            secondRoot = await prepareOwnedTemporaryRoot(temporaryRootParent);
          },
          audit: () =>
            cleanupAudit(
              state.docker,
              state.runId,
              undefined,
              undefined,
              temporaryRootParent,
            ),
          cleanup: () =>
            cleanupOwnedSmokeResources({
              acquiredImages: new Map(),
              docker: state.docker,
              envFile: undefined,
              fixedResourceOwnership,
              registry: undefined,
              runId: state.runId,
              temporaryRootParent,
            }),
          runApplicationFlows: noOp,
          startCaddy: noOp,
          startHelpers: noOp,
          startPlatform: noOp,
          startTf: noOp,
        }),
      ).resolves.toMatchObject({
        audit: {
          builderCacheVolumes: 0,
          builderContainers: 0,
          builderInstances: 0,
          containers: 0,
          imageReferences: 0,
          networks: 0,
          registryFiles: 0,
          temporarySecrets: 0,
          volumes: 0,
        },
      });

      expect(await pathExists(firstRoot as string)).toBe(false);
      expect(await pathExists(secondRoot as string)).toBe(false);
      expect(await pathExists(unrelated)).toBe(true);
      expect(await pathExists(temporaryRootParent)).toBe(true);
    } finally {
      await rm(temporaryRootParent, { force: true, recursive: true });
    }
  });

  it("audits the union of run and both Compose project labels", async () => {
    const filters: string[] = [];
    const docker: DockerCommand = async (args) => {
      const filter = args.at(-1) ?? "";
      filters.push(filter);
      const stdout = filter.includes("local-release")
        ? "helper\nshared\n"
        : filter.includes("apollo-platform")
          ? "platform\nshared\n"
          : "tf\n";
      return { exitCode: 0, stderr: "", stdout };
    };

    const ids = await containerIdsForLabels(docker, [
      "apollo.local-release.run=synthetic",
      "com.docker.compose.project=apollo-platform",
      "com.docker.compose.project=apollo-tf",
    ]);

    expect(new Set(ids)).toEqual(
      new Set(["helper", "shared", "platform", "tf"]),
    );
    expect(filters).toEqual([
      "label=apollo.local-release.run=synthetic",
      "label=com.docker.compose.project=apollo-platform",
      "label=com.docker.compose.project=apollo-tf",
    ]);
  });

  it("removes only exact task-registry tags or digests without pruning", async () => {
    const commands: readonly string[][] = [];
    let removed = false;
    const docker: DockerCommand = async (args) => {
      (commands as string[][]).push([...args]);
      if (args[0] === "image" && args[1] === "ls") {
        return { exitCode: 0, stderr: "", stdout: "sha256:image-one\n" };
      }
      if (args[0] === "image" && args[1] === "inspect") {
        return {
          exitCode: 0,
          stderr: "",
          stdout: removed
            ? "null\nnull\n"
            : `${JSON.stringify(["localhost:62000/redis:source"])}\n${JSON.stringify(
                ["localhost:62000/redis@sha256:digest"],
              )}\n`,
        };
      }
      if (args[0] === "image" && args[1] === "rm") {
        expect(args).toEqual([
          "image",
          "rm",
          "-f",
          "localhost:62000/redis:source",
        ]);
        removed = true;
        return { exitCode: 0, stderr: "", stdout: "" };
      }
      throw new Error("unexpected Docker command");
    };

    await removeExactRegistryReferences(docker, "localhost:62000");

    expect(commands.some((args) => args.includes("prune"))).toBe(false);
    expect(removed).toBe(true);
  });

  it("uses the real Platform-to-TF authorization bridge", () => {
    expect(exercisePlatform.toString()).toContain("/v1/sessions");
    expect(exerciseTf.toString()).toContain("bridgeTfSession");
    expect(exerciseTf.toString()).not.toContain("seedTfSession");
  });

  it("proves restored granted search and exact heartbeat staleness recovery", () => {
    const source = exerciseTf.toString();

    expect(source).toContain("restored granted search");
    expect(source).toMatch(/\[\s*"stop",\s*"tf-integrations"\s*\]/);
    expect(source).toContain(
      'modules.get("account-integrations") === "unknown"',
    );
    expect(source).toMatch(
      /\[\s*"up",\s*"-d",\s*"--no-deps",\s*"tf-integrations"\s*\]/,
    );
    expect(source).toContain(
      'modules.get("account-integrations") === "healthy"',
    );
    expect(source).toContain("heartbeatStaleDeadlineMs");
    expect(source).toContain(
      "Date.now() - heartbeatStoppedAt > heartbeatStaleDeadlineMs",
    );
  });

  it("executes both baseline-profile one-shot services against disposable state", () => {
    const source = runCoolifyProductionSmoke.toString();

    expect(source).toContain("proveProfiledEntrypoints");
    expect(source).toContain('stage = "profiled-entrypoints"');
  });

  it("runs the native-Linux shared-token proof before any profiled or production containers", () => {
    const source = runCoolifyProductionSmoke.toString();
    const nativeProof = source.indexOf(
      'stage = "native-linux-admin-token-ownership"',
    );
    const profiledProof = source.indexOf('stage = "profiled-entrypoints"');

    expect(nativeProof).toBeGreaterThan(-1);
    expect(profiledProof).toBeGreaterThan(nativeProof);
    expect(source).toContain("proveNativeLinuxAdminTokenOwnership");
  });

  it("uses a disposable native filesystem and the deployable proof contract", () => {
    const source = proveNativeLinuxAdminTokenOwnership.toString();

    expect(source).toContain('"--privileged"');
    expect(source).toContain('"--tmpfs"');
    expect(source).toContain('"/var/lib/docker:');
    expect(source).toContain("network");
    expect(source).toContain("container:${registryContainer}");
    expect(source).toContain("prove-admin-token-ownership.sh");
    expect(source).toContain("admin_dashboard_token");
    expect(source).toContain("chown 10001:10001");
    expect(source).not.toContain('["volume", "create"');
    expect(source).not.toContain("apollo-tf-postgres-v1");
  });

  it("starts the route forwarder through a shell entrypoint", () => {
    const source = proveCaddyRoutes.toString();

    expect(source).toMatch(/"--entrypoint",\s*"sh"/);
  });

  it("forwards Caddy through the package networks without host listeners", () => {
    const source = proveCaddyRoutes.toString();

    expect(source).toContain('[18200, "platform-api", 8080]');
    expect(source).toContain('[18201, "tf-api", 8080]');
    expect(source).toContain('[18202, "tf-web", 80]');
    expect(source).toContain('[18203, "tf-admin", 80]');
    expect(source).toContain("TCP:${host}:${targetPort}");
    expect(source).toContain("apollo-platform-bridge-v1");
    expect(source).toContain("apollo-tf-edge-v1");
    expect(source).not.toContain("host.docker.internal");
  });

  it("probes Caddy with route hostnames in TLS SNI", () => {
    const source = proveCaddyRoutes.toString();

    for (const host of [
      "api.apollot.ru",
      "api.tf.apollot.ru",
      "tf.apollot.ru",
      "admin.apollot.ru",
    ]) {
      expect(source).toContain(`${host}:127.0.0.1`);
    }
    expect(source).toContain("https://${request.host}${request.path}");
    expect(source).toContain('"apollo-platform-platform-api-1"');
    expect(source).toContain('require("node:https")');
    expect(source).not.toContain("wget --no-check-certificate");
    expect(source).toContain("verifyCaddyRouteMatrix(requestRoute)");
    expect(source).not.toContain("https://127.0.0.1");
  });

  it("terminates the private admin authorization input without logging it", () => {
    const source = proveCaddyRoutes.toString();

    expect(source).toMatch(/input:\s*`\$\{authorization\}\n`/);
  });

  it("derives one protected credential generation for both nginx and Caddy", async () => {
    const root = await mkdtemp(join(tmpdir(), "apollo-caddy-generation-"));
    const passwordHash = `$2a$12$${"A".repeat(53)}`;
    const calls: {
      readonly args: readonly string[];
      readonly input: string | undefined;
    }[] = [];
    try {
      const secrets = await prepareSecrets(root);
      const docker: DockerCommand = async (args, options) => {
        calls.push({ args: [...args], input: options?.input });
        return { exitCode: 0, stderr: "", stdout: `${passwordHash}\n` };
      };

      await prepareAdminCredentialGeneration(docker, secrets, "contract-run");

      expect(
        await readFile(
          join(secrets.adminCredentialDirectory, "admin_access_htpasswd"),
          "utf8",
        ),
      ).toBe(`${secrets.adminUser}:${passwordHash}`);
      expect(await readFile(secrets.caddyEnvironmentPath, "utf8")).toBe(
        `APOLLO_ADMIN_CADDY_USER='${secrets.adminUser}'\n` +
          `APOLLO_ADMIN_CADDY_PASSWORD_HASH='${passwordHash}'\n`,
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].args).toContain("hash-password");
      expect(calls[0].input).toBe(`${secrets.adminPassword}\n`);
      expect(calls[0].args.join(" ")).not.toContain(secrets.adminUser);
      expect(calls[0].args.join(" ")).not.toContain(secrets.adminPassword);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("makes the live Caddy proof consume the credential generation without rehashing", () => {
    const source = proveCaddyRoutes.toString();

    expect(source).toContain("secrets.caddyEnvironmentPath");
    expect(source).toContain("/run/secrets/apollo-caddy.env");
    expect(source).toContain(". /run/secrets/apollo-caddy.env");
    expect(source).toMatch(/"--entrypoint",\s*"\/bin\/sh"/);
    expect(source).not.toContain('"--env-file"');
    expect(source).not.toContain('"password hash"');
    expect(source).not.toContain('"hash-password"');
  });

  it("requires all four Caddy routes in unauthenticated, wrong-auth, and authenticated states with every security header", async () => {
    const calls: {
      authorization: "approved" | "none" | "wrong";
      host: string;
      path: string;
    }[] = [];
    await verifyCaddyRouteMatrix(async (request) => {
      calls.push(request);
      const rejected =
        request.host === "admin.apollot.ru" &&
        request.authorization !== "approved";
      return {
        body: rejected ? "" : "ok\n",
        headers: {
          "referrer-policy": "no-referrer",
          "strict-transport-security": "max-age=31536000; includeSubDomains",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
        },
        status: rejected ? 401 : 200,
      };
    });

    expect(calls).toEqual(
      ["none", "wrong", "approved"].flatMap((authorization) =>
        [
          ["api.apollot.ru", "/healthz"],
          ["api.tf.apollot.ru", "/api/healthz"],
          ["tf.apollot.ru", "/healthz"],
          ["admin.apollot.ru", "/healthz"],
        ].map(([host, path]) => ({ authorization, host, path })),
      ),
    );
  });

  it("fails the Caddy matrix when any required response header is absent", async () => {
    await expect(
      verifyCaddyRouteMatrix(async (request) => ({
        body:
          request.host === "admin.apollot.ru" &&
          request.authorization !== "approved"
            ? ""
            : "ok\n",
        headers: {
          "referrer-policy": "no-referrer",
          "strict-transport-security": "max-age=31536000; includeSubDomains",
          "x-content-type-options": "nosniff",
        },
        status:
          request.host === "admin.apollot.ru" &&
          request.authorization !== "approved"
            ? 401
            : 200,
      })),
    ).rejects.toThrow("Caddy security header contract failed");
  });

  it("records digest-qualified local image references for exact cleanup", () => {
    const source = runCoolifyProductionSmoke.toString();

    expect(source).toContain(
      "localReferences.push(`${registry}/${target.image}@${digest}`)",
    );
    expect(source).toContain(
      "localReferences.push(`${registry}/redis@${digests.redis}`)",
    );
  });

  it("removes network-sharing helpers before Compose resources", () => {
    const cleanupSource = cleanupOwnedSmokeResources.toString();
    const helperRemoval = cleanupSource.indexOf(
      'options.docker(["rm", "-f", container])',
    );
    const tfTeardown = cleanupSource.indexOf("tfCompose");
    const platformTeardown = cleanupSource.indexOf("platformCompose");

    expect(helperRemoval).toBeGreaterThan(-1);
    expect(helperRemoval).toBeLessThan(tfTeardown);
    expect(helperRemoval).toBeLessThan(platformTeardown);
  });

  it("builds every custom production target from one source commit", () => {
    expect(productionTargets).toEqual([
      {
        dockerfile: "artifacts/platform-api/Dockerfile",
        image: "platform-api",
        target: "runtime",
      },
      {
        dockerfile: "artifacts/platform-api/Dockerfile",
        image: "platform-postgres",
        target: "postgres-role-init",
      },
      {
        dockerfile: "artifacts/api-server/Dockerfile",
        image: "tf-api",
        target: "runner",
      },
      {
        dockerfile: "artifacts/api-server/Dockerfile",
        image: "tf-postgres",
        target: "postgres-role-init",
      },
      {
        dockerfile: "artifacts/music-player/Dockerfile",
        image: "tf-web",
        target: "runner",
      },
      {
        dockerfile: "artifacts/admin-dashboard/Dockerfile",
        image: "tf-admin",
        target: "default",
      },
      {
        dockerfile: "artifacts/tf-search/Dockerfile",
        image: "tf-search",
        target: "runner",
      },
      {
        dockerfile: "artifacts/tf-integrations/Dockerfile",
        image: "tf-integrations",
        target: "runner",
      },
      {
        dockerfile: "artifacts/tf-integrations/Dockerfile",
        image: "tf-integrations-postgres",
        target: "postgres-role-init",
      },
      {
        dockerfile: "artifacts/tf-download-worker/Dockerfile",
        image: "tf-download-worker",
        target: "runner",
      },
      {
        dockerfile: "artifacts/tf-download-worker/Dockerfile",
        image: "tf-download-redis",
        target: "queue-redis",
      },
    ]);
  });

  it("writes source provenance and invokes only the explicit loopback validator mode", () => {
    expect(writeReleaseEnvironment.toString()).toContain(
      'values.set("RELEASE_SOURCE_COMMIT", sourceCommit)',
    );
    const smokeSource = runCoolifyProductionSmoke.toString();
    expect(smokeSource).toContain('"--mode"');
    expect(smokeSource).toContain('"loopback-local-smoke"');
    expect(smokeSource).not.toContain('"--release-manifest"');
  });
});

describe.runIf(process.env.APOLLO_RUN_COOLIFY_PRODUCTION_SMOKE === "1")(
  "Coolify exact production package",
  () => {
    it(
      "builds, starts, exercises, persists, routes, and cleans the package",
      async () => {
        await expect(runCoolifyProductionSmoke()).resolves.toMatchObject({
          cleanup: {
            builderCacheVolumes: 0,
            builderContainers: 0,
            builderInstances: 0,
            containers: 0,
            imageReferences: 0,
            networks: 0,
            registryFiles: 0,
            temporarySecrets: 0,
            volumes: 0,
          },
        });
      },
      60 * 60_000,
    );
  },
);
