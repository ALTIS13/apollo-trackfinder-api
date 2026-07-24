import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { spawn } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { parsePlatformRuntimeConfig } from "./runtime-config.js";

const execFileAsync = promisify(execFile);
const children: ReturnType<typeof spawn>[] = [];
const temporaryDirectories: string[] = [];

async function runtimeFixtureEnvironment(nodeEnv = "production"): Promise<{
  readonly environment: NodeJS.ProcessEnv;
  readonly paths: {
    readonly privateJwk: string;
    readonly publicJwks: string;
    readonly oauthClients: string;
  };
}> {
  const directory = await mkdtemp(join(tmpdir(), "apollo-platform-task5-"));
  temporaryDirectories.push(directory);
  const pair = generateKeyPairSync("ed25519");
  const privateJwk = pair.privateKey.export({ format: "jwk" });
  const publicJwk = pair.publicKey.export({ format: "jwk" });
  const paths = {
    privateJwk: join(directory, "platform_assertion_private_jwk"),
    publicJwks: join(directory, "platform_assertion_public_jwks"),
    oauthClients: join(directory, "platform_oauth_clients"),
  };
  await Promise.all([
    writeFile(
      paths.privateJwk,
      JSON.stringify({
        ...privateJwk,
        alg: "EdDSA",
        use: "sig",
        kid: "task-5-test-key",
      }),
      "utf8",
    ),
    writeFile(
      paths.publicJwks,
      JSON.stringify({
        keys: [
          {
            ...publicJwk,
            alg: "EdDSA",
            use: "sig",
            kid: "task-5-test-key",
          },
        ],
      }),
      "utf8",
    ),
    writeFile(
      paths.oauthClients,
      JSON.stringify([
        {
          clientId: "apollo-tf-api",
          audience: "apollo-tf",
          redirectUris: [
            nodeEnv === "development"
              ? "http://127.0.0.1:18082/api/auth/callback"
              : "https://api.tf.apollot.ru/api/auth/callback",
          ],
          clientSecretDigest: createHash("sha256")
            .update("disposable-client-secret")
            .digest("hex"),
        },
      ]),
      "utf8",
    ),
  ]);
  return {
    environment: {
      APOLLO_ALLOWED_ORIGINS: "https://admin.apollo.test",
      APOLLO_ASSERTION_PRIVATE_JWK_FILE: paths.privateJwk,
      APOLLO_ASSERTION_PUBLIC_JWKS_FILE: paths.publicJwks,
      APOLLO_INTROSPECTION_CLIENT_ID: "apollo-tf-api",
      APOLLO_ISSUER:
        nodeEnv === "development"
          ? "http://127.0.0.1:18081"
          : "https://api.apollot.ru",
      APOLLO_OAUTH_CLIENTS_FILE: paths.oauthClients,
      APOLLO_OPERATOR_BOOTSTRAP_TOKEN: "bootstrap-secret",
      APOLLO_REDIS_URL: "redis://127.0.0.1:1",
      DATABASE_URL: "postgres://runtime:secret@127.0.0.1:1/platform",
      NODE_ENV: nodeEnv,
      PORT: "3000",
      APOLLO_TRUST_PROXY_HOPS: "0",
    },
    paths,
  };
}

