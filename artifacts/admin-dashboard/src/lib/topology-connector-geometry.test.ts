import { describe, expect, it } from "vitest";
import { Position } from "@xyflow/react";
import {
  buildConnectorGeometry,
  CONTACT_BEND_CLEARANCE,
  CONTACT_TERMINAL_CLEARANCE,
  type ConnectorGeometry,
  type ConnectorGeometryInput,
  type RoutePoint,
} from "./topology-connector-geometry";
import { getSharedSourceRoutes } from "./topology-shared-routes";
import type { ServiceEdge } from "../types/dashboard";

interface ParsedPathCommand {
  type: "M" | "L" | "Q";
  start: RoutePoint;
  end: RoutePoint;
  controls: RoutePoint[];
}

function parseAbsolutePath(path: string): ParsedPathCommand[] {
  const chunks = Array.from(path.matchAll(/([A-Z])([^A-Z]*)/g));
  const normalizedPath = path.replace(/\s/g, "");
  const normalizedChunks = chunks
    .map(([chunk]) => chunk)
    .join("")
    .replace(/\s/g, "");

  expect(chunks).not.toHaveLength(0);
  expect(normalizedChunks).toBe(normalizedPath);

  let current: RoutePoint | undefined;
  return chunks.map(([, rawType, coordinateText], index) => {
    if (rawType !== "M" && rawType !== "L" && rawType !== "Q") {
      throw new Error(`Unsupported absolute path command: ${rawType}`);
    }

    const values = Array.from(
      coordinateText.matchAll(/-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi),
      ([value]) => Number(value),
    );
    const expectedValueCount = rawType === "Q" ? 4 : 2;
    expect(values).toHaveLength(expectedValueCount);
    values.forEach((value) => expect(Number.isFinite(value)).toBe(true));

    if (rawType === "M") {
      expect(index).toBe(0);
      current = { x: values[0], y: values[1] };
      return { type: rawType, start: current, end: current, controls: [] };
    }
    if (current === undefined) throw new Error("Path must begin with M");

    const start = current;
    const controls =
      rawType === "Q" ? [{ x: values[0], y: values[1] }] : [];
    const end =
      rawType === "Q"
        ? { x: values[2], y: values[3] }
        : { x: values[0], y: values[1] };
    current = end;
    return { type: rawType, start, end, controls };
  });
}

function pointLiesOnSegment(
  point: RoutePoint,
  start: RoutePoint,
  end: RoutePoint,
) {
  if (start.x === end.x && point.x === start.x) {
    return point.y >= Math.min(start.y, end.y) && point.y <= Math.max(start.y, end.y);
  }
  if (start.y === end.y && point.y === start.y) {
    return point.x >= Math.min(start.x, end.x) && point.x <= Math.max(start.x, end.x);
  }
  return false;
}

function selectedSegment(geometry: ConnectorGeometry) {
  const start = geometry.routePoints[geometry.contactSegmentIndex];
  const end = geometry.routePoints[geometry.contactSegmentIndex + 1];

  if (start === undefined || end === undefined) {
    throw new Error("Expected the selected route segment to exist");
  }

  return { start, end };
}

