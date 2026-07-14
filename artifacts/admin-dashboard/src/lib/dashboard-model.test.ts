import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo-snapshot";
import { filterIncidents, getOpenIncidentCount, getServiceNeighborhood } from "./dashboard-model";

describe("dashboard model", () => {
  it("counts only unresolved incidents", () => {
    expect(getOpenIncidentCount(demoSnapshot)).toBe(2);
  });

  it("returns the selected service and directly connected services", () => {
    expect(getServiceNeighborhood(demoSnapshot, "core-api")).toEqual(
      new Set(["public-web", "core-api", "account-integrations", "search-media", "download-worker"]),
    );
  });

  it("filters open incidents for a focused service", () => {
    expect(filterIncidents(demoSnapshot, "open", "download-worker").map((item) => item.id)).toEqual([
      "incident-download-errors",
    ]);
  });

  it("sorts incidents by severity and then newest first regardless of fixture order", () => {
    const reordered = {
      ...demoSnapshot,
      incidents: [
        { ...demoSnapshot.incidents[2], severity: "warning" as const, createdAt: "2026-07-14T09:20:00.000Z" },
        { ...demoSnapshot.incidents[1], severity: "critical" as const, createdAt: "2026-07-14T09:10:00.000Z" },
        { ...demoSnapshot.incidents[0], severity: "critical" as const, createdAt: "2026-07-14T09:30:00.000Z" },
      ],
    };

    expect(filterIncidents(reordered, "all").map((incident) => incident.id)).toEqual([
      "incident-download-errors",
      "incident-soundcloud-degradation",
      "incident-account-latency",
    ]);
  });
});
