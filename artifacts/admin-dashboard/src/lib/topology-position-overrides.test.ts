import { describe, expect, it } from "vitest";
import {
  applyPositionChanges,
  prunePositionOverrides,
} from "./topology-position-overrides";

describe("topology position overrides", () => {
  it("stores normalized fractional positions without mutating overrides", () => {
    const inputOverrides = new Map([
      ["existing", { x: 12, y: 24 }],
    ]);
    const position = { x: 48.5, y: 95.25 };

    const next = applyPositionChanges(inputOverrides, [
      { type: "position", id: "core-api", position },
      { type: "select", id: "core-api", selected: true },
    ]);

    expect(next).not.toBe(inputOverrides);
    expect(next.get("core-api")).toBe(position);
    expect(next.get("core-api")).toEqual({ x: 48.5, y: 95.25 });
    expect(Array.from(inputOverrides)).toEqual([
      ["existing", { x: 12, y: 24 }],
    ]);
  });

  it("records position changes while ignoring non-position changes", () => {
    const moved = applyPositionChanges(new Map(), [
      {
        type: "position",
        id: "core-api",
        position: { x: 320, y: 180 },
        dragging: true,
      },
      { type: "select", id: "core-api", selected: true },
    ]);

    expect(moved.get("core-api")).toEqual({ x: 320, y: 180 });
  });

  it("removes overrides for modules that are no longer present", () => {
    const pruned = prunePositionOverrides(
      new Map([
        ["core-api", { x: 320, y: 180 }],
        ["removed", { x: 1, y: 1 }],
      ]),
      new Set(["core-api"]),
    );

    expect(Array.from(pruned)).toEqual([
      ["core-api", { x: 320, y: 180 }],
    ]);
  });
});
