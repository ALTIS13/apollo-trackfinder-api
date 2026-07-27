import { execFile, spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

const execute = promisify(execFile);
const artifactRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(artifactRoot, "../..");
const rootComposePath = path.join(repositoryRoot, "docker-compose.yml");
const smokeEntrypoint = path.join(
  artifactRoot,
  "scripts/start-smoke-worker.sh",
);
const ADMIN_TOKEN = "task-7-download-smoke-admin";
const WEB_ORIGIN_HOST = "127.0.0.1";
const OUTER_TEST_TIMEOUT_MS = 25 * 60_000;
const SETUP_TIMEOUT_MS = 30_000;
const RUN_TIMEOUT_MS = 18 * 60_000;
const CLEANUP_REMOVAL_RESERVE_MS = 4 * 60_000;
const CLEANUP_AUDIT_RESERVE_MS = 60_000;
const CLEANUP_RESERVE_MS =
  CLEANUP_REMOVAL_RESERVE_MS + CLEANUP_AUDIT_RESERVE_MS;
const SAFETY_MARGIN_MS = 60_000;
const DEFAULT_DOCKER_TIMEOUT_MS = 30_000;
const BUILD_DOCKER_TIMEOUT_MS = 12 * 60_000;
const START_DOCKER_TIMEOUT_MS = 6 * 60_000;
const FILESYSTEM_REMOVAL_TIMEOUT_MS = 30_000;
const FILESYSTEM_AUDIT_TIMEOUT_MS = 5_000;
const TRACKED_FILE_TIMEOUT_MS = 5_000;
const TEMPORARY_DIRECTORY_TERMINATION_GRACE_MS = 100;
const CREATE_TEMPORARY_DIRECTORY_SCRIPT =
  'require("node:fs").mkdirSync(process.argv[1], { mode: 0o700 })';

interface BoundedFetchOptions {
  readonly fetchImplementation?: typeof fetch;
  readonly timeoutMs?: number;
}

interface WaitUntilOptions {
  readonly intervalMs?: number;
  readonly probeTimeoutMs?: number;
  readonly timeoutMs?: number;
}

async function boundedOperation<T>(
  name: string,
  operation: () => Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(`${name} deadline exceeded`);
  }

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`${name} deadline exceeded`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([Promise.resolve().then(operation), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function boundedFetch(
  input: string | URL | Request,
  init: RequestInit = {},
  options: BoundedFetchOptions = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 5_000;
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const callerSignal = init.signal;
  const abortFromCaller = (): void => controller.abort(callerSignal?.reason);

  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });

  try {
    return await boundedOperation(
      "fetch",
      () =>
        fetchImplementation(input, {
          ...init,
          signal: controller.signal,
        }),
      timeoutMs,
      () => controller.abort(new Error("fetch deadline exceeded")),
    );
  } finally {
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

async function waitUntil<T>(
  name: string,
  probe: () => Promise<T | false>,
  options: WaitUntilOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const probeTimeoutMs = options.probeTimeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    try {
      const value = await boundedOperation(
        `${name} probe`,
        probe,
        Math.max(1, Math.min(probeTimeoutMs, remainingMs)),
      );
      if (value !== false) return value;
    } catch (error) {
      lastError = error;
    }

    const sleepMs = Math.min(intervalMs, Math.max(0, deadline - Date.now()));
    if (sleepMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, sleepMs));
    }
  }

  throw new Error(
    `${name} deadline exceeded${
      lastError instanceof Error ? `: ${lastError.name}` : ""
    }`,
  );
}

interface SmokeSecurityPhases {
  readonly cleanup: () => Promise<void>;
  readonly exercisedCanaries: () => Promise<void>;
  readonly ownershipProvisioning: () => Promise<void>;
  readonly productionFixtureRejection: () => Promise<void>;
  readonly queueUnreadablePasswordFailure: () => Promise<void>;
  readonly queueUrlMismatch: () => Promise<void>;
  readonly queueWeakPasswordFailure: () => Promise<void>;
}

interface TrackedFileScanDependencies {
  readonly deadlineAt: number;
  readonly readTrackedFile: (filePath: string) => Promise<Buffer>;
  readonly runGit: (args: readonly string[]) => Promise<DockerResult>;
}

interface CleanupDependencies {
  readonly directoryExists: (directory: string) => Promise<boolean>;
  readonly removeDirectory: (directory: string) => Promise<void>;
  readonly runDocker: (
    args: readonly string[],
    timeoutMs: number,
  ) => Promise<DockerResult>;
}

interface CleanupOptions {
  readonly auditDeadlineAt: number;
  readonly composeFiles: readonly string[];
  readonly dependencies: CleanupDependencies;
  readonly project: string;
  readonly removalDeadlineAt: number;
  readonly temporaryDirectory?: string;
}

type ComposeCommand = (args: readonly string[]) => Promise<DockerResult>;

function redactSmokeText(value: string, canaries: readonly string[]): string {
  return [...new Set(canaries)]
    .filter((canary) => canary.length > 0)
    .sort((left, right) => right.length - left.length)
    .reduce(
      (redacted, canary) => redacted.replaceAll(canary, "[REDACTED]"),
      value,
    );
}

function errorSurface(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const commandError = error as Error & {
    readonly cause?: unknown;
    readonly errors?: readonly unknown[];
    readonly stderr?: string;
    readonly stdout?: string;
  };
  return [
    commandError.message,
    commandError.stdout ?? "",
    commandError.stderr ?? "",
    ...(commandError.cause === undefined
      ? []
      : [errorSurface(commandError.cause)]),
    ...(commandError.errors ?? []).map(errorSurface),
  ]
    .filter(Boolean)
    .join("\n");
}

function createRedactedSmokeError(
  primaryError: unknown,
  logs: string,
  canaries: readonly string[],
): Error {
  const detail = redactSmokeText(
    [errorSurface(primaryError), logs].filter(Boolean).join("\n"),
    canaries,
  );
  return new Error(
    `TF download Docker smoke failed${
      detail.length === 0 ? "" : `: ${detail.slice(-8_000)}`
    }`,
  );
}

async function runSmokeLifecycle<T>(
  run: () => Promise<T>,
  cleanup: () => Promise<void>,
): Promise<T> {
  let primaryError: unknown;
  let result: T | undefined;
  try {
    result = await run();
  } catch (error) {
    primaryError = error;
  }
  try {
    await cleanup();
  } catch (error) {
    primaryError =
      primaryError === undefined
        ? error
        : new AggregateError([primaryError, error], "smoke lifecycle failed");
  }
  if (primaryError !== undefined) throw primaryError;
  return result as T;
}

async function runSmokeSetup<T>(dependencies: {
  readonly cleanup: () => Promise<void>;
  readonly createTemporaryDirectory: (
    directory: string,
    timeoutMs: number,
  ) => Promise<void>;
  readonly now?: () => number;
  readonly reservePort: (timeoutMs: number) => Promise<number>;
  readonly run: (temporaryDirectory: string, port: number) => Promise<T>;
  readonly setupTimeoutMs?: number;
  readonly temporaryDirectory: string;
}): Promise<T> {
  const now = dependencies.now ?? Date.now;
  const setupDeadlineAt =
    now() + (dependencies.setupTimeoutMs ?? SETUP_TIMEOUT_MS);
  return runSmokeLifecycle(async () => {
    await dependencies.createTemporaryDirectory(
      dependencies.temporaryDirectory,
      deadlineCallTimeout(
        "smoke setup",
        setupDeadlineAt,
        SETUP_TIMEOUT_MS,
        now,
      ),
    );
    const port = await dependencies.reservePort(
      deadlineCallTimeout(
        "smoke setup",
        setupDeadlineAt,
        SETUP_TIMEOUT_MS,
        now,
      ),
    );
    return dependencies.run(dependencies.temporaryDirectory, port);
  }, dependencies.cleanup);
}

async function runSmokeSecurityOrchestrator(
  phases: SmokeSecurityPhases,
): Promise<void> {
  await runSmokeLifecycle(async () => {
    await phases.productionFixtureRejection();
    await phases.ownershipProvisioning();
    await phases.queueWeakPasswordFailure();
    await phases.queueUnreadablePasswordFailure();
    await phases.queueUrlMismatch();
    await phases.exercisedCanaries();
  }, phases.cleanup);
}

function cleanupCallTimeout(
  deadlineAt: number,
  capMs: number,
  now: () => number = Date.now,
): number {
  return deadlineCallTimeout("smoke cleanup", deadlineAt, capMs, now);
}

function deadlineCallTimeout(
  name: string,
  deadlineAt: number,
  capMs: number,
  now: () => number = Date.now,
): number {
  const remainingMs = deadlineAt - now();
  if (remainingMs < 1) throw new Error(`${name} deadline exceeded`);
  return Math.min(remainingMs, capMs);
}

async function queryFailedReason(
  compose: ComposeCommand,
  jobId: string,
): Promise<string> {
  const key = `{apollo-tf-downloads}:apollo-tf-downloads-v1:${jobId}`;
  const output = await compose([
    "exec",
    "-T",
    "tf-download-redis",
    "sh",
    "-ceu",
    'password=$(sed -n "1p" /run/secrets/tf_download_queue_password); REDISCLI_AUTH="$password" exec redis-cli --no-auth-warning --raw HGET "$1" failedReason',
    "query-failed-reason",
    key,
  ]);
  return output.stdout.trim();
}

async function scanTrackedFilesForCanaries(
  canaries: readonly string[],
  dependencies: TrackedFileScanDependencies,
): Promise<void> {
  const listed = await boundedOperation(
    "tracked file listing",
    () => dependencies.runGit(["ls-files", "-z"]),
    deadlineCallTimeout(
      "tracked file scan",
      dependencies.deadlineAt,
      TRACKED_FILE_TIMEOUT_MS,
    ),
  );
  const trackedFiles = listed.stdout.split("\0").filter(Boolean);
  const encodedCanaries = canaries.map((canary) => Buffer.from(canary));

  for (const filePath of trackedFiles) {
    const content = await boundedOperation(
      "tracked file read",
      () => dependencies.readTrackedFile(filePath),
      deadlineCallTimeout(
        "tracked file scan",
        dependencies.deadlineAt,
        TRACKED_FILE_TIMEOUT_MS,
      ),
    );
    if (encodedCanaries.some((canary) => content.includes(canary))) {
      throw new Error("tracked file exposed a smoke canary");
    }
  }
}

function splitIds(output: string): readonly string[] {
  return output.split(/\r?\n/).filter(Boolean);
}

