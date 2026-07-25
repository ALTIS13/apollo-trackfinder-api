import { createServer } from "node:net";

import { createSignedBodySignature } from "@workspace/module-runtime-contract";
import type { ProviderAccountRepository } from "@workspace/tf-integrations-db";
import { describe, expect, it } from "vitest";

import { startTfIntegrationsRuntime } from "./index.js";
import { parseProviderTokenKeyring } from "./token-keyring.js";

async function unusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("missing test port");
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

describe("TF integrations runtime command cancellation", () => {
  it("aborts active command work before listener and pool shutdown", async () => {
    const port = await unusedPort();
    const commandSecret = "c".repeat(32);
    let poolEnded = false;
    let commandStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      commandStarted = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    const repository = {
      async isMigrationCurrent() {
        return true;
      },
    } as unknown as ProviderAccountRepository;
    const runtime = await startTfIntegrationsRuntime({
      registerSignals: false,
      dependencies: {
        async parseConfig() {
          return {
            port,
            internalAuthSecret: commandSecret,
            heartbeatSecret: "h".repeat(32),
            databaseUrl:
              "postgres://runtime:password@database/integrations",
            tokenKeyring: parseProviderTokenKeyring(
              JSON.stringify({
                activeKeyId: "test",
                keys: {
                  test: Buffer.alloc(32, 1).toString("base64url"),
                },
              }),
            ),
            spotifyClientId: "spotify-client",
            spotifyClientSecret: "spotify-secret",
            spotifyCallbackUri:
              "https://api.example.test/api/spotify/callback",
            heartbeatApiOrigin: "https://api.example.test",
            version: "test",
            smokeFixtures: false,
          };
        },
        createPool: () =>
          ({
            async end() {
              poolEnded = true;
            },
          }) as never,
        createRepository: () => repository,
        probeDatabase: async () => true,
        createService: () => ({
          async execute(command, context) {
            observedSignal = context.signal;
            commandStarted?.();
            await new Promise<void>((resolve) => {
              const safety = setTimeout(resolve, 100);
              context.signal.addEventListener(
                "abort",
                () => {
                  clearTimeout(safety);
                  resolve();
                },
                { once: true },
              );
            });
            return {
              schemaVersion: 1,
              requestId: command.requestId,
              accountId: command.accountId,
              operation: command.operation,
              error: { code: "provider_unavailable" },
            };
          },
        }),
        startHeartbeat: () => ({ async stop() {} }),
      },
    });

    const command = {
      schemaVersion: 1,
      requestId: "10000000-0000-4000-8000-000000000001",
      accountId: "20000000-0000-4000-8000-000000000002",
      operation: "spotify.status",
      input: {},
    };
    const rawBody = Buffer.from(JSON.stringify(command), "utf8");
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const nonce = Buffer.alloc(32, 4).toString("base64url");
    const pendingResponse = fetch(
      `http://127.0.0.1:${port}/v1/commands`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-apollo-internal-timestamp": timestamp,
          "x-apollo-internal-nonce": nonce,
          "x-apollo-internal-signature": createSignedBodySignature({
            method: "POST",
            path: "/v1/commands",
            timestamp,
            nonce,
            rawBody,
            secret: commandSecret,
          }),
        },
        body: rawBody,
      },
    );
    await started;
    const shuttingDown = runtime.shutdown();
    await pendingResponse;
    await shuttingDown;

    expect(observedSignal?.aborted).toBe(true);
    expect(poolEnded).toBe(true);
  });
});
