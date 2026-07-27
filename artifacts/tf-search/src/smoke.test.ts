import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const execFileAsync = promisify(execFile);
const smokeScript = join(
  repositoryRoot,
  "artifacts",
  "tf-search",
  "scripts",
  "smoke.mjs",
);
const workspaceTemporaryRoot = resolve(repositoryRoot, ".tmp");
const searchTestTemporaryParent = join(
  workspaceTemporaryRoot,
  `tf-search-smoke-test-${process.pid}`,
);

interface DockerCall {
  readonly args: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
}

interface SmokeObservations {
  readonly health: boolean;
  readonly ready: boolean;
  readonly unsignedRejected: boolean;
  readonly staleRejected: boolean;
  readonly replayRejected: boolean;
  readonly publicPolicySearch: boolean;
  readonly heartbeatHealthy: boolean;
  readonly heartbeatUnknownAfterRestart: boolean;
  readonly heartbeatRecovered: boolean;
  readonly heartbeatVersion: string;
  readonly requestsPerMinute: number;
  readonly responseProjection: string;
}

interface SmokeModule {
  readonly observedRequestsPerMinute: (...values: readonly number[]) => number;
  readonly canonicalizeDockerSelectors: (environment: NodeJS.ProcessEnv) => {
    readonly context: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly host: string;
  };
  readonly assertWorkspaceContainedPath: (
    candidate: string,
    root?: string,
  ) => string;
  readonly prepareSecretDirectory: (
    environment: NodeJS.ProcessEnv,
    options?: {
      readonly interlock?: (event: {
        readonly name?: string;
        readonly path: string;
        readonly phase: string;
      }) => Promise<void>;
      readonly repositoryRoot?: string;
      readonly temporaryParent?: string;
    },
  ) => Promise<{
    readonly directory: string;
    readonly ownership: object;
    readonly rawSecretCanaries: readonly string[];
    readonly secretNames: readonly string[];
  }>;
  readonly removeVerifiedDirectory: (
    directory: string,
    options?: {
      readonly interlock?: (event: {
        readonly name?: string;
        readonly path: string;
        readonly phase: string;
      }) => Promise<void>;
      readonly ownership: object;
      readonly repositoryRoot?: string;
      readonly temporaryParent?: string;
    },
  ) => Promise<void>;
  readonly seedPolicySession: (
    compose: (
      args: readonly string[],
    ) => Promise<{ readonly stdout: string; readonly stderr: string }>,
    registerLogCanaries: (values: readonly string[]) => void,
  ) => Promise<unknown>;
  readonly runTfSearchSmoke: (options: {
    readonly environment: NodeJS.ProcessEnv;
    readonly repositoryRoot?: string;
    readonly temporaryParent?: string;
    readonly docker: (
      args: readonly string[],
      environment: NodeJS.ProcessEnv,
    ) => Promise<{ readonly stdout: string; readonly stderr: string }>;
    readonly exerciseStack: (context: {
      readonly apiOrigin: string;
      readonly project: string;
      readonly registerLogCanaries: (values: readonly string[]) => void;
      readonly restartApi: () => Promise<void>;
    }) => Promise<SmokeObservations>;
  }) => Promise<{
    readonly project: string;
    readonly cleanup: {
      readonly containers: number;
      readonly images: number;
      readonly networks: number;
      readonly volumes: number;
      readonly temporaryDirectories: number;
    };
    readonly observations: SmokeObservations;
  }>;
}

async function loadSmokeModule(): Promise<SmokeModule> {
  return (await import(
    `${pathToFileURL(smokeScript).href}?t=${Date.now()}`
  )) as unknown as SmokeModule;
}

