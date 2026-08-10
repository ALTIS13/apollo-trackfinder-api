import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAdminAccountOverview,
  HttpAdminPlatformOverviewClient,
  parseAdminAccountOverviewClientConfig,
  unavailableAdminAccountOverview,
} from "./admin-account-overview-client.js";

const accountId = "10000000-0000-4000-8000-000000000001";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("admin account overview aggregation", () => {
  it("accepts HTTPS and documented internal HTTP service origins", async () => {
    const directory = await mkdtemp(join(tmpdir(), "apollo-admin-overview-"));
    const platformSecretFile = join(directory, "platform-secret");
    const integrationsSecretFile = join(directory, "integrations-secret");
    await Promise.all([
      writeFile(platformSecretFile, "p".repeat(32), "utf8"),
      writeFile(integrationsSecretFile, "i".repeat(32), "utf8"),
    ]);

    try {
      await expect(
        parseAdminAccountOverviewClientConfig({
          APOLLO_PLATFORM_API_ORIGIN: "https://platform.apollo.test",
          APOLLO_TF_CLIENT_ID: "apollo-tf-api",
          APOLLO_TF_CLIENT_SECRET_FILE: platformSecretFile,
          TF_INTEGRATIONS_ORIGIN: "https://integrations.apollo.test",
          TF_INTEGRATIONS_INTERNAL_AUTH_SECRET_FILE: integrationsSecretFile,
        }),
      ).resolves.toMatchObject({
        platformOrigin: "https://platform.apollo.test",
        integrationsOrigin: "https://integrations.apollo.test",
      });

      await expect(
        parseAdminAccountOverviewClientConfig({
          APOLLO_PLATFORM_API_ORIGIN: "http://platform-api:8080",
          APOLLO_TF_BRIDGE_ALLOW_INTERNAL_HTTP: "true",
          APOLLO_TF_CLIENT_ID: "apollo-tf-api",
          APOLLO_TF_CLIENT_SECRET_FILE: platformSecretFile,
          TF_INTEGRATIONS_ORIGIN: "http://tf-integrations:8080",
          TF_INTEGRATIONS_ALLOW_INSECURE_HTTP: "true",
          TF_INTEGRATIONS_INTERNAL_AUTH_SECRET_FILE: integrationsSecretFile,
        }),
      ).resolves.toMatchObject({
        platformOrigin: "http://platform-api:8080",
        integrationsOrigin: "http://tf-integrations:8080",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps platform accounts when integrations are unavailable", async () => {
    const result = await createAdminAccountOverview({
      platform: {
        load: async () => ({
          total: 1,
          activeNow: 1,
          pending: 0,
          suspended: 0,
          accounts: [
            {
              id: accountId,
              email: "operator@example.com",
              displayName: "Apollo Operator",
              status: "active",
              latestActivityAt: "2026-08-10T12:00:00.000Z",
              activeSessionCount: 1,
              moduleKeys: ["tf.search"],
            },
          ],
        }),
      },
      integrations: {
        load: async () => {
          throw new Error("integrations unavailable");
        },
      },
    });

    expect(result).toEqual({
      accountSummary: {
        availability: "available",
        total: 1,
        activeNow: 1,
        pending: 0,
        suspended: 0,
        connectionSummary: { availability: "unavailable" },
      },
      accounts: [
        {
          id: accountId,
          email: "operator@example.com",
          displayName: "Apollo Operator",
          status: "active",
          latestActivityAt: "2026-08-10T12:00:00.000Z",
          activeSessionCount: 1,
          moduleKeys: ["tf.search"],
          spotify: { state: "unavailable" },
          yandex: { state: "unavailable" },
        },
      ],
    });
  });

  it("represents a platform failure as unavailable rather than zero accounts", () => {
    expect(unavailableAdminAccountOverview).toEqual({
      accountSummary: { availability: "unavailable" },
      accounts: [],
    });
  });

  it("keeps platform rows when oversized connection metadata is malformed", async () => {
    const result = await createAdminAccountOverview({
      platform: {
        load: async () => ({
          total: 1,
          activeNow: 1,
          pending: 0,
          suspended: 0,
          accounts: [
            {
              id: accountId,
              email: "operator@example.com",
              displayName: "Apollo Operator",
              status: "active",
              activeSessionCount: 1,
              moduleKeys: ["tf.search"],
            },
          ],
        }),
      },
      integrations: {
        load: async () => ({
          connections: [
            {
              accountId,
              provider: "spotify",
              displayName: "x".repeat(300),
              updatedAt: "2026-08-10T12:00:00.000Z",
            },
          ],
        }),
      },
    });

    expect(result.accountSummary).toEqual({
      availability: "available",
      total: 1,
      activeNow: 1,
      pending: 0,
      suspended: 0,
      connectionSummary: { availability: "unavailable" },
    });
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]?.spotify).toEqual({ state: "unavailable" });
  });

  it("cancels an oversized streaming response as soon as it exceeds 128 KiB", async () => {
    const cancel = vi.fn();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls <= 3) {
          controller.enqueue(new Uint8Array(pulls <= 2 ? 64 * 1024 : 1));
          return;
        }
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            controller.close();
            resolve();
          }, 25);
        });
      },
      cancel,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(body, {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const client = new HttpAdminPlatformOverviewClient({
      platformOrigin: "https://platform.apollo.test",
      platformClientId: "apollo-tf-api",
      platformClientSecret: "p".repeat(32),
    });

    await expect(client.load()).rejects.toThrow("overview unavailable");
    expect(cancel).toHaveBeenCalledOnce();
    expect(pulls).toBeLessThanOrEqual(4);
  });
});
