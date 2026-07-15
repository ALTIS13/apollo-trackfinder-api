import { describe, expect, it } from "vitest";
import { Position } from "@xyflow/react";
import { buildConnectorGeometry } from "./topology-connector-geometry";

describe("buildConnectorGeometry", () => {
  it("calculates horizontal connector contact and stubs", () => {
    const geometry = buildConnectorGeometry({
      sourceX: 0,
      sourceY: 0,
      sourcePosition: Position.Right,
      targetX: 120,
      targetY: 80,
      targetPosition: Position.Left,
      sharedSource: false,
    });

    expect(geometry.contactX).toBe(92);
    expect(geometry.femaleOuterX).toBe(76);
    expect(geometry.maleOuterX).toBe(108);
    expect(geometry.sourcePath).toMatch(/L76 80$/);
    expect(geometry.targetStubPath).toBe("M 108 80 H 120");
  });

  it("starts grouped connectors after their shared source trunk", () => {
    const geometry = buildConnectorGeometry({
      sourceX: 0,
      sourceY: 0,
      sourcePosition: Position.Right,
      targetX: 120,
      targetY: 80,
      targetPosition: Position.Left,
      sharedSource: true,
    });

    expect(geometry.sharedTrunkPath).toBe("M 0 0 H 24");
    expect(geometry.branchSourceX).toBe(24);
    expect(geometry.sourcePath).toMatch(/^M24 0/);
  });
});
