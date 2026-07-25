import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiApp } from "./app.js";
import type { TfIntegrationsGateway } from "./lib/tf-integrations-client.js";
import { TfIntegrationsUnavailableError } from "./lib/tf-integrations-client.js";
import { createTfLogger } from "./lib/logger.js";

vi.hoisted(() => {
  process.env["DATABASE_URL"] ??=
    "postgres://unused:unused@127.0.0.1:1/unused";
});

const ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";
const servers: Server[] = [];

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
});
