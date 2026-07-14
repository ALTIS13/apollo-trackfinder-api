import { describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "./demo-snapshot";
import {
  createHttpDashboardSnapshotAdapter,
  normalizeAdminApiBaseUrl,
} from "./http-snapshot-adapter";

describe("HTTP dashboard snapshot adapter", () => {
  it("normalizes whitespace and trailing slashes from the API base URL", () => {
    expect(normalizeAdminApiBaseUrl(" https://admin.example.test/ ")).toBe(
      "https://admin.example.test",
    );
  });

  it("fetches the stable admin snapshot endpoint and returns its response", async () => {
    const responseJson = vi.fn().mockResolvedValue(demoSnapshot);
    const fetchSnapshot = vi.fn().mockResolvedValue({ ok: true, json: responseJson });
    const adapter = createHttpDashboardSnapshotAdapter({
      baseUrl: "https://admin.example.test/",
      fetchSnapshot,
    });

    await expect(adapter.loadSnapshot()).resolves.toBe(demoSnapshot);
    expect(fetchSnapshot).toHaveBeenCalledWith(
      "https://admin.example.test/api/admin/dashboard",
      { headers: { Accept: "application/json" } },
    );
    expect(responseJson).toHaveBeenCalledTimes(1);
  });

  it("keeps the demo snapshot as last known good data and rejects a non-OK response", async () => {
    const fetchSnapshot = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
    });
    const adapter = createHttpDashboardSnapshotAdapter({
      baseUrl: "https://admin.example.test",
      fetchSnapshot,
    });

    expect(adapter.initialSnapshot).toBe(demoSnapshot);
    await expect(adapter.loadSnapshot()).rejects.toThrow("503 Service Unavailable");
  });
});
