import type { DashboardSnapshot, Incident, IncidentFilter } from "../types/dashboard";

export function getOpenIncidentCount(snapshot: DashboardSnapshot): number {
  return snapshot.incidents.filter((incident) => incident.status === "open").length;
}

export function getServiceNeighborhood(snapshot: DashboardSnapshot, serviceId: string): Set<string> {
  const ids = new Set([serviceId]);
  for (const edge of snapshot.edges) {
    if (edge.source === serviceId) ids.add(edge.target);
    if (edge.target === serviceId) ids.add(edge.source);
  }
  return ids;
}

export function filterIncidents(
  snapshot: DashboardSnapshot,
  filter: IncidentFilter,
  serviceId?: string,
): Incident[] {
  return snapshot.incidents.filter(
    (incident) =>
      (filter === "all" || incident.status === "open") &&
      (serviceId === undefined || incident.serviceId === serviceId),
  );
}
