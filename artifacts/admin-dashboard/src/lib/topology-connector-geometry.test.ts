import { describe, expect, it } from "vitest";
import { Position } from "@xyflow/react";
import {
  buildConnectorGeometry,
  CONDUCTOR_WIDTH,
  type ConnectorGeometryInput,
} from "./topology-connector-geometry";

function getPathXCoordinates(path: string): number[] {
  const commandCoordinateCounts: Record<string, number> = {
    M: 2,
    L: 2,
    H: 1,
    V: 1,
    Q: 4,
    C: 6,
    S: 4,
    T: 2,
    A: 7,
  };
  const commandXOffsets: Record<string, number[]> = {
    M: [0],
    L: [0],
    H: [0],
    V: [],
    Q: [0, 2],
    C: [0, 2, 4],
    S: [0, 2],
    T: [0],
    A: [5],
  };

  // Inspect every absolute command so a smooth-step control point cannot backtrack.
  return Array.from(path.matchAll(/([A-Z])([^A-Z]*)/g)).flatMap(
    ([, command, coordinateText]) => {
      const coordinateCount = commandCoordinateCounts[command];
      const xOffsets = commandXOffsets[command];
      if (coordinateCount === undefined || xOffsets === undefined) return [];
      const values = Array.from(
        coordinateText.matchAll(/-?(?:\d+\.?\d*|\.\d+)/g),
        ([value]) => Number(value),
      );
      const xCoordinates: number[] = [];

      for (let start = 0; start < values.length; start += coordinateCount) {
        xOffsets.forEach((offset) => {
          const x = values[start + offset];
          if (x !== undefined) xCoordinates.push(x);
        });
      }
      return xCoordinates;
    },
  );
}

function expectPathToStayWithinHorizontalBounds(
  path: string,
  firstX: number,
  secondX: number,
) {
  const minimumX = Math.min(firstX, secondX);
  const maximumX = Math.max(firstX, secondX);
  const xCoordinates = getPathXCoordinates(path);

  expect(xCoordinates).not.toHaveLength(0);
  xCoordinates.forEach((x) => {
    expect(x).toBeGreaterThanOrEqual(minimumX);
    expect(x).toBeLessThanOrEqual(maximumX);
  });
}

function getVerticalLineSegmentXs(path: string): number[] {
  const points = Array.from(
    path.matchAll(/(?:M|L)(-?(?:\d+\.?\d*|\.\d+))\s+(-?(?:\d+\.?\d*|\.\d+))/g),
    ([, x, y]) => ({ x: Number(x), y: Number(y) }),
  );

  return points.slice(1).flatMap((point, index) => {
    const previousPoint = points[index];
    return point.x === previousPoint.x && point.y !== previousPoint.y
      ? [point.x]
      : [];
  });
}

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
    expect(geometry.sourcePath).toContain("Q");
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

  it("keeps a shortened same-row degraded branch within its female outer edge", () => {
    const geometry = buildConnectorGeometry({
      sourceX: 488,
      sourceY: 140,
      sourcePosition: Position.Right,
      targetX: 551.642,
      targetY: 140,
      targetPosition: Position.Left,
      sharedBranchLength: 17.142,
    });

    expect(geometry.branchSourceX).toBeCloseTo(505.142, 3);
    expect(geometry.femaleOuterX).toBeCloseTo(507.642, 3);
    expectPathToStayWithinHorizontalBounds(
      geometry.sourcePath,
      geometry.branchSourceX,
      geometry.femaleOuterX,
    );
  });

  it("keeps a one-unit off-row short branch within its female outer edge", () => {
    const geometry = buildConnectorGeometry({
      sourceX: 488,
      sourceY: 140,
      sourcePosition: Position.Right,
      targetX: 551.642,
      targetY: 141,
      targetPosition: Position.Left,
      sharedBranchLength: 17.142,
    });

    expect(geometry.branchSourceX).toBeCloseTo(505.142, 3);
    expect(geometry.femaleOuterX).toBeCloseTo(507.642, 3);
    expectPathToStayWithinHorizontalBounds(
      geometry.sourcePath,
      geometry.branchSourceX,
      geometry.femaleOuterX,
    );
  });

  it("keeps a one-unit off-row short vertical stroke outside the female socket", () => {
    const geometry = buildConnectorGeometry({
      sourceX: 488,
      sourceY: 140,
      sourcePosition: Position.Right,
      targetX: 551.642,
      targetY: 141,
      targetPosition: Position.Left,
      sharedBranchLength: 17.142,
    });
    const verticalSegmentXs = getVerticalLineSegmentXs(geometry.sourcePath);

    expect(verticalSegmentXs).toHaveLength(1);
    verticalSegmentXs.forEach((verticalX) => {
      expect(verticalX + CONDUCTOR_WIDTH / 2).toBeLessThanOrEqual(
        geometry.femaleOuterX + CONDUCTOR_WIDTH / 2,
      );
    });
  });

  it("keeps a zero-clearance crossed target bounded without a shared trunk", () => {
    const geometry = buildConnectorGeometry({
      sourceX: 488,
      sourceY: 140,
      sourcePosition: Position.Right,
      targetX: 529.5,
      targetY: 140,
      targetPosition: Position.Left,
      sharedBranchLength: 0,
    });

    expect(geometry.branchSourceX).toBe(488);
    expect(geometry.femaleOuterX).toBe(485.5);
    expect(geometry.sharedTrunkPath).toBeUndefined();
    expectPathToStayWithinHorizontalBounds(
      geometry.sourcePath,
      geometry.branchSourceX,
      geometry.femaleOuterX,
    );
  });

  it("keeps a crossed off-row target bounded without a shared trunk", () => {
    const geometry = buildConnectorGeometry({
      sourceX: 488,
      sourceY: 140,
      sourcePosition: Position.Right,
      targetX: 529.5,
      targetY: 141,
      targetPosition: Position.Left,
      sharedBranchLength: 0,
    });

    expect(geometry.branchSourceX).toBe(488);
    expect(geometry.femaleOuterX).toBe(485.5);
    expect(geometry.sharedTrunkPath).toBeUndefined();
    expectPathToStayWithinHorizontalBounds(
      geometry.sourcePath,
      geometry.branchSourceX,
      geometry.femaleOuterX,
    );
  });

  it("keeps a crossed off-row vertical stroke outside the female socket", () => {
    const geometry = buildConnectorGeometry({
      sourceX: 488,
      sourceY: 140,
      sourcePosition: Position.Right,
      targetX: 529.5,
      targetY: 141,
      targetPosition: Position.Left,
      sharedBranchLength: 0,
    });
    const verticalSegmentXs = getVerticalLineSegmentXs(geometry.sourcePath);

    expect(verticalSegmentXs).toHaveLength(1);
    verticalSegmentXs.forEach((verticalX) => {
      expect(verticalX + CONDUCTOR_WIDTH / 2).toBeLessThanOrEqual(
        geometry.femaleOuterX + CONDUCTOR_WIDTH / 2,
      );
    });
  });
});