async function cleanupSmokeResources(
  options: CleanupOptions,
): Promise<SmokeResult["cleanup"]> {
  const { dependencies, project } = options;
  const run = async (
    args: readonly string[],
    deadlineAt: number,
    capMs = 30_000,
  ): Promise<DockerResult> =>
    dependencies.runDocker(args, cleanupCallTimeout(deadlineAt, capMs));
  const composeArgs = [
    "compose",
    ...options.composeFiles.flatMap((file) => ["-f", file]),
    "-p",
    project,
    "down",
    "--remove-orphans",
    "--volumes",
    "--rmi",
    "local",
  ];
  const cleanupErrors: unknown[] = [];

  if (options.composeFiles.length > 0) {
    await run(composeArgs, options.removalDeadlineAt, 90_000).catch(
      () => undefined,
    );
  }

  type OwnedResources = {
    readonly containers: readonly string[];
    readonly images: readonly string[];
    readonly networks: readonly string[];
    readonly volumes: readonly string[];
  };
  const noOwnedResources = (): OwnedResources => ({
    containers: [],
    images: [],
    networks: [],
    volumes: [],
  });
  const listOwned = async (deadlineAt: number): Promise<OwnedResources> => {
    const label = `label=com.docker.compose.project=${project}`;
    const [
      labeledContainers,
      namedContainers,
      images,
      labeledNetworks,
      namedNetworks,
      labeledVolumes,
      composeVolumes,
      helperVolumes,
    ] = await Promise.all([
      run(["ps", "-aq", "--filter", label], deadlineAt),
      run(["ps", "-aq", "--filter", `name=^${project}[-_]`], deadlineAt),
      run(["images", "-q", "--filter", `reference=${project}-*`], deadlineAt),
      run(["network", "ls", "-q", "--filter", label], deadlineAt),
      run(["network", "ls", "-q", "--filter", `name=^${project}_`], deadlineAt),
      run(["volume", "ls", "-q", "--filter", label], deadlineAt),
      run(["volume", "ls", "-q", "--filter", `name=^${project}_`], deadlineAt),
      run(["volume", "ls", "-q", "--filter", `name=^${project}-`], deadlineAt),
    ]);
    const unique = (
      ...values: readonly (readonly string[])[]
    ): readonly string[] => [...new Set(values.flat())];
    return {
      containers: unique(
        splitIds(labeledContainers.stdout),
        splitIds(namedContainers.stdout),
      ),
      images: unique(splitIds(images.stdout)),
      networks: unique(
        splitIds(labeledNetworks.stdout),
        splitIds(namedNetworks.stdout),
      ),
      volumes: unique(
        splitIds(labeledVolumes.stdout),
        splitIds(composeVolumes.stdout),
        splitIds(helperVolumes.stdout),
      ),
    };
  };

  const owned = await listOwned(options.removalDeadlineAt).catch((error) => {
    cleanupErrors.push(error);
    return noOwnedResources();
  });
  for (const [resource, ids] of Object.entries(owned)) {
    if (ids.length === 0) continue;
    const args =
      resource === "containers"
        ? ["rm", "-f", ...ids]
        : resource === "images"
          ? ["image", "rm", "-f", ...ids]
          : resource === "networks"
            ? ["network", "rm", ...ids]
            : ["volume", "rm", "-f", ...ids];
    await run(args, options.removalDeadlineAt, 60_000).catch((error) => {
      cleanupErrors.push(error);
    });
  }

  if (options.temporaryDirectory !== undefined) {
    try {
      await boundedOperation(
        "temporary directory removal",
        () => dependencies.removeDirectory(options.temporaryDirectory!),
        cleanupCallTimeout(
          options.removalDeadlineAt,
          FILESYSTEM_REMOVAL_TIMEOUT_MS,
        ),
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  const residue = await listOwned(options.auditDeadlineAt).catch((error) => {
    cleanupErrors.push(error);
    return noOwnedResources();
  });
  let temporaryDirectoryExists = false;
  if (options.temporaryDirectory !== undefined) {
    try {
      temporaryDirectoryExists = await boundedOperation(
        "temporary directory audit",
        () => dependencies.directoryExists(options.temporaryDirectory!),
        cleanupCallTimeout(
          options.auditDeadlineAt,
          FILESYSTEM_AUDIT_TIMEOUT_MS,
        ),
      );
    } catch (error) {
      cleanupErrors.push(error);
      temporaryDirectoryExists = true;
    }
  }

  const cleanup = {
    containers: residue.containers.length,
    images: residue.images.length,
    networks: residue.networks.length,
    temporaryDirectories: temporaryDirectoryExists ? 1 : 0,
    volumes: residue.volumes.length,
  };
  if (
    cleanupErrors.length > 0 ||
    Object.values(cleanup).some((value) => value !== 0)
  ) {
    throw new AggregateError(cleanupErrors, "TF download smoke cleanup failed");
  }
  return cleanup;
}

function shellPath(value: string): string {
  if (process.platform !== "win32") return value;
  const match = /^([A-Za-z]):\\(.*)$/.exec(value);
  if (match === null) return value.replaceAll("\\", "/");
  return `/${match[1]!.toLowerCase()}/${match[2]!.replaceAll("\\", "/")}`;
}

interface SmokeResult {
  readonly project: string;
  readonly observations: {
    readonly productionFlagRejected: boolean;
    readonly productionImageFixtureFree: boolean;
    readonly secretOwnershipEvidence:
      | "docker-desktop-functional"
      | "native-linux";
    readonly queueWeakPasswordRejected: boolean;
    readonly queueUnreadablePasswordRejected: boolean;
    readonly queueUrlMismatchRejected: boolean;
    readonly rawSignatureRejected: boolean;
    readonly pathCanarySanitized: boolean;
    readonly stderrCanaryFailureBounded: boolean;
    readonly apiHealthy: boolean;
    readonly queueHealthy: boolean;
    readonly workerHealthy: boolean;
    readonly heartbeatHealthy: boolean;
    readonly heartbeatUnknownAfterReset: boolean;
    readonly heartbeatRecovered: boolean;
    readonly completedOwnedFixture: boolean;
    readonly authenticatedBytes: boolean;
    readonly statusAndProgress: boolean;
    readonly fullFile: boolean;
    readonly exactRange: boolean;
    readonly replayRejected: boolean;
    readonly tamperRejected: boolean;
    readonly wrongKeyRejected: boolean;
    readonly foreignOwnerRejected: boolean;
    readonly waitingCancellationClean: boolean;
    readonly activeCancellationClean: boolean;
    readonly sizeFailureBounded: boolean;
    readonly deadlineFailureBounded: boolean;
    readonly quotaFailureBounded: boolean;
    readonly noForbiddenInspectSurface: boolean;
    readonly canarySurfacesScanned: number;
    readonly noPublishedWorkerOrQueuePorts: boolean;
  };
  readonly cleanup: {
    readonly containers: number;
    readonly images: number;
    readonly networks: number;
    readonly temporaryDirectories: number;
    readonly volumes: number;
  };
}

interface DockerResult {
  readonly stdout: string;
  readonly stderr: string;
}

interface DockerInputInvocation {
  readonly args: readonly string[];
  readonly input: string;
  readonly spawnChild?: typeof spawn;
}

interface TemporaryDirectoryCreationOptions {
  readonly nodeScript?: string;
  readonly spawnChild?: typeof spawn;
}

interface SessionFixture {
  readonly accountId: string;
  readonly csrf: string;
  readonly handle: string;
}

function generatedSecret(): string {
  return randomBytes(32).toString("base64url");
}

function createSmokeCanaryBundle() {
  const pathMarker = Array.from(randomBytes(16), (value) =>
    value.toString(2).padStart(8, "0"),
  )
    .join("")
    .replaceAll("0", "/")
    .replaceAll("1", "\\");
  const values = {
    queuePassword: generatedSecret(),
    commandSecret: generatedSecret(),
    heartbeatSecret: generatedSecret(),
    searchSecret: generatedSecret(),
    integrationsSecret: generatedSecret(),
    searchHeartbeatSecret: generatedSecret(),
    integrationsHeartbeatSecret: generatedSecret(),
    clientSecret: generatedSecret(),
    databasePassword: generatedSecret(),
    sourceCanary: `source-${generatedSecret()}`,
    accountCanary: randomUUID(),
    signatureCanary: `signature-${generatedSecret()}`,
    pathCanary: `../${pathMarker}/..\\`,
    stderrCanary: `stderr-${generatedSecret()}`,
    wrongKeyCanary: `wrong-key-${generatedSecret()}`,
    wrongQueuePassword: generatedSecret(),
    weakQueuePassword: `weak-${randomBytes(4).toString("hex")}`,
    unreadableQueuePassword: generatedSecret(),
    ownerSessionHandle: generatedSecret(),
    ownerSessionCsrf: generatedSecret(),
    ownerSessionRevision: generatedSecret(),
    foreignSessionHandle: generatedSecret(),
    foreignSessionCsrf: generatedSecret(),
    foreignSessionRevision: generatedSecret(),
  } as const;

  return {
    values,
    canaries: Object.values(values),
    heartbeatKeys: {
      "search-media": values.searchHeartbeatSecret,
      "account-integrations": values.integrationsHeartbeatSecret,
      "download-worker": values.heartbeatSecret,
    },
    sessions: {
      owner: {
        handle: values.ownerSessionHandle,
        csrf: values.ownerSessionCsrf,
        revision: values.ownerSessionRevision,
      },
      foreign: {
        handle: values.foreignSessionHandle,
        csrf: values.foreignSessionCsrf,
        revision: values.foreignSessionRevision,
      },
    },
  } as const;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function reapTemporaryStagingDirectory(directory: string): Promise<void> {
  const deadlineAt =
    Date.now() + FILESYSTEM_REMOVAL_TIMEOUT_MS + FILESYSTEM_AUDIT_TIMEOUT_MS;
  await boundedOperation(
    "temporary staging directory removal",
    () => rm(directory, { force: true, recursive: true }),
    deadlineCallTimeout(
      "temporary staging directory removal",
      deadlineAt,
      FILESYSTEM_REMOVAL_TIMEOUT_MS,
    ),
  );
  const exists = await boundedOperation(
    "temporary staging directory audit",
    () =>
      stat(directory).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      ),
    deadlineCallTimeout(
      "temporary staging directory audit",
      deadlineAt,
      FILESYSTEM_AUDIT_TIMEOUT_MS,
    ),
  );
  if (exists) throw new Error("temporary staging directory residue detected");
}

async function createTemporaryDirectoryTerminal(
  directory: string,
  timeoutMs: number,
  options: TemporaryDirectoryCreationOptions = {},
): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("temporary directory creation deadline exceeded");
  }

  const deadlineAt = Date.now() + timeoutMs;
  const stagingDirectory = `${directory}.staging-${randomUUID()}`;
  await new Promise<void>((resolve, reject) => {
    const running = (options.spawnChild ?? spawn)(
      process.execPath,
      [
        "-e",
        options.nodeScript ?? CREATE_TEMPORARY_DIRECTORY_SCRIPT,
        stagingDirectory,
      ],
      {
        cwd: repositoryRoot,
        stdio: "ignore",
        windowsHide: true,
      },
    );
    type TerminalFailure =
      | { readonly kind: "child"; readonly error: Error }
      | { readonly kind: "deadline" };
    let state: "closing" | "running" | "settled" | "terminating" = "running";
    let terminalFailure: TerminalFailure | undefined;
    let terminationError: Error | undefined;
    let deadlineTimer: NodeJS.Timeout | undefined;
    let terminationTimer: NodeJS.Timeout | undefined;

    const removeListeners = (): void => {
      running.removeListener("error", onError);
      running.removeListener("close", onClose);
    };
    const removeTerminalGuard = (): void => {
      running.removeListener("error", onTerminalError);
      running.removeListener("close", onTerminalClose);
    };
    const installTerminalGuard = (): void => {
      // EventEmitter throws an unhandled "error"; guard it until close confirms
      // that this child can no longer emit lifecycle errors.
      running.on("error", onTerminalError);
      running.once("close", onTerminalClose);
      running.unref?.();
    };
    const settle = (error?: Error, terminationConfirmed = true): void => {
      if (state === "settled") return;
      state = "settled";
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      if (terminationTimer !== undefined) clearTimeout(terminationTimer);
      removeListeners();
      if (!terminationConfirmed) installTerminalGuard();
      if (error === undefined) resolve();
      else reject(error);
    };
    const settleAfterStagingReap = async (error: Error): Promise<void> => {
      try {
        await reapTemporaryStagingDirectory(stagingDirectory);
        settle(error);
      } catch (reaperError) {
        settle(new AggregateError([error, reaperError], error.message));
      }
    };
    const publishStagingDirectory = async (): Promise<void> => {
      try {
        await boundedOperation(
          "temporary directory publish",
          () => rename(stagingDirectory, directory),
          deadlineCallTimeout(
            "temporary directory creation",
            deadlineAt,
            FILESYSTEM_REMOVAL_TIMEOUT_MS,
          ),
        );
        settle();
      } catch (error) {
        const publishError = Object.assign(
          new Error("temporary directory creation failed"),
          { cause: error },
        );
        await settleAfterStagingReap(publishError);
      }
    };
    const failureError = (terminationConfirmed: boolean): Error => {
      const baseMessage =
        terminalFailure?.kind === "deadline"
          ? "temporary directory creation deadline exceeded"
          : "temporary directory creation failed";
      const message = terminationConfirmed
        ? baseMessage
        : `${baseMessage}; child termination could not be confirmed`;
      const causes = [
        terminalFailure?.kind === "child" ? terminalFailure.error : undefined,
        terminationError,
      ].filter((error): error is Error => error !== undefined);
      return causes.length === 0
        ? new Error(message)
        : Object.assign(new Error(message), {
            cause:
              causes.length === 1
                ? causes[0]
                : new AggregateError(causes, message),
          });
    };
    const beginTermination = (failure: TerminalFailure): void => {
      if (state !== "running") return;
      state = "terminating";
      terminalFailure = failure;
      terminationTimer = setTimeout(() => {
        settle(failureError(false), false);
      }, TEMPORARY_DIRECTORY_TERMINATION_GRACE_MS);

      try {
        if (!running.kill("SIGKILL")) {
          terminationError = new Error(
            "child process rejected the SIGKILL request",
          );
        }
      } catch (error) {
        terminationError =
          error instanceof Error ? error : new Error(String(error));
      }
    };
    function onTerminalError(): void {
      // The primary Promise is already settled with the unconfirmed state.
    }
    function onTerminalClose(): void {
      removeTerminalGuard();
      void reapTemporaryStagingDirectory(stagingDirectory).catch(
        () => undefined,
      );
    }
    function onError(error: Error): void {
      if (state === "running") {
        beginTermination({ error, kind: "child" });
      } else if (state === "terminating") {
        terminationError ??= error;
      }
    }
    function onClose(code: number | null): void {
      if (state === "settled") return;
      const wasTerminating = state === "terminating";
      state = "closing";
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      if (terminationTimer !== undefined) clearTimeout(terminationTimer);
      removeListeners();
      if (wasTerminating) {
        void settleAfterStagingReap(failureError(true));
      } else if (code !== 0) {
        void settleAfterStagingReap(
          Object.assign(new Error("temporary directory creation failed"), {
            code,
          }),
        );
      } else {
        void publishStagingDirectory();
      }
    }

    running.once("error", onError);
    running.once("close", onClose);
    deadlineTimer = setTimeout(() => {
      beginTermination({ kind: "deadline" });
    }, timeoutMs);
  });
}

async function reservePort(timeoutMs = 5_000): Promise<number> {
  const server = createServer();
  const forceClose = (): void => {
    try {
      server.close();
    } catch {
      // The server may time out before listen transitions to a closable state.
    }
  };
  const close = async (): Promise<void> => {
    if (!server.listening) return;
    await boundedOperation(
      "port reservation close",
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) =>
            error === undefined ? resolve() : reject(error),
          );
        }),
      2_000,
      forceClose,
    );
  };

  return boundedOperation(
    "port reservation",
    async () => {
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, WEB_ORIGIN_HOST, resolve);
        });
        const address = server.address();
        if (address === null || typeof address === "string") {
          throw new Error("Could not reserve smoke API port");
        }
        return address.port;
      } finally {
        await close();
      }
    },
    Math.min(5_000, timeoutMs),
    forceClose,
  );
}

