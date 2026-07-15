import { describe, expect, it } from "vitest";
import {
  assignEvidenceLabelLanes,
  getEvidenceLabelRect,
  getTopologyVisualBounds,
} from "./topology-evidence-layout";

describe("assignEvidenceLabelLanes", () => {
  const input = {
    anchors: [
      { id: "a", x: 300, y: 120, width: 84 },
      { id: "b", x: 318, y: 126, width: 84 },
    ],
    obstacles: [{ x: 250, y: 40, width: 190, height: 76 }],
    labelHeight: 14,
    baseOffset: 22,
    laneGap: 4,
  };

  it("stacks colliding labels above node obstacles", () => {
    const lanes = assignEvidenceLabelLanes(input);

    expect(lanes.get("a")).toBeGreaterThanOrEqual(1);
    expect(lanes.get("b")).toBeGreaterThan(lanes.get("a")!);
  });

  it("is independent of anchor input order", () => {
    const forward = assignEvidenceLabelLanes(input);
    const reverse = assignEvidenceLabelLanes({
      ...input,
      anchors: [...input.anchors].reverse(),
    });

    expect([...reverse.entries()]).toEqual([...forward.entries()]);
  });

  it("keeps a clear label in lane zero", () => {
    const lanes = assignEvidenceLabelLanes({
      ...input,
      anchors: [{ id: "clear", x: 600, y: 200, width: 84 }],
      obstacles: [],
    });

    expect(lanes.get("clear")).toBe(0);
  });
});

describe("evidence visual bounds", () => {
  it("calculates label rectangles and unions them with module rectangles", () => {
    const label = getEvidenceLabelRect(
      { id: "warning-edge", x: 300, y: 120, width: 84 },
      2,
      { labelHeight: 14, baseOffset: 36, laneGap: 4 },
    );

    expect(label).toEqual({ x: 258, y: 34, width: 84, height: 14 });
    expect(
      getTopologyVisualBounds(
        [{ x: 100, y: 80, width: 190, height: 76 }],
        [label],
      ),
    ).toEqual({ x: 100, y: 34, width: 242, height: 122 });
  });

  it("returns undefined without module or evidence rectangles", () => {
    expect(getTopologyVisualBounds([], [])).toBeUndefined();
  });
});
