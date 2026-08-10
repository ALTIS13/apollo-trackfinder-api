import { describe, expect, it } from "vitest";

import { TfIntegrationsAdminOverviewService } from "./admin-overview.js";

const accountId = "10000000-0000-4000-8000-000000000001";

describe("TfIntegrationsAdminOverviewService", () => {
  it("bounds stored provider display metadata to the dashboard contract", async () => {
    const service = new TfIntegrationsAdminOverviewService({
      listAdminConnectionSummaries: async () => [
        {
          accountId,
          provider: "spotify",
          displayName: "x".repeat(500),
          updatedAt: new Date("2026-08-10T12:00:00.000Z"),
        },
      ],
    });

    await expect(service.load({ accountIds: [accountId] })).resolves.toEqual({
      connections: [
        {
          accountId,
          provider: "spotify",
          displayName: "x".repeat(256),
          updatedAt: "2026-08-10T12:00:00.000Z",
        },
      ],
    });
  });
});
