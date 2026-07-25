import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const children: ChildProcess[] = [];
const temporaryDirectories: string[] = [];
const canary = "task-4-private-secret-canary";

async function fixture(): Promise<NodeJS.ProcessEnv> {
  const directory = await mkdtemp(
    join(tmpdir(), "apollo-tf-integrations-task4-"),
  );
  temporaryDirectories.push(directory);
  const paths = {
    command: join(directory, "command"),
    heartbeat: join(directory, "heartbeat"),
    database: join(directory, "database"),
    keyring: join(directory, "keyring"),
    spotifyId: join(directory, "spotify-id"),
    spotifySecret: join(directory, "spotify-secret"),
  };
  await Promise.all([
    writeFile(paths.command, `${"c".repeat(32)}${canary}`, "utf8"),
    writeFile(paths.heartbeat, `${"h".repeat(32)}${canary}`, "utf8"),
    writeFile(
      paths.database,
      `postgres://runtime:${canary}@127.0.0.1:1/integrations`,
      "utf8",
    ),
    writeFile(
      paths.keyring,
      JSON.stringify({
        activeKeyId: "task-4",
        keys: {
          "task-4": Buffer.alloc(32, 9).toString("base64url"),
        },
      }),
      "utf8",
    ),
    writeFile(paths.spotifyId, `spotify-id-${canary}`, "utf8"),
    writeFile(paths.spotifySecret, `spotify-secret-${canary}`, "utf8"),
  ]);
  return {
    PORT: String(await unusedPort()),
    TF_INTEGRATIONS_INTERNAL_AUTH_SECRET_FILE: paths.command,
    TF_INTEGRATIONS_HEARTBEAT_SECRET_FILE: paths.heartbeat,
    TF_INTEGRATIONS_DATABASE_URL_FILE: paths.database,
    TF_INTEGRATIONS_TOKEN_KEYRING_FILE: paths.keyring,
    TF_INTEGRATIONS_SPOTIFY_CLIENT_ID_FILE: paths.spotifyId,
    TF_INTEGRATIONS_SPOTIFY_CLIENT_SECRET_FILE: paths.spotifySecret,
    TF_INTEGRATIONS_SPOTIFY_CALLBACK_URI:
      "https://api.example.test/api/spotify/callback",
    TF_INTEGRATIONS_HEARTBEAT_API_ORIGIN: "https://api.example.test",
    APOLLO_API_VERSION: "task-4",
  };
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Could not reserve a TCP port");
  }
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return address.port;
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs = 5_000,
): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise<number | null>((resolveExit, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for child exit")),
      timeoutMs,
    );
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolveExit(code);
    });
  });
}

async function waitForListening(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolveListening, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for runtime")),
      5_000,
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString("utf8") === "TF integrations listening\n") {
        clearTimeout(timeout);
        resolveListening();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Runtime exited before listening: ${code}`));
    });
  });
}

async function runtimeWrapper(): Promise<string> {
  const directory = temporaryDirectories.at(-1);
  if (directory === undefined) throw new Error("Missing fixture directory");
  const path = join(directory, "runtime-wrapper.mjs");
  const bundleUrl = pathToFileURL(resolve("dist/index.mjs")).toString();
  await writeFile(
    path,
    `
      import { runTfIntegrationsMain } from ${JSON.stringify(bundleUrl)};
      const repository = {
        async isMigrationCurrent() {
          return process.env.TEST_MIGRATIONS_CURRENT === "true";
        }
      };
      await runTfIntegrationsMain({
        dependencies: {
          createPool() {
            return { async end() {} };
          },
          createRepository() {
            return repository;
          },
          async probeDatabase() {
            return process.env.TEST_DATABASE_READY === "true";
          },
          createService() {
            return { async execute(command) {
              return {
                schemaVersion: 1,
                requestId: command.requestId,
                accountId: command.accountId,
                operation: command.operation,
                error: { code: "provider_unavailable" }
              };
            }};
          },
          startHeartbeat() {
            return { async stop() {} };
          }
        }
      });
    `,
    "utf8",
  );
  return path;
}

afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      await once(child, "exit");
    }),
  );
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("TF integrations production bundles", () => {
  it("starts only after configuration and migration readiness are established", async () => {
    await execFileAsync(process.execPath, ["build.mjs"], {
      cwd: process.cwd(),
    });
    const environment = await fixture();
    const wrapper = await runtimeWrapper();

    const unavailable = spawn(process.execPath, [wrapper], {
      env: {
        ...process.env,
        ...environment,
        TEST_MIGRATIONS_CURRENT: "false",
        TEST_DATABASE_READY: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(unavailable);
    let unavailableOutput = "";
    unavailable.stdout?.on("data", (chunk: Buffer) => {
      unavailableOutput += chunk.toString("utf8");
    });
    await expect(waitForExit(unavailable)).resolves.toBe(1);
    expect(unavailableOutput).not.toContain("listening");

    const ready = spawn(process.execPath, [wrapper], {
      env: {
        ...process.env,
        ...environment,
        PORT: String(await unusedPort()),
        TEST_MIGRATIONS_CURRENT: "true",
        TEST_DATABASE_READY: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(ready);
    await waitForListening(ready);
    ready.kill("SIGTERM");
    const exitCode = await waitForExit(ready);
    expect(
      exitCode === 0 ||
        (process.platform === "win32" &&
          exitCode === null &&
          ready.signalCode === "SIGTERM"),
    ).toBe(true);
  }, 20_000);

  it("prints one sanitized startup failure without secret canaries", async () => {
    await execFileAsync(process.execPath, ["build.mjs"], {
      cwd: process.cwd(),
    });
    const environment = await fixture();
    await writeFile(
      environment.TF_INTEGRATIONS_TOKEN_KEYRING_FILE!,
      `{"activeKeyId":"${canary}"`,
      "utf8",
    );
    const child = spawn(process.execPath, ["dist/index.mjs"], {
      cwd: process.cwd(),
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    await expect(waitForExit(child)).resolves.toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("TF integrations startup failed\n");
    expect(`${stdout}${stderr}`).not.toContain(canary);
    expect(`${stdout}${stderr}`).not.toContain(
      environment.TF_INTEGRATIONS_TOKEN_KEYRING_FILE!,
    );
  }, 15_000);

  it("builds runtime and migrator bundles without source or workspace resolution", async () => {
    await execFileAsync(process.execPath, ["build.mjs"], {
      cwd: process.cwd(),
    });
    await expect(readdir("dist")).resolves.toEqual([
      "index.mjs",
      "migrate.mjs",
      "migrations",
    ]);
    for (const bundle of ["dist/index.mjs", "dist/migrate.mjs"]) {
      const source = await readFile(bundle, "utf8");
      expect(source).not.toContain("@workspace/");
      expect(source).not.toMatch(/(?:^|["'])\.\.?\/src\//m);
      expect(source).not.toMatch(/from\s+["'][^"']+\.ts["']/);
    }

    const environment = await fixture();
    const migrator = spawn(process.execPath, ["dist/migrate.mjs"], {
      cwd: process.cwd(),
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(migrator);
    let stderr = "";
    migrator.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    await expect(waitForExit(migrator, 15_000)).resolves.toBe(1);
    expect(stderr).toBe("TF integrations migration failed\n");
    expect(stderr).not.toContain(canary);
  }, 30_000);
});
