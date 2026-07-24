import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  readdir,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
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
  readonly repositoryRoot?: string;
};

type TemporaryDirectoryRecord = {
  readonly directory: string;
  readonly repositoryRoot: string;
};

type VerifiedWorkspace = {
  readonly lexicalRoot: string;
  readonly physicalRoot: string;
};

type VerifiedDirectory = {
  readonly lexicalCandidate: string;
  readonly physicalCandidate: string;
};

const temporaryDirectories: TemporaryDirectoryRecord[] = [];
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

async function verifiedWorkspaceRoot(root: string): Promise<VerifiedWorkspace> {
  const lexicalRoot = resolve(root);
  const rootStats = await lstat(lexicalRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error("Workspace root cannot be symbolic or reparse-linked");
  }
  const physicalRoot = await realpath(lexicalRoot);
  return { lexicalRoot, physicalRoot };
}

async function verifiedPhysicalDirectory(
  candidate: string,
  workspace: VerifiedWorkspace,
): Promise<VerifiedDirectory> {
  const lexicalCandidate = assertContainedPath(
    candidate,
    workspace.lexicalRoot,
    "Temporary directory escaped the worktree",
  );
  const candidateStats = await lstat(lexicalCandidate);
  if (!candidateStats.isDirectory() || candidateStats.isSymbolicLink()) {
    throw new Error("Temporary directory cannot be symbolic or reparse-linked");
  }
  const physicalCandidate = await realpath(lexicalCandidate);
  assertPhysicalContainment(physicalCandidate, workspace.physicalRoot);
  return { lexicalCandidate, physicalCandidate };
}

async function ensureVerifiedDirectory(
  candidate: string,
  workspace: VerifiedWorkspace,
): Promise<VerifiedDirectory> {
  try {
    return await verifiedPhysicalDirectory(candidate, workspace);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await mkdir(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return verifiedPhysicalDirectory(candidate, workspace);
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

async function prepareTemporaryContext(root: string): Promise<{
  readonly owner: VerifiedDirectory;
  readonly temporary: VerifiedDirectory;
  readonly workspace: VerifiedWorkspace;
}> {
  const workspace = await verifiedWorkspaceRoot(root);
  const layout = temporaryLayout(workspace.lexicalRoot);
  const temporary = await ensureVerifiedDirectory(
    layout.temporaryRoot,
    workspace,
  );
  const owner = await ensureVerifiedDirectory(layout.ownerRoot, workspace);
  assertPhysicalContainment(
    owner.physicalCandidate,
    temporary.physicalCandidate,
  );
  return { owner, temporary, workspace };
}

async function verifiedTemporaryContext(root: string): Promise<{
  readonly owner: VerifiedDirectory;
  readonly temporary: VerifiedDirectory;
  readonly workspace: VerifiedWorkspace;
}> {
  const workspace = await verifiedWorkspaceRoot(root);
  const layout = temporaryLayout(workspace.lexicalRoot);
  const temporary = await verifiedPhysicalDirectory(
    layout.temporaryRoot,
    workspace,
  );
  const owner = await verifiedPhysicalDirectory(layout.ownerRoot, workspace);
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
  const root = options.repositoryRoot ?? repositoryRoot;
  const context = await verifiedTemporaryContext(root);
  const run = await verifiedPhysicalDirectory(directory, context.workspace);
  assertPhysicalContainment(
    run.physicalCandidate,
    context.owner.physicalCandidate,
  );
  return { ...context, run };
}

async function verifiedPhysicalFile(
  candidate: string,
  run: VerifiedDirectory,
  workspace: VerifiedWorkspace,
): Promise<void> {
  const lexicalCandidate = assertContainedPath(
    candidate,
    run.lexicalCandidate,
    "Temporary fixture file escaped its run directory",
  );
  const candidateStats = await lstat(lexicalCandidate);
  if (!candidateStats.isFile() || candidateStats.isSymbolicLink()) {
    throw new Error(
      "Temporary fixture file cannot be symbolic or reparse-linked",
    );
  }
  const physicalCandidate = await realpath(lexicalCandidate);
  assertPhysicalContainment(physicalCandidate, run.physicalCandidate);
  assertPhysicalContainment(physicalCandidate, workspace.physicalRoot);
}

async function verifyTemporaryTree(
  directory: string,
  options: TemporaryOptions = {},
): Promise<Awaited<ReturnType<typeof verifiedRunContext>>> {
  const context = await verifiedRunContext(directory, options);

  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current)) {
      const path = assertContainedPath(
        join(current, entry),
        context.run.lexicalCandidate,
        "Temporary fixture entry escaped its run directory",
      );
      const entryStats = await lstat(path);
      if (entryStats.isSymbolicLink()) {
        throw new Error(
          "Temporary fixture entry cannot be symbolic or reparse-linked",
        );
      }
      const physicalPath = await realpath(path);
      assertPhysicalContainment(physicalPath, context.run.physicalCandidate);
      if (entryStats.isDirectory()) {
        await walk(path);
      } else if (!entryStats.isFile()) {
        throw new Error("Temporary fixture entry must be a file or directory");
      }
    }
  }

  await walk(context.run.lexicalCandidate);
  return context;
}

