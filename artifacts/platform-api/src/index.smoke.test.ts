import { execFile } from "node:child_process";
import { once } from "node:events";
import { readdir } from "node:fs/promises";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { spawn } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const children: ReturnType<typeof spawn>[] = [];

async function unusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Could not reserve a TCP port");
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function waitForListening(
  child: ReturnType<typeof spawn>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for bundle")),
      10_000,
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString("utf8").includes('"msg":"listening"')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Bundle exited before listening: ${code}`));
    });
  });
}

async function waitForExit(
  child: ReturnType<typeof spawn>,
  timeoutMs = 3_000,
): Promise<number | null> {
  return new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for bundle to exit")),
      timeoutMs,
    );
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      await once(child, "exit");
    }),
  );
});

describe("production bundle", () => {
  it("emits only the runnable API, migration, and policy-smoke bundles", async () => {
    await execFileAsync(process.execPath, ["build.mjs"], {
      cwd: process.cwd(),
    });

    await expect(readdir("dist")).resolves.toEqual([
      "index.mjs",
      "migrate.mjs",
      "policy-smoke.mjs",
    ]);
  });

  it("starts without migrations and reports unavailable readiness", async () => {
    await execFileAsync(process.execPath, ["build.mjs"], {
      cwd: process.cwd(),
    });
    const port = await unusedPort();
    const child = spawn(process.execPath, ["dist/index.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        APOLLO_ALLOWED_ORIGINS: "https://admin.apollo.test",
        APOLLO_OPERATOR_BOOTSTRAP_TOKEN: "bootstrap-secret",
        APOLLO_REDIS_URL: "redis://127.0.0.1:1",
        DATABASE_URL: "postgres://runtime:secret@127.0.0.1:1/platform",
        NODE_ENV: "production",
        PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    await waitForListening(child);

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(health.status).toBe(200);
    expect(ready.status).toBe(503);
  });

  it.each([
    ["missing bootstrap token", { APOLLO_OPERATOR_BOOTSTRAP_TOKEN: undefined }],
    [
      "invalid allowed origin",
      { APOLLO_ALLOWED_ORIGINS: "https://admin.apollo.test/path" },
    ],
    ["invalid port", { PORT: "invalid" }],
    ["invalid trust proxy hops", { APOLLO_TRUST_PROXY_HOPS: "3" }],
  ])("exits promptly when %s", async (_name, overrides) => {
    await execFileAsync(process.execPath, ["build.mjs"], {
      cwd: process.cwd(),
    });
    const child = spawn(process.execPath, ["dist/index.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        APOLLO_ALLOWED_ORIGINS: "https://admin.apollo.test",
        APOLLO_OPERATOR_BOOTSTRAP_TOKEN: "bootstrap-secret",
        APOLLO_REDIS_URL: "redis://127.0.0.1:1",
        DATABASE_URL: "postgres://runtime:secret@127.0.0.1:1/platform",
        NODE_ENV: "production",
        PORT: "3000",
        APOLLO_TRUST_PROXY_HOPS: "0",
        ...overrides,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);

    await expect(waitForExit(child)).resolves.toBe(1);
  });
});
