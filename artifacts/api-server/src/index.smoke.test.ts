import { once } from "node:events";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiApp } from "./app.js";
import type { TfIntegrationsGateway } from "./lib/tf-integrations-client.js";
import { TfIntegrationsUnavailableError } from "./lib/tf-integrations-client.js";
import { createTfLogger } from "./lib/logger.js";

vi.hoisted(() => {
  process.env["DATABASE_URL"] ??= "postgres://unused:unused@127.0.0.1:1/unused";
});

const ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";
const servers: Server[] = [];
const artifactDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function startApp(
  gateway: TfIntegrationsGateway,
  readiness: () => Promise<boolean>,
): Promise<string> {
  const app = createApiApp({
    integrationsGateway: gateway,
    readiness,
    requestLogger: createTfLogger(
      new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
    ),
  });
  app.use((request, _response, next) => {
    request.tfPrincipal = {
      accountId: ACCOUNT_ID,
      tfSessionId: "20000000-0000-4000-8000-000000000002",
      installationId: "30000000-0000-4000-8000-000000000003",
      entitlements: ["tf.integrations"],
      sessionExpiresAt: "2026-07-24T04:00:00.000Z",
      policyFreshUntil: "2026-07-24T03:05:00.000Z",
    };
    next();
  });
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe("API integrations runtime wiring", () => {
  it("keeps readiness independent from the integrations gateway", async () => {
    const gateway = {
      execute: vi.fn(async () => {
        throw new TfIntegrationsUnavailableError();
      }),
    } as unknown as TfIntegrationsGateway;
    const readiness = vi.fn().mockResolvedValue(true);
    const origin = await startApp(gateway, readiness);

    const response = await fetch(`${origin}/api/readyz`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
    expect(readiness).toHaveBeenCalledOnce();
    expect(gateway.execute).not.toHaveBeenCalled();
  });

  it("keeps runtime startup DDL-free and gates readiness on migration history", async () => {
    const indexSource = await readFile(
      path.join(artifactDirectory, "src/index.ts"),
      "utf8",
    );

    expect(indexSource).not.toContain("runMigrations");
    expect(indexSource).not.toContain("./lib/migrate");
    expect(indexSource).not.toContain("probeDatabaseHealth");
    expect(indexSource).toContain("createTfMigrationReadinessProbe");
    expect(indexSource).toContain("createTfMigrationReadinessProbe(pool)");
  });

  it("packages the dedicated migrator entrypoint and immutable SQL", async () => {
    const [buildSource, dockerfile, migrateSource] = await Promise.all([
      readFile(path.join(artifactDirectory, "build.mjs"), "utf8"),
      readFile(path.join(artifactDirectory, "Dockerfile"), "utf8"),
      readFile(path.join(artifactDirectory, "src/migrate.ts"), "utf8"),
    ]);

    expect(buildSource).toContain(
      'migrate: path.resolve(artifactDir, "src/migrate.ts")',
    );
    expect(dockerfile).toContain("COPY lib/db/migrations /app/migrations");
    expect(migrateSource).toContain("args: process.argv.slice(2)");
    expect(migrateSource).toContain("env: process.env");
    expect(migrateSource).toContain(
      'process.stderr.write("TF migration failed\\n")',
    );
    expect(migrateSource).toContain("process.exitCode = 1");
    expect(migrateSource).not.toContain("console.error");
  });
});