async function createTemporaryDirectory(
  prefix: string,
  options: TemporaryOptions = {},
): Promise<string> {
  const root = options.repositoryRoot ?? repositoryRoot;
  const context = await prepareTemporaryContext(root);
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
  temporaryDirectories.push({
    directory: directory.lexicalCandidate,
    repositoryRoot: context.workspace.lexicalRoot,
  });
  return directory.lexicalCandidate;
}

async function writeTemporaryFixture(
  directory: string,
  path: string,
  contents: string,
  options: TemporaryOptions = {},
): Promise<void> {
  const context = await verifiedRunContext(directory, options);
  const fixturePath = assertContainedPath(
    path,
    context.run.lexicalCandidate,
    "Temporary fixture file escaped its run directory",
  );
  try {
    const existing = await lstat(fixturePath);
    if (existing.isSymbolicLink()) {
      throw new Error(
        "Temporary fixture file cannot be symbolic or reparse-linked",
      );
    }
    throw new Error("Temporary fixture file already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const refreshed = await verifiedRunContext(directory, options);
  await writeFile(fixturePath, contents, { flag: "wx" });
  const written = await verifiedRunContext(directory, options);
  await verifiedPhysicalFile(fixturePath, written.run, written.workspace);
  assertPhysicalContainment(
    written.run.physicalCandidate,
    refreshed.owner.physicalCandidate,
  );
}

async function removeTemporaryDirectory(
  directory: string,
  options: TemporaryOptions = {},
): Promise<void> {
  await verifyTemporaryTree(directory, options);
  const context = await verifyTemporaryTree(directory, options);
  await rm(context.run.lexicalCandidate, { force: true, recursive: true });
}

async function removeEmptyTemporaryParents(root: string): Promise<void> {
  const workspace = await verifiedWorkspaceRoot(root);
  const layout = temporaryLayout(workspace.lexicalRoot);
  for (const directory of [layout.ownerRoot, layout.temporaryRoot]) {
    try {
      const verified = await verifiedPhysicalDirectory(directory, workspace);
      await rmdir(verified.lexicalCandidate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
        throw error;
      }
    }
  }
}

async function filesRecursively(directory: string): Promise<string[]> {
  await verifyTemporaryTree(directory);
  const entries = await readdir(directory);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry);
    const entryStats = await lstat(path);
    if (entryStats.isDirectory() && !entryStats.isSymbolicLink()) {
      files.push(...(await filesRecursively(path)));
    } else {
      files.push(path);
    }
  }
  return files;
}

afterEach(async () => {
  const records = temporaryDirectories.splice(0);
  const roots = new Set(records.map((record) => record.repositoryRoot));
  for (const record of records) {
    try {
      await removeTemporaryDirectory(record.directory, {
        repositoryRoot: record.repositoryRoot,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  for (const root of roots) {
    try {
      await removeEmptyTemporaryParents(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
});

describe("TF deployment identity contract", () => {
  it("keeps API deployment fixtures under the suite-owned parent", async () => {
    const directory = await createTemporaryDirectory(
      "apollo-tf-api-ownership-",
    );
    const fromOwner = relative(apiDeploymentTemporaryRoot, directory);

    expect(fromOwner).not.toBe("..");
    expect(fromOwner.startsWith(`..${sep}`)).toBe(false);
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
      await rm(fixtureRoot, { force: true, recursive: true });
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
      await rm(fixtureRoot, { force: true, recursive: true });
      await rmdir(outerTemporaryRoot).catch((error: unknown) => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
          throw error;
        }
      });
    }
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

    const outputDirectory = await createTemporaryDirectory(
      "apollo-tf-web-bundle-",
    );
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

    const bundle = (
      await Promise.all(
        (await filesRecursively(outputDirectory)).map((path) =>
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
