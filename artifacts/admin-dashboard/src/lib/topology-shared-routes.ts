import {
  CONNECTOR_BEND_RADIUS,
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

    orderedEdges.forEach((edge, index) => {
      routes.set(edge.id, {
        statusBands,
        aggregateStatus,
        renderTrunk: index === orderedEdges.length - 1,
        sharedBranchLength,
      });
    });
  });
  return routes;
}
