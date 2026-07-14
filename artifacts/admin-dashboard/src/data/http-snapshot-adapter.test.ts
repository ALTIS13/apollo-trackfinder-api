import { describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "./demo-snapshot";
import {
  createHttpDashboardSnapshotAdapter,
} from "./http-snapshot-adapter";

describe("HTTP dashboard snapshot adapter", () => {
  it("fetches the same-origin admin snapshot endpoint and returns its response", async () => {
    const responseJson = vi.fn().mockResolvedValue(demoSnapshot);
    const fetchSnapshot = vi.fn().mockResolvedValue({ ok: true, json: responseJson });
    const adapter = createHttpDashboardSnapshotAdapter({
      fetchSnapshot,
    });

    await expect(adapter.loadSnapshot()).resolves.toEqual(demoSnapshot);
    expect(fetchSnapshot).toHaveBeenCalledWith(
      "/api/admin/dashboard",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
    expect(responseJson).toHaveBeenCalledTimes(1);
  });

  it("keeps the demo snapshot as an unverified fallback and rejects a non-OK response", async () => {
    const fetchSnapshot = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
    });
    const adapter = createHttpDashboardSnapshotAdapter({
      fetchSnapshot,
    });

    expect(adapter.initialSnapshot).toBe(demoSnapshot);
    expect(adapter).toMatchObject({
      mode: "http",
      capabilities: { canAcknowledgeIncidents: false },
    });
    await expect(adapter.loadSnapshot()).rejects.toThrow("503 Service Unavailable");
  });

  it.each([
    [
      "an invalid enum",
      { ...demoSnapshot, modules: [{ ...demoSnapshot.modules[0], status: "broken" }] },
    ],
    ["an invalid timestamp", { ...demoSnapshot, generatedAt: "today" }],
    [
      "duplicate service IDs",
      { ...demoSnapshot, modules: [demoSnapshot.modules[0], demoSnapshot.modules[0]] },
    ],
    [
      "an unknown edge service reference",
      {
        ...demoSnapshot,
        edges: [{ ...demoSnapshot.edges[0], target: "missing-service" }],
      },
    ],
    [
      "an unknown incident service reference",
      {
        ...demoSnapshot,
        incidents: [{ ...demoSnapshot.incidents[0], serviceId: "missing-service" }],
      },
    ],
    [
      "an oversized collection",
      { ...demoSnapshot, metrics: Array.from({ length: 33 }, (_, index) => ({ ...demoSnapshot.metrics[0], id: `metric-${index}` })) },
    ],
  ])("rejects HTTP 200 JSON containing %s", async (_label, body) => {
    const adapter = createHttpDashboardSnapshotAdapter({
      fetchSnapshot: vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(body),
      }),
    });

    await expect(adapter.loadSnapshot()).rejects.toThrow(
      "Invalid admin dashboard snapshot",
    );
  });

  it("aborts a hung request after 10 seconds", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const adapter = createHttpDashboardSnapshotAdapter({
      fetchSnapshot: vi.fn((_input, init) => {
        requestSignal = init.signal ?? undefined;
        return new Promise<never>(() => undefined);
      }),
    });

    const request = adapter.loadSnapshot();
    const rejection = expect(request).rejects.toThrow(
      "timed out after 10000ms",
    );
    expect(requestSignal).toBeDefined();
    await vi.advanceTimersByTimeAsync(10_000);

    await rejection;
    expect(requestSignal?.aborted).toBe(true);
    vi.useRealTimers();
  });

  it("shares one in-flight request across concurrent refreshes", async () => {
    let resolveResponse!: (value: { ok: true; json: () => Promise<typeof demoSnapshot> }) => void;
    const fetchSnapshot = vi.fn(
      () => new Promise<{ ok: true; json: () => Promise<typeof demoSnapshot> }>((resolve) => {
        resolveResponse = resolve;
      }),
    );
    const adapter = createHttpDashboardSnapshotAdapter({
      fetchSnapshot,
    });

    const first = adapter.loadSnapshot();
    const second = adapter.loadSnapshot();
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);

    resolveResponse({ ok: true, json: async () => demoSnapshot });
    await expect(Promise.all([first, second])).resolves.toEqual([
      demoSnapshot,
      demoSnapshot,
    ]);
  });
});
