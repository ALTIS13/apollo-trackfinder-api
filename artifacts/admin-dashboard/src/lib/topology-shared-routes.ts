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
  branchAttachmentX?: number;
  branchChannel: number;
  branchChannelY?: number;
  branchApproachX?: number;
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

const FAN_ATTACHMENT_INSET = 12;
const FAN_ATTACHMENT_GAP = CONTACT_BEND_CLEARANCE;

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
    const fanOutActive = Array.from(edgesByDirection.values()).some(
      (directionEdges) => directionEdges.length > 1,
    );
    const allTargetsKnown = orderedEdges.every((edge) =>
      nodePositions.has(edge.target),
    );
    const desiredFanBranchLength =
      FAN_ATTACHMENT_INSET * 2 +
      FAN_ATTACHMENT_GAP * Math.max(0, orderedEdges.length - 1);
    const safeFanBranchLength = orderedEdges.reduce((safeLength, edge) => {
      const targetPosition = nodePositions.get(edge.target);
      if (targetPosition === undefined || targetPosition.x < sourceX)
        return safeLength;
      const targetOnSourceRow = targetCenterY(targetPosition) === sourceY;
      if (targetPosition.x === sourceX && !targetOnSourceRow) return safeLength;
      const terminalReserve = targetOnSourceRow ? TARGET_STUB_LENGTH : 0;
      return Math.min(
        safeLength,
        Math.max(0, targetPosition.x - sourceX - terminalReserve),
      );
    }, desiredFanBranchLength);
    const effectiveSharedBranchLength =
      fanOutActive && allTargetsKnown
        ? safeFanBranchLength
        : sharedBranchLength;
    if (
      fanOutActive &&
      allTargetsKnown &&
      effectiveSharedBranchLength === 0
    ) {
      throw new Error(
        "Crowded topology fan requires a positive horizontal corridor",
      );
    }
    const metadata = new Map<
      string,
      Pick<
        SharedSourceRoute,
        | "branchIndex"
        | "branchCount"
        | "branchAttachmentX"
        | "branchChannel"
        | "branchChannelY"
        | "branchApproachX"
      >
    >();
    const branchApproaches = new Map<string, number>();
    const reservedVerticalTracks: number[] = fanOutActive && allTargetsKnown
      ? orderedEdges.map(
          (_, index) =>
            sourceX +
            (effectiveSharedBranchLength * (index + 1)) /
              (orderedEdges.length + 1),
        )
      : [];
    const isReservedTrack = (candidate: number) =>
      reservedVerticalTracks.some(
        (reserved) => Math.abs(candidate - reserved) < 0.000001,
      );
    const reserveApproach = (lower: number, upper: number) => {
      for (let level = 1; level <= 12; level += 1) {
        const denominator = 2 ** level;
        for (let numerator = 1; numerator < denominator; numerator += 2) {
          const candidate = lower + ((upper - lower) * numerator) / denominator;
          if (!isReservedTrack(candidate)) {
            reservedVerticalTracks.push(candidate);
            return candidate;
          }
        }
      }
      throw new Error("Unable to reserve a distinct topology approach track");
    };
    const edgesByTargetRow = new Map<number, ServiceEdge[]>();
    orderedEdges.forEach((edge) => {
      const targetPosition = nodePositions.get(edge.target);
      if (targetPosition === undefined) return;
      const row = targetCenterY(targetPosition);
      const rowEdges = edgesByTargetRow.get(row) ?? [];
      rowEdges.push(edge);
      edgesByTargetRow.set(row, rowEdges);
    });
    edgesByTargetRow.forEach((rowEdges) => {
      const orderedRowEdges = [...rowEdges].sort((left, right) => {
        const leftX = nodePositions.get(left.target)?.x ?? 0;
        const rightX = nodePositions.get(right.target)?.x ?? 0;
        return leftX === rightX ? left.id.localeCompare(right.id) : leftX - rightX;
      });
      let previousTargetX: number | undefined;
      orderedRowEdges.forEach((edge) => {
        const targetX = nodePositions.get(edge.target)?.x ?? sourceX;
        const lower = Math.max(
          targetX - TARGET_STUB_LENGTH,
          previousTargetX ?? Number.NEGATIVE_INFINITY,
        );
        if (fanOutActive && allTargetsKnown) {
          branchApproaches.set(edge.id, reserveApproach(lower, targetX));
        }
        previousTargetX = targetX;
      });
    });

    const usedChannelSlots = new Set<number>();
    const reserveChannelSlot = (direction: BranchDirection, index: number) => {
      let slot =
        direction === "above"
          ? -(index + 1)
          : direction === "below"
            ? index + 1
            : index % 2 === 0
              ? index / 2 + 1
              : -(index + 1) / 2;
      const step = slot < 0 ? -1 : 1;
      while (usedChannelSlots.has(slot)) slot += step;
      usedChannelSlots.add(slot);
      return slot;
    };

    orderedEdges.forEach((edge, orderedIndex) => {
      const targetPosition = nodePositions.get(edge.target);
      const direction = branchDirection(
        sourceY,
        targetPosition === undefined ? sourceY : targetCenterY(targetPosition),
      );
      const directionEdges = edgesByDirection.get(direction)!;
      const directionIndex = directionEdges.findIndex(
        (candidate) => candidate.id === edge.id,
      );
      if (!fanOutActive || !allTargetsKnown) {
        metadata.set(edge.id, {
          branchIndex: directionIndex,
          branchCount: directionEdges.length,
          branchChannel: 0,
        });
        return;
      }

      const slot = reserveChannelSlot(direction, directionIndex);
      metadata.set(edge.id, {
        branchIndex: orderedIndex,
        branchCount: orderedEdges.length,
        branchAttachmentX:
          sourceX +
          (effectiveSharedBranchLength * (orderedIndex + 1)) /
            (orderedEdges.length + 1),
        branchChannel: orderedIndex + 1,
        branchChannelY: sourceY + slot * CONTACT_BEND_CLEARANCE,
        branchApproachX: branchApproaches.get(edge.id)!,
      });
    });

    orderedEdges.forEach((edge, index) => {
      const branch = metadata.get(edge.id)!;
      routes.set(edge.id, {
        statusBands,
        aggregateStatus,
        renderTrunk: index === orderedEdges.length - 1,
        sharedBranchLength: effectiveSharedBranchLength,
        ...branch,
      });
    });
  });
  return routes;
}