async function corruptAssertionKeyMaterial(
  paths: Awaited<ReturnType<typeof runtimeFixtureEnvironment>>["paths"],
): Promise<void> {
  const privatePair = generateKeyPairSync("ed25519");
  const publicPair = generateKeyPairSync("ed25519");
  const privateJwk = privatePair.privateKey.export({ format: "jwk" });
  const publicJwk = publicPair.publicKey.export({ format: "jwk" });
  await Promise.all([
    writeFile(
      paths.privateJwk,
      JSON.stringify({
        ...privateJwk,
        x: publicJwk.x,
        alg: "EdDSA",
        use: "sig",
        kid: "task-5-corrupt-key",
      }),
      "utf8",
    ),
    writeFile(
      paths.publicJwks,
      JSON.stringify({
        keys: [
          {
            ...publicJwk,
            alg: "EdDSA",
            use: "sig",
            kid: "task-5-corrupt-key",
          },
        ],
      }),
      "utf8",
    ),
  ]);
}

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
  if (child.exitCode !== null) return child.exitCode;
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
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("production bundle", () => {
  it("loads strict file-backed assertion and OAuth client JSON", async () => {
    const fixture = await runtimeFixtureEnvironment();
    const config = await parsePlatformRuntimeConfig(fixture.environment);
    expect(config.issuer).toBe("https://api.apollot.ru");
    expect(config.introspectionClientId).toBe("apollo-tf-api");
    expect(config.assertionPrivateJwk).toMatchObject({
      kty: "OKP",
      crv: "Ed25519",
      alg: "EdDSA",
      use: "sig",
      kid: "task-5-test-key",
      d: expect.any(String),
    });
    expect(config.assertionPublicJwks).toEqual([
      expect.objectContaining({
        kty: "OKP",
        crv: "Ed25519",
        kid: "task-5-test-key",
      }),
    ]);
    expect(config.oauthClients.get("apollo-tf-api")).toMatchObject({
      clientId: "apollo-tf-api",
      audience: "apollo-tf",
    });
  });

  it.each([
    ["missing", "missing"],
    ["unreadable", "unreadable"],
    ["empty", "empty"],
    ["oversized", "oversized"],
    ["malformed", "malformed"],
    ["duplicate-key", "duplicate-key"],
    ["unknown-key", "unknown-key"],
  ])(
    "rejects a %s secret file without reflecting its contents",
    async (_name, mutation) => {
      const fixture = await runtimeFixtureEnvironment();
      const canary = "runtime-secret-canary";
      if (mutation === "missing") {
        fixture.environment.APOLLO_ASSERTION_PRIVATE_JWK_FILE = join(
          fixture.paths.privateJwk,
          "missing",
        );
      } else if (mutation === "unreadable") {
        fixture.environment.APOLLO_ASSERTION_PRIVATE_JWK_FILE =
          temporaryDirectories.at(-1);
      } else if (mutation === "empty") {
        await writeFile(fixture.paths.privateJwk, "", "utf8");
      } else if (mutation === "oversized") {
        await writeFile(fixture.paths.privateJwk, " ".repeat(65_537), "utf8");
      } else if (mutation === "malformed") {
        await writeFile(fixture.paths.privateJwk, `{"d":"${canary}"`, "utf8");
      } else if (mutation === "duplicate-key") {
        await writeFile(
          fixture.paths.oauthClients,
          `[{"clientId":"apollo-tf-api","clientId":"duplicate","audience":"apollo-tf","redirectUris":["https://api.tf.apollot.ru/api/auth/callback"],"clientSecretDigest":"${"a".repeat(64)}"}]`,
          "utf8",
        );
      } else {
        const privateJwk = JSON.parse(
          await import("node:fs/promises").then(({ readFile }) =>
            readFile(fixture.paths.privateJwk, "utf8"),
          ),
        ) as Record<string, unknown>;
        await writeFile(
          fixture.paths.privateJwk,
          JSON.stringify({ ...privateJwk, unknown: canary }),
          "utf8",
        );
      }

      let error: unknown;
      try {
        await parsePlatformRuntimeConfig(fixture.environment);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect(String((error as Error).message)).not.toContain(canary);
      expect(String((error as Error).message)).not.toContain(
        fixture.paths.privateJwk,
      );
    },
    20_000,
  );

  it.each([
    ["fatal invalid UTF-8", "publicJwks", "invalid-utf8"],
    ["malformed JSON", "publicJwks", "malformed"],
    ["unknown key", "oauthClients", "unknown-key"],
  ] as const)(
    "rejects %s corruption in the %s runtime file",
    async (_name, target, mutation) => {
      const fixture = await runtimeFixtureEnvironment();
      const path = fixture.paths[target];
      const canary = "runtime-public-file-canary";

      if (mutation === "invalid-utf8") {
        await writeFile(
          path,
          Buffer.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d]),
        );
      } else if (mutation === "malformed") {
        await writeFile(path, `{"keys":[{"kid":"${canary}"}]`, "utf8");
      } else {
        await writeFile(
          path,
          JSON.stringify([
            {
              clientId: "apollo-tf-api",
              audience: "apollo-tf",
              redirectUris: ["https://api.tf.apollot.ru/api/auth/callback"],
              clientSecretDigest: "a".repeat(64),
              unknown: canary,
            },
          ]),
          "utf8",
        );
      }

      let error: unknown;
      try {
        await parsePlatformRuntimeConfig(fixture.environment);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect(String((error as Error).message)).not.toContain(canary);
      expect(String((error as Error).message)).not.toContain(path);
    },
  );

  it("rejects wrong-environment issuer, redirect fixtures, and introspection binding", async () => {
    const httpIssuer = await runtimeFixtureEnvironment();
    httpIssuer.environment.APOLLO_ISSUER = "http://127.0.0.1:18081";
    await expect(
      Promise.resolve().then(() =>
        parsePlatformRuntimeConfig(httpIssuer.environment),
      ),
    ).rejects.toThrow();

    const developmentRegistry = await runtimeFixtureEnvironment();
    await writeFile(
      developmentRegistry.paths.oauthClients,
      JSON.stringify([
        {
          clientId: "apollo-tf-api",
          audience: "apollo-tf",
          redirectUris: ["http://127.0.0.1:18082/api/auth/callback"],
          clientSecretDigest: "a".repeat(64),
        },
      ]),
      "utf8",
    );
    await expect(
      Promise.resolve().then(() =>
        parsePlatformRuntimeConfig(developmentRegistry.environment),
      ),
    ).rejects.toThrow();

    const unknownClient = await runtimeFixtureEnvironment();
    unknownClient.environment.APOLLO_INTROSPECTION_CLIENT_ID =
      "unregistered-client";
    await expect(
      Promise.resolve().then(() =>
        parsePlatformRuntimeConfig(unknownClient.environment),
      ),
    ).rejects.toThrow();
  });

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
    const fixture = await runtimeFixtureEnvironment();
    const child = spawn(process.execPath, ["dist/index.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...fixture.environment,
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
  }, 15_000);

  it("rejects cryptographically inconsistent assertion key material generically", async () => {
    const fixture = await runtimeFixtureEnvironment();
    await corruptAssertionKeyMaterial(fixture.paths);

    await expect(
      parsePlatformRuntimeConfig(fixture.environment),
    ).rejects.toThrow("Platform OAuth secret configuration is invalid");
  });

  it("exits nonzero before listening when assertion key import fails", async () => {
    await execFileAsync(process.execPath, ["build.mjs"], {
      cwd: process.cwd(),
    });
    const fixture = await runtimeFixtureEnvironment();
    await corruptAssertionKeyMaterial(fixture.paths);
    const child = spawn(process.execPath, ["dist/index.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...fixture.environment,
        PORT: String(await unusedPort()),
      },
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
    expect(stdout).not.toContain('"msg":"listening"');
    expect(stderr).toBe("Platform API startup failed\n");
    expect(`${stdout}${stderr}`).not.toContain("task-5-corrupt-key");
  }, 15_000);

  it.each([
    ["missing bootstrap token", { APOLLO_OPERATOR_BOOTSTRAP_TOKEN: undefined }],
    [
      "invalid allowed origin",
      { APOLLO_ALLOWED_ORIGINS: "https://admin.apollo.test/path" },
    ],
    ["invalid port", { PORT: "invalid" }],
    ["invalid trust proxy hops", { APOLLO_TRUST_PROXY_HOPS: "3" }],
    [
      "missing assertion private JWK file",
      { APOLLO_ASSERTION_PRIVATE_JWK_FILE: undefined },
    ],
  ])(
    "exits promptly when %s",
    async (_name, overrides) => {
      await execFileAsync(process.execPath, ["build.mjs"], {
        cwd: process.cwd(),
      });
      const fixture = await runtimeFixtureEnvironment();
      const childEnvironment: NodeJS.ProcessEnv = {
        ...process.env,
        ...fixture.environment,
      };
      for (const [name, value] of Object.entries(overrides)) {
        if (value === undefined) {
          delete childEnvironment[name];
        } else {
          childEnvironment[name] = value;
        }
      }
      const child = spawn(process.execPath, ["dist/index.mjs"], {
        cwd: process.cwd(),
        env: childEnvironment,
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(child);

      await expect(waitForExit(child)).resolves.toBe(1);
    },
    15_000,
  );
});
