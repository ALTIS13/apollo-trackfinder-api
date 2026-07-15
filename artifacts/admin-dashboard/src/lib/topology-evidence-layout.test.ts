import { describe, expect, it } from "vitest";
import {
  assignEvidenceLabelLanes,
  getConnectorVisualRects,
  getEvidenceLabelRect,
  getTopologyVisualBounds,
} from "./topology-evidence-layout";
import { buildConnectorGeometry } from "./topology-connector-geometry";
import { Position } from "@xyflow/react";

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

  it("includes reverse route, plug hit target, traffic, and evidence extents", () => {
    const geometry = buildConnectorGeometry({
      sourceX: 200,
      sourceY: 100,
      sourcePosition: Position.Right,
      targetX: 0,
      targetY: 300,
      targetPosition: Position.Left,
    });
    const connectorRects = getConnectorVisualRects(geometry, "240/мин");
    const evidenceRect = getEvidenceLabelRect(
      { id: "reverse", x: geometry.contactX, y: geometry.contactY, width: 84 },
      1,
      { labelHeight: 14, baseOffset: 22, laneGap: 4 },
    );
    const bounds = getTopologyVisualBounds(
      [
        { x: 10, y: 70, width: 190, height: 76 },
        { x: -190, y: 262, width: 190, height: 76 },
      ],
      [evidenceRect],
      connectorRects,
    )!;
    const right = bounds.x + bounds.width;
    const bottom = bounds.y + bounds.height;

    expect(geometry.routePoints).toContainEqual({ x: 312, y: 100 });
    expect(right).toBeGreaterThanOrEqual(312);
    expect(bottom).toBeGreaterThan(geometry.contactY + 24);
    expect(bounds.y).toBeLessThanOrEqual(evidenceRect.y);
  });
});
