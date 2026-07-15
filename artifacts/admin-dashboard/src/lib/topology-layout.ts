import dagre from "dagre";
import type { ServiceEdge, ServiceModule } from "../types/dashboard";

export const NODE_WIDTH = 190;
export const NODE_HEIGHT = 76;
export const TOPOLOGY_RANK_SEPARATION = 84;
export const TOPOLOGY_NODE_SEPARATION = 40;

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TopologyLayout {
  nodes: LayoutNode[];
  width: number;
  height: number;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function layoutTopology(modules: ServiceModule[], edges: ServiceEdge[]): TopologyLayout {
  const graph = new dagre.graphlib.Graph();
  const canonicalModules = [...modules].sort((left, right) => compareStrings(left.id, right.id));
  const canonicalEdges = [...edges].sort(
    (left, right) =>
      compareStrings(left.source, right.source) ||
      compareStrings(left.target, right.target) ||
      compareStrings(left.id, right.id),
  );

  graph.setGraph({
    rankdir: "LR",
    ranksep: TOPOLOGY_RANK_SEPARATION,
    nodesep: TOPOLOGY_NODE_SEPARATION,
    marginx: 24,
    marginy: 24,
  });
  graph.setDefaultEdgeLabel(() => ({}));
  canonicalModules.forEach((module) => graph.setNode(module.id, { width: NODE_WIDTH, height: NODE_HEIGHT }));
  canonicalEdges.forEach((edge) => graph.setEdge(edge.source, edge.target));
  dagre.layout(graph);

  const nodes = modules.map((module) => {
    const node = graph.node(module.id);

    return {
      id: module.id,
      x: node.x - NODE_WIDTH / 2,
      y: node.y - NODE_HEIGHT / 2,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    };
  });
  const dimensions = graph.graph();

  return {
    nodes,
    width: dimensions.width ?? 0,
    height: dimensions.height ?? 0,
  };
}
