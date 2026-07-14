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
});
