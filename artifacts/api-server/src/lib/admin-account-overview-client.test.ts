import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  createAdminAccountOverview,
  parseAdminAccountOverviewClientConfig,
} from "./admin-account-overview-client.js";

const accountId = "10000000-0000-4000-8000-000000000001";

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
        total: 1,
        activeNow: 1,
        pending: 0,
        suspended: 0,
        spotifyConnected: 0,
        yandexConnected: 0,
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
});
