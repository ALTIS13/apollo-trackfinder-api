import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
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
    options?: { readonly repositoryRoot?: string },
  ) => Promise<{
    readonly directory: string;
    readonly rawSecretCanaries: readonly string[];
    readonly secretNames: readonly string[];
  }>;
  readonly removeVerifiedDirectory: (
    directory: string,
    options?: { readonly repositoryRoot?: string },
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

  it("creates exact per-run secrets under the worktree and removes them", async () => {
    const smoke = await loadSmokeModule();
    const environment = { ...process.env };
    const prepared = await smoke.prepareSecretDirectory(environment, {
      repositoryRoot,
    });

    expect(prepared.directory.startsWith(resolve(repositoryRoot, ".tmp"))).toBe(
      true,
    );
    expect([...prepared.secretNames].sort()).toEqual([
      "tf_client_secret",
      "tf_database_url",
      "tf_module_heartbeat_keys",
      "tf_postgres_password",
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
      repositoryRoot,
    });
    await expect(access(prepared.directory)).rejects.toBeDefined();
    await expect(access(join(repositoryRoot, ".tmp"))).rejects.toBeDefined();
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
    const linkedRunDirectory = join(
      linkedTemporaryRoot,
      `tf-search-smoke-${randomUUID()}`,
    );
    const sentinel = join(outside, "sentinel");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    let temporaryRootIsLink = false;
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
      await symlink(outside, linkedRunDirectory, linkType);
      runDirectoryIsLink = true;

      await expect(
        smoke.removeVerifiedDirectory(linkedRunDirectory, {
          repositoryRoot: workspace,
        }),
      ).rejects.toThrow(/symbolic|reparse|physical/i);
      expect(await readFile(sentinel, "utf8")).toBe("preserve");
    } finally {
      if (runDirectoryIsLink) {
        await unlink(linkedRunDirectory).catch(() => undefined);
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
