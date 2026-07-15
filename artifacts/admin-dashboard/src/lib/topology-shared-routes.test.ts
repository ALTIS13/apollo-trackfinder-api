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
