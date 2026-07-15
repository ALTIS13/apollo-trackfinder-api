import { describe, expect, it } from "vitest";
import { Position } from "@xyflow/react";
import {
  buildConnectorGeometry,
  CONTACT_BEND_CLEARANCE,
  CONTACT_TERMINAL_CLEARANCE,
  type ConnectorGeometry,
  type ConnectorGeometryInput,
} from "./topology-connector-geometry";

function selectedSegment(geometry: ConnectorGeometry) {
  const start = geometry.routePoints[geometry.contactSegmentIndex];
  const end = geometry.routePoints[geometry.contactSegmentIndex + 1];

  if (start === undefined || end === undefined) {
    throw new Error("Expected the selected route segment to exist");
  }

  return { start, end };
}

function expectCanonicalContact(geometry: ConnectorGeometry) {
  const { start, end } = selectedSegment(geometry);
  const lastPointIndex = geometry.routePoints.length - 1;
  const startClearance =
    geometry.contactSegmentIndex === 0
      ? CONTACT_TERMINAL_CLEARANCE
      : CONTACT_BEND_CLEARANCE;
  const endClearance =
    geometry.contactSegmentIndex + 1 === lastPointIndex
      ? CONTACT_TERMINAL_CLEARANCE
      : CONTACT_BEND_CLEARANCE;

  expect(end.x).toBeGreaterThan(start.x);
  expect(start.y).toBe(end.y);
  expect(geometry.contactX).toBeGreaterThanOrEqual(start.x + startClearance);
  expect(geometry.contactX).toBeLessThanOrEqual(end.x - endClearance);
  expect(geometry.routePoints[geometry.contactSegmentIndex].y).toBe(
    geometry.contactY,
  );
  expect(geometry.femaleOuterX).toBe(geometry.contactX - 16);
  expect(geometry.maleOuterX).toBe(geometry.contactX + 16);
  expect(geometry.sourcePath).toMatch(new RegExp(`${geometry.femaleOuterX}`));
  expect(geometry.targetPath).toMatch(new RegExp(`${geometry.maleOuterX}`));

  geometry.routePoints.slice(1, -1).forEach((point, index) => {
    const previous = geometry.routePoints[index];
    const next = geometry.routePoints[index + 2];
    expect(
      (previous.x === point.x && point.x === next.x) ||
        (previous.y === point.y && point.y === next.y),
    ).toBe(false);
  });
}

describe("buildConnectorGeometry", () => {
  it.each([
    {
      name: "same-row route",
      input: {
        sourceX: 0,
        sourceY: 0,
        sourcePosition: Position.Right,
        targetX: 160,
        targetY: 0,
        targetPosition: Position.Left,
      },
    },
    {
      name: "different-row route",
      input: {
        sourceX: 0,
        sourceY: 0,
        sourcePosition: Position.Right,
        targetX: 160,
        targetY: 80,
        targetPosition: Position.Left,
      },
    },
    {
      name: "shortened shared trunk route",
      input: {
        sourceX: 0,
        sourceY: 0,
        sourcePosition: Position.Right,
        targetX: 160,
        targetY: 80,
        targetPosition: Position.Left,
        sharedBranchLength: 24,
      },
    },
    {
      name: "target-left-of-source route",
      input: {
        sourceX: 120,
        sourceY: 0,
        sourcePosition: Position.Right,
        targetX: 0,
        targetY: 80,
        targetPosition: Position.Left,
      },
    },
  ] satisfies { name: string; input: ConnectorGeometryInput }[])(
    "centers the plug on an eligible straight segment for $name",
    ({ input }) => {
      const geometry = buildConnectorGeometry(input);

      expectCanonicalContact(geometry);
      expect(geometry.usedDetour).toBe(false);
    },
  );

  it("uses the lower deterministic detour when no normal segment fits the plug", () => {
    const geometry = buildConnectorGeometry({
      sourceX: 0,
      sourceY: 0,
      sourcePosition: Position.Right,
      targetX: 59,
      targetY: 0,
      targetPosition: Position.Left,
    });

    expectCanonicalContact(geometry);
    expect(geometry.usedDetour).toBe(true);
    expect(geometry.routePoints).toContainEqual({ x: 171, y: 64 });
  });

  it("preserves the shared trunk while branching from its shortened endpoint", () => {
    const geometry = buildConnectorGeometry({
      sourceX: 0,
      sourceY: 0,
      sourcePosition: Position.Right,
      targetX: 160,
      targetY: 80,
      targetPosition: Position.Left,
      sharedBranchLength: 24,
    });

    expect(geometry.sharedTrunkPath).toBe("M 0 0 H 24");
    expect(geometry.branchSourceX).toBe(24);
    expect(geometry.sourcePath).toMatch(/^M24 0/);
  });
});
