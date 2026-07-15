import { describe, expect, it } from "vitest";
import { Position } from "@xyflow/react";
import {
  buildConnectorGeometry,
  type ConnectorGeometryInput,
} from "./topology-connector-geometry";

describe("buildConnectorGeometry", () => {
  it("calculates horizontal connector contact and stubs", () => {
    const geometry = buildConnectorGeometry({
      sourceX: 0,
      sourceY: 0,
      sourcePosition: Position.Right,
      targetX: 120,
      targetY: 80,
      targetPosition: Position.Left,
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
      sharedBranchLength: 24,
    });

    expect(geometry.sharedTrunkPath).toBe("M 0 0 H 24");
    expect(geometry.branchSourceX).toBe(24);
    expect(geometry.sourcePath).toMatch(/^M24 0/);
  });

  it("uses a shortened group branch origin for a short-clearance trunk owner and sibling", () => {
    const trunkOwnerInput: ConnectorGeometryInput = {
      sourceX: 0,
      sourceY: 0,
      sourcePosition: Position.Right,
      targetX: 52.5,
      targetY: 80,
      targetPosition: Position.Left,
      sharedBranchLength: 1,
    };
    const trunkOwner = buildConnectorGeometry(trunkOwnerInput);
    const sibling = buildConnectorGeometry({
      ...trunkOwnerInput,
      targetX: 120,
    });

    expect([trunkOwner.branchSourceX, sibling.branchSourceX]).toEqual([1, 1]);
    expect([trunkOwner.sharedTrunkPath, sibling.sharedTrunkPath]).toEqual([
      "M 0 0 H 1",
      "M 0 0 H 1",
    ]);
  });

  it("starts every group branch at source when no shared clearance fits", () => {
    const trunkOwner = buildConnectorGeometry({
      sourceX: 0,
      sourceY: 0,
      sourcePosition: Position.Right,
      targetX: 70,
      targetY: 80,
      targetPosition: Position.Left,
      sharedBranchLength: 0,
    });
    const sibling = buildConnectorGeometry({
      sourceX: 0,
      sourceY: 0,
      sourcePosition: Position.Right,
      targetX: 120,
      targetY: 80,
      targetPosition: Position.Left,
      sharedBranchLength: 0,
    });

    expect([trunkOwner.branchSourceX, sibling.branchSourceX]).toEqual([0, 0]);
    expect([trunkOwner.sharedTrunkPath, sibling.sharedTrunkPath]).toEqual([
      undefined,
      undefined,
    ]);
    expect(trunkOwner.sourcePath).toMatch(/^M0 0/);
    expect(sibling.sourcePath).toMatch(/^M0 0/);
  });
});
