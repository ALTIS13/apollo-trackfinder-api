import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo-snapshot";
import { layoutTopology } from "./topology-layout";

describe("layoutTopology", () => {
  it("places request flow in stable left-to-right layers", () => {
    const layout = layoutTopology(demoSnapshot.modules, demoSnapshot.edges);
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));

    expect(byId.get("public-web")!.x).toBeLessThan(byId.get("core-api")!.x);
    expect(byId.get("core-api")!.x).toBeLessThan(byId.get("search-media")!.x);
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
