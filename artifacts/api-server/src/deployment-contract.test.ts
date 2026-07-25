import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  realpath,
  readdir,
  rename,
  rmdir,
  symlink,
  type FileHandle,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const rootComposePath = join(repositoryRoot, "docker-compose.yml");
const nestedComposePath = join(
  repositoryRoot,
  "artifacts",
  "api-server",
  "docker-compose.yml",
);
const musicPlayerDirectory = join(repositoryRoot, "artifacts", "music-player");
const musicPlayerDockerfile = join(musicPlayerDirectory, "Dockerfile");
const modulesDocumentation = join(repositoryRoot, "MODULES.md");
const apiStartupScript = join(
  repositoryRoot,
  "artifacts",
  "api-server",
  "container",
  "start-tf.sh",
);
type TemporaryOptions = {
  readonly afterTemporaryRootVerified?: () => Promise<void>;
  readonly interlock?: (event: {
    readonly name?: string;
    readonly path: string;
    readonly phase: string;
  }) => Promise<void>;
  readonly repositoryRoot?: string;
};

type TemporaryDirectoryRecord = {
  readonly directory: string;
  readonly ownership: object;
  readonly repositoryRoot: string;
};

type FileIdentity = {
  readonly device: string;
  readonly inode: string;
};

type VerifiedWorkspace = {
  readonly identity: FileIdentity;
  readonly lexicalRoot: string;
  readonly physicalRoot: string;
};

type VerifiedDirectory = {
  readonly identity: FileIdentity;
  readonly lexicalCandidate: string;
  readonly physicalCandidate: string;
};

type VerifiedFile = {
  readonly identity: FileIdentity;
  readonly lexicalCandidate: string;
  readonly physicalCandidate: string;
};

type VerifiedTreeEntry =
  | (VerifiedDirectory & {
      readonly kind: "directory";
      readonly relativePath: string;
    })
  | (VerifiedFile & {
      readonly kind: "file";
      readonly relativePath: string;
    });

type TemporaryOwnershipRecord = {
  readonly directory: VerifiedDirectory;
  entries: Map<string, VerifiedTreeEntry>;
  manifestSealed: boolean;
  readonly markerToken: string;
  readonly owner: VerifiedDirectory;
  readonly ownership: object;
  readonly temporary: VerifiedDirectory;
  readonly workspace: VerifiedWorkspace;
};

const temporaryDirectories: TemporaryDirectoryRecord[] = [];
const temporaryOwnershipRecords = new WeakMap<
  object,
  TemporaryOwnershipRecord
>();
const OWNERSHIP_MARKER = ".api-deployment-contract-owner";
const workspaceTemporaryRoot = join(repositoryRoot, ".tmp");
const apiDeploymentTemporaryRoot = join(
  workspaceTemporaryRoot,
  "api-deployment-contract",
);
const temporaryRoot = apiDeploymentTemporaryRoot;

type ComposeService = {
  readonly build?: {
    readonly args?: Record<string, string>;
    readonly context?: string;
    readonly dockerfile?: string;
  };
  readonly depends_on?: Record<string, unknown>;
  readonly deploy?: Record<string, unknown>;
  readonly environment?: Record<string, string>;
  readonly healthcheck?: Record<string, unknown>;
  readonly init?: boolean;
  readonly networks?: readonly string[];
  readonly pids_limit?: number;
  readonly ports?: readonly string[];
  readonly read_only?: boolean;
  readonly security_opt?: readonly string[];
  readonly secrets?: readonly string[];
  readonly stop_grace_period?: string;
  readonly tmpfs?: readonly string[];
  readonly user?: string;
  readonly volumes?: readonly string[];
};

type ComposeTemplate = {
  readonly name?: string;
  readonly networks?: Record<string, Record<string, unknown> | null>;
  readonly secrets?: Record<string, { readonly file?: string }>;
  readonly services: Record<string, ComposeService>;
  readonly volumes?: Record<string, unknown>;
};

async function composeTemplate(path: string): Promise<ComposeTemplate> {
  return parse(await readFile(path, "utf8")) as ComposeTemplate;
}

function service(template: ComposeTemplate, name: string): ComposeService {
  const current = template.services[name];
  if (current === undefined) throw new Error(`missing service ${name}`);
  return current;
}

function shellPath(path: string): string {
  if (process.platform !== "win32") return path;
  const match = /^([A-Za-z]):\\(.*)$/.exec(path);
  if (match === null) return path.replaceAll("\\", "/");
  return `/${match[1]!.toLowerCase()}/${match[2]!.replaceAll("\\", "/")}`;
}

async function runApiStartup(options: {
  readonly databaseUrl?: string;
  readonly heartbeatFileConfigured?: boolean;
  readonly heartbeatKeys?: string;
  readonly heartbeatPath?: string;
  readonly inlineHeartbeatKeys?: string;
}): Promise<{
  readonly stdout: string;
  readonly stderr: string;
}> {
  const directory = await createTemporaryDirectory("apollo-tf-api-startup-");
  const databasePath = join(directory, "tf_database_url");
  const heartbeatPath =
    options.heartbeatPath ?? join(directory, "tf_module_heartbeat_keys");
  await writeTemporaryFixture(
    directory,
    databasePath,
    options.databaseUrl ??
      "postgres://trackfinder:contract@db:5432/trackfinder",
  );
  if (options.heartbeatKeys !== undefined) {
    await writeTemporaryFixture(
      directory,
      heartbeatPath,
      options.heartbeatKeys,
    );
  }
  await verifyTemporaryTree(directory);
  const probe = [
    "const value = JSON.parse(process.env.APOLLO_MODULE_HEARTBEAT_KEYS);",
    "const database = new URL(process.env.DATABASE_URL);",
    "process.stdout.write(JSON.stringify({",
    "  heartbeatModules: Object.keys(value),",
    "  databaseHost: database.hostname,",
    "  databaseUser: database.username,",
    "}));",
  ].join("");

  return execFileAsync(
    "sh",
    [shellPath(apiStartupScript), process.execPath, "-e", probe],
    {
      cwd: repositoryRoot,
      env: {
        PATH: process.env.PATH,
        DATABASE_URL_FILE: shellPath(databasePath),
        APOLLO_MODULE_HEARTBEAT_KEYS:
          options.inlineHeartbeatKeys ??
          '{"attacker":"must-not-win-over-file"}',
        ...(options.heartbeatFileConfigured === false
          ? {}
          : {
              APOLLO_MODULE_HEARTBEAT_KEYS_FILE: shellPath(heartbeatPath),
            }),
      },
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    },
  );
}

function assertContainedPath(
  candidate: string,
  root: string,
  errorMessage: string,
): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const fromRoot = relative(resolvedRoot, resolvedCandidate);
  if (
    fromRoot.length === 0 ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    resolve(resolvedRoot, fromRoot) !== resolvedCandidate
  ) {
    throw new Error(errorMessage);
  }
  return resolvedCandidate;
}

function assertPhysicalContainment(
  candidate: string,
  root: string,
  allowRoot = false,
): void {
  const fromRoot = relative(root, candidate);
  if (
    (!allowRoot && fromRoot.length === 0) ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    resolve(root, fromRoot) !== candidate
  ) {
    throw new Error("Physical temporary path escaped its owner");
  }
}

function fileIdentity(stats: {
  readonly dev: bigint | number;
  readonly ino: bigint | number;
}): FileIdentity {
  return Object.freeze({
    device: String(stats.dev),
    inode: String(stats.ino),
  });
}

function assertIdentity(
  actual: FileIdentity,
  expected: FileIdentity,
  label: string,
): void {
  if (
    actual.device !== expected.device ||
    actual.inode !== expected.inode
  ) {
    throw new Error(`${label} identity was replaced`);
  }
}