function expectValidSplitPath(
  path: string,
  expectedStart: RoutePoint,
  expectedEnd: RoutePoint,
  geometry: ConnectorGeometry,
  firstSegmentIndex: number,
  lastSegmentIndex: number,
) {
  const commands = parseAbsolutePath(path);
  const movementCommands = commands.slice(1);
  let currentSegmentIndex = firstSegmentIndex;
  const visitedSegmentIndexes = new Set([currentSegmentIndex]);

  expect(commands[0]).toMatchObject({ type: "M", end: expectedStart });
  expect(commands.at(-1)?.end).toEqual(expectedEnd);
  expect(movementCommands).not.toHaveLength(0);
  expect(firstSegmentIndex).toBeGreaterThanOrEqual(0);
  expect(lastSegmentIndex).toBeLessThan(geometry.routePoints.length - 1);
  expect(firstSegmentIndex).toBeLessThanOrEqual(lastSegmentIndex);

  commands.forEach((command) => {
    [command.start, ...command.controls, command.end].forEach((point) => {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
    });
  });

  movementCommands.forEach((command) => {
    expect(command.end).not.toEqual(command.start);
    command.controls.forEach((control) => {
      expect(control).not.toEqual(command.start);
      expect(control).not.toEqual(command.end);
    });

    if (command.type === "L") {
      expect(
        command.start.x === command.end.x ||
          command.start.y === command.end.y,
      ).toBe(true);

      const matchingSegmentIndexes = geometry.routePoints
        .slice(firstSegmentIndex, lastSegmentIndex + 1)
        .flatMap((segmentStart, offset) => {
          const segmentIndex = firstSegmentIndex + offset;
          const segmentEnd = geometry.routePoints[segmentIndex + 1];
          return pointLiesOnSegment(command.start, segmentStart, segmentEnd) &&
            pointLiesOnSegment(command.end, segmentStart, segmentEnd)
            ? [segmentIndex]
            : [];
        });
      expect(matchingSegmentIndexes).toContain(currentSegmentIndex);

      const segmentStart = geometry.routePoints[currentSegmentIndex];
      const segmentEnd = geometry.routePoints[currentSegmentIndex + 1];
      const forwardDotProduct =
        (command.end.x - command.start.x) *
          (segmentEnd.x - segmentStart.x) +
        (command.end.y - command.start.y) *
          (segmentEnd.y - segmentStart.y);
      expect(forwardDotProduct).toBeGreaterThan(0);
    } else if (command.type === "Q") {
      const [control] = command.controls;
      const cornerIndex = currentSegmentIndex + 1;
      const incomingStart = geometry.routePoints[currentSegmentIndex];
      const corner = geometry.routePoints[cornerIndex];
      const outgoingEnd = geometry.routePoints[cornerIndex + 1];

      expect(currentSegmentIndex).toBeLessThan(lastSegmentIndex);
      expect(control).toEqual(corner);
      expect(
        pointLiesOnSegment(command.start, incomingStart, corner),
      ).toBe(true);
      expect(
        pointLiesOnSegment(command.end, corner, outgoingEnd),
      ).toBe(true);

      const incomingDotProduct =
        (corner.x - command.start.x) * (corner.x - incomingStart.x) +
        (corner.y - command.start.y) * (corner.y - incomingStart.y);
      const outgoingDotProduct =
        (command.end.x - corner.x) * (outgoingEnd.x - corner.x) +
        (command.end.y - corner.y) * (outgoingEnd.y - corner.y);
      expect(incomingDotProduct).toBeGreaterThan(0);
      expect(outgoingDotProduct).toBeGreaterThan(0);

      currentSegmentIndex += 1;
      visitedSegmentIndexes.add(currentSegmentIndex);
    }
  });

  expect(currentSegmentIndex).toBe(lastSegmentIndex);
  expect([...visitedSegmentIndexes]).toEqual(
    Array.from(
      { length: lastSegmentIndex - firstSegmentIndex + 1 },
      (_, offset) => firstSegmentIndex + offset,
    ),
  );
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
  const routeSource = geometry.routePoints[0];
  const routeTarget = geometry.routePoints.at(-1)!;

  geometry.routePoints.forEach((point) => {
    expect(Number.isFinite(point.x)).toBe(true);
    expect(Number.isFinite(point.y)).toBe(true);
  });

  expect(end.x).toBeGreaterThan(start.x);
  expect(start.y).toBe(end.y);
  expect(geometry.femaleOuterX).toBeGreaterThanOrEqual(
    start.x + startClearance,
  );
  expect(geometry.maleOuterX).toBeLessThanOrEqual(end.x - endClearance);
  expect(geometry.routePoints[geometry.contactSegmentIndex].y).toBe(
    geometry.contactY,
  );
  expect(geometry.femaleOuterX).toBe(geometry.contactX - 16);
  expect(geometry.maleOuterX).toBe(geometry.contactX + 16);

  expectValidSplitPath(
    geometry.sourcePath,
    routeSource,
    { x: geometry.femaleOuterX, y: geometry.contactY },
    geometry,
    0,
    geometry.contactSegmentIndex,
  );
  expectValidSplitPath(
    geometry.targetPath,
    { x: geometry.maleOuterX, y: geometry.contactY },
    routeTarget,
    geometry,
    geometry.contactSegmentIndex,
    geometry.routePoints.length - 2,
  );

  const sourceSplitCommand = parseAbsolutePath(geometry.sourcePath).at(-1)!;
  const targetSplitCommand = parseAbsolutePath(geometry.targetPath)[1];
  expect(sourceSplitCommand.end).toEqual({
    x: geometry.femaleOuterX,
    y: geometry.contactY,
  });
  expect(sourceSplitCommand.start.y).toBe(geometry.contactY);
  expect(sourceSplitCommand.end.x).toBeGreaterThan(sourceSplitCommand.start.x);
  expect(targetSplitCommand.start).toEqual({
    x: geometry.maleOuterX,
    y: geometry.contactY,
  });
  expect(targetSplitCommand.end.y).toBe(geometry.contactY);
  expect(targetSplitCommand.end.x).toBeGreaterThan(targetSplitCommand.start.x);

  geometry.routePoints.slice(1, -1).forEach((point, index) => {
    const previous = geometry.routePoints[index];
    const next = geometry.routePoints[index + 2];
    expect(
      (previous.x === point.x && point.x === next.x) ||
        (previous.y === point.y && point.y === next.y),
    ).toBe(false);
  });
}

