import { describe, expect, it } from "vitest";

import { createAdminAccountOverview } from "./admin-account-overview-client.js";

const accountId = "10000000-0000-4000-8000-000000000001";

describe("admin account overview aggregation", () => {
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