async function docker(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  timeout = DEFAULT_DOCKER_TIMEOUT_MS,
): Promise<DockerResult> {
  return boundedOperation(
    "docker command",
    () =>
      execute("docker", [...args], {
        cwd: repositoryRoot,
        env: environment,
        maxBuffer: 16 * 1024 * 1024,
        timeout,
        windowsHide: true,
      }),
    timeout,
  );
}

async function dockerWithInput(
  invocation: DockerInputInvocation,
  environment: NodeJS.ProcessEnv,
  timeout = DEFAULT_DOCKER_TIMEOUT_MS,
): Promise<DockerResult> {
  if (!Number.isSafeInteger(timeout) || timeout < 1) {
    throw new Error("docker command deadline exceeded");
  }

  return new Promise<DockerResult>((resolve, reject) => {
    const running = (invocation.spawnChild ?? spawn)(
      "docker",
      [...invocation.args],
      {
        cwd: repositoryRoot,
        env: environment,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const { stdin, stdout: output, stderr: errorOutput } = running;
    if (stdin === null || output === null || errorOutput === null) {
      running.kill();
      reject(new Error("docker command pipes unavailable"));
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let closed = false;
    let inputCompleted = false;
    let outputBytes = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const removeListeners = (): void => {
      running.removeListener("error", onChildError);
      running.removeListener("close", onClose);
      stdin.removeListener("error", onInputError);
      output.removeListener("data", onStdout);
      errorOutput.removeListener("data", onStderr);
    };
    const stopChild = (): void => {
      try {
        running.kill();
      } catch {
        // Cleanup will remove any project-owned resource left by Docker.
      }
    };
    const finish = (
      error: unknown | undefined,
      result?: DockerResult,
      terminate = error !== undefined && !closed,
    ): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (terminate) stopChild();
      stdin.destroy();
      removeListeners();
      if (error === undefined && result !== undefined) resolve(result);
      else reject(error);
    };
    const result = (): DockerResult => ({
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    });
    const inputError = (cause: unknown): Error =>
      Object.assign(new Error("docker command input failed"), { cause });
    const append = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > 16 * 1024 * 1024) {
        finish(new Error("docker command output limit exceeded"));
        return;
      }
      target.push(chunk);
    };
    const onStdout = (chunk: Buffer): void => append(stdout, chunk);
    const onStderr = (chunk: Buffer): void => append(stderr, chunk);
    function onChildError(error: Error): void {
      finish(error);
    }
    function onInputError(error: Error): void {
      finish(inputError(error));
    }
    function onClose(code: number | null): void {
      closed = true;
      if (code !== 0) {
        finish(
          Object.assign(new Error("docker command failed"), {
            code,
            ...result(),
          }),
          undefined,
          false,
        );
      } else if (!inputCompleted) {
        finish(
          new Error("docker command closed before input completed"),
          undefined,
          false,
        );
      } else {
        finish(undefined, result(), false);
      }
    }
    const onInputComplete = (error?: Error | null): void => {
      if (error !== undefined && error !== null) {
        finish(inputError(error));
        return;
      }
      inputCompleted = true;
    };

    output.on("data", onStdout);
    errorOutput.on("data", onStderr);
    running.once("error", onChildError);
    running.once("close", onClose);
    stdin.once("error", onInputError);
    timer = setTimeout(
      () => finish(new Error("docker command deadline exceeded")),
      timeout,
    );
    stdin.end(invocation.input, onInputComplete as () => void);
  });
}

function assertCondition(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function waitFor<T>(
  name: string,
  probe: () => Promise<T | false>,
  timeoutMs = 60_000,
): Promise<T> {
  return waitUntil(name, probe, {
    probeTimeoutMs: 5_000,
    timeoutMs,
  });
}

async function fetchJson(
  url: string,
  init: RequestInit = {},
): Promise<{
  readonly response: Response;
  readonly body: Record<string, unknown> | null;
  readonly text: string;
}> {
  const response = await boundedFetch(url, { redirect: "error", ...init });
  const text = await boundedOperation(
    "fetch body",
    () => response.text(),
    5_000,
  );
  let body: Record<string, unknown> | null = null;
  try {
    body =
      text.length === 0 ? null : (JSON.parse(text) as Record<string, unknown>);
  } catch {
    body = null;
  }
  return { response, body, text };
}

function sessionHeaders(
  session: SessionFixture,
  origin: string,
  mutation = false,
): Record<string, string> {
  return {
    cookie:
      `__Host-apollo_tf=${session.handle}; ` +
      `__Host-apollo_tf_csrf=${session.csrf}`,
    ...(mutation ? { origin, "x-csrf-token": session.csrf } : {}),
  };
}

function trackIdFor(
  mode: string,
  sourceCanary: string,
  pathCanary: string,
  stderrCanary: string,
): string {
  const url =
    `https://youtube.com/watch?v=fixture-${mode}` +
    `&mode=${mode}&source=${sourceCanary}` +
    `&path=${pathCanary}&stderr=${stderrCanary}`;
  return `yt_${Buffer.from(url).toString("base64url")}`;
}

function signedProbeInvocation(
  composeBase: readonly string[],
  source: string,
  values: Readonly<Record<string, string>>,
): DockerInputInvocation {
  return {
    args: [
      ...composeBase,
      "exec",
      "-T",
      "tf-download-worker",
      "node",
      "-e",
      source,
    ],
    input: JSON.stringify(values),
  };
}

async function runDisposableSmoke(): Promise<SmokeResult> {
  const project =
    `apollo-tf-download-smoke-${process.pid}-` + randomBytes(4).toString("hex");
  const temporaryDirectory = path.join(
    tmpdir(),
    `${project}-${randomBytes(8).toString("hex")}`,
  );
  let port: number | undefined;
  let cleanupResult: SmokeResult["cleanup"] | undefined;
  let smokeResult: SmokeResult | undefined;
  let redactors: readonly string[] = [];
  let cleanupPromise: Promise<SmokeResult["cleanup"]> | undefined;
  let cleanupStartedAt: number | undefined;

  const cleanup = async (): Promise<void> => {
    cleanupStartedAt ??= Date.now();
    const removalDeadlineAt = cleanupStartedAt + CLEANUP_REMOVAL_RESERVE_MS;
    const auditDeadlineAt = removalDeadlineAt + CLEANUP_AUDIT_RESERVE_MS;
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      TF_SECRET_DIRECTORY: path.join(temporaryDirectory, "secrets"),
      ...(port === undefined ? {} : { TF_API_PORT: String(port) }),
      TF_DOWNLOAD_REDIS_IMAGE: `${project}-redis:local`,
      TF_DOWNLOAD_WORKER_IMAGE: `${project}-worker:local`,
      ADMIN_DASHBOARD_TOKEN: ADMIN_TOKEN,
    };
    cleanupPromise ??= cleanupSmokeResources({
      auditDeadlineAt,
      composeFiles: [
        rootComposePath,
        path.join(temporaryDirectory, "smoke.compose.yml"),
      ],
      dependencies: {
        directoryExists: (directory) =>
          stat(directory).then(
            () => true,
            () => false,
          ),
        removeDirectory: (directory) =>
          rm(directory, { force: true, recursive: true }),
        runDocker: (args, timeoutMs) => docker(args, environment, timeoutMs),
      },
      project,
      removalDeadlineAt,
      temporaryDirectory,
    });
    cleanupResult = await cleanupPromise;
  };

  try {
    await runSmokeSetup({
      cleanup,
      createTemporaryDirectory: createTemporaryDirectoryTerminal,
      reservePort: async (timeoutMs) => {
        port = await reservePort(timeoutMs);
        return port;
      },
      run: async (directory, reservedPort) => {
        smokeResult = await runPreparedDisposableSmoke(
          project,
          directory,
          reservedPort,
          (values) => {
            redactors = values;
          },
          cleanup,
        );
      },
      temporaryDirectory,
    });
  } catch (error) {
    throw createRedactedSmokeError(error, "", redactors);
  }

  assertCondition(smokeResult !== undefined, "smoke result missing");
  assertCondition(cleanupResult !== undefined, "smoke cleanup result missing");
  return { ...smokeResult, cleanup: cleanupResult };
}

