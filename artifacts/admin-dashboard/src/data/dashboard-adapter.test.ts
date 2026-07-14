import { describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "./demo-snapshot";
import { createDashboardAdapterForEnvironment } from "./dashboard-adapter";

describe("dashboard adapter environment wiring", () => {
  it("uses the demo adapter when no build-time API URL is configured", () => {
    expect(createDashboardAdapterForEnvironment(" ")).toMatchObject({
      initialSnapshot: demoSnapshot,
    });
  });

  it("uses the HTTP adapter when a build-time API URL is configured", async () => {
    const fetchSnapshot = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(demoSnapshot),
    });
    const adapter = createDashboardAdapterForEnvironment(
      "https://admin.example.test/",
      fetchSnapshot,
    );

    await adapter.loadSnapshot();
    expect(fetchSnapshot).toHaveBeenCalledWith(
      "https://admin.example.test/api/admin/dashboard",
      { headers: { Accept: "application/json" } },
    );
  });
});
