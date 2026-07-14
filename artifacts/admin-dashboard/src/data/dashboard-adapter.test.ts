import { describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "./demo-snapshot";
import { createDashboardAdapterForEnvironment } from "./dashboard-adapter";

describe("dashboard adapter environment wiring", () => {
  it("uses the demo adapter when no build-time API URL is configured", () => {
    expect(createDashboardAdapterForEnvironment(false)).toMatchObject({
      initialSnapshot: demoSnapshot,
    });
  });

  it("uses the same-origin HTTP adapter when production mode is configured", async () => {
    const fetchSnapshot = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(demoSnapshot),
    });
    const adapter = createDashboardAdapterForEnvironment(true, fetchSnapshot);

    await adapter.loadSnapshot();
    expect(fetchSnapshot).toHaveBeenCalledWith(
      "/api/admin/dashboard",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
    expect(adapter).toMatchObject({
      mode: "http",
      capabilities: { canAcknowledgeIncidents: false },
    });
  });
});
