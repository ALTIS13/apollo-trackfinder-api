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
  it("assigns every contributor a stable attachment and channel when any direction is crowded", () => {
    const crowdedPositions = new Map([
      ["core", { x: 0, y: 100, width: 190, height: 76 }],
      ["above-a", { x: 340, y: -80, width: 190, height: 76 }],
      ["above-b", { x: 340, y: 0, width: 190, height: 76 }],
      ["same-a", { x: 340, y: 100, width: 190, height: 76 }],
      ["same-b", { x: 560, y: 100, width: 190, height: 76 }],
      ["below", { x: 340, y: 260, width: 190, height: 76 }],
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
        branchAttachmentX: route.branchAttachmentX,
        branchChannel: route.branchChannel,
        branchChannelY: route.branchChannelY,
        branchApproachX: route.branchApproachX,
        sharedBranchLength: route.sharedBranchLength,
      };
    };

    expect(metadata("core-above-a")).toMatchObject({
      branchIndex: 0,
      branchCount: 5,
      branchAttachmentX: 210,
      branchChannel: 1,
    });
    expect(metadata("core-above-b")).toMatchObject({
      branchIndex: 1,
      branchCount: 5,
      branchAttachmentX: 230,
      branchChannel: 2,
    });
    expect(metadata("core-same-a")).toMatchObject({
      branchIndex: 2,
      branchCount: 5,
      branchAttachmentX: 250,
      branchChannel: 3,
      branchApproachX: expect.any(Number),
    });
    expect(metadata("core-same-b")).toMatchObject({
      branchIndex: 3,
      branchCount: 5,
      branchAttachmentX: 270,
      branchChannel: 4,
      branchApproachX: expect.any(Number),
    });
    expect(metadata("core-below")).toMatchObject({
      branchIndex: 4,
      branchCount: 5,
      branchAttachmentX: 290,
      branchChannel: 5,
    });
    expect(
      new Set(crowdedEdges.map((candidate) => metadata(candidate.id).branchAttachmentX))
        .size,
    ).toBe(crowdedEdges.length);
    expect(
      new Set(crowdedEdges.map((candidate) => metadata(candidate.id).branchChannelY))
        .size,
    ).toBe(crowdedEdges.length);
    expect(
      crowdedEdges.map((candidate) => metadata(candidate.id).sharedBranchLength),
    ).toEqual(Array(crowdedEdges.length).fill(120));
    crowdedEdges.forEach((candidate) => {
      expect(reordered.get(candidate.id)).toEqual(routes.get(candidate.id));
    });
  });

  it("partitions approaches for siblings on the same off-source target row", () => {
    const offSourcePositions = new Map([
      ["core", { x: 0, y: 180, width: 190, height: 76 }],
      ["above-a", { x: 380, y: 20, width: 190, height: 76 }],
      ["above-b", { x: 400, y: 20, width: 190, height: 76 }],
    ]);
    const routes = getSharedSourceRoutes(
      [
        edge("core-above-b", "above-b", "warning"),
        edge("core-above-a", "above-a", "healthy"),
      ],
      offSourcePositions,
    );

    expect(routes.get("core-above-a")?.branchApproachX).toBe(374);
    expect(routes.get("core-above-b")?.branchApproachX).toBe(394);
  });

  it("reserves globally distinct approach tracks across different target rows", () => {
    const crossRowPositions = new Map([
      ["core", { x: 0, y: 180, width: 190, height: 76 }],
      ["target-a", { x: 380, y: -120, width: 190, height: 76 }],
      ["target-b", { x: 395, y: -20, width: 190, height: 76 }],
    ]);
    const routes = getSharedSourceRoutes(
      [
        edge("core-target-a", "target-a", "warning"),
        edge("core-target-b", "target-b", "degraded"),
      ],
      crossRowPositions,
    );
    const approaches = Array.from(
      routes.values(),
      (route) => route.branchApproachX,
    );
    const attachments = new Set(
      Array.from(routes.values(), (route) => route.branchAttachmentX),
    );

    expect(approaches.every((value) => typeof value === "number")).toBe(true);
    expect(new Set(approaches).size).toBe(2);
    approaches.forEach((approach) => expect(attachments.has(approach)).toBe(false));
  });

  it("compresses fan attachments into a narrow corridor before the target stub", () => {
    const narrowPositions = new Map([
      ["core", { x: 0, y: 100, width: 190, height: 76 }],
      ["top", { x: 210, y: -180, width: 190, height: 76 }],
      ["middle", { x: 210, y: -80, width: 190, height: 76 }],
      ["same", { x: 210, y: 100, width: 190, height: 76 }],
    ]);
    const routes = getSharedSourceRoutes(
      [
        edge("core-top", "top", "healthy"),
        edge("core-middle", "middle", "warning"),
        edge("core-same", "same", "degraded"),
      ],
      narrowPositions,
    );
    const attachments = Array.from(
      routes.values(),
      (route) => route.branchAttachmentX!,
    );

    expect(Array.from(routes.values(), (route) => route.sharedBranchLength)).toEqual([
      8,
      8,
      8,
    ]);
    expect(new Set(attachments).size).toBe(3);
    attachments.forEach((attachment) => {
      expect(attachment).toBeGreaterThan(190);
      expect(attachment).toBeLessThan(198);
    });
  });

  it("rejects a crowded fan when target cards leave no horizontal corridor", () => {
    const touchingPositions = new Map([
      ["core", { x: 0, y: 100, width: 190, height: 76 }],
      ["top", { x: 190, y: -180, width: 190, height: 76 }],
      ["middle", { x: 190, y: -80, width: 190, height: 76 }],
      ["same", { x: 190, y: 100, width: 190, height: 76 }],
    ]);
    expect(() =>
      getSharedSourceRoutes(
        [
          edge("core-top", "top", "healthy"),
          edge("core-middle", "middle", "warning"),
          edge("core-same", "same", "degraded"),
        ],
        touchingPositions,
      ),
    ).toThrow("Crowded topology fan requires a positive horizontal corridor");
  });

  it("uses the full minimal corridor for off-row targets", () => {
    const minimalOffRowPositions = new Map([
      ["core", { x: 0, y: 180, width: 190, height: 76 }],
      ["target-a", { x: 202, y: -20, width: 190, height: 76 }],
      ["target-b", { x: 202, y: 80, width: 190, height: 76 }],
    ]);
    const routes = getSharedSourceRoutes(
      [
        edge("core-target-a", "target-a", "warning"),
        edge("core-target-b", "target-b", "degraded"),
      ],
      minimalOffRowPositions,
    );

    expect(Array.from(routes.values(), (route) => route.sharedBranchLength)).toEqual([
      12,
      12,
    ]);
    expect(
      Array.from(routes.values(), (route) => route.branchAttachmentX),
    ).toEqual([194, 198]);
  });

  it("keeps the default one-above one-same one-below group out of fan mode", () => {
    const balancedPositions = new Map(positions);
    balancedPositions.set("core", { x: 0, y: 120, width: 190, height: 76 });
    const routes = getSharedSourceRoutes(
      [
        edge("core-bottom", "bottom", "warning"),
        edge("core-top", "top", "healthy"),
        edge("core-middle", "middle", "degraded"),
      ],
      balancedPositions,
    );

    expect(
      Array.from(routes.values(), (route) => ({
        attachment: route.branchAttachmentX,
        channel: route.branchChannel,
        length: route.sharedBranchLength,
      })),
    ).toEqual([
      { attachment: undefined, channel: 0, length: 24 },
      { attachment: undefined, channel: 0, length: 24 },
      { attachment: undefined, channel: 0, length: 24 },
    ]);
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