async function runPreparedDisposableSmoke(
  project: string,
  temporaryDirectory: string,
  port: number,
  registerRedactors: (values: readonly string[]) => void,
  cleanup: () => Promise<void>,
): Promise<SmokeResult> {
  const operationDeadline = Date.now() + RUN_TIMEOUT_MS;
  const secretDirectory = path.join(temporaryDirectory, "secrets");
  const overridePath = path.join(temporaryDirectory, "smoke.compose.yml");
  const origin = `http://${WEB_ORIGIN_HOST}:${port}`;
  const canaryBundle = createSmokeCanaryBundle();
  const {
    queuePassword,
    commandSecret,
    heartbeatSecret,
    searchSecret,
    integrationsSecret,
    clientSecret,
    databasePassword,
    sourceCanary,
    accountCanary,
    signatureCanary,
    pathCanary,
    stderrCanary,
    wrongKeyCanary,
    wrongQueuePassword,
    weakQueuePassword,
    unreadableQueuePassword,
  } = canaryBundle.values;
  const canaries = canaryBundle.canaries;
  registerRedactors(canaries);
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    TF_SECRET_DIRECTORY: secretDirectory,
    TF_API_PORT: String(port),
    TF_DOWNLOAD_REDIS_IMAGE: `${project}-redis:local`,
    TF_DOWNLOAD_WORKER_IMAGE: `${project}-worker:local`,
    ADMIN_DASHBOARD_TOKEN: ADMIN_TOKEN,
  };
  const composeBase = [
    "compose",
    "-f",
    rootComposePath,
    "-f",
    overridePath,
    "-p",
    project,
  ] as const;
  const boundedTimeout = (requestedMs: number): number => {
    const remainingMs = operationDeadline - Date.now();
    if (remainingMs < 1) {
      throw new Error("smoke operation deadline exceeded");
    }
    return Math.min(requestedMs, remainingMs);
  };
  const dockerWithin = (
    args: readonly string[],
    timeout = DEFAULT_DOCKER_TIMEOUT_MS,
  ): Promise<DockerResult> =>
    docker(args, environment, boundedTimeout(timeout));
  const compose = (
    args: readonly string[],
    timeout = DEFAULT_DOCKER_TIMEOUT_MS,
  ): Promise<DockerResult> => dockerWithin([...composeBase, ...args], timeout);
  const composeWithInput = (
    args: readonly string[],
    input: string,
    timeout = DEFAULT_DOCKER_TIMEOUT_MS,
  ): Promise<DockerResult> =>
    dockerWithInput(
      { args: [...composeBase, ...args], input },
      environment,
      boundedTimeout(timeout),
    );
  const finalWorkerImage = `${project}-worker-final:local`;
  const probeVolumes = [
    `${project}-weak-password`,
    `${project}-unreadable-password`,
  ];
  const responseSurfaces: string[] = [];
  const failureSurfaces: string[] = [];
  let logs = "";
  let primaryError: unknown;
  let result: SmokeResult | undefined;
  let secrets: Record<string, string> = {};

  const expectGenericDockerFailure = async (
    args: readonly string[],
    genericMessage: string,
    timeoutMs = DEFAULT_DOCKER_TIMEOUT_MS,
  ): Promise<string> => {
    try {
      await dockerWithin(args, timeoutMs);
    } catch (error) {
      const failure = error as Error & {
        readonly code?: number | string;
        readonly stderr?: string;
        readonly stdout?: string;
      };
      const output = `${failure.stdout ?? ""}\n${failure.stderr ?? ""}`.trim();
      assertCondition(
        failure.code !== undefined && failure.code !== 0,
        "negative Docker probe did not report a nonzero exit",
      );
      assertCondition(
        output === genericMessage,
        "negative Docker probe was not generic",
      );
      for (const canary of canaries) {
        assertCondition(
          !output.includes(canary),
          "negative Docker probe exposed a canary",
        );
      }
      failureSurfaces.push(output);
      return output;
    }
    throw new Error("negative Docker probe unexpectedly succeeded");
  };

  const provisionNativeSecretOwnership = async (): Promise<
    "docker-desktop-functional" | "native-linux"
  > => {
    if (process.platform !== "linux") return "docker-desktop-functional";

    const security = await dockerWithin([
      "info",
      "--format",
      "{{json .SecurityOptions}}",
    ]);
    assertCondition(
      !security.stdout.toLowerCase().includes("rootless"),
      "native Linux smoke requires rootful Docker UID ownership",
    );
    await dockerWithin([
      "run",
      "--rm",
      "--name",
      `${project}-secret-owner`,
      "--label",
      `com.docker.compose.project=${project}`,
      "--mount",
      `type=bind,src=${secretDirectory},dst=/secrets`,
      "--user",
      "0:0",
      "node:20-bookworm-slim",
      "sh",
      "-ceu",
      "chmod 0400 /secrets/*; chown 10001:10001 /secrets/*; chown 999:999 /secrets/tf_postgres_password /secrets/tf_download_queue_password",
    ]);

    const redisOwned = new Set([
      "tf_postgres_password",
      "tf_download_queue_password",
    ]);
    for (const name of Object.keys(secrets)) {
      const metadata = await stat(path.join(secretDirectory, name));
      const expectedOwner = redisOwned.has(name) ? 999 : 10001;
      assertCondition(
        metadata.uid === expectedOwner && metadata.gid === expectedOwner,
        "native Linux secret owner mismatch",
      );
      assertCondition(
        (metadata.mode & 0o777) === 0o400,
        "native Linux secret mode mismatch",
      );
    }
    return "native-linux";
  };

  const replaceQueueUrl = async (password: string): Promise<void> => {
    const filePath = path.join(secretDirectory, "tf_download_queue_redis_url");
    await rm(filePath, { force: true });
    await writeFile(
      filePath,
      `redis://default:${encodeURIComponent(password)}@tf-download-redis:6379/0`,
      { encoding: "utf8", mode: 0o400 },
    );
    if (process.platform !== "win32") await chmod(filePath, 0o400);
    await provisionNativeSecretOwnership();
  };

  const proveProductionFixtureRejection = async (): Promise<{
    readonly fixtureFree: boolean;
    readonly rejected: boolean;
  }> => {
    await dockerWithin(
      [
        "build",
        "--file",
        path.join(artifactRoot, "Dockerfile"),
        "--target",
        "final",
        "--tag",
        finalWorkerImage,
        repositoryRoot,
      ],
      BUILD_DOCKER_TIMEOUT_MS,
    );
    await dockerWithin([
      "run",
      "--rm",
      "--name",
      `${project}-final-surface`,
      "--label",
      `com.docker.compose.project=${project}`,
      "--entrypoint",
      "/bin/sh",
      finalWorkerImage,
      "-ceu",
      'test ! -e /app/bin/start-smoke-worker.sh; test ! -e /app/bin/smoke-downloader.sh; test ! -e /app/bin/smoke-deadline.mjs; test -z "${NODE_OPTIONS+x}"',
    ]);
    await expectGenericDockerFailure(
      [
        "run",
        "--rm",
        "--name",
        `${project}-production-flag`,
        "--label",
        `com.docker.compose.project=${project}`,
        "--env",
        "TF_DOWNLOAD_SMOKE_FIXTURES=true",
        finalWorkerImage,
      ],
      "TF download worker startup failed",
    );
    return { fixtureFree: true, rejected: true };
  };

  const passwordProbes = {
    unreadable: {
      mode: "0000",
      name: "unreadable",
      owner: "0:0",
      value: unreadableQueuePassword,
      volume: probeVolumes[1]!,
    },
    weak: {
      mode: "0400",
      name: "weak",
      owner: "999:999",
      value: weakQueuePassword,
      volume: probeVolumes[0]!,
    },
  } as const;
  const proveQueuePasswordFailure = async (
    probe: (typeof passwordProbes)[keyof typeof passwordProbes],
  ): Promise<boolean> => {
    const inputName = `${probe.name}-password`;
    await writeFile(path.join(temporaryDirectory, inputName), probe.value, {
      encoding: "utf8",
      mode: 0o600,
    });
    await dockerWithin([
      "volume",
      "create",
      "--label",
      `com.docker.compose.project=${project}`,
      probe.volume,
    ]);
    await dockerWithin([
      "run",
      "--rm",
      "--name",
      `${project}-${probe.name}-password-owner`,
      "--label",
      `com.docker.compose.project=${project}`,
      "--mount",
      `type=bind,src=${temporaryDirectory},dst=/input,readonly`,
      "--mount",
      `type=volume,src=${probe.volume},dst=/secret`,
      "--user",
      "0:0",
      "node:20-bookworm-slim",
      "sh",
      "-ceu",
      `cp /input/${inputName} /secret/password; chown ${probe.owner} /secret/password; chmod ${probe.mode} /secret/password`,
    ]);
    await expectGenericDockerFailure(
      [
        "run",
        "--rm",
        "--name",
        `${project}-${probe.name}-password`,
        "--label",
        `com.docker.compose.project=${project}`,
        "--env",
        "TF_DOWNLOAD_QUEUE_PASSWORD_FILE=/run/secrets/password",
        "--mount",
        `type=volume,src=${probe.volume},dst=/run/secrets,readonly`,
        `${project}-redis:local`,
      ],
      "TF download queue startup failed",
    );
    return true;
  };

  const proveQueueUrlMismatch = async (): Promise<boolean> => {
    await replaceQueueUrl(wrongQueuePassword);
    await compose(
      [
        "up",
        "-d",
        "--no-build",
        "--wait",
        "--wait-timeout",
        "180",
        "db",
        "redis",
        "tf-download-redis",
        "platform-api",
      ],
      START_DOCKER_TIMEOUT_MS,
    );
    await compose(
      ["up", "-d", "--no-build", "--no-deps", "tf-download-worker"],
      60_000,
    );
    await compose(["up", "-d", "--no-build", "--no-deps", "api"], 60_000);

    const workerFailure = await waitFor(
      "mismatched worker startup",
      async () => {
        const output = await compose([
          "logs",
          "--no-color",
          "tf-download-worker",
        ]);
        return output.stdout.includes("TF download worker startup failed")
          ? output.stdout
          : false;
      },
      30_000,
    );
    const apiFailure = await waitFor(
      "mismatched API startup",
      async () => {
        const output = await compose(["logs", "--no-color", "api"]);
        return output.stdout.includes("TF API startup failed")
          ? output.stdout
          : false;
      },
      30_000,
    );
    for (const surface of [workerFailure, apiFailure]) {
      assertCondition(
        !surface.includes(wrongQueuePassword),
        "queue mismatch failure exposed its password",
      );
    }
    failureSurfaces.push(workerFailure, apiFailure);

    await compose(
      ["rm", "-sf", "tf-download-worker", "api"],
      DEFAULT_DOCKER_TIMEOUT_MS,
    );
    await replaceQueueUrl(queuePassword);
    return true;
  };

  try {
    await mkdir(secretDirectory, { recursive: true, mode: 0o700 });
    secrets = {
      tf_postgres_password: databasePassword,
      tf_database_url:
        `postgres://trackfinder:${encodeURIComponent(databasePassword)}` +
        "@db:5432/trackfinder",
      tf_client_secret: clientSecret,
      tf_search_internal_auth_secret: searchSecret,
      tf_integrations_internal_auth_secret: integrationsSecret,
      tf_download_queue_password: queuePassword,
      tf_download_queue_redis_url:
        `redis://default:${encodeURIComponent(queuePassword)}` +
        "@tf-download-redis:6379/0",
      tf_download_internal_auth_secret: commandSecret,
      tf_download_heartbeat_secret: heartbeatSecret,
      tf_module_heartbeat_keys: JSON.stringify(canaryBundle.heartbeatKeys),
    };
    for (const [name, value] of Object.entries(secrets)) {
      const filePath = path.join(secretDirectory, name);
      await writeFile(filePath, value, { encoding: "utf8", mode: 0o400 });
      if (process.platform !== "win32") await chmod(filePath, 0o400);
    }
    if (process.platform !== "win32") await chmod(secretDirectory, 0o700);

    await writeFile(
      overridePath,
      [
        "services:",
        "  api:",
        "    environment:",
        `      ADMIN_DASHBOARD_TOKEN: ${ADMIN_TOKEN}`,
        "      NODE_ENV: development",
        "      APOLLO_PLATFORM_API_ORIGIN: http://platform-api:8080",
        `      APOLLO_PLATFORM_ISSUER: ${origin}`,
        '      APOLLO_TF_BRIDGE_ALLOW_INTERNAL_HTTP: "true"',
        `      APOLLO_TF_CALLBACK_URL: ${origin}/api/auth/callback`,
        `      APOLLO_TF_WEB_ORIGIN: ${origin}`,
        `      SERVER_URL: ${origin}`,
        "    depends_on:",
        "      tf-integrations: !reset null",
        "      tf-search: !reset null",
        "      platform-api:",
        "        condition: service_started",
        "  platform-api:",
        "    image: node:20-bookworm-slim",
        "    command:",
        "      - node",
        "      - -e",
        "      - >-",
        "        const http=require('node:http');",
        "        http.createServer((req,res)=>{",
        "        if(req.method!=='POST'||req.url!=='/v1/oauth/introspect'){res.writeHead(404).end();return}",
        "        const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{try{",
        "        const body=JSON.parse(Buffer.concat(chunks));",
        "        const out=JSON.stringify({active:true,accountId:body.accountId,sessionId:body.sessionId,installationId:body.installationId,accountStatus:'active',entitlements:['tf.downloads'],expiresAt:new Date(Date.now()+1800000).toISOString()});",
        "        res.writeHead(200,{'content-type':'application/json','content-length':Buffer.byteLength(out)});res.end(out)",
        "        }catch{res.writeHead(400).end()}})}).listen(8080,'0.0.0.0')",
        "    init: true",
        "    read_only: true",
        "    tmpfs:",
        "      - /tmp:rw,noexec,nosuid,size=16m",
        "    networks:",
        "      - tf-edge",
        "    security_opt:",
        "      - no-new-privileges:true",
        "    cap_drop:",
        "      - ALL",
        "    pids_limit: 64",
        "  tf-download-worker:",
        "    build:",
        "      target: smoke-runtime",
        "    environment:",
        "      NODE_ENV: test",
        '      TF_DOWNLOAD_SMOKE_FIXTURES: "true"',
        '      TF_DOWNLOAD_MAX_FILE_BYTES: "1024"',
        '      TF_DOWNLOAD_STORAGE_QUOTA_BYTES: "1536"',
        '      TF_DOWNLOAD_SWEEP_INTERVAL_MS: "1000"',
        "",
      ].join("\n"),
      "utf8",
    );

    const rendered = await compose(["config"]);
    for (const canary of canaries) {
      assertCondition(
        !`${rendered.stdout}\n${rendered.stderr}`.includes(canary),
        "rendered Compose exposed a canary",
      );
    }

    await compose(
      ["build", "tf-download-redis", "tf-download-worker", "api"],
      BUILD_DOCKER_TIMEOUT_MS,
    );
    let productionFixture = { fixtureFree: false, rejected: false };
    let secretOwnershipEvidence: "docker-desktop-functional" | "native-linux" =
      "docker-desktop-functional";
    let queueWeakPasswordRejected = false;
    let queueUnreadablePasswordRejected = false;
    let queueUrlMismatchRejected = false;

    const exerciseCanaries = async (): Promise<void> => {
      await compose(
        [
          "up",
          "-d",
          "--no-build",
          "--wait",
          "--wait-timeout",
          "300",
          "db",
          "redis",
          "tf-download-redis",
          "tf-download-worker",
          "platform-api",
          "api",
        ],
        START_DOCKER_TIMEOUT_MS,
      );

      const inspectIds = (
        await compose([
          "ps",
          "-q",
          "api",
          "tf-download-redis",
          "tf-download-worker",
        ])
      ).stdout
        .split(/\r?\n/)
        .filter(Boolean);
      assertCondition(
        inspectIds.length === 3,
        "smoke services were not created",
      );
      const inspection = (await docker(["inspect", ...inspectIds], environment))
        .stdout;
      const inspected = JSON.parse(inspection) as Array<{
        readonly Config?: {
          readonly Env?: readonly string[];
          readonly Labels?: Record<string, string>;
        };
        readonly HostConfig?: {
          readonly Binds?: readonly string[] | null;
          readonly PortBindings?: Record<string, unknown>;
        };
        readonly Mounts?: readonly {
          readonly Destination?: string;
          readonly Source?: string;
        }[];
        readonly NetworkSettings?: {
          readonly Networks?: Record<string, unknown>;
        };
        readonly State?: {
          readonly Health?: { readonly Status?: string };
        };
      }>;
      const byService = new Map(
        inspected.map((container) => [
          container.Config?.Labels?.["com.docker.compose.service"],
          container,
        ]),
      );
      const queueHealthy =
        byService.get("tf-download-redis")?.State?.Health?.Status === "healthy";
      const workerHealthy =
        byService.get("tf-download-worker")?.State?.Health?.Status ===
        "healthy";
      const noPublishedWorkerOrQueuePorts = [
        "tf-download-redis",
        "tf-download-worker",
      ].every(
        (name) =>
          Object.keys(byService.get(name)?.HostConfig?.PortBindings ?? {})
            .length === 0,
      );
      assertCondition(queueHealthy, "queue Redis was not healthy");
      assertCondition(workerHealthy, "worker was not healthy");

      const apiHealthy = await waitFor("TF API health", async () => {
        const response = await boundedFetch(`${origin}/api/readyz`);
        return response.ok;
      });

      const dashboardModule = async (
        expected: "healthy" | "unknown",
        timeoutMs = 45_000,
      ): Promise<Record<string, unknown>> =>
        waitFor(
          `download-worker heartbeat ${expected}`,
          async () => {
            const probe = await fetchJson(`${origin}/api/admin/dashboard`, {
              headers: { "x-admin-dashboard-token": ADMIN_TOKEN },
            });
            const modules = probe.body?.["modules"];
            if (!probe.response.ok || !Array.isArray(modules)) return false;
            const module = modules.find(
              (candidate) =>
                typeof candidate === "object" &&
                candidate !== null &&
                (candidate as Record<string, unknown>)["id"] ===
                  "download-worker",
            ) as Record<string, unknown> | undefined;
            return module?.["status"] === expected ? module : false;
          },
          timeoutMs,
        );

      const heartbeat = await dashboardModule("healthy");
      await compose(["restart", "api"]);
      await waitFor("TF API health after reset", async () => {
        const response = await boundedFetch(`${origin}/api/readyz`);
        return response.ok;
      });
      const unknown = await dashboardModule("unknown", 10_000);
      const recovered = await dashboardModule("healthy", 45_000);

      const seedSession = async (
        credentials: (typeof canaryBundle.sessions)["owner"],
        forcedAccountId?: string,
      ): Promise<SessionFixture> => {
        const { handle, csrf, revision } = credentials;
        const accountId = forcedAccountId ?? randomUUID();
        const now = Date.now();
        const stored = JSON.stringify({
          revision,
          session: {
            id: randomUUID(),
            accountId,
            platformSessionId: randomUUID(),
            installationId: randomUUID(),
            entitlements: ["tf.downloads"],
            assertionExpiresAt: new Date(now + 1_000).toISOString(),
            expiresAt: new Date(now + 30 * 60_000).toISOString(),
          },
        });
        await composeWithInput(
          [
            "exec",
            "-T",
            "redis",
            "sh",
            "-ceu",
            'value=$(cat); exec redis-cli -n 1 SET "$1" "$value" PX "$2"',
            "seed-session",
            `tf-auth:session:${digest(handle)}`,
            String(30 * 60_000),
          ],
          stored,
        );
        return { accountId, csrf, handle };
      };
      const owner = await seedSession(
        canaryBundle.sessions.owner,
        accountCanary,
      );
      const foreign = await seedSession(canaryBundle.sessions.foreign);

      const jobModes = new Map<string, string>();
      const enqueue = async (
        mode: string,
        session = owner,
        metadata: { readonly artist?: string; readonly title?: string } = {},
      ): Promise<string> => {
        const probe = await fetchJson(`${origin}/api/tracks/download/queue`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...sessionHeaders(session, origin, true),
          },
          body: JSON.stringify({
            tracks: [
              {
                trackId: trackIdFor(
                  mode,
                  sourceCanary,
                  pathCanary,
                  stderrCanary,
                ),
                artist: metadata.artist ?? "Smoke Artist",
                title: metadata.title ?? `Smoke ${mode}`,
                quality: "320",
              },
            ],
          }),
        });
        responseSurfaces.push(probe.text);
        assertCondition(
          probe.response.status === 200,
          `enqueue failed (${probe.response.status} ${probe.text.slice(0, 128)})`,
        );
        const results = probe.body?.["results"];
        assertCondition(Array.isArray(results), "enqueue result missing");
        const jobId = (results[0] as Record<string, unknown>)["jobId"];
        assertCondition(typeof jobId === "string", "enqueue job id missing");
        jobModes.set(jobId, mode);
        return jobId;
      };
      const status = async (
        jobId: string,
        session = owner,
      ): Promise<Record<string, unknown> & { readonly status: string }> => {
        const probe = await fetchJson(
          `${origin}/api/tracks/download/status/${jobId}`,
          { headers: sessionHeaders(session, origin) },
        );
        responseSurfaces.push(probe.text);
        assertCondition(probe.response.status === 200, "status request failed");
        assertCondition(
          typeof probe.body?.["status"] === "string",
          "status body missing",
        );
        return probe.body as Record<string, unknown> & {
          readonly status: string;
        };
      };
      const waitForStatus = (
        jobId: string,
        expected: readonly string[],
      ): Promise<Record<string, unknown> & { readonly status: string }> =>
        waitFor(
          `${jobModes.get(jobId) ?? "unknown"} job ${expected.join("/")}`,
          async () => {
            const current = await status(jobId);
            return expected.includes(current.status) ? current : false;
          },
          60_000,
        );
      const cancel = async (jobId: string): Promise<string> => {
        const probe = await fetchJson(
          `${origin}/api/tracks/download/jobs/${jobId}`,
          {
            method: "DELETE",
            headers: sessionHeaders(owner, origin, true),
          },
        );
        responseSurfaces.push(probe.text);
        assertCondition(probe.response.status === 200, "cancel request failed");
        return String(probe.body?.["status"]);
      };

      const completedJob = await enqueue("normal");
      const completed = await waitForStatus(completedJob, ["completed"]);
      const full = await boundedFetch(
        `${origin}/api/tracks/download/file/${completedJob}`,
        { headers: sessionHeaders(owner, origin) },
      );
      const fullBytes = Buffer.from(
        await boundedOperation(
          "full file body",
          () => full.arrayBuffer(),
          5_000,
        ),
      );
      responseSurfaces.push(fullBytes.toString("base64"));
      const ranged = await boundedFetch(
        `${origin}/api/tracks/download/file/${completedJob}`,
        {
          headers: {
            ...sessionHeaders(owner, origin),
            range: "bytes=10-19",
          },
        },
      );
      const rangedBytes = Buffer.from(
        await boundedOperation(
          "range file body",
          () => ranged.arrayBuffer(),
          5_000,
        ),
      );
      responseSurfaces.push(rangedBytes.toString("base64"));
      const authenticatedBytes =
        full.status === 200 &&
        fullBytes.length === 600 &&
        fullBytes.every((value) => value === 65);
      const exactRange =
        ranged.status === 206 &&
        ranged.headers.get("content-range") === "bytes 10-19/600" &&
        rangedBytes.length === 10 &&
        rangedBytes.every((value) => value === 65);
      const pathJob = await enqueue("normal", owner, {
        artist: pathCanary,
        title: pathCanary,
      });
      const pathResult = await waitForStatus(pathJob, ["completed"]);
      const pathFile = await boundedFetch(
        `${origin}/api/tracks/download/file/${pathJob}`,
        { headers: sessionHeaders(owner, origin) },
      );
      await boundedOperation(
        "path canary file body",
        () => pathFile.arrayBuffer(),
        5_000,
      );
      const pathDisposition = pathFile.headers.get("content-disposition") ?? "";
      const encodedFilename = /filename\*=UTF-8''([^;]+)/.exec(
        pathDisposition,
      )?.[1];
      const pathFilename =
        encodedFilename === undefined
          ? ""
          : decodeURIComponent(encodedFilename);
      responseSurfaces.push(pathDisposition, pathFilename);
      const pathFilenameSanitized =
        pathFile.status === 200 &&
        pathResult.status === "completed" &&
        pathFilename.length > 0 &&
        !pathDisposition.includes(pathCanary) &&
        !pathFilename.includes(pathCanary) &&
        !/[\\/]/.test(pathFilename);
      assertCondition(
        pathFilenameSanitized,
        "artist/title traversal reached the completed filename",
      );

      const signedProbeSource = String.raw`
const { createHash, createHmac, randomBytes, randomUUID } = require("node:crypto");
const { readFileSync } = require("node:fs");
const secret = readFileSync(process.env.TF_DOWNLOAD_INTERNAL_AUTH_SECRET_FILE, "utf8").trim();
const input = JSON.parse(readFileSync(0, "utf8"));
const path = "/v1/files";
const body = JSON.stringify({schemaVersion:1,requestId:randomUUID(),accountId:input.accountId,jobId:input.jobId});
function signed(value, key = secret, nonce = randomBytes(32).toString("hex")) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", key).update(["POST",path,timestamp,nonce,createHash("sha256").update(value).digest("hex")].join("\n")).digest("hex");
  return {timestamp,nonce,signature};
}
async function send(value, headers) {
  const response = await fetch("http://127.0.0.1:8080" + path, {method:"POST",headers:{"content-type":"application/json","x-apollo-internal-timestamp":headers.timestamp,"x-apollo-internal-nonce":headers.nonce,"x-apollo-internal-signature":headers.signature},body:value,signal:AbortSignal.timeout(5000)});
  await response.arrayBuffer();
  return response.status;
}
async function main() {
const replayHeaders = signed(body);
const first = await send(body, replayHeaders);
const replay = await send(body, replayHeaders);
const tamperHeaders = signed(body);
const tamper = await send(body + " ", tamperHeaders);
const wrong = await send(body, signed(body, input.wrongKey));
const raw = await send(body, {...signed(body),signature:input.rawSignature});
const foreignBody = JSON.stringify({...JSON.parse(body),requestId:randomUUID(),accountId:input.foreignId});
const foreign = await send(foreignBody, signed(foreignBody));
process.stdout.write(JSON.stringify({first,replay,tamper,wrong,raw,foreign}));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
`;
      const signedProbe = await dockerWithInput(
        signedProbeInvocation(composeBase, signedProbeSource, {
          accountId: owner.accountId,
          foreignId: foreign.accountId,
          jobId: completedJob,
          rawSignature: signatureCanary,
          wrongKey: wrongKeyCanary,
        }),
        environment,
        boundedTimeout(DEFAULT_DOCKER_TIMEOUT_MS),
      );
      const signedStatuses = JSON.parse(signedProbe.stdout) as Record<
        string,
        number
      >;
      const rawSignatureRejected = signedStatuses["raw"] === 401;
      assertCondition(
        rawSignatureRejected,
        "raw signature canary was not rejected",
      );

      const activeOne = await enqueue("active");
      const activeTwo = await enqueue("active");
      await Promise.all([
        waitForStatus(activeOne, ["active"]),
        waitForStatus(activeTwo, ["active"]),
      ]);
      const waiting = await enqueue("active");
      await waitForStatus(waiting, ["waiting"]);
      const waitingAccepted = await cancel(waiting);
      const activeAccepted = await cancel(activeOne);
      await cancel(activeTwo);
      await Promise.all([
        waitForStatus(waiting, ["canceled"]),
        waitForStatus(activeOne, ["canceled"]),
        waitForStatus(activeTwo, ["canceled"]),
      ]);
      const storageListing = await compose([
        "exec",
        "-T",
        "tf-download-worker",
        "node",
        "-e",
        "const{readdirSync}=require('node:fs');process.stdout.write(JSON.stringify(readdirSync(process.env.TF_DOWNLOAD_STORAGE_ROOT)))",
      ]);
      const storageFiles = JSON.parse(storageListing.stdout) as string[];
      const pathCanarySanitized =
        pathFilenameSanitized &&
        storageFiles.every(
          (name) => !name.includes(pathCanary) && !/[\\/]/.test(name),
        );
      assertCondition(
        pathCanarySanitized,
        "path canary reached a storage filename",
      );
      const waitingCancellationClean =
        waitingAccepted === "waiting" &&
        !storageFiles.some((name) => name.startsWith(waiting));
      const activeCancellationClean =
        activeAccepted === "active" &&
        !storageFiles.some(
          (name) => name.startsWith(activeOne) || name.startsWith(activeTwo),
        );

      const sizeJob = await enqueue("size");
      await waitForStatus(sizeJob, ["failed"]);
      const quotaHoldJob = await enqueue("hold");
      await waitForStatus(quotaHoldJob, ["active"]);
      await waitFor("quota hold partial", async () => {
        const output = await compose([
          "exec",
          "-T",
          "-e",
          `HOLD_JOB_ID=${quotaHoldJob}`,
          "tf-download-worker",
          "node",
          "-e",
          "const{statSync}=require('node:fs');const p=process.env.TF_DOWNLOAD_STORAGE_ROOT+'/'+process.env.HOLD_JOB_ID+'.mp3.part';try{process.stdout.write(String(statSync(p).size))}catch{process.stdout.write('0')}",
        ]);
        return Number(output.stdout.trim()) === 900;
      });
      const quotaJob = await enqueue("quota");
      await waitForStatus(quotaJob, ["failed"]);
      await cancel(quotaHoldJob);
      await waitForStatus(quotaHoldJob, ["canceled"]);
      const deadlineJob = await enqueue("deadline");
      await waitForStatus(deadlineJob, ["failed"]);
      const [sizeReason, deadlineReason, quotaReason] = await Promise.all([
        queryFailedReason(compose, sizeJob),
        queryFailedReason(compose, deadlineJob),
        queryFailedReason(compose, quotaJob),
      ]);
      const stderrJob = await enqueue("stderr");
      await waitForStatus(stderrJob, ["failed"]);
      const stderrReason = await queryFailedReason(compose, stderrJob);
      const stderrCanaryFailureBounded = stderrReason === "download_failed";
      assertCondition(
        stderrCanaryFailureBounded,
        "stderr fixture did not fail with the bounded generic code",
      );

      const foreignStatus = await boundedFetch(
        `${origin}/api/tracks/download/status/${completedJob}`,
        { headers: sessionHeaders(foreign, origin) },
      );
      const foreignFile = await boundedFetch(
        `${origin}/api/tracks/download/file/${completedJob}`,
        { headers: sessionHeaders(foreign, origin) },
      );
      responseSurfaces.push(
        await boundedOperation(
          "foreign status body",
          () => foreignStatus.text(),
          5_000,
        ),
        await boundedOperation(
          "foreign file body",
          () => foreignFile.text(),
          5_000,
        ),
      );

      logs = (await compose(["logs", "--no-color"])).stdout;
      const imageHistory = (
        await Promise.all(
          [
            `${project}-redis:local`,
            `${project}-worker:local`,
            `${project}-api`,
            finalWorkerImage,
          ].map(async (image) =>
            dockerWithin([
              "history",
              "--no-trunc",
              "--format",
              "{{json .}}",
              image,
            ]).then((value) => value.stdout),
          ),
        )
      ).join("\n");
      await scanTrackedFilesForCanaries(canaries, {
        deadlineAt: operationDeadline,
        readTrackedFile: (filePath) =>
          readFile(path.join(repositoryRoot, filePath)),
        runGit: (args) =>
          boundedOperation(
            "tracked file listing",
            () =>
              execute("git", [...args], {
                cwd: repositoryRoot,
                timeout: 10_000,
                windowsHide: true,
              }),
            10_000,
          ),
      });
      const trackedProjection = "tracked files scanned in process";
      const surfaces = [
        rendered.stdout,
        `${logs}\n${failureSurfaces.join("\n")}`,
        responseSurfaces.join("\n"),
        inspection,
        imageHistory,
        trackedProjection,
      ];
      for (const surface of surfaces) {
        for (const canary of canaries) {
          assertCondition(
            !surface.includes(canary),
            "smoke surface exposed a canary",
          );
        }
      }
      const workerInspection = byService.get("tf-download-worker");
      const workerEnvironmentNames = (workerInspection?.Config?.Env ?? []).map(
        (entry) => entry.split("=", 1)[0] ?? "",
      );
      const workerMountSurface = [
        ...(workerInspection?.HostConfig?.Binds ?? []),
        ...(workerInspection?.Mounts ?? []).flatMap((mount) => [
          mount.Source ?? "",
          mount.Destination ?? "",
        ]),
      ];
      const workerNetworkNames = Object.keys(
        workerInspection?.NetworkSettings?.Networks ?? {},
      ).map((name) => name.replace(`${project}_`, ""));
      const noForbiddenInspectSurface =
        workerInspection !== undefined &&
        workerEnvironmentNames.every(
          (name) =>
            !/DATABASE|POSTGRES|PLATFORM|SPOTIFY|YANDEX|PROVIDER|DOCKER_HOST|COOLIFY|CADDY|SSH/i.test(
              name,
            ),
        ) &&
        workerMountSurface.every(
          (value) => !value.includes("/var/run/docker.sock"),
        ) &&
        new Set(workerNetworkNames).size === 3 &&
        [
          "tf-download-queue",
          "tf-download-control",
          "tf-download-egress",
        ].every((name) => workerNetworkNames.includes(name));

      result = {
        project,
        observations: {
          productionFlagRejected: productionFixture.rejected,
          productionImageFixtureFree: productionFixture.fixtureFree,
          secretOwnershipEvidence,
          queueWeakPasswordRejected,
          queueUnreadablePasswordRejected,
          queueUrlMismatchRejected,
          rawSignatureRejected,
          pathCanarySanitized,
          stderrCanaryFailureBounded,
          apiHealthy,
          queueHealthy,
          workerHealthy,
          heartbeatHealthy: heartbeat["status"] === "healthy",
          heartbeatUnknownAfterReset: unknown["status"] === "unknown",
          heartbeatRecovered: recovered["status"] === "healthy",
          completedOwnedFixture: completed.status === "completed",
          authenticatedBytes,
          statusAndProgress:
            completed["progress"] === 100 && completed["fileSize"] === 600,
          fullFile: full.status === 200,
          exactRange,
          replayRejected:
            signedStatuses["first"] === 200 && signedStatuses["replay"] === 401,
          tamperRejected: signedStatuses["tamper"] === 401,
          wrongKeyRejected: signedStatuses["wrong"] === 401,
          foreignOwnerRejected:
            signedStatuses["foreign"] === 404 &&
            foreignStatus.status === 404 &&
            foreignFile.status === 404,
          waitingCancellationClean,
          activeCancellationClean,
          sizeFailureBounded: sizeReason === "output_too_large",
          deadlineFailureBounded: deadlineReason === "deadline_exceeded",
          quotaFailureBounded: quotaReason === "storage_quota_exceeded",
          noForbiddenInspectSurface,
          canarySurfacesScanned: surfaces.length,
          noPublishedWorkerOrQueuePorts,
        },
        cleanup: {
          containers: -1,
          images: -1,
          networks: -1,
          temporaryDirectories: -1,
          volumes: -1,
        },
      };
    };

    await runSmokeSecurityOrchestrator({
      cleanup,
      exercisedCanaries: exerciseCanaries,
      ownershipProvisioning: async () => {
        secretOwnershipEvidence = await provisionNativeSecretOwnership();
      },
      productionFixtureRejection: async () => {
        productionFixture = await proveProductionFixtureRejection();
      },
      queueUnreadablePasswordFailure: async () => {
        queueUnreadablePasswordRejected = await proveQueuePasswordFailure(
          passwordProbes.unreadable,
        );
      },
      queueUrlMismatch: async () => {
        queueUrlMismatchRejected = await proveQueueUrlMismatch();
      },
      queueWeakPasswordFailure: async () => {
        queueWeakPasswordRejected = await proveQueuePasswordFailure(
          passwordProbes.weak,
        );
      },
    });
  } catch (error) {
    primaryError = error;
    try {
      const [
        projectLogs,
        workerLogs,
        apiLogs,
        platformLogs,
        projectState,
        workerProbe,
        apiProbe,
        platformProbe,
      ] = await Promise.all([
        compose(["logs", "--no-color"]),
        compose(["logs", "--no-color", "tf-download-worker"]),
        compose(["logs", "--no-color", "api"]),
        compose(["logs", "--no-color", "platform-api"]),
        compose(["ps", "-a", "--format", "json"]),
        compose([
          "exec",
          "-T",
          "tf-download-worker",
          "node",
          "-e",
          "Promise.all(['/healthz','/readyz'].map(async p=>[p,(await fetch('http://127.0.0.1:8080'+p,{signal:AbortSignal.timeout(5000)})).status])).then(v=>process.stdout.write(JSON.stringify(v)))",
        ]).catch(() => ({ stdout: "worker probe unavailable", stderr: "" })),
        compose([
          "exec",
          "-T",
          "api",
          "node",
          "-e",
          "Promise.all(['/api/healthz','/api/readyz'].map(async p=>[p,(await fetch('http://127.0.0.1:8080'+p,{signal:AbortSignal.timeout(5000)})).status])).then(v=>process.stdout.write(JSON.stringify(v)))",
        ]).catch(() => ({ stdout: "api probe unavailable", stderr: "" })),
        compose([
          "exec",
          "-T",
          "api",
          "node",
          "-e",
          "fetch('http://platform-api:8080/v1/oauth/introspect',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({accountId:'00000000-0000-4000-8000-000000000001',sessionId:'00000000-0000-4000-8000-000000000002',installationId:'00000000-0000-4000-8000-000000000003',audience:'apollo-tf'}),signal:AbortSignal.timeout(5000)}).then(async r=>process.stdout.write(JSON.stringify([r.status,await r.text()])))",
        ]).catch(() => ({ stdout: "platform probe unavailable", stderr: "" })),
      ]);
      logs = [
        projectLogs.stdout,
        projectState.stdout,
        workerProbe.stdout,
        apiProbe.stdout,
        platformProbe.stdout,
        apiLogs.stdout,
        platformLogs.stdout,
        platformProbe.stdout,
        workerLogs.stdout,
      ].join("\n");
    } catch {
      // Cleanup and residue audit remain authoritative.
    }
  }

  if (primaryError !== undefined) {
    throw createRedactedSmokeError(primaryError, logs, canaries);
  }
  assertCondition(result !== undefined, "smoke result missing");
  return result;
}

