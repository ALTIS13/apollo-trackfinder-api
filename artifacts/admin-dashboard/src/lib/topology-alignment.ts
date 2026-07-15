import type { XYPosition } from "@xyflow/react";

export const TOPOLOGY_GRID_SIZE = 24;
export const TOPOLOGY_MAGNETIC_THRESHOLD_PX = 8;

export type TopologyAlignmentMode = "free" | "align";
export type AlignmentAxis = "x" | "y";

export interface AlignableTopologyNode {
  id: string;
  position: XYPosition;
  width: number;
  height: number;
}

export interface AlignmentGuide {
  axis: AlignmentAxis;
  position: number;
}

export interface AlignTopologyPositionInput {
  nodeId: string;
  position: XYPosition;
  width: number;
  height: number;
  nodes: readonly AlignableTopologyNode[];
  zoom: number;
  mode: TopologyAlignmentMode;
  precision: boolean;
}

function snap(value: number): number {
  return Math.round(value / TOPOLOGY_GRID_SIZE) * TOPOLOGY_GRID_SIZE;
}

function anchors(start: number, size: number): number[] {
  return [start, start + size / 2, start + size];
}

function safeZoom(zoom: number): number {
  return Number.isFinite(zoom) ? Math.max(zoom, 0.01) : 0.01;
}

export function alignTopologyPosition(
  input: AlignTopologyPositionInput,
): { position: XYPosition; guides: AlignmentGuide[] } {
  if (input.mode === "free" || input.precision) {
    return { position: input.position, guides: [] };
  }

  const base = { x: snap(input.position.x), y: snap(input.position.y) };
  const threshold = TOPOLOGY_MAGNETIC_THRESHOLD_PX / safeZoom(input.zoom);
  const peers = [...input.nodes]
    .filter((node) => node.id !== input.nodeId)
    .sort((left, right) => left.id.localeCompare(right.id));
  const result = { ...base };
  const guides: AlignmentGuide[] = [];

  for (const axis of ["x", "y"] as const) {
    const size = axis === "x" ? input.width : input.height;
    const moving = anchors(result[axis], size);
    let best:
      | { distance: number; delta: number; guide: number; key: string }
      | undefined;

    peers.forEach((peer) => {
      const peerStart = peer.position[axis];
      const peerSize = axis === "x" ? peer.width : peer.height;
      anchors(peerStart, peerSize).forEach((target, targetIndex) => {
        moving.forEach((source, sourceIndex) => {
          const delta = target - source;
          const distance = Math.abs(delta);
          const candidate = {
            distance,
            delta,
            guide: target,
            key: `${peer.id}:${targetIndex}:${sourceIndex}`,
          };
          if (
            distance <= threshold &&
            (best === undefined ||
              distance < best.distance ||
              (distance === best.distance && candidate.key < best.key))
          ) {
            best = candidate;
          }
        });
      });
    });

    if (best !== undefined) {
      result[axis] += best.delta;
      guides.push({ axis, position: best.guide });
    }
  }

  return { position: result, guides };
}

export function moveTopologyPositionByKeyboard(input: {
  key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";
  position: XYPosition;
  zoom: number;
  precision: boolean;
}): XYPosition {
  const step = input.precision
    ? 1 / safeZoom(input.zoom)
    : TOPOLOGY_GRID_SIZE;
  const delta = {
    ArrowLeft: { x: -step, y: 0 },
    ArrowRight: { x: step, y: 0 },
    ArrowUp: { x: 0, y: -step },
    ArrowDown: { x: 0, y: step },
  }[input.key];
  return { x: input.position.x + delta.x, y: input.position.y + delta.y };
}
