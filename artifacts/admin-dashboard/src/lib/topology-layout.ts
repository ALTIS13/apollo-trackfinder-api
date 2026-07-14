import dagre from "dagre";
import type { ServiceEdge, ServiceModule } from "../types/dashboard";

export const NODE_WIDTH = 190;
export const NODE_HEIGHT = 76;

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

export function layoutTopology(modules: ServiceModule[], edges: ServiceEdge[]): TopologyLayout {
  const graph = new dagre.graphlib.Graph();

  graph.setGraph({ rankdir: "LR", ranksep: 72, nodesep: 34, marginx: 24, marginy: 24 });
  graph.setDefaultEdgeLabel(() => ({}));
  modules.forEach((module) => graph.setNode(module.id, { width: NODE_WIDTH, height: NODE_HEIGHT }));
  edges.forEach((edge) => graph.setEdge(edge.source, edge.target));
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