async function verifiedWorkspaceRoot(
  root: string,
  expected?: VerifiedWorkspace,
): Promise<VerifiedWorkspace> {
  const lexicalRoot = resolve(root);
  const rootStats = await lstat(lexicalRoot, { bigint: true });
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error("Workspace root cannot be symbolic or reparse-linked");
  }
  const physicalRoot = await realpath(lexicalRoot);
  const identity = fileIdentity(rootStats);
  if (expected !== undefined) {
    if (
      lexicalRoot !== expected.lexicalRoot ||
      physicalRoot !== expected.physicalRoot
    ) {
      throw new Error("Workspace root was replaced");
    }
    assertIdentity(identity, expected.identity, "Workspace root");
  }
  return { identity, lexicalRoot, physicalRoot };
}

async function verifiedPhysicalDirectory(
  candidate: string,
  workspace: VerifiedWorkspace,
  expected?: VerifiedDirectory,
): Promise<VerifiedDirectory> {
  const lexicalCandidate = assertContainedPath(
    candidate,
    workspace.lexicalRoot,
    "Temporary directory escaped the worktree",
  );
  const candidateStats = await lstat(lexicalCandidate, { bigint: true });
  if (!candidateStats.isDirectory() || candidateStats.isSymbolicLink()) {
    throw new Error("Temporary directory cannot be symbolic or reparse-linked");
  }
  const physicalCandidate = await realpath(lexicalCandidate);
  assertPhysicalContainment(physicalCandidate, workspace.physicalRoot);
  const identity = fileIdentity(candidateStats);
  if (expected !== undefined) {
    if (
      lexicalCandidate !== expected.lexicalCandidate ||
      physicalCandidate !== expected.physicalCandidate
    ) {
      throw new Error("Temporary directory was replaced");
    }
    assertIdentity(identity, expected.identity, "Temporary directory");
  }
  return { identity, lexicalCandidate, physicalCandidate };
}

function temporaryLayout(root: string): {
  readonly ownerRoot: string;
  readonly temporaryRoot: string;
} {
  const temporaryRoot = assertContainedPath(
    join(root, ".tmp"),
    root,
    "Workspace temporary root escaped the worktree",
  );
  const ownerRoot = assertContainedPath(
    join(temporaryRoot, "api-deployment-contract"),
    root,
    "API temporary owner escaped the worktree",
  );
  return { ownerRoot, temporaryRoot };
}

async function verifyExistingDirectory(
  candidate: string,
  workspace: VerifiedWorkspace,
): Promise<VerifiedDirectory | undefined> {
  try {
    return await verifiedPhysicalDirectory(candidate, workspace);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}

async function ensureVerifiedDirectory(
  candidate: string,
  workspace: VerifiedWorkspace,
): Promise<VerifiedDirectory> {
  const existing = await verifyExistingDirectory(candidate, workspace);
  if (existing !== undefined) return existing;
  try {
    await mkdir(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return verifiedPhysicalDirectory(candidate, workspace);
}

async function prepareTemporaryContext(
  root: string,
  afterTemporaryRootVerified?: () => Promise<void>,
): Promise<{
  readonly owner: VerifiedDirectory;
  readonly temporary: VerifiedDirectory;
  readonly workspace: VerifiedWorkspace;
}> {
  const workspace = await verifiedWorkspaceRoot(root);
  const layout = temporaryLayout(workspace.lexicalRoot);
  await ensureVerifiedDirectory(layout.temporaryRoot, workspace);
  if (afterTemporaryRootVerified !== undefined) {
    await afterTemporaryRootVerified();
  }

  let lastNotFound: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const currentWorkspace = await verifiedWorkspaceRoot(
        workspace.lexicalRoot,
        workspace,
      );
      const temporary = await ensureVerifiedDirectory(
        layout.temporaryRoot,
        currentWorkspace,
      );
      const owner = await ensureVerifiedDirectory(
        layout.ownerRoot,
        currentWorkspace,
      );
      assertPhysicalContainment(
        owner.physicalCandidate,
        temporary.physicalCandidate,
      );
      return { owner, temporary, workspace: currentWorkspace };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      lastNotFound = error;
    }
  }
  throw new Error("API temporary owner could not be stabilized", {
    cause: lastNotFound,
  });
}

async function verifiedTemporaryContext(
  root: string,
  expected?: Pick<
    TemporaryOwnershipRecord,
    "owner" | "temporary" | "workspace"
  >,
): Promise<{
  readonly owner: VerifiedDirectory;
  readonly temporary: VerifiedDirectory;
  readonly workspace: VerifiedWorkspace;
}> {
  const workspace = await verifiedWorkspaceRoot(root, expected?.workspace);
  const layout = temporaryLayout(workspace.lexicalRoot);
  const temporary = await verifiedPhysicalDirectory(
    layout.temporaryRoot,
    workspace,
    expected?.temporary,
  );
  const owner = await verifiedPhysicalDirectory(
    layout.ownerRoot,
    workspace,
    expected?.owner,
  );
  assertPhysicalContainment(
    owner.physicalCandidate,
    temporary.physicalCandidate,
  );
  return { owner, temporary, workspace };
}

async function verifiedRunContext(
  directory: string,
  options: TemporaryOptions = {},
): Promise<{
  readonly owner: VerifiedDirectory;
  readonly run: VerifiedDirectory;
  readonly temporary: VerifiedDirectory;
  readonly workspace: VerifiedWorkspace;
}> {
  const record = temporaryOwnershipRecord(directory, options);
  return verifyOwnedHierarchy(record);
}

async function verifiedPhysicalFile(
  candidate: string,
  run: VerifiedDirectory,
  workspace: VerifiedWorkspace,
  expected?: VerifiedFile,
): Promise<VerifiedFile> {
  const lexicalCandidate = assertContainedPath(
    candidate,
    run.lexicalCandidate,
    "Temporary fixture file escaped its run directory",
  );
  const candidateStats = await lstat(lexicalCandidate, { bigint: true });
  if (!candidateStats.isFile() || candidateStats.isSymbolicLink()) {
    throw new Error(
      "Temporary fixture file cannot be symbolic or reparse-linked",
    );
  }
  const physicalCandidate = await realpath(lexicalCandidate);
  assertPhysicalContainment(physicalCandidate, run.physicalCandidate);
  assertPhysicalContainment(physicalCandidate, workspace.physicalRoot);
  const identity = fileIdentity(candidateStats);
  if (expected !== undefined) {
    if (
      lexicalCandidate !== expected.lexicalCandidate ||
      physicalCandidate !== expected.physicalCandidate
    ) {
      throw new Error("Temporary fixture file was replaced");
    }
    assertIdentity(identity, expected.identity, "Temporary fixture file");
  }
  return { identity, lexicalCandidate, physicalCandidate };
}

function temporaryOwnershipRecord(
  directory: string,
  options: TemporaryOptions = {},
): TemporaryOwnershipRecord {
  const root = resolve(options.repositoryRoot ?? repositoryRoot);
  const lexicalDirectory = resolve(directory);
  const tracked = temporaryDirectories.find(
    (candidate) =>
      candidate.directory === lexicalDirectory &&
      candidate.repositoryRoot === root,
  );
  const record =
    tracked === undefined
      ? undefined
      : temporaryOwnershipRecords.get(tracked.ownership);
  if (
    record === undefined ||
    record.directory.lexicalCandidate !== lexicalDirectory
  ) {
    throw new Error(
      "API fixture ownership or physical run record does not match",
    );
  }
  return record;
}

async function runTemporaryInterlock(
  options: TemporaryOptions,
  phase: string,
  path: string,
  name?: string,
): Promise<void> {
  await options.interlock?.({ name, path, phase });
}

async function verifyOwnedHierarchy(
  record: TemporaryOwnershipRecord,
): Promise<{
  readonly owner: VerifiedDirectory;
  readonly run: VerifiedDirectory;
  readonly temporary: VerifiedDirectory;
  readonly workspace: VerifiedWorkspace;
}> {
  const context = await verifiedTemporaryContext(record.workspace.lexicalRoot, {
    owner: record.owner,
    temporary: record.temporary,
    workspace: record.workspace,
  });
  const run = await verifiedPhysicalDirectory(
    record.directory.lexicalCandidate,
    context.workspace,
    record.directory,
  );
  assertPhysicalContainment(
    run.physicalCandidate,
    context.owner.physicalCandidate,
  );
  return { ...context, run };
}

async function openedRegularIdentity(
  handle: FileHandle,
  label: string,
): Promise<FileIdentity> {
  const stats = await handle.stat({ bigint: true });
  if (!stats.isFile()) throw new Error(`${label} is not a regular file`);
  return fileIdentity(stats);
}

async function readAndVerifyOwnershipMarker(
  record: TemporaryOwnershipRecord,
): Promise<void> {
  const marker = record.entries.get(OWNERSHIP_MARKER);
  if (marker === undefined || marker.kind !== "file") {
    throw new Error("API fixture ownership marker is missing");
  }
  const current = await verifyOwnedHierarchy(record);
  await verifiedPhysicalFile(
    marker.lexicalCandidate,
    current.run,
    current.workspace,
    marker,
  );
  const handle = await open(marker.lexicalCandidate, "r");
  try {
    assertIdentity(
      await openedRegularIdentity(handle, "API fixture ownership marker"),
      marker.identity,
      "API fixture ownership marker",
    );
    if ((await handle.readFile({ encoding: "utf8" })) !== record.markerToken) {
      throw new Error("API fixture ownership marker token does not match");
    }
    const refreshed = await verifyOwnedHierarchy(record);
    await verifiedPhysicalFile(
      marker.lexicalCandidate,
      refreshed.run,
      refreshed.workspace,
      marker,
    );
    assertIdentity(
      await openedRegularIdentity(handle, "API fixture ownership marker"),
      marker.identity,
      "API fixture ownership marker",
    );
  } finally {
    await handle.close();
  }
}

async function scanTemporaryTree(
  record: TemporaryOwnershipRecord,
): Promise<Map<string, VerifiedTreeEntry>> {
  const context = await verifyOwnedHierarchy(record);
  const entries = new Map<string, VerifiedTreeEntry>();

  async function walk(current: VerifiedDirectory): Promise<void> {
    for (const entry of await readdir(current.lexicalCandidate, {
      withFileTypes: true,
    })) {
      const path = assertContainedPath(
        join(current.lexicalCandidate, entry.name),
        context.run.lexicalCandidate,
        "Temporary fixture entry escaped its run directory",
      );
      if (entry.isSymbolicLink()) {
        throw new Error(
          "Temporary fixture entry cannot be symbolic or reparse-linked",
        );
      }
      const relativePath = relative(context.run.lexicalCandidate, path);
      if (entry.isDirectory()) {
        const directory = await verifiedPhysicalDirectory(
          path,
          context.workspace,
        );
        assertPhysicalContainment(
          directory.physicalCandidate,
          context.run.physicalCandidate,
        );
        entries.set(relativePath, {
          ...directory,
          kind: "directory",
          relativePath,
        });
        await walk(directory);
      } else if (entry.isFile()) {
        const file = await verifiedPhysicalFile(
          path,
          context.run,
          context.workspace,
        );
        entries.set(relativePath, {
          ...file,
          kind: "file",
          relativePath,
        });
      } else {
        throw new Error("Temporary fixture entry must be a file or directory");
      }
    }
  }

  await walk(context.run);
  await verifyOwnedHierarchy(record);
  return entries;
}

function assertTreeEntry(
  actual: VerifiedTreeEntry,
  expected: VerifiedTreeEntry,
): void {
  if (
    actual.kind !== expected.kind ||
    actual.lexicalCandidate !== expected.lexicalCandidate ||
    actual.physicalCandidate !== expected.physicalCandidate
  ) {
    throw new Error("Temporary tree manifest entry was replaced");
  }
  assertIdentity(actual.identity, expected.identity, "Temporary tree entry");
}

async function verifyExactTemporaryTree(
  record: TemporaryOwnershipRecord,
): Promise<void> {
  const actual = await scanTemporaryTree(record);
  const expectedNames = [...record.entries.keys()].sort();
  const actualNames = [...actual.keys()].sort();
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error("Temporary tree contains an unexpected manifest entry");
  }
  for (const name of expectedNames) {
    assertTreeEntry(actual.get(name)!, record.entries.get(name)!);
  }
  await readAndVerifyOwnershipMarker(record);
}

