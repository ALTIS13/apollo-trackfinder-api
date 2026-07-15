import { describe, expect, it } from "vitest";
import type { ServiceEdge } from "../types/dashboard";
import { getSharedSourceRoutes, getWorstHealthStatus } from "./topology-shared-routes";

const edge = (
  id: string,
  target: string,
  status: ServiceEdge["status"],
): ServiceEdge => ({
  id,
  source: "core",
  target,
  status,
  requestsPerMinute: 1,
});

const positions = new Map([
  ["core", { x: 0, y: 0, width: 190, height: 76 }],
  ["top", { x: 300, y: 20, width: 190, height: 76 }],
  ["middle", { x: 300, y: 120, width: 190, height: 76 }],
  ["bottom", { x: 300, y: 220, width: 190, height: 76 }],
]);

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length === 0) return [[]];
  return values.flatMap((value, index) =>
    permutations(
      values.filter((_, candidateIndex) => candidateIndex !== index),
    ).map((remaining) => [value, ...remaining]),
  );
}

describe("getSharedSourceRoutes", () => {
  it("assigns stable, distinct fan-out metadata only to crowded branch directions", () => {
    const crowdedPositions = new Map([
      ["core", { x: 0, y: 100, width: 190, height: 76 }],
      ["above-a", { x: 320, y: -80, width: 190, height: 76 }],
      ["above-b", { x: 320, y: 0, width: 190, height: 76 }],
      ["same-a", { x: 320, y: 100, width: 190, height: 76 }],
      ["same-b", { x: 560, y: 100, width: 190, height: 76 }],
      ["below", { x: 320, y: 260, width: 190, height: 76 }],
    ]);
    const crowdedEdges = [
      edge("core-above-b", "above-b", "warning"),
      edge("core-same-b", "same-b", "healthy"),
      edge("core-below", "below", "degraded"),
      edge("core-above-a", "above-a", "healthy"),
      edge("core-same-a", "same-a", "unknown"),
    ];

    const routes = getSharedSourceRoutes(crowdedEdges, crowdedPositions);
    const reordered = getSharedSourceRoutes(
      [...crowdedEdges].reverse(),
      crowdedPositions,
    );
    const metadata = (id: string) => {
      const route = routes.get(id) as unknown as Record<string, unknown>;
      return {
        branchIndex: route.branchIndex,
        branchCount: route.branchCount,
        branchAttachmentY: route.branchAttachmentY,
        branchChannel: route.branchChannel,
        branchApproachX: route.branchApproachX,
        sharedFanMinimumY: route.sharedFanMinimumY,
        sharedFanMaximumY: route.sharedFanMaximumY,
      };
    };

    expect(metadata("core-above-a")).toMatchObject({
      branchIndex: 0,
      branchCount: 2,
      branchChannel: 1,
    });
    expect(metadata("core-above-b")).toMatchObject({
      branchIndex: 1,
      branchCount: 2,
      branchChannel: 2,
    });
    expect(metadata("core-same-a")).toMatchObject({
      branchIndex: 0,
      branchCount: 2,
      branchChannel: 3,
      branchApproachX: 312.5,
    });
    expect(metadata("core-same-b")).toMatchObject({
      branchIndex: 1,
      branchCount: 2,
      branchChannel: 4,
      branchApproachX: 440,
    });
    expect(metadata("core-below")).toMatchObject({
      branchIndex: 0,
      branchCount: 1,
      branchAttachmentY: 138,
      branchChannel: 0,
    });
    expect(new Set([
      metadata("core-above-a").branchAttachmentY,
      metadata("core-above-b").branchAttachmentY,
      metadata("core-same-a").branchAttachmentY,
      metadata("core-same-b").branchAttachmentY,
    ]).size).toBe(4);
    expect(metadata("core-above-a").sharedFanMinimumY).toBeLessThan(138);
    expect(metadata("core-same-b").sharedFanMaximumY).toBeGreaterThan(138);
    crowdedEdges.forEach((candidate) => {
      expect(reordered.get(candidate.id)).toEqual(routes.get(candidate.id));
    });
  });

  it("orders source edges by target center then id and aggregates their statuses", () => {
    const routes = getSharedSourceRoutes(
      [
        edge("core-bottom", "bottom", "warning"),
        edge("core-top", "top", "healthy"),
        edge("core-middle", "middle", "degraded"),
      ],
      positions,
    );
    const route = routes.get("core-top");

    expect(route?.statusBands).toEqual([
      { status: "healthy", count: 1 },
      { status: "degraded", count: 1 },
      { status: "warning", count: 1 },
    ]);
    expect(route?.aggregateStatus).toBe("degraded");
    expect(routes.get("core-bottom")?.renderTrunk).toBe(true);
  });

  it("groups duplicate statuses by their first ordered occurrence", () => {
    const routes = getSharedSourceRoutes(
      [
        edge("core-bottom", "bottom", "healthy"),
        edge("core-top", "top", "healthy"),
        edge("core-middle", "middle", "warning"),
      ],
      positions,
    );

    expect(routes.get("core-top")?.statusBands).toEqual([
      { status: "healthy", count: 2 },
      { status: "warning", count: 1 },
    ]);
  });

  it("keeps a source route stable when unrelated edges are reordered", () => {
    const coreEdges = [
      edge("core-bottom", "bottom", "warning"),
      edge("core-top", "top", "healthy"),
    ];
    const unrelated: ServiceEdge = {
      id: "other-edge",
      source: "other",
      target: "top",
      status: "degraded",
      requestsPerMinute: 1,
    };

    expect(getSharedSourceRoutes([...coreEdges, unrelated], positions)).toEqual(
      getSharedSourceRoutes([unrelated, ...coreEdges], positions),
    );
  });

  it("returns no shared routes when the source node is missing", () => {
    const missingSourcePositions = new Map(positions);
    missingSourcePositions.delete("core");

    expect(
      getSharedSourceRoutes(
        [
          edge("core-top", "top", "healthy"),
          edge("core-bottom", "bottom", "warning"),
        ],
        missingSourcePositions,
      ),
    ).toEqual(new Map());
  });

  it("uses zero clearance and edge ID order when target nodes are missing", () => {
    const routes = getSharedSourceRoutes(
      [
        edge("core-z-missing", "missing-z", "warning"),
        edge("core-a-missing", "missing-a", "healthy"),
      ],
      new Map([["core", positions.get("core")!]]),
    );

    expect(routes.get("core-a-missing")?.statusBands).toEqual([
      { status: "healthy", count: 1 },
      { status: "warning", count: 1 },
    ]);
    expect(routes.get("core-a-missing")?.sharedBranchLength).toBe(0);
    expect(routes.get("core-a-missing")?.renderTrunk).toBe(false);
    expect(routes.get("core-z-missing")?.renderTrunk).toBe(true);
  });
});

describe("getWorstHealthStatus", () => {
  it("returns healthy for an empty list", () => {
    expect(getWorstHealthStatus([])).toBe("healthy");
  });

  it.each(["healthy", "unknown", "warning", "degraded"] as const)(
    "returns the %s singleton unchanged",
    (status) => {
      expect(getWorstHealthStatus([status])).toBe(status);
    },
  );

  it.each([
    [["healthy", "unknown"] as const, "unknown" as const],
    [["healthy", "unknown", "warning"] as const, "warning" as const],
    [
      ["healthy", "unknown", "warning", "degraded"] as const,
      "degraded" as const,
    ],
  ])("selects %s regardless of input permutation", (statuses, expected) => {
    permutations(statuses).forEach((permutation) => {
      expect(getWorstHealthStatus(permutation)).toBe(expected);
    });
  });
});