describe("TF download smoke fixture gate", () => {
  it("rejects the fixture flag outside exact test mode", async () => {
    await expect(
      execute(
        "sh",
        [
          shellPath(smokeEntrypoint),
          "sh",
          "-c",
          "printf '%s' \"$TF_DOWNLOAD_YT_DLP_PATH\"",
        ],
        {
          env: {
            PATH: process.env.PATH,
            NODE_ENV: "production",
            TF_DOWNLOAD_SMOKE_FIXTURES: "true",
          },
          windowsHide: true,
        },
      ),
    ).rejects.toBeDefined();
  });

  it("activates fixtures only for exact test mode and exact true", async () => {
    const result = await execute(
      "sh",
      [
        shellPath(smokeEntrypoint),
        "sh",
        "-c",
        'printf \'%s|%s|%s\' "$TF_DOWNLOAD_YT_DLP_PATH" "$NODE_OPTIONS" "${TF_DOWNLOAD_SMOKE_FIXTURES+x}"',
      ],
      {
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "test",
          TF_DOWNLOAD_SMOKE_FIXTURES: "true",
        },
        windowsHide: true,
      },
    );

    expect(result.stdout).toBe(
      "/app/bin/smoke-downloader.sh|--import=/app/bin/smoke-deadline.mjs|",
    );
    expect(result.stderr).toBe("");
  });

  it("keeps the production image on its original entrypoint", async () => {
    const dockerfile = await readFile(
      path.join(artifactRoot, "Dockerfile"),
      "utf8",
    );

    expect(dockerfile).toContain("FROM runtime AS smoke-runtime");
    expect(dockerfile).toContain(
      'ENTRYPOINT ["/app/bin/start-smoke-worker.sh", "/app/bin/start-worker.sh"]',
    );
    expect(dockerfile).toContain(
      "COPY artifacts/tf-download-worker/scripts/smoke-deadline.mjs ./bin/smoke-deadline.mjs",
    );
    expect(dockerfile).toContain('CMD ["node", "/app/dist/index.mjs"]');
    expect(dockerfile).toContain("FROM runtime AS final");
    expect(dockerfile).toContain('ENTRYPOINT ["/app/bin/start-worker.sh"]');
  });
});