function expectVerticalStrokesOutsidePlug(geometry: ConnectorGeometry) {
  const verticalCommands = [
    ...parseAbsolutePath(geometry.sourcePath),
    ...parseAbsolutePath(geometry.targetPath),
  ].filter(
    (command) =>
      command.type === "L" &&
      command.start.x === command.end.x &&
      command.start.y !== command.end.y,
  );

  expect(verticalCommands).not.toHaveLength(0);
  verticalCommands.forEach((command) => {
    expect(
      command.start.x <= geometry.femaleOuterX ||
        command.start.x >= geometry.maleOuterX,
    ).toBe(true);
  });
}

function expectNoPositiveLengthOverlap(geometries: readonly ConnectorGeometry[]) {
  const segments = geometries.map((geometry) =>
    geometry.routePoints.slice(0, -1).map((start, index) => {
      const end = geometry.routePoints[index + 1]!;
      return {
        horizontal: start.y === end.y,
        fixed: start.y === end.y ? start.y : start.x,
        minimum: Math.min(
          start.y === end.y ? start.x : start.y,
          start.y === end.y ? end.x : end.y,
        ),
        maximum: Math.max(
          start.y === end.y ? start.x : start.y,
          start.y === end.y ? end.x : end.y,
        ),
      };
    }),
  );

  segments.forEach((leftSegments, leftIndex) => {
    segments.slice(leftIndex + 1).forEach((rightSegments) => {
      leftSegments.forEach((left) => {
        rightSegments.forEach((right) => {
          if (left.horizontal !== right.horizontal || left.fixed !== right.fixed)
            return;
          expect(
            Math.min(left.maximum, right.maximum) -
              Math.max(left.minimum, right.minimum),
          ).toBeLessThanOrEqual(0);
        });
      });
    });
  });
}