async function verifyTemporaryTree(
  directory: string,
  options: TemporaryOptions = {},
): Promise<Awaited<ReturnType<typeof verifiedRunContext>>> {
  const record = temporaryOwnershipRecord(directory, options);
  await verifyExactTemporaryTree(record);
  return verifyOwnedHierarchy(record);
}

async function captureGeneratedTreeManifest(
  directory: string,
  options: TemporaryOptions = {},
): Promise<void> {
  const record = temporaryOwnershipRecord(directory, options);
  if (record.manifestSealed) {
    throw new Error("Generated tree manifest is already sealed");
  }
  await readAndVerifyOwnershipMarker(record);
  const actual = await scanTemporaryTree(record);
  for (const [name, expected] of record.entries) {
    const current = actual.get(name);
    if (current === undefined) {
      throw new Error("Temporary tree manifest entry is missing");
    }
    assertTreeEntry(current, expected);
  }
  record.entries = actual;
  record.manifestSealed = true;
  await verifyExactTemporaryTree(record);
}

async function createOwnedFixtureFile(
  record: TemporaryOwnershipRecord,
  name: string,
  contents: string,
  options: TemporaryOptions,
): Promise<VerifiedFile> {
  if (
    name.length === 0 ||
    name.includes("/") ||
    name.includes("\\") ||
    record.entries.has(name)
  ) {
    throw new Error("Invalid or duplicate API fixture file name");
  }
  if (name !== OWNERSHIP_MARKER) {
    await readAndVerifyOwnershipMarker(record);
  }
  const current = await verifyOwnedHierarchy(record);
  const path = assertContainedPath(
    join(current.run.lexicalCandidate, name),
    current.run.lexicalCandidate,
    "Temporary fixture file escaped its run directory",
  );
  try {
    const existing = await lstat(path);
    if (existing.isSymbolicLink()) {
      throw new Error(
        "Temporary fixture file cannot be symbolic or reparse-linked",
      );
    }
    throw new Error("Temporary fixture file already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await runTemporaryInterlock(options, "before-fixture-open", path, name);
  await verifyOwnedHierarchy(record);

  const handle = await open(path, "wx", 0o600);
  let file: VerifiedFile;
  try {
    const identity = await openedRegularIdentity(handle, "API fixture file");
    file = Object.freeze({
      identity,
      lexicalCandidate: path,
      physicalCandidate: path,
    });
    record.entries.set(name, {
      ...file,
      kind: "file",
      relativePath: name,
    });
    await runTemporaryInterlock(options, "after-fixture-open", path, name);

    const refreshed = await verifyOwnedHierarchy(record);
    const verified = await verifiedPhysicalFile(
      path,
      refreshed.run,
      refreshed.workspace,
    );
    assertIdentity(verified.identity, identity, "API fixture file");
    assertIdentity(
      await openedRegularIdentity(handle, "API fixture file"),
      identity,
      "API fixture file",
    );
    file = Object.freeze({ ...verified, identity });
    record.entries.set(name, {
      ...file,
      kind: "file",
      relativePath: name,
    });
    if (name !== OWNERSHIP_MARKER) {
      await readAndVerifyOwnershipMarker(record);
    }

    await handle.writeFile(contents, { encoding: "utf8" });
    await handle.sync();
    assertIdentity(
      await openedRegularIdentity(handle, "API fixture file"),
      identity,
      "API fixture file",
    );
  } finally {
    await handle.close();
  }

  const written = await verifyOwnedHierarchy(record);
  await verifiedPhysicalFile(
    path,
    written.run,
    written.workspace,
    file!,
  );
  return file!;
}

async function createTemporaryDirectory(
  prefix: string,
  options: TemporaryOptions = {},
): Promise<string> {
  const root = resolve(options.repositoryRoot ?? repositoryRoot);
  let lastNotFound: unknown;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const context = await prepareTemporaryContext(
      root,
      attempt === 0 ? options.afterTemporaryRootVerified : undefined,
    );
    try {
      const directoryPath = assertContainedPath(
        await mkdtemp(join(context.owner.lexicalCandidate, prefix)),
        context.owner.lexicalCandidate,
        "Generated temporary directory escaped its owner",
      );
      const directory = await verifiedPhysicalDirectory(
        directoryPath,
        context.workspace,
      );
      assertPhysicalContainment(
        directory.physicalCandidate,
        context.owner.physicalCandidate,
      );
      const ownership = Object.freeze(Object.create(null)) as object;
      const ownershipRecord: TemporaryOwnershipRecord = {
        directory,
        entries: new Map(),
        manifestSealed: false,
        markerToken: randomBytes(32).toString("base64url"),
        owner: context.owner,
        ownership,
        temporary: context.temporary,
        workspace: context.workspace,
      };
      temporaryOwnershipRecords.set(ownership, ownershipRecord);
      temporaryDirectories.push({
        directory: directory.lexicalCandidate,
        ownership,
        repositoryRoot: context.workspace.lexicalRoot,
      });
      await createOwnedFixtureFile(
        ownershipRecord,
        OWNERSHIP_MARKER,
        ownershipRecord.markerToken,
        { repositoryRoot: root },
      );
      return directory.lexicalCandidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      lastNotFound = error;
    }
  }
  throw new Error("API temporary run could not be created", {
    cause: lastNotFound,
  });
}

async function writeTemporaryFixture(
  directory: string,
  path: string,
  contents: string,
  options: TemporaryOptions = {},
): Promise<void> {
  const record = temporaryOwnershipRecord(directory, options);
  const context = await verifyOwnedHierarchy(record);
  const fixturePath = assertContainedPath(
    path,
    context.run.lexicalCandidate,
    "Temporary fixture file escaped its run directory",
  );
  const name = relative(context.run.lexicalCandidate, fixturePath);
  await createOwnedFixtureFile(record, name, contents, options);
}

async function removeOwnedFile(
  record: TemporaryOwnershipRecord,
  entry: VerifiedTreeEntry,
  options: TemporaryOptions,
): Promise<void> {
  if (entry.kind !== "file") throw new Error("Cleanup entry is not a file");
  if (entry.relativePath !== OWNERSHIP_MARKER) {
    await readAndVerifyOwnershipMarker(record);
  }
  const current = await verifyOwnedHierarchy(record);
  await verifiedPhysicalFile(
    entry.lexicalCandidate,
    current.run,
    current.workspace,
    entry,
  );
  const handle = await open(entry.lexicalCandidate, "r");
  try {
    assertIdentity(
      await openedRegularIdentity(handle, "API cleanup file"),
      entry.identity,
      "API cleanup file",
    );
    await runTemporaryInterlock(
      options,
      "after-cleanup-file-open",
      entry.lexicalCandidate,
      entry.relativePath,
    );
    const refreshed = await verifyOwnedHierarchy(record);
    await verifiedPhysicalFile(
      entry.lexicalCandidate,
      refreshed.run,
      refreshed.workspace,
      entry,
    );
    assertIdentity(
      await openedRegularIdentity(handle, "API cleanup file"),
      entry.identity,
      "API cleanup file",
    );
    if (entry.relativePath === OWNERSHIP_MARKER) {
      if (
        (await handle.readFile({ encoding: "utf8" })) !== record.markerToken
      ) {
        throw new Error("API fixture ownership marker token does not match");
      }
    } else {
      await readAndVerifyOwnershipMarker(record);
    }
    await unlink(entry.lexicalCandidate);
  } finally {
    await handle.close();
  }
  try {
    await lstat(entry.lexicalCandidate);
    throw new Error("API cleanup file still exists after unlink");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  record.entries.delete(entry.relativePath);
}

async function removeOwnedDirectory(
  record: TemporaryOwnershipRecord,
  entry: VerifiedTreeEntry,
): Promise<void> {
  if (entry.kind !== "directory") {
    throw new Error("Cleanup entry is not a directory");
  }
  await readAndVerifyOwnershipMarker(record);
  const current = await verifyOwnedHierarchy(record);
  const directory = await verifiedPhysicalDirectory(
    entry.lexicalCandidate,
    current.workspace,
    entry,
  );
  assertPhysicalContainment(
    directory.physicalCandidate,
    current.run.physicalCandidate,
  );
  if ((await readdir(directory.lexicalCandidate)).length !== 0) {
    throw new Error("Temporary manifest directory is not empty");
  }
  await rmdir(directory.lexicalCandidate);
  record.entries.delete(entry.relativePath);
}

async function removeEmptyRecordedDirectory(
  directory: VerifiedDirectory,
  workspace: VerifiedWorkspace,
): Promise<void> {
  try {
    await verifiedPhysicalDirectory(
      directory.lexicalCandidate,
      workspace,
      directory,
    );
    await rmdir(directory.lexicalCandidate);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
      throw error;
    }
  }
}

function entryDepth(entry: VerifiedTreeEntry): number {
  return entry.relativePath.split(/[\\/]/u).length;
}

function forgetTemporaryRecord(record: TemporaryOwnershipRecord): void {
  const index = temporaryDirectories.findIndex(
    (candidate) => candidate.ownership === record.ownership,
  );
  if (index >= 0) temporaryDirectories.splice(index, 1);
  temporaryOwnershipRecords.delete(record.ownership);
}

async function removeTemporaryDirectory(
  directory: string,
  options: TemporaryOptions = {},
): Promise<void> {
  const record = temporaryOwnershipRecord(directory, options);
  await verifyExactTemporaryTree(record);
  await runTemporaryInterlock(
    options,
    "after-cleanup-manifest-verified",
    record.directory.lexicalCandidate,
  );
  await verifyExactTemporaryTree(record);

  const files = [...record.entries.values()]
    .filter(
      (entry) =>
        entry.kind === "file" && entry.relativePath !== OWNERSHIP_MARKER,
    )
    .sort(
      (left, right) =>
        entryDepth(right) - entryDepth(left) ||
        right.relativePath.localeCompare(left.relativePath),
    );
  for (const entry of files) {
    await removeOwnedFile(record, entry, options);
  }

  const directories = [...record.entries.values()]
    .filter((entry) => entry.kind === "directory")
    .sort(
      (left, right) =>
        entryDepth(right) - entryDepth(left) ||
        right.relativePath.localeCompare(left.relativePath),
    );
  for (const entry of directories) {
    await removeOwnedDirectory(record, entry);
  }

  await readAndVerifyOwnershipMarker(record);
  const marker = record.entries.get(OWNERSHIP_MARKER);
  if (marker === undefined) {
    throw new Error("API fixture ownership marker is missing");
  }
  await removeOwnedFile(record, marker, options);

  const current = await verifyOwnedHierarchy(record);
  if ((await readdir(current.run.lexicalCandidate)).length !== 0) {
    throw new Error("API fixture run is not empty after manifest cleanup");
  }
  await rmdir(current.run.lexicalCandidate);
  const workspace = await verifiedWorkspaceRoot(
    record.workspace.lexicalRoot,
    record.workspace,
  );
  await removeEmptyRecordedDirectory(record.owner, workspace);
  await removeEmptyRecordedDirectory(record.temporary, workspace);
  forgetTemporaryRecord(record);
}

async function filesRecursively(directory: string): Promise<string[]> {
  const record = temporaryOwnershipRecord(directory);
  await verifyExactTemporaryTree(record);
  return [...record.entries.values()]
    .filter(
      (entry) =>
        entry.kind === "file" && entry.relativePath !== OWNERSHIP_MARKER,
    )
    .map((entry) => entry.lexicalCandidate)
    .sort();
}

afterEach(async () => {
  const records = [...temporaryDirectories];
  for (const record of records) {
    try {
      await removeTemporaryDirectory(record.directory, {
        repositoryRoot: record.repositoryRoot,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const ownership = temporaryOwnershipRecords.get(record.ownership);
      if (ownership !== undefined) forgetTemporaryRecord(ownership);
    }
  }
});

async function createFilesystemRaceFixture(prefix: string): Promise<{
  readonly externalMarker: string;
  readonly fixtureRoot: string;
  readonly outside: string;
  readonly workspace: string;
}> {
  const outerTemporaryRoot = join(
    repositoryRoot,
    ".superpowers",
    "sdd",
    "task-6-api-fixture-filesystem-tmp",
  );
  await mkdir(outerTemporaryRoot, { recursive: true });
  const fixtureRoot = await mkdtemp(join(outerTemporaryRoot, prefix));
  const workspace = join(fixtureRoot, "workspace");
  const outside = join(fixtureRoot, "outside");
  const externalMarker = join(outside, "external-marker");
  await mkdir(workspace);
  await mkdir(outside);
  await writeFile(externalMarker, "preserve");
  return { externalMarker, fixtureRoot, outside, workspace };
}

async function removeSyntheticFixtureTree(directory: string): Promise<void> {
  const workspace = await verifiedWorkspaceRoot(repositoryRoot);
  const lexicalRoot = assertContainedPath(
    directory,
    workspace.lexicalRoot,
    "Synthetic fixture root escaped the worktree",
  );
  const rootStats = await lstat(lexicalRoot, { bigint: true });
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error("Synthetic fixture root is not a regular directory");
  }
  const rootIdentity = fileIdentity(rootStats);
  const physicalRoot = await realpath(lexicalRoot);
  assertPhysicalContainment(physicalRoot, workspace.physicalRoot);
  const lexicalParent = dirname(lexicalRoot);
  const parent = await verifiedPhysicalDirectory(lexicalParent, workspace);
  const manifest: Array<{
    readonly identity: FileIdentity;
    readonly kind: "directory" | "file" | "link";
    readonly path: string;
  }> = [];

  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = assertContainedPath(
        join(current, entry.name),
        lexicalRoot,
        "Synthetic fixture entry escaped its root",
      );
      const stats = await lstat(path, { bigint: true });
      const identity = fileIdentity(stats);
      if (stats.isSymbolicLink()) {
        manifest.push({ identity, kind: "link", path });
      } else if (stats.isFile()) {
        const physicalPath = await realpath(path);
        assertPhysicalContainment(physicalPath, physicalRoot);
        manifest.push({ identity, kind: "file", path });
      } else if (stats.isDirectory()) {
        const physicalPath = await realpath(path);
        assertPhysicalContainment(physicalPath, physicalRoot);
        manifest.push({ identity, kind: "directory", path });
        await walk(path);
      } else {
        throw new Error("Synthetic fixture entry has an unsupported type");
      }
    }
  }

  await walk(lexicalRoot);
  assertIdentity(
    fileIdentity(await lstat(lexicalRoot, { bigint: true })),
    rootIdentity,
    "Synthetic fixture root",
  );
  const byDepth = (left: { path: string }, right: { path: string }) =>
    right.path.split(/[\\/]/u).length - left.path.split(/[\\/]/u).length ||
    right.path.localeCompare(left.path);
  for (const entry of manifest
    .filter((candidate) => candidate.kind !== "directory")
    .sort(byDepth)) {
    const current = await lstat(entry.path, { bigint: true });
    const kind = current.isSymbolicLink()
      ? "link"
      : current.isFile()
        ? "file"
        : "other";
    if (kind !== entry.kind) {
      throw new Error("Synthetic fixture entry type was replaced");
    }
    assertIdentity(
      fileIdentity(current),
      entry.identity,
      "Synthetic fixture entry",
    );
    await unlink(entry.path);
  }
  for (const entry of manifest
    .filter((candidate) => candidate.kind === "directory")
    .sort(byDepth)) {
    const current = await lstat(entry.path, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink()) {
      throw new Error("Synthetic fixture directory was replaced");
    }
    assertIdentity(
      fileIdentity(current),
      entry.identity,
      "Synthetic fixture directory",
    );
    if ((await readdir(entry.path)).length !== 0) {
      throw new Error("Synthetic fixture directory changed after scan");
    }
    await rmdir(entry.path);
  }
  const finalRootStats = await lstat(lexicalRoot, { bigint: true });
  if (!finalRootStats.isDirectory() || finalRootStats.isSymbolicLink()) {
    throw new Error("Synthetic fixture root was replaced");
  }
  assertIdentity(
    fileIdentity(finalRootStats),
    rootIdentity,
    "Synthetic fixture root",
  );
  if ((await readdir(lexicalRoot)).length !== 0) {
    throw new Error("Synthetic fixture root changed after scan");
  }
  await rmdir(lexicalRoot);
  try {
    await verifiedPhysicalDirectory(
      parent.lexicalCandidate,
      workspace,
      parent,
    );
    await rmdir(parent.lexicalCandidate);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
      throw error;
    }
  }
}

