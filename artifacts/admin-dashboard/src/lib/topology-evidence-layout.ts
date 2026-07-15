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
  moduleRects: readonly EvidenceObstacle[],
  labelRects: readonly EvidenceObstacle[],
): EvidenceObstacle | undefined {
  const rectangles = [...moduleRects, ...labelRects];
  if (rectangles.length === 0) return undefined;

  const minX = Math.min(...rectangles.map((rect) => rect.x));
  const minY = Math.min(...rectangles.map((rect) => rect.y));
  const maxX = Math.max(...rectangles.map((rect) => rect.x + rect.width));
  const maxY = Math.max(...rectangles.map((rect) => rect.y + rect.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