function buildGroupedGeometries(input: {
  source: { x: number; y: number; width: number; height: number };
  targets: Array<{
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  reverseEdges?: boolean;
}) {
  const positions = new Map([
    ["source", input.source],
    ...input.targets.map((target) => [target.id, target] as const),
  ]);
  const edges: ServiceEdge[] = input.targets.map((target, index) => ({
    id: `source-${target.id}`,
    source: "source",
    target: target.id,
    status: (["healthy", "warning", "degraded", "unknown"] as const)[
      index % 4
    ],
    requestsPerMinute: 1,
  }));
  const orderedInput = input.reverseEdges ? [...edges].reverse() : edges;
  const routes = getSharedSourceRoutes(orderedInput, positions);

  return new Map(
    edges.map((candidate) => {
      const target = positions.get(candidate.target)!;
      const route = routes.get(candidate.id);
      return [
        candidate.id,
        buildConnectorGeometry({
          sourceX: input.source.x + input.source.width,
          sourceY: input.source.y + input.source.height / 2,
          sourcePosition: Position.Right,
          targetX: target.x,
          targetY: target.y + target.height / 2,
          targetPosition: Position.Left,
          ...route,
        }),
      ] as const;
    }),
  );
}

const connectorInput = (
  overrides: Partial<ConnectorGeometryInput> = {},
): ConnectorGeometryInput => ({
  sourceX: 0,
  sourceY: 0,
  sourcePosition: Position.Right,
  targetX: 160,
  targetY: 80,
  targetPosition: Position.Left,
  ...overrides,
});

describe("buildConnectorGeometry", () => {
  it.each([
    {
      name: "default above, same, and below targets",
      source: { x: 0, y: 100, width: 190, height: 76 },
      targets: [
        { id: "above", x: 340, y: -40, width: 190, height: 76 },
        { id: "same", x: 340, y: 100, width: 190, height: 76 },
        { id: "below", x: 340, y: 240, width: 190, height: 76 },
      ],
    },
    {
      name: "two same-direction targets",
      source: { x: 0, y: 180, width: 190, height: 76 },
      targets: [
        { id: "above-a", x: 380, y: -80, width: 190, height: 76 },
        { id: "above-b", x: 380, y: 20, width: 190, height: 76 },
        { id: "above-c", x: 380, y: 80, width: 190, height: 76 },
      ],
    },
    {
      name: "two same-row targets",
      source: { x: 0, y: 100, width: 190, height: 76 },
      targets: [
        { id: "same-a", x: 380, y: 100, width: 190, height: 76 },
        { id: "same-b", x: 400, y: 100, width: 190, height: 76 },
        { id: "same-c", x: 420, y: 100, width: 190, height: 76 },
      ],
    },
    {
      name: "zero-clearance crossed targets",
      source: { x: 120, y: 100, width: 190, height: 76 },
      targets: [
        { id: "cross-a", x: 260, y: -20, width: 190, height: 76 },
        { id: "cross-b", x: 250, y: 20, width: 190, height: 76 },
      ],
    },
  ])("keeps sibling solid geometry disjoint for $name", ({ name, source, targets }) => {
    const geometries = buildGroupedGeometries({ source, targets });

    geometries.forEach(expectCanonicalContact);
    expectNoPositiveLengthOverlap([...geometries.values()]);
    if (name === "zero-clearance crossed targets") {
      geometries.forEach((geometry) => expect(geometry.usedDetour).toBe(true));
    }
  });

  it("keeps crowded fan-out geometry stable when unrelated edge order changes", () => {
    const input = {
      source: { x: 0, y: 180, width: 190, height: 76 },
      targets: [
        { id: "above-a", x: 380, y: -80, width: 190, height: 76 },
        { id: "above-b", x: 380, y: 20, width: 190, height: 76 },
        { id: "above-c", x: 380, y: 80, width: 190, height: 76 },
        { id: "same-a", x: 380, y: 180, width: 190, height: 76 },
        { id: "same-b", x: 400, y: 180, width: 190, height: 76 },
        { id: "same-c", x: 420, y: 180, width: 190, height: 76 },
      ],
    };

    expect(buildGroupedGeometries(input)).toEqual(
      buildGroupedGeometries({ ...input, reverseEdges: true }),
    );
  });

  it.each([
    {
      name: "same-row route",
      input: connectorInput({ targetY: 0 }),
    },
    {
      name: "different-row route",
      input: connectorInput(),
    },
    {
      name: "shortened shared trunk route",
      input: connectorInput({ sharedBranchLength: 24 }),
    },
    {
      name: "target-left-of-source route",
      input: connectorInput({ sourceX: 120, targetX: 0 }),
    },
  ])(
    "centers the plug on an eligible straight segment for $name",
    ({ input }) => {
      const geometry = buildConnectorGeometry(input);

      expectCanonicalContact(geometry);
      expect(geometry.usedDetour).toBe(false);
    },
  );

  it("uses the lower deterministic detour when no normal segment fits the plug", () => {
    const geometry = buildConnectorGeometry(
      connectorInput({ targetX: 59, targetY: 0 }),
    );

    expectCanonicalContact(geometry);
    expect(geometry.usedDetour).toBe(true);
    expect(geometry.routePoints).toContainEqual({ x: 171, y: 64 });
  });

  it("keeps the default grouped Core to Search route inside its endpoint corridor", () => {
    const geometry = buildConnectorGeometry(
      connectorInput({
        sourceX: 538.5,
        sourceY: 194,
        targetX: 665.5,
        targetY: 326,
        sharedBranchLength: 24,
      }),
    );

    expectCanonicalContact(geometry);
    expect(geometry.usedDetour).toBe(false);
    expect(geometry.routePoints).toEqual([
      { x: 562.5, y: 194 },
      { x: 562.5, y: 326 },
      { x: 665.5, y: 326 },
    ]);
    geometry.routePoints.forEach((point) => {
      expect(point.x).toBeGreaterThanOrEqual(538.5);
      expect(point.x).toBeLessThanOrEqual(665.5);
    });
  });

  it("diverges grouped off-row branches at a zero-clearance branch point", () => {
    const upward = buildConnectorGeometry(
      connectorInput({ targetY: -80, sharedBranchLength: 0 }),
    );
    const downward = buildConnectorGeometry(
      connectorInput({ targetY: 80, sharedBranchLength: 0 }),
    );

    [upward, downward].forEach(expectCanonicalContact);
    expect(upward.routePoints.slice(0, 2)).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: -80 },
    ]);
    expect(downward.routePoints.slice(0, 2)).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 80 },
    ]);
  });

  it("preserves the shared trunk while branching from its shortened endpoint", () => {
    const geometry = buildConnectorGeometry(
      connectorInput({ sharedBranchLength: 24 }),
    );

    expectCanonicalContact(geometry);
    expect(geometry.sharedTrunkPath).toBe("M 0 0 H 24");
    expect(geometry.branchSourceX).toBe(24);
    expect(geometry.routePoints[0]).toEqual({ x: 24, y: 0 });
  });

  it("keeps a one-unit shared trunk owner and sibling on the same branch origin", () => {
    const ownerInput = connectorInput({
      targetX: 52.5,
      sharedBranchLength: 1,
    });
    const owner = buildConnectorGeometry(ownerInput);
    const sibling = buildConnectorGeometry({ ...ownerInput, targetX: 120 });

    [owner, sibling].forEach(expectCanonicalContact);
    expect([owner.branchSourceX, sibling.branchSourceX]).toEqual([1, 1]);
    expect([owner.sharedTrunkPath, sibling.sharedTrunkPath]).toEqual([
      "M 0 0 H 1",
      "M 0 0 H 1",
    ]);
    expect([owner.routePoints[0], sibling.routePoints[0]]).toEqual([
      { x: 1, y: 0 },
      { x: 1, y: 0 },
    ]);
    expect(owner.usedDetour).toBe(true);
    expect(sibling.usedDetour).toBe(false);
  });

  it("starts a trunk owner and sibling at the source when no shared clearance fits", () => {
    const owner = buildConnectorGeometry(
      connectorInput({ targetX: 70, sharedBranchLength: 0 }),
    );
    const sibling = buildConnectorGeometry(
      connectorInput({ targetX: 120, sharedBranchLength: 0 }),
    );

    [owner, sibling].forEach(expectCanonicalContact);
    expect([owner.branchSourceX, sibling.branchSourceX]).toEqual([0, 0]);
    expect([owner.sharedTrunkPath, sibling.sharedTrunkPath]).toEqual([
      undefined,
      undefined,
    ]);
    expect([owner.routePoints[0], sibling.routePoints[0]]).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ]);
    expect(owner.usedDetour).toBe(true);
    expect(sibling.usedDetour).toBe(false);
  });

  it("keeps the prior 17.142-unit same-row branch continuous through a detour", () => {
    const geometry = buildConnectorGeometry(
      connectorInput({
        sourceX: 488,
        sourceY: 140,
        targetX: 551.642,
        targetY: 140,
        sharedBranchLength: 17.142,
      }),
    );

    expectCanonicalContact(geometry);
    expect(geometry.branchSourceX).toBeCloseTo(505.142, 3);
    expect(geometry.routePoints[0]).toEqual({ x: 505.142, y: 140 });
    expect(geometry.routePoints.at(-1)).toEqual({ x: 551.642, y: 140 });
    expect(geometry.sharedTrunkPath).toBe("M 488 140 H 505.142");
    expect(geometry.usedDetour).toBe(true);
  });

  it("keeps a one-unit off-row short shared branch and vertical strokes continuous", () => {
    const geometry = buildConnectorGeometry(
      connectorInput({
        sourceX: 488,
        sourceY: 140,
        targetX: 551.642,
        targetY: 141,
        sharedBranchLength: 17.142,
      }),
    );

    expectCanonicalContact(geometry);
    expectVerticalStrokesOutsidePlug(geometry);
    expect(geometry.routePoints[0]).toEqual({ x: 505.142, y: 140 });
    expect(geometry.routePoints.at(-1)).toEqual({ x: 551.642, y: 141 });
    expect(geometry.usedDetour).toBe(true);
  });

  it("keeps a zero-clearance crossed target continuous without a shared trunk", () => {
    const geometry = buildConnectorGeometry(
      connectorInput({
        sourceX: 488,
        sourceY: 140,
        targetX: 529.5,
        targetY: 140,
        sharedBranchLength: 0,
      }),
    );

    expectCanonicalContact(geometry);
    expect(geometry.branchSourceX).toBe(488);
    expect(geometry.sharedTrunkPath).toBeUndefined();
    expect(geometry.routePoints[0]).toEqual({ x: 488, y: 140 });
    expect(geometry.routePoints.at(-1)).toEqual({ x: 529.5, y: 140 });
    expect(geometry.usedDetour).toBe(true);
  });

  it("keeps a crossed one-unit off-row target and vertical strokes continuous", () => {
    const geometry = buildConnectorGeometry(
      connectorInput({
        sourceX: 488,
        sourceY: 140,
        targetX: 529.5,
        targetY: 141,
        sharedBranchLength: 0,
      }),
    );

    expectCanonicalContact(geometry);
    expectVerticalStrokesOutsidePlug(geometry);
    expect(geometry.branchSourceX).toBe(488);
    expect(geometry.sharedTrunkPath).toBeUndefined();
    expect(geometry.routePoints[0]).toEqual({ x: 488, y: 140 });
    expect(geometry.routePoints.at(-1)).toEqual({ x: 529.5, y: 141 });
    expect(geometry.usedDetour).toBe(true);
  });
});
