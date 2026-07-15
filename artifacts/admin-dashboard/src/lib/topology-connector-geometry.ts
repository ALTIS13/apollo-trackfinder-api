import { Position } from "@xyflow/react";

export const CONDUCTOR_WIDTH = 6;
export const CONTACT_HALF_LENGTH = 16;
export const TARGET_STUB_LENGTH = 12;
export const CONTACT_BEND_CLEARANCE = 24;
export const CONTACT_TERMINAL_CLEARANCE = 28;
export const SHARED_TRUNK_LENGTH = 24;
export const CONNECTOR_BEND_RADIUS = 7.5;

export interface RoutePoint {
  x: number;
  y: number;
}

export interface ConnectorGeometryInput {
  sourceX: number;
  sourceY: number;
  sourcePosition: Position;
  targetX: number;
  targetY: number;
  targetPosition: Position;
  sharedBranchLength?: number;
  branchAttachmentY?: number;
  branchChannel?: number;
  branchApproachX?: number;
  sharedFanMinimumY?: number;
  sharedFanMaximumY?: number;
}

export interface ConnectorGeometry {
  sourcePath: string;
  targetPath: string;
  contactX: number;
  contactY: number;
  femaleOuterX: number;
  maleOuterX: number;
  branchSourceX: number;
  routePoints: RoutePoint[];
  contactSegmentIndex: number;
  usedDetour: boolean;
  sharedTrunkPath?: string;
  sharedRoutePoints: RoutePoint[];
  sharedGradientStart: RoutePoint;
  sharedGradientEnd: RoutePoint;
}

interface ContactSegment {
  index: number;
  contactX: number;
}

function collapseRoutePoints(points: RoutePoint[]): RoutePoint[] {
  return points.reduce<RoutePoint[]>((collapsed, point) => {
    const previous = collapsed.at(-1);
    if (previous?.x === point.x && previous.y === point.y) return collapsed;

    const beforePrevious = collapsed.at(-2);
    if (
      beforePrevious !== undefined &&
      previous !== undefined &&
      ((beforePrevious.x === previous.x && previous.x === point.x) ||
        (beforePrevious.y === previous.y && previous.y === point.y))
    ) {
      collapsed[collapsed.length - 1] = point;
      return collapsed;
    }

    collapsed.push(point);
    return collapsed;
  }, []);
}

function findContactSegment(points: RoutePoint[]): ContactSegment | undefined {
  const minimumX = Math.min(...points.map((point) => point.x));
  const maximumX = Math.max(...points.map((point) => point.x));
  const minimumY = Math.min(...points.map((point) => point.y));
  const maximumY = Math.max(...points.map((point) => point.y));
  const centerX = (minimumX + maximumX) / 2;
  const centerY = (minimumY + maximumY) / 2;

  return points.reduce<ContactSegment | undefined>((best, start, index) => {
    const end = points[index + 1];
    if (end === undefined || start.y !== end.y || end.x <= start.x) return best;

    const startClearance =
      index === 0 ? CONTACT_TERMINAL_CLEARANCE : CONTACT_BEND_CLEARANCE;
    const endClearance =
      index + 1 === points.length - 1
        ? CONTACT_TERMINAL_CLEARANCE
        : CONTACT_BEND_CLEARANCE;
    const intervalStart = start.x + startClearance;
    const intervalEnd = end.x - endClearance;
    const intervalLength = intervalEnd - intervalStart;
    if (intervalLength < CONTACT_HALF_LENGTH * 2) return best;

    const contactX = (intervalStart + intervalEnd) / 2;
    if (best === undefined) return { index, contactX };

    const bestEnd = points[best.index + 1]!;
    const bestStartClearance =
      best.index === 0 ? CONTACT_TERMINAL_CLEARANCE : CONTACT_BEND_CLEARANCE;
    const bestEndClearance =
      best.index + 1 === points.length - 1
        ? CONTACT_TERMINAL_CLEARANCE
        : CONTACT_BEND_CLEARANCE;
    const bestLength =
      bestEnd.x - bestEndClearance - (points[best.index].x + bestStartClearance);
    if (intervalLength !== bestLength) {
      return intervalLength > bestLength ? { index, contactX } : best;
    }

    const distanceToCenter = Math.hypot(contactX - centerX, start.y - centerY);
    const bestDistanceToCenter = Math.hypot(
      best.contactX - centerX,
      points[best.index].y - centerY,
    );
    if (distanceToCenter !== bestDistanceToCenter) {
      return distanceToCenter < bestDistanceToCenter ? { index, contactX } : best;
    }

    return index < best.index ? { index, contactX } : best;
  }, undefined);
}

