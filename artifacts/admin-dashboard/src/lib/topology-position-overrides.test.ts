import { describe, expect, it } from "vitest";
import {
  applyPositionChanges,
  prunePositionOverrides,
} from "./topology-position-overrides";

describe("topology position overrides", () => {
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
