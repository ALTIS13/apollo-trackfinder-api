import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo-snapshot";
import {
  layoutTopology,
  NODE_HEIGHT,
  NODE_WIDTH,
  TOPOLOGY_NODE_SEPARATION,
  TOPOLOGY_RANK_SEPARATION,
} from "./topology-layout";

describe("layoutTopology", () => {
  it("places request flow in stable left-to-right layers", () => {
    const layout = layoutTopology(demoSnapshot.modules, demoSnapshot.edges);
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));

    expect(byId.get("public-web")!.x).toBeLessThan(byId.get("core-api")!.x);
    expect(byId.get("core-api")!.x).toBeLessThan(byId.get("search-media")!.x);
    expect(byId.get("core-api")!.x - byId.get("public-web")!.x).toBe(
      NODE_WIDTH + TOPOLOGY_RANK_SEPARATION,
    );
    expect(TOPOLOGY_RANK_SEPARATION).toBe(132);
    expect(byId.get("core-api")!.x - byId.get("public-web")!.x).toBe(
      NODE_WIDTH + 132,
    );
    expect(
      byId.get("download-worker")!.y -
        byId.get("account-integrations")!.y,
    ).toBe(NODE_HEIGHT + TOPOLOGY_NODE_SEPARATION);
    expect(TOPOLOGY_NODE_SEPARATION).toBe(56);
    expect(
      byId.get("download-worker")!.y - byId.get("account-integrations")!.y,
    ).toBe(NODE_HEIGHT + 56);
    expect(layout.nodes.every((node) => node.width === 190 && node.height === 76)).toBe(true);
  });

  it("keeps node positions stable when input arrays are reversed", () => {
    const original = layoutTopology(demoSnapshot.modules, demoSnapshot.edges);
    const reversed = layoutTopology([...demoSnapshot.modules].reverse(), [...demoSnapshot.edges].reverse());
    const originalById = new Map(original.nodes.map((node) => [node.id, node]));
    const reversedById = new Map(reversed.nodes.map((node) => [node.id, node]));

    expect(
      demoSnapshot.modules.every((module) => {
        const originalNode = originalById.get(module.id)!;
        const reversedNode = reversedById.get(module.id)!;

        return originalNode.x === reversedNode.x && originalNode.y === reversedNode.y;
      }),
    ).toBe(true);
  });
});