function fakeDocker(options: { readonly logs?: string } = {}) {
  const calls: DockerCall[] = [];
  const run = async (
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
  ): Promise<{ readonly stdout: string; readonly stderr: string }> => {
    calls.push({ args: [...args], environment: { ...environment } });
    if (args[0] === "context" && args[1] === "show") {
      return { stdout: "desktop-linux\n", stderr: "" };
    }
    if (args[0] === "context" && args[1] === "inspect") {
      return {
        stdout:
          process.platform === "win32"
            ? '"npipe:////./pipe/docker_engine"\n'
            : '"unix:///var/run/docker.sock"\n',
        stderr: "",
      };
    }
    if (args[0] === "compose" && args.includes("config")) {
      return {
        stdout: JSON.stringify({
          services: {
            api: {
              environment: {
                TF_SEARCH_ORIGIN: "http://tf-search:8080",
              },
            },
            "tf-search": {
              environment: {
                TF_SEARCH_HEARTBEAT_API_ORIGIN: "http://api:8080",
              },
            },
          },
        }),
        stderr: "",
      };
    }
    if (args[0] === "compose" && args.includes("logs")) {
      return {
        stdout:
          options.logs ??
          '{"level":"info","message":"TF search listening"}\n' +
            '{"level":"info","message":"Server listening"}\n',
        stderr: "",
      };
    }
    if (
      (args[0] === "ps" ||
        args[0] === "network" ||
        args[0] === "volume" ||
        args[0] === "image") &&
      args.includes("ls")
    ) {
      return { stdout: "", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
  return { calls, run };
}

function successfulObservations(): SmokeObservations {
  return {
    health: true,
    ready: true,
    unsignedRejected: true,
    staleRejected: true,
    replayRejected: true,
    publicPolicySearch: true,
    heartbeatHealthy: true,
    heartbeatUnknownAfterRestart: true,
    heartbeatRecovered: true,
    heartbeatVersion: "task-5-smoke",
    requestsPerMinute: 1,
    responseProjection: '{"results":[{"title":"Fixture Track"}]}',
  };
}

describe("tf-search disposable smoke contract", () => {
  it("rejects remote and conflicting Docker selectors before invocation", async () => {
    const smoke = await loadSmokeModule();
    const docker = fakeDocker();

    await expect(
      smoke.runTfSearchSmoke({
        environment: {
          ...process.env,
          DOCKER_HOST: "tcp://remote.example:2375",
        },
        repositoryRoot,
        temporaryParent: searchTestTemporaryParent,
        docker: docker.run,
        exerciseStack: async () => successfulObservations(),
      }),
    ).rejects.toThrow("local Docker");
    expect(docker.calls).toEqual([]);

    expect(() =>
      smoke.canonicalizeDockerSelectors({
        DOCKER_CONTEXT: "desktop-linux",
        Docker_Context: "remote-context",
      }),
    ).toThrow("Conflicting Docker selector environment");
    expect(() =>
      smoke.canonicalizeDockerSelectors({
        BUILDKIT_HOST: "tcp://remote-builder.example:1234",
      }),
    ).toThrow("Unsafe Docker build selector environment");
  });

  it("only accepts temporary paths contained by the worktree", async () => {
    const smoke = await loadSmokeModule();
    const contained = resolve(repositoryRoot, ".tmp", "tf-search-smoke-safe");

    expect(smoke.assertWorkspaceContainedPath(contained, repositoryRoot)).toBe(
      contained,
    );
    expect(() =>
      smoke.assertWorkspaceContainedPath(
        resolve(repositoryRoot, "..", "outside"),
        repositoryRoot,
      ),
    ).toThrow("outside the worktree");
    expect(() =>
      smoke.assertWorkspaceContainedPath(repositoryRoot, repositoryRoot),
    ).toThrow("outside the worktree");
  });

  it("retains a positive RPM observed before a later heartbeat window expires", async () => {
    const smoke = await loadSmokeModule();

    expect(smoke.observedRequestsPerMinute(2, 0)).toBe(2);
    expect(smoke.observedRequestsPerMinute(0, 3, 1)).toBe(3);
  });

  it("isolates per-run secrets from a concurrent API temp owner", async () => {
    const smoke = await loadSmokeModule();
    const environment = { ...process.env };
    const apiTemporaryParent = join(
      workspaceTemporaryRoot,
      "api-deployment-contract",
    );
    await mkdir(apiTemporaryParent, { recursive: true });
    const apiRunDirectory = await mkdtemp(
      join(apiTemporaryParent, "concurrent-api-owner-"),
    );
    const apiMarker = join(apiRunDirectory, "active");
    await writeFile(apiMarker, "api-owner");
    let prepared:
      | Awaited<ReturnType<SmokeModule["prepareSecretDirectory"]>>
      | undefined;
    let removed = false;

    try {
      prepared = await smoke.prepareSecretDirectory(environment, {
        repositoryRoot,
        temporaryParent: searchTestTemporaryParent,
      });

      const fromOwner = prepared.directory.slice(
        searchTestTemporaryParent.length,
      );
      expect(fromOwner.startsWith("\\") || fromOwner.startsWith("/")).toBe(
        true,
      );
      expect([...prepared.secretNames].sort()).toEqual([
        "tf_admin_database_url",
        "tf_client_secret",
        "tf_migrator_database_url",
        "tf_migrator_password",
        "tf_module_heartbeat_keys",
        "tf_postgres_admin_password",
        "tf_runtime_database_url",
        "tf_runtime_password",
        "tf_search_heartbeat_secret",
        "tf_search_internal_auth_secret",
      ]);
      expect(new Set(prepared.rawSecretCanaries).size).toBe(
        prepared.rawSecretCanaries.length,
      );
      expect(environment.TF_SECRET_DIRECTORY).toBe(prepared.directory);

      const heartbeatSecret = await readFile(
        join(prepared.directory, "tf_search_heartbeat_secret"),
        "utf8",
      );
      const heartbeatMap = JSON.parse(
        await readFile(
          join(prepared.directory, "tf_module_heartbeat_keys"),
          "utf8",
        ),
      ) as Record<string, string>;
      expect(heartbeatMap).toEqual({ "search-media": heartbeatSecret });

      await smoke.removeVerifiedDirectory(prepared.directory, {
        ownership: prepared.ownership,
        repositoryRoot,
        temporaryParent: searchTestTemporaryParent,
      });
      removed = true;
      await expect(access(prepared.directory)).rejects.toBeDefined();
      await expect(access(searchTestTemporaryParent)).rejects.toBeDefined();
      expect(await readFile(apiMarker, "utf8")).toBe("api-owner");
    } finally {
      if (prepared !== undefined && !removed) {
        await smoke
          .removeVerifiedDirectory(prepared.directory, {
            ownership: prepared.ownership,
            repositoryRoot,
            temporaryParent: searchTestTemporaryParent,
          })
          .catch(() => undefined);
      }
      await rm(apiRunDirectory, { force: true, recursive: true });
      await rmdir(apiTemporaryParent).catch(() => undefined);
      await rmdir(workspaceTemporaryRoot).catch(() => undefined);
    }
  });

  it("rejects symlink or junction escapes before writing or deleting", async ({
    skip,
  }) => {
    const smoke = await loadSmokeModule();
    const outerTemporaryRoot = join(
      repositoryRoot,
      ".superpowers",
      "sdd",
      "task-5-physical-containment-tmp",
    );
    await mkdir(outerTemporaryRoot, { recursive: true });
    const fixtureRoot = await mkdtemp(
      join(outerTemporaryRoot, "physical-containment-"),
    );
    const workspace = join(fixtureRoot, "workspace");
    const outside = join(fixtureRoot, "outside");
    const linkedTemporaryRoot = join(workspace, ".tmp");
    const linkedTemporaryParent = join(
      linkedTemporaryRoot,
      "tf-search-smoke-test",
    );
    const linkedRunDirectory = join(
      linkedTemporaryParent,
      `tf-search-smoke-${randomUUID()}`,
    );
    const sentinel = join(outside, "sentinel");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    let temporaryRootIsLink = false;
    let temporaryParentIsLink = false;
    let runDirectoryIsLink = false;

    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(sentinel, "preserve");
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
        smoke.prepareSecretDirectory({}, { repositoryRoot: workspace }),
      ).rejects.toThrow(/symbolic|reparse|physical/i);
      expect(await readFile(sentinel, "utf8")).toBe("preserve");

      await unlink(linkedTemporaryRoot);
      temporaryRootIsLink = false;
      await mkdir(linkedTemporaryRoot);
      await symlink(outside, linkedTemporaryParent, linkType);
      temporaryParentIsLink = true;

      await expect(
        smoke.prepareSecretDirectory(
          {},
          {
            repositoryRoot: workspace,
            temporaryParent: linkedTemporaryParent,
          },
        ),
      ).rejects.toThrow(/symbolic|reparse|physical/i);
      expect(await readFile(sentinel, "utf8")).toBe("preserve");

      await unlink(linkedTemporaryParent);
      temporaryParentIsLink = false;
      await mkdir(linkedTemporaryParent);
      await symlink(outside, linkedRunDirectory, linkType);
      runDirectoryIsLink = true;

      await expect(
        smoke.removeVerifiedDirectory(linkedRunDirectory, {
          ownership: {},
          repositoryRoot: workspace,
          temporaryParent: linkedTemporaryParent,
        }),
      ).rejects.toThrow(/ownership|symbolic|reparse|physical/i);
      expect(await readFile(sentinel, "utf8")).toBe("preserve");
    } finally {
      if (runDirectoryIsLink) {
        await unlink(linkedRunDirectory).catch(() => undefined);
      }
      if (temporaryParentIsLink) {
        await unlink(linkedTemporaryParent).catch(() => undefined);
      }
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

  // Node has no cross-platform openat/unlinkat or directory rename lock. These
  // interlocks exercise every observable identity boundary around handle I/O.
  it("rejects parent replacement before marker creation without writing secrets outside", async ({
    skip,
  }) => {
    const smoke = await loadSmokeModule();
    const outerTemporaryRoot = join(
      repositoryRoot,
      ".superpowers",
      "sdd",
      "task-6-parent-interleave-tmp",
    );
    await mkdir(outerTemporaryRoot, { recursive: true });
    const fixtureRoot = await mkdtemp(join(outerTemporaryRoot, "parent-race-"));
    const workspace = join(fixtureRoot, "workspace");
    const outside = join(fixtureRoot, "outside");
    const temporaryRoot = join(workspace, ".tmp");
    const owner = join(temporaryRoot, "tf-search-smoke-owner");
    const displacedOwner = join(temporaryRoot, "owner-original");
    const externalMarker = join(outside, "external-marker");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    let ownerIsLink = false;
    let interlocked = false;

    await mkdir(owner, { recursive: true });
    await mkdir(outside);
    await writeFile(externalMarker, "preserve");
    try {
      await expect(
        smoke.prepareSecretDirectory(
          {},
          {
            repositoryRoot: workspace,
            temporaryParent: owner,
            interlock: async ({ path, phase }) => {
              if (phase !== "after-run-created") return;
              interlocked = true;
              const externalRun = join(
                outside,
                path.slice(path.lastIndexOf(sep) + 1),
              );
              await rename(owner, displacedOwner);
              await mkdir(externalRun);
              try {
                await symlink(outside, owner, linkType);
                ownerIsLink = true;
              } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code === "EPERM" || code === "EACCES") {
                  skip();
                  return;
                }
                throw error;
              }
            },
          },
        ),
      ).rejects.toThrow(
        /ownership|physical|identity|replaced|symbolic|reparse/i,
      );
      expect(interlocked).toBe(true);
      expect(await readFile(externalMarker, "utf8")).toBe("preserve");
      const outsideEntries = await readdir(outside, {
        recursive: true,
        withFileTypes: true,
      });
      for (const entry of outsideEntries) {
        if (!entry.isFile() || entry.name === "external-marker") continue;
        const value = await readFile(
          join(entry.parentPath, entry.name),
          "utf8",
        );
        expect(value).toBe("");
      }
    } finally {
      if (ownerIsLink) await unlink(owner).catch(() => undefined);
      await rm(fixtureRoot, { force: true, recursive: true });
      await rmdir(outerTemporaryRoot).catch(() => undefined);
    }
  });

  it("rejects run replacement before secret creation and preserves the external marker", async ({
    skip,
  }) => {
    const smoke = await loadSmokeModule();
    const outerTemporaryRoot = join(
      repositoryRoot,
      ".superpowers",
      "sdd",
      "task-6-run-interleave-tmp",
    );
    await mkdir(outerTemporaryRoot, { recursive: true });
    const fixtureRoot = await mkdtemp(join(outerTemporaryRoot, "run-race-"));
    const workspace = join(fixtureRoot, "workspace");
    const outside = join(fixtureRoot, "outside");
    const owner = join(workspace, ".tmp", "tf-search-smoke-owner");
    const externalMarker = join(outside, "external-marker");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    let displacedRun = "";
    let runIsLink = false;
    let interlocked = false;

    await mkdir(owner, { recursive: true });
    await mkdir(outside);
    await writeFile(externalMarker, "preserve");
    try {
      await expect(
        smoke.prepareSecretDirectory(
          {},
          {
            repositoryRoot: workspace,
            temporaryParent: owner,
            interlock: async ({ path, phase }) => {
              if (phase !== "after-ownership-marker-created") return;
              interlocked = true;
              displacedRun = `${path}-original`;
              await rename(path, displacedRun);
              try {
                await symlink(outside, path, linkType);
                runIsLink = true;
              } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code === "EPERM" || code === "EACCES") {
                  skip();
                  return;
                }
                throw error;
              }
            },
          },
        ),
      ).rejects.toThrow(
        /ownership|physical|identity|replaced|symbolic|reparse/i,
      );
      expect(interlocked).toBe(true);
      expect(await readFile(externalMarker, "utf8")).toBe("preserve");
      expect(await readdir(outside)).toEqual(["external-marker"]);
      if (displacedRun.length > 0) {
        const displacedFiles = await readdir(displacedRun);
        expect(displacedFiles).toEqual([".tf-search-smoke-owner"]);
      }
    } finally {
      if (runIsLink) {
        const runLink = (await readdir(owner)).find((name) =>
          name.startsWith("tf-search-smoke-"),
        );
        if (runLink !== undefined) {
          await unlink(join(owner, runLink)).catch(() => undefined);
        }
      }
      await rm(fixtureRoot, { force: true, recursive: true });
      await rmdir(outerTemporaryRoot).catch(() => undefined);
    }
  });

  it("rejects file substitution after exclusive open without overwriting an external file", async () => {
    const smoke = await loadSmokeModule();
    const outerTemporaryRoot = join(
      repositoryRoot,
      ".superpowers",
      "sdd",
      "task-6-file-interleave-tmp",
    );
    await mkdir(outerTemporaryRoot, { recursive: true });
    const fixtureRoot = await mkdtemp(join(outerTemporaryRoot, "file-race-"));
    const workspace = join(fixtureRoot, "workspace");
    const outside = join(fixtureRoot, "outside");
    const owner = join(workspace, ".tmp", "tf-search-smoke-owner");
    const externalMarker = join(outside, "external-marker");
    let displacedFile = "";
    let interlocked = false;

    await mkdir(owner, { recursive: true });
    await mkdir(outside);
    await writeFile(externalMarker, "preserve");
    try {
      await expect(
        smoke.prepareSecretDirectory(
          {},
          {
            repositoryRoot: workspace,
            temporaryParent: owner,
            interlock: async ({ name, path, phase }) => {
              if (
                phase !== "after-owned-file-open" ||
                name !== "tf_client_secret"
              ) {
                return;
              }
              interlocked = true;
              displacedFile = `${path}-original`;
              await rename(path, displacedFile);
              await link(externalMarker, path);
            },
          },
        ),
      ).rejects.toThrow(/identity|replaced/i);
      expect(interlocked).toBe(true);
      expect(await readFile(externalMarker, "utf8")).toBe("preserve");
      expect(await readFile(displacedFile, "utf8")).toBe("");
      expect((await lstat(externalMarker)).nlink).toBeGreaterThanOrEqual(2);
    } finally {
      await rm(fixtureRoot, { force: true, recursive: true });
      await rmdir(outerTemporaryRoot).catch(() => undefined);
    }
  });

  it("refuses cleanup after run replacement and never follows the replacement", async ({
    skip,
  }) => {
    const smoke = await loadSmokeModule();
    const outerTemporaryRoot = join(
      repositoryRoot,
      ".superpowers",
      "sdd",
      "task-6-cleanup-run-interleave-tmp",
    );
    await mkdir(outerTemporaryRoot, { recursive: true });
    const fixtureRoot = await mkdtemp(
      join(outerTemporaryRoot, "cleanup-race-"),
    );
    const workspace = join(fixtureRoot, "workspace");
    const outside = join(fixtureRoot, "outside");
    const owner = join(workspace, ".tmp", "tf-search-smoke-owner");
    const externalMarker = join(outside, "external-marker");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    let prepared:
      | Awaited<ReturnType<SmokeModule["prepareSecretDirectory"]>>
      | undefined;
    let displacedRun = "";
    let runIsLink = false;
    let interlocked = false;

    await mkdir(owner, { recursive: true });
    await mkdir(outside);
    await writeFile(externalMarker, "preserve");
    try {
      prepared = await smoke.prepareSecretDirectory(
        {},
        { repositoryRoot: workspace, temporaryParent: owner },
      );
      await expect(
        smoke.removeVerifiedDirectory(prepared.directory, {
          repositoryRoot: workspace,
          temporaryParent: owner,
          ownership: prepared.ownership,
          interlock: async ({ path, phase }) => {
            if (phase !== "after-cleanup-scan") return;
            interlocked = true;
            displacedRun = `${path}-original`;
            await rename(path, displacedRun);
            try {
              await symlink(outside, path, linkType);
              runIsLink = true;
            } catch (error) {
              const code = (error as NodeJS.ErrnoException).code;
              if (code === "EPERM" || code === "EACCES") {
                skip();
                return;
              }
              throw error;
            }
          },
        }),
      ).rejects.toThrow(
        /ownership|physical|identity|replaced|symbolic|reparse/i,
      );
      expect(interlocked).toBe(true);
      expect(await readFile(externalMarker, "utf8")).toBe("preserve");
      expect(await readdir(outside)).toEqual(["external-marker"]);
      expect((await readdir(displacedRun)).length).toBeGreaterThan(1);
    } finally {
      if (runIsLink && prepared !== undefined) {
        await unlink(prepared.directory).catch(() => undefined);
      }
      await rm(fixtureRoot, { force: true, recursive: true });
      await rmdir(outerTemporaryRoot).catch(() => undefined);
    }
  });

  it("refuses cleanup when the ownership marker changes", async () => {
    const smoke = await loadSmokeModule();
    const outerTemporaryRoot = join(
      repositoryRoot,
      ".superpowers",
      "sdd",
      "task-6-marker-mismatch-tmp",
    );
    await mkdir(outerTemporaryRoot, { recursive: true });
    const fixtureRoot = await mkdtemp(join(outerTemporaryRoot, "marker-race-"));
    const workspace = join(fixtureRoot, "workspace");
    const owner = join(workspace, ".tmp", "tf-search-smoke-owner");
    let prepared:
      | Awaited<ReturnType<SmokeModule["prepareSecretDirectory"]>>
      | undefined;

    await mkdir(owner, { recursive: true });
    try {
      prepared = await smoke.prepareSecretDirectory(
        {},
        { repositoryRoot: workspace, temporaryParent: owner },
      );
      const marker = join(prepared.directory, ".tf-search-smoke-owner");
      await chmod(marker, 0o600).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
      await writeFile(marker, "attacker-marker");

      await expect(
        smoke.removeVerifiedDirectory(prepared.directory, {
          repositoryRoot: workspace,
          temporaryParent: owner,
          ownership: prepared.ownership,
        }),
      ).rejects.toThrow(/marker|ownership|identity/i);
      expect(
        await readFile(
          join(prepared.directory, prepared.secretNames[0]),
          "utf8",
        ),
      ).not.toBe("");
    } finally {
      await rm(fixtureRoot, { force: true, recursive: true });
      await rmdir(outerTemporaryRoot).catch(() => undefined);
    }
  });

  it("refuses cleanup when the run directory contains an unknown entry", async () => {
    const smoke = await loadSmokeModule();
    const outerTemporaryRoot = join(
      repositoryRoot,
      ".superpowers",
      "sdd",
      "task-6-unknown-entry-tmp",
    );
    await mkdir(outerTemporaryRoot, { recursive: true });
    const fixtureRoot = await mkdtemp(
      join(outerTemporaryRoot, "unknown-race-"),
    );
    const workspace = join(fixtureRoot, "workspace");
    const owner = join(workspace, ".tmp", "tf-search-smoke-owner");
    let prepared:
      | Awaited<ReturnType<SmokeModule["prepareSecretDirectory"]>>
      | undefined;

    await mkdir(owner, { recursive: true });
    try {
      prepared = await smoke.prepareSecretDirectory(
        {},
        { repositoryRoot: workspace, temporaryParent: owner },
      );
      const unknown = join(prepared.directory, "unexpected-entry");
      await writeFile(unknown, "preserve");

      await expect(
        smoke.removeVerifiedDirectory(prepared.directory, {
          repositoryRoot: workspace,
          temporaryParent: owner,
          ownership: prepared.ownership,
        }),
      ).rejects.toThrow(/unexpected|allowlist|ownership/i);
      expect(await readFile(unknown, "utf8")).toBe("preserve");
      expect(
        await readFile(
          join(prepared.directory, prepared.secretNames[0]),
          "utf8",
        ),
      ).not.toBe("");
    } finally {
      await rm(fixtureRoot, { force: true, recursive: true });
      await rmdir(outerTemporaryRoot).catch(() => undefined);
    }
  });

  it("revalidates an opened cleanup file before unlinking it", async () => {
    const smoke = await loadSmokeModule();
    const outerTemporaryRoot = join(
      repositoryRoot,
      ".superpowers",
      "sdd",
      "task-6-cleanup-file-interleave-tmp",
    );
    await mkdir(outerTemporaryRoot, { recursive: true });
    const fixtureRoot = await mkdtemp(
      join(outerTemporaryRoot, "cleanup-file-race-"),
    );
    const workspace = join(fixtureRoot, "workspace");
    const outside = join(fixtureRoot, "outside");
    const owner = join(workspace, ".tmp", "tf-search-smoke-owner");
    const externalMarker = join(outside, "external-marker");
    let prepared:
      | Awaited<ReturnType<SmokeModule["prepareSecretDirectory"]>>
      | undefined;
    let displacedFile = "";
    let interlocked = false;

    await mkdir(owner, { recursive: true });
    await mkdir(outside);
    await writeFile(externalMarker, "preserve");
    try {
      prepared = await smoke.prepareSecretDirectory(
        {},
        { repositoryRoot: workspace, temporaryParent: owner },
      );
      await expect(
        smoke.removeVerifiedDirectory(prepared.directory, {
          repositoryRoot: workspace,
          temporaryParent: owner,
          ownership: prepared.ownership,
          interlock: async ({ name, path, phase }) => {
            if (
              phase !== "after-cleanup-file-open" ||
              name !== "tf_client_secret"
            ) {
              return;
            }
            interlocked = true;
            displacedFile = `${path}-original`;
            await rename(path, displacedFile);
            await link(externalMarker, path);
          },
        }),
      ).rejects.toThrow(/identity|replaced/i);
      expect(interlocked).toBe(true);
      expect(await readFile(externalMarker, "utf8")).toBe("preserve");
      expect(await readFile(displacedFile, "utf8")).not.toBe("");
    } finally {
      await rm(fixtureRoot, { force: true, recursive: true });
      await rmdir(outerTemporaryRoot).catch(() => undefined);
    }
  });

  it("uses one unique project, verifies the full stack contract, and audits cleanup", async () => {
    const smoke = await loadSmokeModule();
    const docker = fakeDocker();
    const observations = successfulObservations();
    const result = await smoke.runTfSearchSmoke({
      environment: {
        ...process.env,
        COMPOSE_PROJECT_NAME: "hostile-inherited-project",
        TF_SEARCH_SMOKE_API_PORT: "18088",
      },
      repositoryRoot,
      temporaryParent: searchTestTemporaryParent,
      docker: docker.run,
      exerciseStack: async ({ restartApi }) => {
        await restartApi();
        return observations;
      },
    });

    expect(result.project).toMatch(/^apollo-tf-search-smoke-\d+-[a-f0-9]{8}$/);
    expect(result.project).not.toBe("hostile-inherited-project");
    expect(result.observations).toEqual(observations);
    expect(result.cleanup).toEqual({
      containers: 0,
      images: 0,
      networks: 0,
      volumes: 0,
      temporaryDirectories: 0,
    });

    const composeCalls = docker.calls.filter(
      ({ args }) => args[0] === "compose",
    );
    expect(
      composeCalls.map(({ args }) =>
        args.includes("config")
          ? "config"
          : args.includes("up")
            ? "up"
            : args.includes("restart")
              ? "restart"
              : args.includes("logs")
                ? "logs"
                : args.includes("down")
                  ? "down"
                  : "other",
      ),
    ).toEqual(["config", "up", "restart", "logs", "down"]);
    for (const { args, environment } of composeCalls) {
      expect(args).toContain("-p");
      expect(args[args.indexOf("-p") + 1]).toBe(result.project);
      expect(environment.COMPOSE_PROJECT_NAME).toBe(result.project);
      expect(environment.COMPOSE_BAKE).toBe("false");
      expect(environment.TF_SECRET_DIRECTORY).toMatch(
        new RegExp(
          `^${searchTestTemporaryParent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\\\/]`,
        ),
      );
      expect(environment.DOCKER_HOST ?? "").not.toMatch(/^tcp:\/\//i);
    }
    const down = composeCalls.find(({ args }) => args.includes("down"));
    expect(down?.args).toEqual(
      expect.arrayContaining([
        "down",
        "-v",
        "--remove-orphans",
        "--rmi",
        "local",
      ]),
    );
    expect(
      docker.calls.filter(
        ({ args }) =>
          args[0] === "ps" ||
          (args[0] === "network" && args[1] === "ls") ||
          (args[0] === "volume" && args[1] === "ls") ||
          (args[0] === "image" && args[1] === "ls"),
      ),
    ).toHaveLength(5);
    expect(
      docker.calls.filter(
        ({ args }) => args[0] === "image" && args[1] === "ls",
      ),
    ).toEqual([
      expect.objectContaining({
        args: expect.arrayContaining([
          "--filter",
          `label=com.docker.compose.project=${result.project}`,
        ]),
      }),
      expect.objectContaining({
        args: expect.arrayContaining([
          "--filter",
          `reference=${result.project}-*`,
        ]),
      }),
    ]);
  });

  it("always tears down and audits after a failed runtime assertion", async () => {
    const smoke = await loadSmokeModule();
    const docker = fakeDocker();

    await expect(
      smoke.runTfSearchSmoke({
        environment: process.env,
        repositoryRoot,
        temporaryParent: searchTestTemporaryParent,
        docker: docker.run,
        exerciseStack: async () => {
          throw new Error("runtime assertion failed");
        },
      }),
    ).rejects.toThrow("runtime assertion failed");

    const composeCalls = docker.calls.filter(
      ({ args }) => args[0] === "compose",
    );
    const down = composeCalls.find(({ args }) => args.includes("down"));
    expect(down?.args).toEqual(
      expect.arrayContaining([
        "down",
        "-v",
        "--remove-orphans",
        "--rmi",
        "local",
      ]),
    );
    expect(
      docker.calls.some(
        ({ args }) => args[0] === "network" && args[1] === "ls",
      ),
    ).toBe(true);
    expect(
      docker.calls.some(({ args }) => args[0] === "volume" && args[1] === "ls"),
    ).toBe(true);
    expect(
      docker.calls.filter(
        ({ args }) => args[0] === "image" && args[1] === "ls",
      ),
    ).toHaveLength(2);
  });

  it("captures project logs and tears down when startup fails", async () => {
    const smoke = await loadSmokeModule();
    const base = fakeDocker();
    const docker = async (
      args: readonly string[],
      environment: NodeJS.ProcessEnv,
    ) => {
      const result = await base.run(args, environment);
      if (args[0] === "compose" && args.includes("up")) {
        throw new Error("startup failed");
      }
      return result;
    };

    await expect(
      smoke.runTfSearchSmoke({
        environment: process.env,
        repositoryRoot,
        temporaryParent: searchTestTemporaryParent,
        docker,
        exerciseStack: async () => successfulObservations(),
      }),
    ).rejects.toThrow("startup failed");
    expect(
      base.calls.some(
        ({ args }) => args[0] === "compose" && args.includes("logs"),
      ),
    ).toBe(true);
    expect(
      base.calls.some(
        ({ args }) => args[0] === "compose" && args.includes("down"),
      ),
    ).toBe(true);
  });

  it("rejects success-path log canaries without surfacing their values", async () => {
    const smoke = await loadSmokeModule();
    const artist = "Artist Success Canary";
    const docker = fakeDocker({
      logs: `{"level":"info","artist":"${artist}"}\n`,
    });

    let message = "";
    try {
      await smoke.runTfSearchSmoke({
        environment: process.env,
        repositoryRoot,
        temporaryParent: searchTestTemporaryParent,
        docker: docker.run,
        exerciseStack: async ({ registerLogCanaries }) => {
          registerLogCanaries([artist]);
          return successfulObservations();
        },
      });
      expect.fail("success-path canary was not rejected");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("sensitive smoke canary");
    expect(message).not.toContain(artist);
    expect(
      docker.calls.some(
        ({ args }) =>
          args[0] === "compose" &&
          args.includes("down") &&
          args.includes("--rmi"),
      ),
    ).toBe(true);
  });

  it("checks failure logs and sanitizes fixture-bearing thrown errors", async () => {
    const smoke = await loadSmokeModule();
    const canaries = [
      "Artist Failure Canary",
      "Title Failure Canary",
      "Artist Failure Canary Title Failure Canary",
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000003",
      "00000000-0000-4000-8000-000000000004",
      "session-handle-failure-canary",
      "csrf-failure-canary",
      "authorization-token-failure-canary",
    ];
    const docker = fakeDocker({
      logs: `{"level":"error","session":"${canaries[7]}"}\n`,
    });

    let message = "";
    try {
      await smoke.runTfSearchSmoke({
        environment: process.env,
        repositoryRoot,
        temporaryParent: searchTestTemporaryParent,
        docker: docker.run,
        exerciseStack: async ({ registerLogCanaries }) => {
          registerLogCanaries(canaries);
          throw new Error(`runtime failed for ${canaries[9]}`);
        },
      });
      expect.fail("failure-path canary was not rejected");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("sensitive smoke canary");
    for (const canary of canaries) {
      expect(message).not.toContain(canary);
    }
    expect(
      docker.calls.filter(
        ({ args }) =>
          args[0] === "compose" &&
          (args.includes("logs") || args.includes("down")),
      ).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("registers generated session canaries before the Redis seed command", async () => {
    const smoke = await loadSmokeModule();
    const events: string[] = [];
    let canaries: readonly string[] = [];

    await expect(
      smoke.seedPolicySession(
        async () => {
          events.push("compose");
          throw new Error("redis seed failed");
        },
        (values) => {
          events.push("register");
          canaries = [...values];
        },
      ),
    ).rejects.toThrow("redis seed failed");

    expect(events).toEqual(["register", "compose"]);
    expect(canaries).toHaveLength(7);
    expect(new Set(canaries).size).toBe(7);
    expect(
      canaries.filter((value) => /^[0-9a-f-]{36}$/.test(value)),
    ).toHaveLength(4);
    expect(canaries.filter((value) => value.length === 43)).toHaveLength(3);
  });

  it("keeps real Docker execution explicitly gated", async () => {
    const source = await readFile(smokeScript, "utf8");

    expect(source).toContain('TF_SEARCH_SMOKE_REAL_DOCKER !== "1"');
    expect(source).toContain("deterministic fixture");
    expect(source).toContain("(async () => {");
    expect(source).toContain(
      "})().catch((error) => { console.error(error); process.exitCode = 1; });",
    );
    expect(source).toContain("down");
    expect(source).toContain("--remove-orphans");
  });

  it.skipIf(process.env.TF_SEARCH_SMOKE_REAL_DOCKER !== "1")(
    "runs the explicitly gated local Docker smoke",
    async () => {
      const result = await execFileAsync(process.execPath, [smokeScript], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          TF_SEARCH_SMOKE_REAL_DOCKER: "1",
        },
        maxBuffer: 8 * 1024 * 1024,
        timeout: 10 * 60_000,
      });
      expect(result.stderr).toBe("");
      expect(result.stdout).toMatch(
        /TF search deterministic fixture smoke passed .+?"containers":0,"images":0,"networks":0,"volumes":0,"temporaryDirectories":0/,
      );
    },
    10 * 60_000,
  );
});