describe("TF download bounded smoke orchestration", () => {
  it("aborts a never-settling fetch within its local deadline", async () => {
    let observedSignal: AbortSignal | undefined;
    const neverFetch = ((
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      observedSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    }) as typeof fetch;

    await expect(
      boundedFetch(
        "http://127.0.0.1:1/never",
        {},
        {
          fetchImplementation: neverFetch,
          timeoutMs: 20,
        },
      ),
    ).rejects.toThrow("fetch deadline exceeded");
    expect(observedSignal?.aborted).toBe(true);
  });

  it("bounds a never-settling command abstraction", async () => {
    await expect(
      boundedOperation(
        "command",
        () => new Promise<never>(() => undefined),
        20,
      ),
    ).rejects.toThrow("command deadline exceeded");
  });

  it.each(["stdin error", "callback error", "early close"] as const)(
    "rejects one %s and clears child listeners before lifecycle cleanup",
    async (failureMode) => {
      const childEvents = new EventEmitter();
      const stdinEvents = new EventEmitter();
      const stdoutEvents = new EventEmitter();
      const stderrEvents = new EventEmitter();
      const kill = vi.fn(() => true);
      const destroy = vi.fn();
      const inputFailure = Object.assign(new Error("closed input"), {
        code: "EPIPE",
      });
      const stdin = Object.assign(stdinEvents, {
        destroy,
        end: vi.fn(
          (_input: string, callback: (error?: Error | null) => void): void => {
            queueMicrotask(() => {
              if (failureMode === "stdin error") {
                stdinEvents.emit("error", inputFailure);
              } else if (failureMode === "callback error") {
                callback(inputFailure);
              } else {
                childEvents.emit("close", 0, null);
              }
            });
          },
        ),
      });
      const child = Object.assign(childEvents, {
        kill,
        stderr: stderrEvents,
        stdin,
        stdout: stdoutEvents,
      }) as unknown as ReturnType<typeof spawn>;
      const spawnChild = vi.fn(() => child) as unknown as typeof spawn;
      const cleanup = vi.fn(async () => undefined);
      const invocation = {
        args: ["ignored-by-fake"],
        input: "signed probe input",
        spawnChild,
      } as DockerInputInvocation & {
        readonly spawnChild: typeof spawn;
      };

      await expect(
        runSmokeLifecycle(
          () => dockerWithInput(invocation, process.env, 500),
          cleanup,
        ),
      ).rejects.toThrow(
        failureMode === "early close"
          ? "closed before input completed"
          : "input failed",
      );

      expect(spawnChild).toHaveBeenCalledTimes(1);
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(childEvents.eventNames()).toEqual([]);
      expect(stdinEvents.eventNames()).toEqual([]);
      expect(stdoutEvents.eventNames()).toEqual([]);
      expect(stderrEvents.eventNames()).toEqual([]);
      if (failureMode !== "early close") expect(kill).toHaveBeenCalledTimes(1);
    },
  );

  it("bounds every never-settling wait probe", async () => {
    let probes = 0;
    await expect(
      waitUntil(
        "probe",
        () => {
          probes += 1;
          return new Promise<false>(() => undefined);
        },
        {
          intervalMs: 1,
          probeTimeoutMs: 10,
          timeoutMs: 35,
        },
      ),
    ).rejects.toThrow("probe deadline exceeded");
    expect(probes).toBeGreaterThan(0);
  });

  it("keeps secret values out of Redis and tracked-file command argv", async () => {
    const secret = "queue-secret-literal";
    const canary = "tracked-canary-literal";
    const composeCalls: readonly string[][] = [];
    const gitCalls: readonly string[][] = [];
    const mutableComposeCalls = composeCalls as string[][];
    const mutableGitCalls = gitCalls as string[][];

    await queryFailedReason(async (args) => {
      mutableComposeCalls.push([...args]);
      return { stdout: "download_failed\n", stderr: "" };
    }, "30000000-0000-4000-8000-000000000003");
    await scanTrackedFilesForCanaries([secret, canary], {
      deadlineAt: Date.now() + 5_000,
      readTrackedFile: async () => Buffer.from("safe tracked source"),
      runGit: async (args) => {
        mutableGitCalls.push([...args]);
        return { stdout: "safe.ts\0", stderr: "" };
      },
    });
    const signedInvocation = signedProbeInvocation(
      ["compose", "-p", "smoke-project"],
      "static-probe-source",
      { rawSignature: canary, wrongKey: secret },
    );
    mutableComposeCalls.push([...signedInvocation.args]);

    const argv = JSON.stringify([...composeCalls, ...gitCalls]);
    expect(argv).not.toContain(secret);
    expect(argv).not.toContain(canary);
    expect(argv).toContain("/run/secrets/tf_download_queue_password");
    expect(gitCalls).toEqual([["ls-files", "-z"]]);
    expect(signedInvocation.input).toContain(secret);
    expect(signedInvocation.input).toContain(canary);
  });

  it("redacts secrets from command errors and final failure text", () => {
    const secret = "primary-secret-literal";
    const canary = "stderr-canary-literal";
    const failure = Object.assign(new Error(`command failed with ${secret}`), {
      cause: new Error(`cause ${canary}`),
      stderr: `stderr ${canary}`,
      stdout: `stdout ${secret}`,
    });

    const redacted = createRedactedSmokeError(failure, canary, [
      secret,
      canary,
    ]);

    expect(redacted.message).not.toContain(secret);
    expect(redacted.message).not.toContain(canary);
    expect(redacted.message).toContain("[REDACTED]");
  });

  it("feeds every named generated secret into scans and final redaction", () => {
    const bundle = createSmokeCanaryBundle();
    const generatedValues = Object.values(bundle.values);

    expect(new Set(bundle.canaries)).toEqual(new Set(generatedValues));
    expect(bundle.heartbeatKeys).toEqual({
      "search-media": bundle.values.searchHeartbeatSecret,
      "account-integrations": bundle.values.integrationsHeartbeatSecret,
      "download-worker": bundle.values.heartbeatSecret,
    });
    expect(bundle.sessions).toEqual({
      owner: {
        csrf: bundle.values.ownerSessionCsrf,
        handle: bundle.values.ownerSessionHandle,
        revision: bundle.values.ownerSessionRevision,
      },
      foreign: {
        csrf: bundle.values.foreignSessionCsrf,
        handle: bundle.values.foreignSessionHandle,
        revision: bundle.values.foreignSessionRevision,
      },
    });
    expect(bundle.values.pathCanary).toContain("..");
    expect(bundle.values.pathCanary).toContain("/");
    expect(bundle.values.pathCanary).toContain("\\");

    const redacted = redactSmokeText(
      generatedValues.join("\n"),
      bundle.canaries,
    );
    for (const value of generatedValues) {
      expect(redacted).not.toContain(value);
    }
  });

  it("executes every required security phase in order and always cleans up", async () => {
    const calls: string[] = [];
    const phase = (name: string) => async (): Promise<void> => {
      calls.push(name);
    };

    await runSmokeSecurityOrchestrator({
      cleanup: phase("cleanup"),
      exercisedCanaries: phase("canaries"),
      ownershipProvisioning: phase("ownership"),
      productionFixtureRejection: phase("production"),
      queueUnreadablePasswordFailure: phase("queue-unreadable"),
      queueUrlMismatch: phase("queue-url-mismatch"),
      queueWeakPasswordFailure: phase("queue-weak"),
    });

    expect(calls).toEqual([
      "production",
      "ownership",
      "queue-weak",
      "queue-unreadable",
      "queue-url-mismatch",
      "canaries",
      "cleanup",
    ]);
  });

  it("runs cleanup for temporary-directory and port reservation failures", async () => {
    const cleanup = vi.fn(async () => undefined);

    await expect(
      runSmokeSetup({
        cleanup,
        createTemporaryDirectory: async () => {
          throw new Error("temporary directory failed");
        },
        reservePort: async () => 1234,
        run: async () => undefined,
        temporaryDirectory: "temporary-directory-one",
      }),
    ).rejects.toThrow("temporary directory failed");
    await expect(
      runSmokeSetup({
        cleanup,
        createTemporaryDirectory: async () => undefined,
        reservePort: async () => {
          throw new Error("port reservation failed");
        },
        run: async () => undefined,
        temporaryDirectory: "temporary-directory-two",
      }),
    ).rejects.toThrow("port reservation failed");
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it("bounds never-settling directory creation and cleans the exact path once", async () => {
    const exactPath = path.join(
      tmpdir(),
      `known-smoke-directory-${randomUUID()}`,
    );
    const removedPaths: string[] = [];
    const auditedPaths: string[] = [];
    const cleanup = vi.fn(async () => {
      removedPaths.push(exactPath);
      auditedPaths.push(exactPath);
    });
    const dependencies = {
      cleanup,
      createTemporaryDirectory: (
        _directory: string,
        timeoutMs?: number,
      ): Promise<void> =>
        timeoutMs === undefined
          ? new Promise<void>(() => undefined)
          : new Promise<void>((_resolve, reject) =>
              setTimeout(
                () =>
                  reject(
                    new Error("temporary directory creation deadline exceeded"),
                  ),
                timeoutMs,
              ),
            ),
      reservePort: async () => 1234,
      run: async () => undefined,
      setupTimeoutMs: 20,
      temporaryDirectory: exactPath,
    };

    const outcome = await Promise.race([
      runSmokeSetup(dependencies).then(
        () => "resolved",
        (error: unknown) =>
          error instanceof Error ? error.message : String(error),
      ),
      new Promise<"test guard exceeded">((resolve) =>
        setTimeout(() => resolve("test guard exceeded"), 150),
      ),
    ]);

    expect(outcome).toContain("temporary directory creation deadline exceeded");
    expect(removedPaths).toEqual([exactPath]);
    expect(auditedPaths).toEqual([exactPath]);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it.each(["late error", "late close"] as const)(
    "bounds unconfirmed directory-helper termination and guards %s",
    async (lateEvent) => {
      const exactPath = path.join(
        tmpdir(),
        `unconfirmed-smoke-directory-${randomUUID()}`,
      );
      const childEvents = new EventEmitter();
      const kill = vi.fn(() => false);
      const child = Object.assign(childEvents, {
        kill,
      }) as unknown as ReturnType<typeof spawn>;
      const spawnChild = vi.fn(() => child) as unknown as typeof spawn;
      const cleanedPaths: string[] = [];
      const cleanup = vi.fn(async () => {
        cleanedPaths.push(exactPath);
      });
      const reservePort = vi.fn(async () => 1234);
      const run = vi.fn(async () => undefined);

      const outcome = await Promise.race([
        runSmokeSetup({
          cleanup,
          createTemporaryDirectory: (directory, timeoutMs) =>
            createTemporaryDirectoryTerminal(directory, timeoutMs, {
              spawnChild,
            }),
          reservePort,
          run,
          setupTimeoutMs: 20,
          temporaryDirectory: exactPath,
        }).then(
          () => "resolved",
          (error: unknown) =>
            error instanceof Error ? error.message : String(error),
        ),
        new Promise<"test guard exceeded">((resolve) =>
          setTimeout(() => resolve("test guard exceeded"), 500),
        ),
      ]);

      expect(outcome).toContain("child termination could not be confirmed");
      expect(cleanedPaths).toEqual([exactPath]);
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(spawnChild).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenCalledWith("SIGKILL");
      expect(reservePort).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(childEvents.listenerCount("error")).toBe(1);
      expect(childEvents.listenerCount("close")).toBe(1);

      if (lateEvent === "late error") {
        expect(() =>
          childEvents.emit("error", new Error("late child error")),
        ).not.toThrow();
        expect(childEvents.listenerCount("error")).toBe(1);
        expect(childEvents.listenerCount("close")).toBe(1);
      }

      childEvents.emit("close", null, null);
      childEvents.emit("close", null, null);
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(childEvents.eventNames()).toEqual([]);
    },
  );

  it("reaps late staging creation without publishing the final path", async () => {
    const exactPath = path.join(
      tmpdir(),
      `staged-smoke-directory-${randomUUID()}`,
    );
    const childEvents = new EventEmitter();
    const kill = vi.fn(() => false);
    const unref = vi.fn();
    const child = Object.assign(childEvents, {
      kill,
      unref,
    }) as unknown as ReturnType<typeof spawn>;
    let childDirectory: string | undefined;
    const spawnChild = vi.fn(
      (_command: string, args: readonly string[]): ReturnType<typeof spawn> => {
        childDirectory = args[2];
        return child;
      },
    ) as unknown as typeof spawn;
    const pathExists = async (directory: string): Promise<boolean> =>
      stat(directory).then(
        () => true,
        () => false,
      );
    const cleanup = vi.fn(async () => {
      await rm(exactPath, { force: true, recursive: true });
    });

    try {
      await expect(
        runSmokeSetup({
          cleanup,
          createTemporaryDirectory: (directory, timeoutMs) =>
            createTemporaryDirectoryTerminal(directory, timeoutMs, {
              spawnChild,
            }),
          reservePort: async () => 1234,
          run: async () => {
            throw new Error("smoke run must not start");
          },
          setupTimeoutMs: 20,
          temporaryDirectory: exactPath,
        }),
      ).rejects.toThrow("child termination could not be confirmed");

      expect(childDirectory).toBeDefined();
      expect(childDirectory).not.toBe(exactPath);
      expect(path.dirname(childDirectory!)).toBe(path.dirname(exactPath));
      expect(await pathExists(exactPath)).toBe(false);
      expect(unref).toHaveBeenCalledTimes(1);

      await mkdir(childDirectory!, { recursive: true });
      expect(await pathExists(childDirectory!)).toBe(true);
      expect(await pathExists(exactPath)).toBe(false);

      childEvents.emit("close", 0, null);
      await waitUntil(
        "temporary staging directory reaper",
        async () => (!(await pathExists(childDirectory!)) ? true : false),
        {
          intervalMs: 5,
          probeTimeoutMs: 50,
          timeoutMs: 500,
        },
      );

      expect(await pathExists(exactPath)).toBe(false);
      expect(await pathExists(childDirectory!)).toBe(false);
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(childEvents.eventNames()).toEqual([]);
    } finally {
      childEvents.emit("close", 0, null);
      await rm(exactPath, { force: true, recursive: true });
      if (childDirectory !== undefined) {
        await rm(childDirectory, { force: true, recursive: true });
      }
    }
  });

  it("terminates delayed directory creation before cleanup can be bypassed", async () => {
    const exactPath = path.join(
      tmpdir(),
      `delayed-smoke-directory-${randomUUID()}`,
    );
    const removedPaths: string[] = [];
    const auditedPaths: string[] = [];
    const directoryExists = async (): Promise<boolean> =>
      stat(exactPath).then(
        () => true,
        () => false,
      );
    const cleanup = vi.fn(async () => {
      removedPaths.push(exactPath);
      await rm(exactPath, { force: true, recursive: true });
      auditedPaths.push(exactPath);
      expect(await directoryExists()).toBe(false);
    });

    await expect(
      runSmokeSetup({
        cleanup,
        createTemporaryDirectory: (directory, timeoutMs) =>
          createTemporaryDirectoryTerminal(directory, timeoutMs, {
            nodeScript:
              'setTimeout(() => require("node:fs").mkdirSync(process.argv[1]), 200)',
          }),
        reservePort: async () => 1234,
        run: async () => {
          throw new Error("smoke run must not start");
        },
        setupTimeoutMs: 40,
        temporaryDirectory: exactPath,
      }),
    ).rejects.toThrow("temporary directory creation deadline exceeded");

    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    expect(await directoryExists()).toBe(false);
    expect(removedPaths).toEqual([exactPath]);
    expect(auditedPaths).toEqual([exactPath]);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("creates and cleans the exact path with the static terminal helper", async () => {
    const exactPath = path.join(
      tmpdir(),
      `successful-smoke-directory-${randomUUID()}`,
    );
    const runPaths: string[] = [];
    const cleanup = vi.fn(async () => {
      await rm(exactPath, { force: true, recursive: true });
      await expect(stat(exactPath)).rejects.toBeDefined();
    });

    await runSmokeSetup({
      cleanup,
      createTemporaryDirectory: createTemporaryDirectoryTerminal,
      reservePort: async () => 1234,
      run: async (directory) => {
        runPaths.push(directory);
        expect((await stat(directory)).isDirectory()).toBe(true);
      },
      setupTimeoutMs: 5_000,
      temporaryDirectory: exactPath,
    });

    expect(runPaths).toEqual([exactPath]);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("terminates a never-settling creation helper before exact-path cleanup", async () => {
    const exactPath = path.join(
      tmpdir(),
      `hung-smoke-directory-${randomUUID()}`,
    );
    const removedPaths: string[] = [];
    const auditedPaths: string[] = [];
    const cleanup = vi.fn(async () => {
      removedPaths.push(exactPath);
      await rm(exactPath, { force: true, recursive: true });
      auditedPaths.push(exactPath);
      await expect(stat(exactPath)).rejects.toBeDefined();
    });

    await expect(
      runSmokeSetup({
        cleanup,
        createTemporaryDirectory: (directory, timeoutMs) =>
          createTemporaryDirectoryTerminal(directory, timeoutMs, {
            nodeScript: "setInterval(() => undefined, 1_000)",
          }),
        reservePort: async () => 1234,
        run: async () => {
          throw new Error("smoke run must not start");
        },
        setupTimeoutMs: 40,
        temporaryDirectory: exactPath,
      }),
    ).rejects.toThrow("temporary directory creation deadline exceeded");

    expect(removedPaths).toEqual([exactPath]);
    expect(auditedPaths).toEqual([exactPath]);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("removes a directory created by a helper that exits nonzero", async () => {
    const exactPath = path.join(
      tmpdir(),
      `failed-smoke-directory-${randomUUID()}`,
    );
    const removedPaths: string[] = [];
    const auditedPaths: string[] = [];
    const cleanup = vi.fn(async () => {
      removedPaths.push(exactPath);
      await rm(exactPath, { force: true, recursive: true });
      auditedPaths.push(exactPath);
      await expect(stat(exactPath)).rejects.toBeDefined();
    });

    await expect(
      runSmokeSetup({
        cleanup,
        createTemporaryDirectory: (directory, timeoutMs) =>
          createTemporaryDirectoryTerminal(directory, timeoutMs, {
            nodeScript:
              'require("node:fs").mkdirSync(process.argv[1]); process.exitCode = 23',
          }),
        reservePort: async () => 1234,
        run: async () => {
          throw new Error("smoke run must not start");
        },
        setupTimeoutMs: 5_000,
        temporaryDirectory: exactPath,
      }),
    ).rejects.toThrow("temporary directory creation failed");

    expect(removedPaths).toEqual([exactPath]);
    expect(auditedPaths).toEqual([exactPath]);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("bounds port setup by the remaining setup deadline and cleans once", async () => {
    const exactPath = path.join(
      tmpdir(),
      `port-smoke-directory-${randomUUID()}`,
    );
    const observedTimeouts: number[] = [];
    const cleanup = vi.fn(async () => {
      await rm(exactPath, { force: true, recursive: true });
      await expect(stat(exactPath)).rejects.toBeDefined();
    });
    let controlledNow = 10_000;
    const dependencies = {
      cleanup,
      createTemporaryDirectory: async (directory: string) => {
        await mkdir(directory, { mode: 0o700 });
        controlledNow += 12;
      },
      now: () => controlledNow,
      reservePort: async (timeoutMs: number) => {
        observedTimeouts.push(timeoutMs);
        throw new Error("port reservation deadline exceeded");
      },
      run: async () => {
        throw new Error("smoke run must not start");
      },
      setupTimeoutMs: 30,
      temporaryDirectory: exactPath,
    };

    await expect(runSmokeSetup(dependencies)).rejects.toThrow(
      "port reservation deadline exceeded",
    );

    expect(observedTimeouts).toEqual([18]);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("removes the exact temp path after delayed creation and setup timeout", async () => {
    const exactPath = path.join(tmpdir(), "known-smoke-directory");
    const removedPaths: string[] = [];
    const auditResults: boolean[] = [];
    let observedCreatePath: string | undefined;
    let exists = false;

    await expect(
      runSmokeSetup({
        temporaryDirectory: exactPath,
        cleanup: async () => {
          removedPaths.push(exactPath);
          exists = false;
          auditResults.push(exists);
        },
        createTemporaryDirectory: async (directory) => {
          observedCreatePath = directory;
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
          exists = true;
        },
        reservePort: async () => {
          throw new Error("port reservation deadline exceeded");
        },
        run: async () => undefined,
      }),
    ).rejects.toThrow("port reservation deadline exceeded");

    expect(observedCreatePath).toBe(exactPath);
    expect(removedPaths).toEqual([exactPath]);
    expect(auditResults).toEqual([false]);
  });

  it("falls back from compose down across exact owned resource classes", async () => {
    const calls: string[][] = [];
    const listCounts = new Map<string, number>();
    const listResult = (key: string, first: string): string => {
      const count = listCounts.get(key) ?? 0;
      listCounts.set(key, count + 1);
      return count === 0 ? `${first}\n` : "";
    };

    const cleanup = await cleanupSmokeResources({
      auditDeadlineAt: Date.now() + 5_000,
      composeFiles: ["root.yml", "override.yml"],
      dependencies: {
        directoryExists: async () => false,
        removeDirectory: async () => undefined,
        runDocker: async (args) => {
          calls.push([...args]);
          if (args[0] === "compose") throw new Error("compose down failed");
          const command = args.join(" ");
          if (command.startsWith("ps -aq")) {
            return {
              stdout: listResult("containers", "owned-container"),
              stderr: "",
            };
          }
          if (command.startsWith("images -q")) {
            return { stdout: listResult("images", "owned-image"), stderr: "" };
          }
          if (command.startsWith("network ls")) {
            return {
              stdout: listResult("networks", "owned-network"),
              stderr: "",
            };
          }
          if (command.startsWith("volume ls")) {
            return {
              stdout: listResult("volumes", "owned-volume"),
              stderr: "",
            };
          }
          return { stdout: "", stderr: "" };
        },
      },
      project: "apollo-tf-download-smoke-test",
      removalDeadlineAt: Date.now() + 5_000,
      temporaryDirectory: "temporary-smoke-directory",
    });

    const argv = calls.map((args) => args.join(" ")).join("\n");
    expect(argv).toContain("rm -f owned-container");
    expect(argv).toContain("image rm -f owned-image");
    expect(argv).toContain("network rm owned-network");
    expect(argv).toContain("volume rm -f owned-volume");
    expect(argv).toContain(
      "label=com.docker.compose.project=apollo-tf-download-smoke-test",
    );
    expect(argv).toContain("reference=apollo-tf-download-smoke-test-*");
    expect(argv).not.toContain("prune");
    expect(cleanup).toEqual({
      containers: 0,
      images: 0,
      networks: 0,
      temporaryDirectories: 0,
      volumes: 0,
    });
  });

  it("reserves a strict cleanup and safety margin before the outer timeout", () => {
    expect(
      SETUP_TIMEOUT_MS + RUN_TIMEOUT_MS + CLEANUP_RESERVE_MS + SAFETY_MARGIN_MS,
    ).toBeLessThan(OUTER_TEST_TIMEOUT_MS);
    expect(CLEANUP_REMOVAL_RESERVE_MS + CLEANUP_AUDIT_RESERVE_MS).toBe(
      CLEANUP_RESERVE_MS,
    );
    expect(CLEANUP_AUDIT_RESERVE_MS).toBeGreaterThan(
      DEFAULT_DOCKER_TIMEOUT_MS + FILESYSTEM_AUDIT_TIMEOUT_MS,
    );
    expect(cleanupCallTimeout(10_000, 4_000, () => 7_500)).toBe(2_500);
  });

  it("bounds hung temp removal and still runs the reserved audit", async () => {
    const startedAt = Date.now();
    let auditCalls = 0;
    const outcome = await Promise.race([
      cleanupSmokeResources({
        composeFiles: [],
        removalDeadlineAt: startedAt + 30,
        auditDeadlineAt: startedAt + 180,
        dependencies: {
          directoryExists: async () => {
            auditCalls += 1;
            return false;
          },
          removeDirectory: () => new Promise<void>(() => undefined),
          runDocker: async () => ({ stdout: "", stderr: "" }),
        },
        project: "apollo-tf-download-smoke-hung-remove",
        temporaryDirectory: "known-temporary-directory",
      }).then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise<"test-deadline">((resolve) =>
        setTimeout(() => resolve("test-deadline"), 300),
      ),
    ]);

    expect(outcome).toBe("rejected");
    expect(auditCalls).toBe(1);
  });

  it("runs the final audit after the removal window is exhausted", async () => {
    let auditCalls = 0;

    await expect(
      cleanupSmokeResources({
        composeFiles: [],
        removalDeadlineAt: Date.now() - 1,
        auditDeadlineAt: Date.now() + 100,
        dependencies: {
          directoryExists: async () => {
            auditCalls += 1;
            return false;
          },
          removeDirectory: async () => undefined,
          runDocker: async () => ({ stdout: "", stderr: "" }),
        },
        project: "apollo-tf-download-smoke-expired-removal",
        temporaryDirectory: "known-temporary-directory",
      }),
    ).rejects.toThrow("TF download smoke cleanup failed");

    expect(auditCalls).toBe(1);
  });

  it("bounds a hung temp-directory final audit", async () => {
    const startedAt = Date.now();
    const outcome = await Promise.race([
      cleanupSmokeResources({
        composeFiles: [],
        removalDeadlineAt: startedAt + 30,
        auditDeadlineAt: startedAt + 100,
        dependencies: {
          directoryExists: () => new Promise<boolean>(() => undefined),
          removeDirectory: async () => undefined,
          runDocker: async () => ({ stdout: "", stderr: "" }),
        },
        project: "apollo-tf-download-smoke-hung-audit",
        temporaryDirectory: "known-temporary-directory",
      }).then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise<"test-deadline">((resolve) =>
        setTimeout(() => resolve("test-deadline"), 300),
      ),
    ]);

    expect(outcome).toBe("rejected");
  });

  it("bounds every tracked-file read by the current run deadline", async () => {
    const outcome = await Promise.race([
      scanTrackedFilesForCanaries(["generated-secret"], {
        deadlineAt: Date.now() + 30,
        readTrackedFile: () => new Promise<Buffer>(() => undefined),
        runGit: async () => ({ stdout: "hung.ts\0", stderr: "" }),
      }).then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise<"test-deadline">((resolve) =>
        setTimeout(() => resolve("test-deadline"), 300),
      ),
    ]);

    expect(outcome).toBe("rejected");
  });
});

const realDockerEnabled = process.env.TF_DOWNLOAD_SMOKE_REAL_DOCKER === "1";

describe.skipIf(!realDockerEnabled)(
  "TF download disposable real Docker smoke",
  () => {
    it(
      "proves the private download stack and removes every owned resource",
      async () => {
        const result = await runDisposableSmoke();

        expect(result.project).toMatch(
          /^apollo-tf-download-smoke-\d+-[a-f0-9]{8}$/,
        );
        expect(result.observations).toEqual({
          productionFlagRejected: true,
          productionImageFixtureFree: true,
          secretOwnershipEvidence:
            process.platform === "linux"
              ? "native-linux"
              : "docker-desktop-functional",
          queueWeakPasswordRejected: true,
          queueUnreadablePasswordRejected: true,
          queueUrlMismatchRejected: true,
          rawSignatureRejected: true,
          pathCanarySanitized: true,
          stderrCanaryFailureBounded: true,
          apiHealthy: true,
          queueHealthy: true,
          workerHealthy: true,
          heartbeatHealthy: true,
          heartbeatUnknownAfterReset: true,
          heartbeatRecovered: true,
          completedOwnedFixture: true,
          authenticatedBytes: true,
          statusAndProgress: true,
          fullFile: true,
          exactRange: true,
          replayRejected: true,
          tamperRejected: true,
          wrongKeyRejected: true,
          foreignOwnerRejected: true,
          waitingCancellationClean: true,
          activeCancellationClean: true,
          sizeFailureBounded: true,
          deadlineFailureBounded: true,
          quotaFailureBounded: true,
          noForbiddenInspectSurface: true,
          canarySurfacesScanned: 6,
          noPublishedWorkerOrQueuePorts: true,
        });
        expect(result.cleanup).toEqual({
          containers: 0,
          images: 0,
          networks: 0,
          temporaryDirectories: 0,
          volumes: 0,
        });
      },
      OUTER_TEST_TIMEOUT_MS,
    );
  },
);
