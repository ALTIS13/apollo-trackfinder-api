import {
  CONNECTOR_BEND_RADIUS,
  CONTACT_BEND_CLEARANCE,
  CONTACT_HALF_LENGTH,
  SHARED_TRUNK_LENGTH,
  TARGET_STUB_LENGTH,
} from "./topology-connector-geometry";
import type { HealthStatus, ServiceEdge } from "../types/dashboard";

export interface SharedStatusBand {
  status: HealthStatus;
  count: number;
}

export interface SharedSourceRoute {
  statusBands: SharedStatusBand[];
  aggregateStatus: HealthStatus;
  renderTrunk: boolean;
  sharedBranchLength: number;
  branchIndex: number;
  branchCount: number;
  branchAttachmentY: number;
  branchChannel: number;
  branchApproachX?: number;
  sharedFanMinimumY: number;
  sharedFanMaximumY: number;
}

export interface TopologyNodePosition {
  x: number;
  width: number;
  y?: number;
  height?: number;
}

const severity: HealthStatus[] = ["healthy", "unknown", "warning", "degraded"];

export function getWorstHealthStatus(statuses: readonly HealthStatus[]): HealthStatus {
  return statuses.reduce(
    (worst, status) =>
      severity.indexOf(status) > severity.indexOf(worst) ? status : worst,
    "healthy",
  );
}

function targetCenterY(position: TopologyNodePosition): number {
  return (position.y ?? 0) + (position.height ?? 0) / 2;
}

type BranchDirection = "above" | "same" | "below";

function branchDirection(sourceY: number, targetY: number): BranchDirection {
  if (targetY < sourceY) return "above";
  if (targetY > sourceY) return "below";
  return "same";
}

export function getSharedSourceRoutes(
  edges: ServiceEdge[],
  nodePositions: ReadonlyMap<string, TopologyNodePosition>,
): Map<string, SharedSourceRoute> {
  const edgesBySource = new Map<string, ServiceEdge[]>();
  edges.forEach((edge) => {
    const sourceEdges = edgesBySource.get(edge.source) ?? [];
    sourceEdges.push(edge);
    edgesBySource.set(edge.source, sourceEdges);
  });

  const routes = new Map<string, SharedSourceRoute>();
  edgesBySource.forEach((sourceEdges) => {
    if (sourceEdges.length < 2) return;
    const sourcePosition = nodePositions.get(sourceEdges[0]!.source);
    if (sourcePosition === undefined) return;
    const orderedEdges = [...sourceEdges].sort((left, right) => {
      const leftTarget = nodePositions.get(left.target);
      const rightTarget = nodePositions.get(right.target);
      const centerDelta =
        (leftTarget === undefined ? 0 : targetCenterY(leftTarget)) -
        (rightTarget === undefined ? 0 : targetCenterY(rightTarget));
      return centerDelta === 0 ? left.id.localeCompare(right.id) : centerDelta;
    });
    const sourceX = sourcePosition.x + sourcePosition.width;
    const sourceY = targetCenterY(sourcePosition);
    const sharedBranchLength = orderedEdges.reduce(
      (shortestClearance, edge) => {
        const targetPosition = nodePositions.get(edge.target);
        if (targetPosition === undefined) return 0;
        const femaleOuterX =
          targetPosition.x - 2 * CONTACT_HALF_LENGTH - TARGET_STUB_LENGTH;
        const clearance = femaleOuterX - sourceX - CONNECTOR_BEND_RADIUS;
        return Math.min(shortestClearance, Math.max(0, clearance));
      },
      SHARED_TRUNK_LENGTH,
    );
    const statusBands = orderedEdges.reduce<SharedStatusBand[]>((bands, edge) => {
      const existing = bands.find((band) => band.status === edge.status);
      if (existing !== undefined) existing.count += 1;
      else bands.push({ status: edge.status, count: 1 });
      return bands;
    }, []);
    const aggregateStatus = getWorstHealthStatus(orderedEdges.map((edge) => edge.status));

    const edgesByDirection = new Map<BranchDirection, ServiceEdge[]>([
      ["above", []],
      ["same", []],
      ["below", []],
    ]);
    orderedEdges.forEach((edge) => {
      const targetPosition = nodePositions.get(edge.target);
      const direction = branchDirection(
        sourceY,
        targetPosition === undefined ? sourceY : targetCenterY(targetPosition),
      );
      edgesByDirection.get(direction)!.push(edge);
    });
    const crowdedBelowCount =
      edgesByDirection.get("below")!.length > 1
        ? edgesByDirection.get("below")!.length
        : 0;
    const metadata = new Map<
      string,
      Pick<
        SharedSourceRoute,
        | "branchIndex"
        | "branchCount"
        | "branchAttachmentY"
        | "branchChannel"
        | "branchApproachX"
      >
    >();
    const sameRowApproaches = new Map<string, number>();
    const sameRowEdges = [...edgesByDirection.get("same")!].sort((left, right) => {
      const leftX = nodePositions.get(left.target)?.x ?? 0;
      const rightX = nodePositions.get(right.target)?.x ?? 0;
      return leftX === rightX ? left.id.localeCompare(right.id) : leftX - rightX;
    });
    if (sameRowEdges.length > 1) {
      let previousTargetX: number | undefined;
      sameRowEdges.forEach((edge) => {
        const targetX = nodePositions.get(edge.target)?.x ?? sourceX;
        const approachX =
          previousTargetX === undefined || targetX <= previousTargetX
            ? targetX - CONNECTOR_BEND_RADIUS
            : (previousTargetX + targetX) / 2;
        sameRowApproaches.set(edge.id, approachX);
        previousTargetX = targetX;
      });
    }
    let branchChannel = 0;
    orderedEdges.forEach((edge) => {
      const targetPosition = nodePositions.get(edge.target);
      const direction = branchDirection(
        sourceY,
        targetPosition === undefined ? sourceY : targetCenterY(targetPosition),
      );
      const directionEdges = edgesByDirection.get(direction)!;
      const branchIndex = directionEdges.findIndex((candidate) => candidate.id === edge.id);
      const branchCount = directionEdges.length;
      if (branchCount < 2) {
        metadata.set(edge.id, {
          branchIndex,
          branchCount,
          branchAttachmentY: sourceY,
          branchChannel: 0,
        });
        return;
      }

      branchChannel += 1;
      const slot =
        direction === "above"
          ? -(branchIndex + 1)
          : direction === "below"
            ? branchIndex + 1
            : crowdedBelowCount + branchIndex + 1;
      metadata.set(edge.id, {
        branchIndex,
        branchCount,
        branchAttachmentY: sourceY + slot * CONTACT_BEND_CLEARANCE,
        branchChannel,
        ...(sameRowApproaches.has(edge.id)
          ? { branchApproachX: sameRowApproaches.get(edge.id)! }
          : {}),
      });
    });
    const attachmentYs = [
      sourceY,
      ...Array.from(metadata.values(), (item) => item.branchAttachmentY),
    ];
    const sharedFanMinimumY = Math.min(...attachmentYs);
    const sharedFanMaximumY = Math.max(...attachmentYs);

    orderedEdges.forEach((edge, index) => {
      const branch = metadata.get(edge.id)!;
      routes.set(edge.id, {
        statusBands,
        aggregateStatus,
        renderTrunk: index === orderedEdges.length - 1,
        sharedBranchLength,
        ...branch,
        sharedFanMinimumY,
        sharedFanMaximumY,
      });
    });
  });
  return routes;
}