function buildRoundedPath(points: RoutePoint[]): string {
  const [first, ...rest] = points;
  if (first === undefined) return "";
  if (rest.length === 0) return `M${first.x} ${first.y}`;

  let path = `M${first.x} ${first.y}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1];
    const corner = points[index];
    const next = points[index + 1];
    const previousLength = Math.hypot(corner.x - previous.x, corner.y - previous.y);
    const nextLength = Math.hypot(next.x - corner.x, next.y - corner.y);
    const radius = Math.min(
      CONNECTOR_BEND_RADIUS,
      previousLength / 2,
      nextLength / 2,
    );
    const entry = {
      x: corner.x + ((previous.x - corner.x) * radius) / previousLength,
      y: corner.y + ((previous.y - corner.y) * radius) / previousLength,
    };
    const exit = {
      x: corner.x + ((next.x - corner.x) * radius) / nextLength,
      y: corner.y + ((next.y - corner.y) * radius) / nextLength,
    };
    path += ` L${entry.x} ${entry.y} Q${corner.x} ${corner.y} ${exit.x} ${exit.y}`;
  }

  const last = points.at(-1)!;
  return `${path} L${last.x} ${last.y}`;
}

function buildNormalRoute(
  source: RoutePoint,
  target: RoutePoint,
  divergeAtSource: boolean,
): RoutePoint[] {
  if (source.y === target.y) return [source, target];
  if (source.x <= target.x) {
    if (divergeAtSource) {
      return [source, { x: source.x, y: target.y }, target];
    }
    const minimumTargetApproach =
      CONTACT_BEND_CLEARANCE +
      CONTACT_HALF_LENGTH * 2 +
      CONTACT_TERMINAL_CLEARANCE;
    const bendX = Math.min(
      source.x + CONTACT_TERMINAL_CLEARANCE,
      Math.max(source.x, target.x - minimumTargetApproach),
    );
    return [source, { x: bendX, y: source.y }, { x: bendX, y: target.y }, target];
  }

  const corridorX = Math.max(source.x, target.x) + 112;
  return [source, { x: corridorX, y: source.y }, { x: corridorX, y: target.y }, target];
}

function buildDetourRoute(source: RoutePoint, target: RoutePoint): RoutePoint[] {
  const detourX = Math.max(source.x, target.x) + 112;
  const detourY = Math.max(source.y, target.y) + 64;
  const approachX = target.x - CONTACT_TERMINAL_CLEARANCE;
  return [
    source,
    { x: detourX, y: source.y },
    { x: detourX, y: detourY },
    { x: approachX, y: detourY },
    { x: approachX, y: target.y },
    target,
  ];
}

function buildFannedRoute(
  source: RoutePoint,
  target: RoutePoint,
  branchChannel: number,
  branchApproachX?: number,
): { points: RoutePoint[]; usedDetour: boolean } {
  const approachX =
    branchApproachX ??
    target.x - CONTACT_TERMINAL_CLEARANCE - branchChannel * CONNECTOR_BEND_RADIUS * 2;
  if (source.x < approachX) {
    return {
      points: [
        source,
        { x: approachX, y: source.y },
        { x: approachX, y: target.y },
        target,
      ],
      usedDetour: false,
    };
  }

  return {
    points: buildFannedDetourRoute(
      source,
      target,
      branchChannel,
      branchApproachX,
    ),
    usedDetour: true,
  };
}

function buildFannedDetourRoute(
  source: RoutePoint,
  target: RoutePoint,
  branchChannel: number,
  branchApproachX?: number,
): RoutePoint[] {
  const approachX =
    branchApproachX ??
    target.x - CONTACT_TERMINAL_CLEARANCE - branchChannel * CONNECTOR_BEND_RADIUS * 2;
  const detourX =
    Math.max(source.x, target.x) +
    112 +
    branchChannel * CONNECTOR_BEND_RADIUS * 2;
  const detourY = Math.max(source.y, target.y) + 64;
  return [
    source,
    { x: detourX, y: source.y },
    { x: detourX, y: detourY },
    { x: approachX, y: detourY },
    { x: approachX, y: target.y },
    target,
  ];
}

function buildSharedRoute(input: ConnectorGeometryInput, branchSourceX: number) {
  const minimumY = Math.min(input.sourceY, input.sharedFanMinimumY ?? input.sourceY);
  const maximumY = Math.max(input.sourceY, input.sharedFanMaximumY ?? input.sourceY);
  const pathParts: string[] = [];
  const points: RoutePoint[] = [];

  if (branchSourceX !== input.sourceX) {
    pathParts.push(`M ${input.sourceX} ${input.sourceY} H ${branchSourceX}`);
    points.push(
      { x: input.sourceX, y: input.sourceY },
      { x: branchSourceX, y: input.sourceY },
    );
  }
  if (minimumY < input.sourceY) {
    pathParts.push(`M ${branchSourceX} ${input.sourceY} V ${minimumY}`);
    points.push({ x: branchSourceX, y: minimumY });
  }
  if (maximumY > input.sourceY) {
    pathParts.push(`M ${branchSourceX} ${input.sourceY} V ${maximumY}`);
    points.push({ x: branchSourceX, y: maximumY });
  }

  const verticalGradient = branchSourceX === input.sourceX && minimumY !== maximumY;
  return {
    path: pathParts.length === 0 ? undefined : pathParts.join(" "),
    points,
    gradientStart: verticalGradient
      ? { x: branchSourceX, y: minimumY }
      : { x: input.sourceX, y: input.sourceY },
    gradientEnd: verticalGradient
      ? { x: branchSourceX, y: maximumY }
      : { x: branchSourceX, y: input.sourceY },
  };
}

export function buildConnectorGeometry(input: ConnectorGeometryInput): ConnectorGeometry {
  const sharedBranchLength = Math.max(0, input.sharedBranchLength ?? 0);
  const branchSourceX = input.sourceX + sharedBranchLength;
  const branchChannel = Math.max(0, input.branchChannel ?? 0);
  const source = {
    x: branchSourceX,
    y: branchChannel > 0 ? (input.branchAttachmentY ?? input.sourceY) : input.sourceY,
  };
  const target = { x: input.targetX, y: input.targetY };
  const fannedRoute =
    branchChannel > 0
      ? buildFannedRoute(
          source,
          target,
          branchChannel,
          input.branchApproachX,
        )
      : undefined;
  let routePoints = collapseRoutePoints(
    fannedRoute !== undefined
      ? fannedRoute.points
      : buildNormalRoute(source, target, input.sharedBranchLength !== undefined),
  );
  let contactSegment = findContactSegment(routePoints);
  let usedDetour = fannedRoute?.usedDetour ?? false;

  if (contactSegment === undefined) {
    routePoints = collapseRoutePoints(
      branchChannel > 0
        ? buildFannedDetourRoute(
            source,
            target,
            branchChannel,
            input.branchApproachX,
          )
        : buildDetourRoute(source, target),
    );
    contactSegment = findContactSegment(routePoints);
    usedDetour = true;
  }
  if (contactSegment === undefined) {
    throw new Error("The deterministic connector detour must contain a plug segment");
  }
  const sharedRoute = buildSharedRoute(input, branchSourceX);

  const contactY = routePoints[contactSegment.index].y;
  const contactX = contactSegment.contactX;
  const femaleOuterX = contactX - CONTACT_HALF_LENGTH;
  const maleOuterX = contactX + CONTACT_HALF_LENGTH;
  const sourcePath = buildRoundedPath([
    ...routePoints.slice(0, contactSegment.index + 1),
    { x: femaleOuterX, y: contactY },
  ]);
  const targetPath = buildRoundedPath([
    { x: maleOuterX, y: contactY },
    ...routePoints.slice(contactSegment.index + 1),
  ]);

  return {
    sourcePath,
    targetPath,
    contactX,
    contactY,
    femaleOuterX,
    maleOuterX,
    branchSourceX,
    routePoints,
    contactSegmentIndex: contactSegment.index,
    usedDetour,
    sharedTrunkPath: sharedRoute.path,
    sharedRoutePoints: sharedRoute.points,
    sharedGradientStart: sharedRoute.gradientStart,
    sharedGradientEnd: sharedRoute.gradientEnd,
  };
}