describe("TF deployment identity contract", () => {
  it("keeps API deployment fixtures under the suite-owned parent", async () => {
    const directory = await createTemporaryDirectory(
      "apollo-tf-api-ownership-",
    );
    const fromOwner = relative(apiDeploymentTemporaryRoot, directory);

    expect(fromOwner).not.toBe("..");
    expect(fromOwner.startsWith(`..${sep}`)).toBe(false);
  });

  it("creates a per-run ownership marker before fixture data", async () => {
    const directory = await createTemporaryDirectory(
      "apollo-tf-api-marker-",
    );

    expect(await readdir(directory)).toEqual([
      ".api-deployment-contract-owner",
    ]);
  });

  it("recreates an empty temp root removed before owner creation", async () => {
    const outerTemporaryRoot = join(
      repositoryRoot,
      ".superpowers",
      "sdd",
      "task-5-api-owner-race-tmp",
    );
    await mkdir(outerTemporaryRoot, { recursive: true });
    const fixtureRoot = await mkdtemp(
      join(outerTemporaryRoot, "api-owner-race-"),
    );
    const workspace = join(fixtureRoot, "workspace");
    const temporaryRoot = join(workspace, ".tmp");
    const expectedOwner = join(temporaryRoot, "api-deployment-contract");
    let interleavingObserved = 0;

    await mkdir(workspace);
    try {
      const directory = await createTemporaryDirectory("owner-race-", {
        repositoryRoot: workspace,
        afterTemporaryRootVerified: async () => {
          expect((await lstat(temporaryRoot)).isDirectory()).toBe(true);
          await rmdir(temporaryRoot);
          interleavingObserved += 1;
        },
      });

      expect(interleavingObserved).toBe(1);
      const fromOwner = relative(expectedOwner, directory);
      expect(fromOwner).not.toBe("..");
      expect(fromOwner.startsWith(`..${sep}`)).toBe(false);
    } finally {
      await removeSyntheticFixtureTree(fixtureRoot);
      await rmdir(outerTemporaryRoot).catch((error: unknown) => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
          throw error;
        }
      });
    }
  });

  it("rejects linked temp roots, owner parents, and run directories", async ({
    skip,
  }) => {
    const outerTemporaryRoot = join(
      repositoryRoot,
      ".superpowers",
      "sdd",
      "task-5-api-physical-containment-tmp",
    );
    await mkdir(outerTemporaryRoot, { recursive: true });
    const fixtureRoot = await mkdtemp(
      join(outerTemporaryRoot, "api-containment-"),
    );
    const workspace = join(fixtureRoot, "workspace");
    const outside = join(fixtureRoot, "outside");
    const marker = join(outside, "marker");
    const linkedTemporaryRoot = join(workspace, ".tmp");
    const linkedOwner = join(linkedTemporaryRoot, "api-deployment-contract");
    const linkedRun = join(linkedOwner, `linked-run-${randomUUID()}`);
    const linkType = process.platform === "win32" ? "junction" : "dir";
    let temporaryRootIsLink = false;
    let ownerIsLink = false;
    let runIsLink = false;

    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(marker, "preserve");
    try {
      try {
        await symlink(outside, linkedTemporaryRoot, linkType);
        temporaryRootIsLink = true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "EACCES") {
          skip();
          return;
        }
        throw error;
      }

      await expect(
        createTemporaryDirectory("linked-root-", {
          repositoryRoot: workspace,
        }),
      ).rejects.toThrow(/symbolic|reparse|physical/i);
      expect(await readFile(marker, "utf8")).toBe("preserve");

      await unlink(linkedTemporaryRoot);
      temporaryRootIsLink = false;
      await mkdir(linkedTemporaryRoot);
      await symlink(outside, linkedOwner, linkType);
      ownerIsLink = true;

      await expect(
        createTemporaryDirectory("linked-owner-", {
          repositoryRoot: workspace,
        }),
      ).rejects.toThrow(/symbolic|reparse|physical/i);
      expect(await readFile(marker, "utf8")).toBe("preserve");

      await unlink(linkedOwner);
      ownerIsLink = false;
      await mkdir(linkedOwner);
      await symlink(outside, linkedRun, linkType);
      runIsLink = true;

      await expect(
        removeTemporaryDirectory(linkedRun, { repositoryRoot: workspace }),
      ).rejects.toThrow(/symbolic|reparse|physical/i);
      expect(await readFile(marker, "utf8")).toBe("preserve");
    } finally {
      if (runIsLink) await unlink(linkedRun).catch(() => undefined);
      if (ownerIsLink) await unlink(linkedOwner).catch(() => undefined);
      if (temporaryRootIsLink) {
        await unlink(linkedTemporaryRoot).catch(() => undefined);
      }
      await removeSyntheticFixtureTree(fixtureRoot);
      await rmdir(outerTemporaryRoot).catch((error: unknown) => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
          throw error;
        }
      });
    }
  });

  it("rejects a linked fixture file without overwriting its target", async ({
    skip,
  }) => {
    const outerTemporaryRoot = join(
      repositoryRoot,
      ".superpowers",
      "sdd",
      "task-5-api-physical-containment-tmp",
    );
    await mkdir(outerTemporaryRoot, { recursive: true });
    const fixtureRoot = await mkdtemp(
      join(outerTemporaryRoot, "api-file-containment-"),
    );
    const workspace = join(fixtureRoot, "workspace");
    const outside = join(fixtureRoot, "outside");
    const marker = join(outside, "marker");
    let linkedFile = "";
    let fileIsLink = false;

    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(marker, "preserve");
    try {
      const directory = await createTemporaryDirectory("linked-file-", {
        repositoryRoot: workspace,
      });
      linkedFile = join(directory, "fixture");
      try {
        await symlink(marker, linkedFile, "file");
        fileIsLink = true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "EACCES") {
          skip();
          return;
        }
        throw error;
      }

      await expect(
        writeTemporaryFixture(directory, linkedFile, "overwrite", {
          repositoryRoot: workspace,
        }),
      ).rejects.toThrow(/symbolic|reparse|physical/i);
      expect(await readFile(marker, "utf8")).toBe("preserve");
    } finally {
      if (fileIsLink) await unlink(linkedFile).catch(() => undefined);
      await removeSyntheticFixtureTree(fixtureRoot);
      await rmdir(outerTemporaryRoot).catch((error: unknown) => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
          throw error;
        }
      });
    }
  });

  it("rejects run replacement between verification and fixture open", async ({
    skip,
  }) => {
    const fixture = await createFilesystemRaceFixture("run-write-race-");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    let directory = "";
    let displacedRun = "";
    let runIsLink = false;
    let interlocked = false;

    try {
      directory = await createTemporaryDirectory("run-write-", {
        repositoryRoot: fixture.workspace,
      });
      displacedRun = `${directory}-original`;
      await expect(
        writeTemporaryFixture(
          directory,
          join(directory, "fixture"),
          "sensitive-canary",
          {
            repositoryRoot: fixture.workspace,
            interlock: async ({ path, phase }) => {
              if (phase !== "before-fixture-open") return;
              interlocked = true;
              await rename(directory, displacedRun);
              try {
                await symlink(fixture.outside, directory, linkType);
                runIsLink = true;
              } catch (error) {
                await rename(displacedRun, directory);
                const code = (error as NodeJS.ErrnoException).code;
                if (code === "EPERM" || code === "EACCES") {
                  skip();
                  return;
                }
                throw error;
              }
              expect(path).toBe(join(directory, "fixture"));
            },
          },
        ),
      ).rejects.toThrow(/identity|physical|reparse|replaced|symbolic/i);
      expect(interlocked).toBe(true);
      expect(await readFile(fixture.externalMarker, "utf8")).toBe("preserve");
      expect(await readdir(fixture.outside)).toEqual(["external-marker"]);
    } finally {
      if (runIsLink) {
        await unlink(directory).catch(() => undefined);
        await rename(displacedRun, directory).catch(() => undefined);
      }
      await removeSyntheticFixtureTree(fixture.fixtureRoot);
    }
  });

  it("rejects file replacement after exclusive open without writing outside", async () => {
    const fixture = await createFilesystemRaceFixture("file-write-race-");
    let directory = "";
    let displacedFile = "";
    let fixturePath = "";
    let interlocked = false;

    try {
      directory = await createTemporaryDirectory("file-write-", {
        repositoryRoot: fixture.workspace,
      });
      fixturePath = join(directory, "fixture");
      displacedFile = `${fixturePath}-original`;
      await expect(
        writeTemporaryFixture(directory, fixturePath, "sensitive-canary", {
          repositoryRoot: fixture.workspace,
          interlock: async ({ name, path, phase }) => {
            if (phase !== "after-fixture-open" || name !== "fixture") return;
            interlocked = true;
            await rename(path, displacedFile);
            await link(fixture.externalMarker, path);
          },
        }),
      ).rejects.toThrow(/identity|replaced/i);
      expect(interlocked).toBe(true);
      expect(await readFile(fixture.externalMarker, "utf8")).toBe("preserve");
      expect(await readFile(displacedFile, "utf8")).toBe("");
    } finally {
      if (fixturePath.length > 0 && displacedFile.length > 0) {
        await unlink(fixturePath).catch(() => undefined);
        await rename(displacedFile, fixturePath).catch(() => undefined);
      }
      await removeSyntheticFixtureTree(fixture.fixtureRoot);
    }
  });

  it("rejects run replacement between manifest verification and cleanup", async ({
    skip,
  }) => {
    const fixture = await createFilesystemRaceFixture("run-cleanup-race-");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    let directory = "";
    let displacedRun = "";
    let runIsLink = false;
    let interlocked = false;

    try {
      directory = await createTemporaryDirectory("run-cleanup-", {
        repositoryRoot: fixture.workspace,
      });
      displacedRun = `${directory}-original`;
      await writeTemporaryFixture(
        directory,
        join(directory, "fixture"),
        "owned",
        { repositoryRoot: fixture.workspace },
      );
      await expect(
        removeTemporaryDirectory(directory, {
          repositoryRoot: fixture.workspace,
          interlock: async ({ phase }) => {
            if (phase !== "after-cleanup-manifest-verified") return;
            interlocked = true;
            await rename(directory, displacedRun);
            try {
              await symlink(fixture.outside, directory, linkType);
              runIsLink = true;
            } catch (error) {
              await rename(displacedRun, directory);
              const code = (error as NodeJS.ErrnoException).code;
              if (code === "EPERM" || code === "EACCES") {
                skip();
                return;
              }
              throw error;
            }
          },
        }),
      ).rejects.toThrow(/identity|physical|reparse|replaced|symbolic/i);
      expect(interlocked).toBe(true);
      expect(await readFile(fixture.externalMarker, "utf8")).toBe("preserve");
      expect(await readdir(fixture.outside)).toEqual(["external-marker"]);
    } finally {
      if (runIsLink) {
        await unlink(directory).catch(() => undefined);
        await rename(displacedRun, directory).catch(() => undefined);
      }
      await removeSyntheticFixtureTree(fixture.fixtureRoot);
    }
  });

  it("rejects file replacement between verification and unlink", async () => {
    const fixture = await createFilesystemRaceFixture("file-cleanup-race-");
    let directory = "";
    let displacedFile = "";
    let fixturePath = "";
    let interlocked = false;

    try {
      directory = await createTemporaryDirectory("file-cleanup-", {
        repositoryRoot: fixture.workspace,
      });
      fixturePath = join(directory, "fixture");
      displacedFile = `${fixturePath}-original`;
      await writeTemporaryFixture(directory, fixturePath, "owned", {
        repositoryRoot: fixture.workspace,
      });
      await expect(
        removeTemporaryDirectory(directory, {
          repositoryRoot: fixture.workspace,
          interlock: async ({ name, path, phase }) => {
            if (phase !== "after-cleanup-file-open" || name !== "fixture") {
              return;
            }
            interlocked = true;
            await rename(path, displacedFile);
            await link(fixture.externalMarker, path);
          },
        }),
      ).rejects.toThrow(/identity|replaced/i);
      expect(interlocked).toBe(true);
      expect(await readFile(fixture.externalMarker, "utf8")).toBe("preserve");
      expect(await readFile(displacedFile, "utf8")).toBe("owned");
    } finally {
      if (fixturePath.length > 0 && displacedFile.length > 0) {
        await unlink(fixturePath).catch(() => undefined);
        await rename(displacedFile, fixturePath).catch(() => undefined);
      }
      await removeSyntheticFixtureTree(fixture.fixtureRoot);
    }
  });

  it("rejects cleanup when the ownership marker changes", async () => {
    const directory = await createTemporaryDirectory(
      "apollo-tf-api-marker-mismatch-",
    );
    const marker = join(directory, ".api-deployment-contract-owner");
    const originalMarker = await readFile(marker, "utf8");
    await writeFile(marker, "attacker-marker");

    await expect(removeTemporaryDirectory(directory)).rejects.toThrow(
      /marker|ownership|identity/i,
    );

    await writeFile(marker, originalMarker);
  });

  it("rejects entries added after the cleanup manifest is built", async () => {
    const directory = await createTemporaryDirectory(
      "apollo-tf-api-manifest-race-",
    );
    const generatedDirectory = join(directory, "assets");
    const generatedFile = join(generatedDirectory, "bundle.js");
    const lateFile = join(generatedDirectory, "late.js");
    await mkdir(generatedDirectory);
    await writeFile(generatedFile, "generated");
    await captureGeneratedTreeManifest(directory);

    await expect(
      removeTemporaryDirectory(directory, {
        interlock: async ({ phase }) => {
          if (phase === "after-cleanup-manifest-verified") {
            await writeFile(lateFile, "unknown");
          }
        },
      }),
    ).rejects.toThrow(/allowlist|manifest|unexpected/i);

    await unlink(lateFile);
  });

  it("preserves the root base identities while retaining Task 9 hardening", async () => {
    const template = await composeTemplate(rootComposePath);

    expect(template.name).toBeUndefined();
    expect(Object.keys(template.services).sort()).toEqual([
      "admin",
      "api",
      "db",
      "redis",
      "tf-search",
      "web",
    ]);
    expect(Object.keys(template.volumes ?? {}).sort()).toEqual([
      "pgdata",
      "redis_data",
    ]);
    expect(service(template, "db").environment).toMatchObject({
      POSTGRES_DB: "trackfinder",
      POSTGRES_PASSWORD_FILE: "/run/secrets/tf_postgres_password",
      POSTGRES_USER: "trackfinder",
    });
    expect(service(template, "db").volumes).toContain(
      "pgdata:/var/lib/postgresql/data",
    );
    expect(service(template, "api").environment).toMatchObject({
      APOLLO_MODULE_HEARTBEAT_KEYS_FILE:
        "/run/secrets/tf_module_heartbeat_keys",
      APOLLO_TF_AUTH_REDIS_URL: "redis://redis:6379/1",
      DATABASE_URL_FILE: "/run/secrets/tf_database_url",
      REDIS_URL: "redis://redis:6379/0",
      TF_SEARCH_ALLOW_INSECURE_HTTP: "true",
      TF_SEARCH_INTERNAL_AUTH_SECRET_FILE:
        "/run/secrets/tf_search_internal_auth_secret",
      TF_SEARCH_ORIGIN: "http://tf-search:8080",
    });
    expect(service(template, "api").environment).not.toHaveProperty(
      "APOLLO_MODULE_HEARTBEAT_KEYS",
    );
    expect(service(template, "api").environment).not.toHaveProperty(
      "DATABASE_URL",
    );
    expect(service(template, "api").ports).toEqual([
      "127.0.0.1:${TF_API_PORT:-8080}:8080",
    ]);
    expect(service(template, "db").ports).toBeUndefined();
    expect(service(template, "redis").ports).toBeUndefined();
    expect(service(template, "admin").environment).toMatchObject({
      APOLLO_API_UPSTREAM: "http://api:8080",
    });
    expect(service(template, "api").depends_on).toMatchObject({
      "tf-search": { condition: "service_healthy" },
    });
    expect(JSON.stringify(template)).not.toMatch(/postgres:\/\/[^"]+:[^"]+@/);
  });

  it("preserves the nested API base identities and private data services", async () => {
    const template = await composeTemplate(nestedComposePath);

    expect(template.name).toBeUndefined();
    expect(Object.keys(template.services).sort()).toEqual([
      "api",
      "db",
      "redis",
      "tf-search",
    ]);
    expect(Object.keys(template.volumes ?? {}).sort()).toEqual([
      "postgres_data",
      "redis_data",
    ]);
    expect(service(template, "db").environment).toMatchObject({
      POSTGRES_DB: "apollo_trackfinder",
      POSTGRES_PASSWORD_FILE: "/run/secrets/tf_postgres_password",
      POSTGRES_USER: "apollo",
    });
    expect(service(template, "db").volumes).toContain(
      "postgres_data:/var/lib/postgresql/data",
    );
    expect(service(template, "redis").volumes).toContain("redis_data:/data");
    expect(service(template, "api").environment).toMatchObject({
      APOLLO_MODULE_HEARTBEAT_KEYS_FILE:
        "/run/secrets/tf_module_heartbeat_keys",
      APOLLO_TF_AUTH_REDIS_URL: "redis://redis:6379/1",
      DATABASE_URL_FILE: "/run/secrets/tf_database_url",
      REDIS_URL: "redis://redis:6379/0",
      TF_SEARCH_ALLOW_INSECURE_HTTP: "true",
      TF_SEARCH_INTERNAL_AUTH_SECRET_FILE:
        "/run/secrets/tf_search_internal_auth_secret",
      TF_SEARCH_ORIGIN: "http://tf-search:8080",
    });
    expect(service(template, "api").environment).not.toHaveProperty(
      "APOLLO_MODULE_HEARTBEAT_KEYS",
    );
    expect(service(template, "api").environment).not.toHaveProperty(
      "DATABASE_URL",
    );
    expect(service(template, "api").ports).toEqual([
      "127.0.0.1:${TF_API_PORT:-8080}:8080",
    ]);
    expect(service(template, "db").ports).toBeUndefined();
    expect(service(template, "redis").ports).toBeUndefined();
    expect(service(template, "api").depends_on).toMatchObject({
      "tf-search": { condition: "service_healthy" },
    });
    expect(JSON.stringify(template)).not.toMatch(/postgres:\/\/[^"]+:[^"]+@/);

    const documentation = await readFile(modulesDocumentation, "utf8");
    expect(documentation).toContain(
      "`tf_database_url` при первом запуске обновлённого Compose обязан содержать\nтекущий пароль существующей роли",
    );
    expect(documentation).toContain(
      "замена `tf_postgres_password` сама по себе пароль роли\nне меняет",
    );
    expect(documentation).toContain("выполнить `ALTER ROLE ... PASSWORD ...`");
  });

  it("passes a non-default API URL into the Vite build and compiled bundle", async () => {
    const template = await composeTemplate(rootComposePath);
    const web = service(template, "web");
    const dockerfile = await readFile(musicPlayerDockerfile, "utf8");
    const apiOrigin = "https://tf-api.contract.invalid";

    expect(web.build?.args).toEqual({
      VITE_API_URL: "${VITE_API_URL:-https://api.tf.apollot.ru}",
    });
    expect(web.environment ?? {}).not.toHaveProperty("VITE_API_URL");
    expect(dockerfile).toContain("ARG VITE_API_URL");
    expect(dockerfile).toContain("ENV VITE_API_URL=${VITE_API_URL}");

    const outputRunDirectory = await createTemporaryDirectory(
      "apollo-tf-web-bundle-",
    );
    const outputDirectory = join(outputRunDirectory, "vite");
    await execFileAsync(
      process.execPath,
      [
        join(musicPlayerDirectory, "node_modules", "vite", "bin", "vite.js"),
        "build",
        "--config",
        "vite.config.ts",
        "--outDir",
        outputDirectory,
      ],
      {
        cwd: musicPlayerDirectory,
        env: {
          ...process.env,
          VITE_API_URL: apiOrigin,
        },
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      },
    );

    await captureGeneratedTreeManifest(outputRunDirectory);
    const bundle = (
      await Promise.all(
        (await filesRecursively(outputRunDirectory)).map((path) =>
          readFile(path, "utf8"),
        ),
      )
    ).join("\n");
    expect(bundle).toContain(apiOrigin);
  }, 60_000);

  it("loads the bounded heartbeat key map from its configured file without replacing the database contract", async () => {
    const heartbeatSecret = "h".repeat(32);
    const heartbeatMap = JSON.stringify({
      "core-api": "c".repeat(32),
      "search-media": heartbeatSecret,
    });
    const result = await runApiStartup({ heartbeatKeys: heartbeatMap });

    expect(JSON.parse(result.stdout)).toEqual({
      heartbeatModules: ["core-api", "search-media"],
      databaseHost: "db",
      databaseUser: "trackfinder",
    });
    expect(result.stderr).toBe("");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(heartbeatSecret);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(heartbeatMap);
  });

  it("rejects an inherited valid inline heartbeat map when the file selector is absent", async () => {
    const inlineSecret = "i".repeat(32);
    const inlineMap = JSON.stringify({ "search-media": inlineSecret });
    const execution = runApiStartup({
      heartbeatFileConfigured: false,
      inlineHeartbeatKeys: inlineMap,
    });

    await expect(execution).rejects.toBeDefined();
    await execution.catch((error: unknown) => {
      const output =
        typeof error === "object" && error !== null
          ? `${String((error as { stdout?: unknown }).stdout ?? "")}\n${String(
              (error as { stderr?: unknown }).stderr ?? "",
            )}`
          : "";
      expect(output.trim()).toBe("");
      expect(output).not.toContain(inlineSecret);
      expect(output).not.toContain(inlineMap);
    });
  });

  it.each([
    ["missing", undefined, "missing"],
    ["empty", "", undefined],
    ["whitespace-only", " \r\n\t", undefined],
    ["oversized", `{"search-media":"${"h".repeat(131_073)}"}`, undefined],
    ["malformed JSON", "{", undefined],
    ["array", JSON.stringify(["h".repeat(32)]), undefined],
    ["null", "null", undefined],
    [
      "missing search-media",
      JSON.stringify({ "core-api": "c".repeat(32) }),
      undefined,
    ],
    [
      "short search-media secret",
      JSON.stringify({ "search-media": "h".repeat(31) }),
      undefined,
    ],
    [
      "long search-media secret",
      JSON.stringify({ "search-media": "h".repeat(513) }),
      undefined,
    ],
    [
      "nested secret structure",
      JSON.stringify({ "search-media": { secret: "h".repeat(32) } }),
      undefined,
    ],
    [
      "unknown module",
      JSON.stringify({
        "search-media": "h".repeat(32),
        "unknown-module": "u".repeat(32),
      }),
      undefined,
    ],
  ])(
    "rejects a %s heartbeat map before starting the API",
    async (_label, heartbeatKeys, heartbeatPathKind) => {
      const outsideMissingPath = resolve(
        temporaryRoot,
        `apollo-missing-heartbeat-${process.pid}`,
      );
      const execution = runApiStartup({
        ...(heartbeatKeys === undefined ? {} : { heartbeatKeys }),
        ...(heartbeatPathKind === "missing"
          ? { heartbeatPath: outsideMissingPath }
          : {}),
      });
      await expect(execution).rejects.toBeDefined();
      await execution.catch((error: unknown) => {
        const output =
          typeof error === "object" && error !== null
            ? `${String((error as { stdout?: unknown }).stdout ?? "")}\n${String(
                (error as { stderr?: unknown }).stderr ?? "",
              )}`
            : "";
        expect(output.trim()).toBe("");
      });
    },
  );

  it("documents the exact file-backed search boundary and one-replica limitation", async () => {
    const documentation = await readFile(modulesDocumentation, "utf8");

    for (const secret of [
      "tf_search_internal_auth_secret",
      "tf_search_heartbeat_secret",
      "tf_module_heartbeat_keys",
    ]) {
      expect(documentation).toContain(`\`${secret}\``);
    }
    expect(documentation).toContain("одна реплика");
    expect(documentation).toContain("2 048");
    expect(documentation).toContain("один час");
    expect(documentation).toContain("http://tf-search:8080");
    expect(documentation).toContain("HTTPS");
    expect(documentation).toContain("синхронизац");
    expect(documentation).toContain("домен не нужен");
    expect(documentation).toContain(
      "HomeNode, Coolify, Caddy, UFW и DNS не изменялись",
    );
  });
});
