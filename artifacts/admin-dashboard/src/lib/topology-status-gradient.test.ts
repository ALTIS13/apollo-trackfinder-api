import { describe, expect, it } from "vitest";
import { buildStatusGradientStops } from "./topology-status-gradient";

describe("buildStatusGradientStops", () => {
  it("builds exact weighted opaque transition stops", () => {
    const stops = buildStatusGradientStops([
      { status: "healthy", count: 2 },
      { status: "warning", count: 1 },
    ]);

    expect(stops.map((stop) => stop.status)).toEqual([
      "healthy",
      "healthy",
      "warning",
      "warning",
    ]);
    expect(stops[0]?.offset).toBeCloseTo(0);
    expect(stops[1]?.offset).toBeCloseTo(2 / 3 - 0.04);
    expect(stops[2]?.offset).toBeCloseTo(2 / 3 + 0.04);
    expect(stops[3]?.offset).toBeCloseTo(1);
    expect(stops.every((stop) => Number.isFinite(stop.offset))).toBe(true);
    expect(stops.every((stop, index) => index === 0 || stop.offset >= stops[index - 1]!.offset)).toBe(true);
    expect(stops.every((stop) => !("opacity" in stop))).toBe(true);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
  ])("rejects a %s individual band count", (_label, count) => {
    expect(
      buildStatusGradientStops([
        { status: "healthy", count: 2 },
        { status: "warning", count },
      ]),
    ).toEqual([]);
  });

  it("rejects finite counts whose total overflows", () => {
    expect(
      buildStatusGradientStops([
        { status: "healthy", count: Number.MAX_VALUE },
        { status: "warning", count: Number.MAX_VALUE },
      ]),
    ).toEqual([]);
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
