import type { ConnectorGeometry } from "./topology-connector-geometry";

export interface EvidenceAnchor {
  id: string;
  x: number;
  y: number;
  width: number;
}

export interface EvidenceObstacle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EvidenceLabelMetrics {
  labelHeight: number;
  baseOffset: number;
  laneGap: number;
}

export const CONNECTOR_VISUAL_METRICS = {
  routeWidth: 1.75,
  contactHitHalfWidth: 34,
  contactHitTop: 30,
  contactHitBottom: 24,
  trafficLabelCenterY: 19,
  trafficLabelFontSize: 9,
  trafficLabelHeight: 11,
} as const;

export function getConnectorVisualRects(
  geometry: ConnectorGeometry,
  trafficLabel: string,
): EvidenceObstacle[] {
  const routeHalfWidth = CONNECTOR_VISUAL_METRICS.routeWidth / 2;
  const minRouteX = Math.min(...geometry.routePoints.map((point) => point.x));
  const minRouteY = Math.min(...geometry.routePoints.map((point) => point.y));
  const maxRouteX = Math.max(...geometry.routePoints.map((point) => point.x));
  const maxRouteY = Math.max(...geometry.routePoints.map((point) => point.y));
  const trafficWidth = Math.max(
    1,
    trafficLabel.length * CONNECTOR_VISUAL_METRICS.trafficLabelFontSize,
  );

  return [
    {
      x: minRouteX - routeHalfWidth,
      y: minRouteY - routeHalfWidth,
      width: maxRouteX - minRouteX + routeHalfWidth * 2,
      height: maxRouteY - minRouteY + routeHalfWidth * 2,
    },
    {
      x: geometry.contactX - CONNECTOR_VISUAL_METRICS.contactHitHalfWidth,
      y: geometry.contactY - CONNECTOR_VISUAL_METRICS.contactHitTop,
      width: CONNECTOR_VISUAL_METRICS.contactHitHalfWidth * 2,
      height:
        CONNECTOR_VISUAL_METRICS.contactHitTop +
        CONNECTOR_VISUAL_METRICS.contactHitBottom,
    },
    {
      x: geometry.contactX - trafficWidth / 2,
      y:
        geometry.contactY +
        CONNECTOR_VISUAL_METRICS.trafficLabelCenterY -
        CONNECTOR_VISUAL_METRICS.trafficLabelHeight / 2,
      width: trafficWidth,
      height: CONNECTOR_VISUAL_METRICS.trafficLabelHeight,
    },
  ];
}

function intersects(a: EvidenceObstacle, b: EvidenceObstacle): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

export function getEvidenceLabelRect(
  anchor: EvidenceAnchor,
  lane: number,
  metrics: EvidenceLabelMetrics,
): EvidenceObstacle {
  return {
    x: anchor.x - anchor.width / 2,
    y:
      anchor.y -
      metrics.baseOffset -
      metrics.labelHeight -
      lane * (metrics.labelHeight + metrics.laneGap),
    width: anchor.width,
    height: metrics.labelHeight,
  };
}

export function assignEvidenceLabelLanes(input: {
  anchors: readonly EvidenceAnchor[];
  obstacles: readonly EvidenceObstacle[];
  labelHeight: number;
  baseOffset: number;
  laneGap: number;
}): Map<string, number> {
  const placed: EvidenceObstacle[] = [];
  const result = new Map<string, number>();
  const metrics: EvidenceLabelMetrics = {
    labelHeight: input.labelHeight,
    baseOffset: input.baseOffset,
    laneGap: input.laneGap,
  };
  const ordered = [...input.anchors].sort(
    (a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id),
  );

  ordered.forEach((anchor) => {
    let lane = 0;
    while (true) {
      const rect = getEvidenceLabelRect(anchor, lane, metrics);
      if (![...input.obstacles, ...placed].some((item) => intersects(rect, item))) {
        result.set(anchor.id, lane);
        placed.push(rect);
        return;
      }
      lane += 1;
    }
  });

  return result;
}

export function getTopologyVisualBounds(
  ...rectangleGroups: readonly (readonly EvidenceObstacle[])[]
): EvidenceObstacle | undefined {
  const rectangles = rectangleGroups.flat();
  if (rectangles.length === 0) return undefined;

  const minX = Math.min(...rectangles.map((rect) => rect.x));
  const minY = Math.min(...rectangles.map((rect) => rect.y));
  const maxX = Math.max(...rectangles.map((rect) => rect.x + rect.width));
  const maxY = Math.max(...rectangles.map((rect) => rect.y + rect.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
