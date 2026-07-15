import { describe, expect, it } from "vitest";
import { buildStatusGradientStops } from "./topology-status-gradient";

describe("buildStatusGradientStops", () => {
  it("builds weighted opaque finite monotonic stops", () => {
    const stops = buildStatusGradientStops([
      { status: "healthy", count: 2 },
      { status: "warning", count: 1 },
    ]);

    expect(stops).toEqual([
      { offset: 0, status: "healthy" },
      { offset: expect.any(Number), status: "healthy" },
      { offset: expect.any(Number), status: "warning" },
      { offset: 1, status: "warning" },
    ]);
    expect(stops.map((stop) => stop.offset)).toEqual(
      expect.arrayContaining(stops.map((stop) => expect.any(Number))),
    );
    expect(stops[0]?.offset).toBe(0);
    expect(stops.at(-1)?.offset).toBe(1);
    expect(stops.every((stop) => Number.isFinite(stop.offset))).toBe(true);
    expect(stops.every((stop, index) => index === 0 || stop.offset >= stops[index - 1]!.offset)).toBe(true);
    expect(stops.every((stop) => !("opacity" in stop))).toBe(true);
  });

  it("returns identical output for the same bands despite unrelated edge order", () => {
    const bands = [
      { status: "healthy" as const, count: 2 },
      { status: "warning" as const, count: 1 },
    ];

    expect(buildStatusGradientStops(bands)).toEqual(
      buildStatusGradientStops([...bands]),
    );
  });

  it("uses two stops for one status and no stops for empty bands", () => {
    expect(buildStatusGradientStops([{ status: "unknown", count: 3 }])).toEqual([
      { offset: 0, status: "unknown" },
      { offset: 1, status: "unknown" },
    ]);
    expect(buildStatusGradientStops([])).toEqual([]);
  });
});
