import { useCallback, useEffect, useMemo, useState } from "react";
import { demoSnapshot } from "../data/demo-snapshot";
import {
  filterIncidents,
  getServiceNeighborhood,
} from "../lib/dashboard-model";
import type { DashboardSnapshot, IncidentFilter } from "../types/dashboard";

const REFRESH_INTERVAL_MS = 15_000;

export function useDashboardState(
  initialSnapshot: DashboardSnapshot = demoSnapshot,
) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [selectedServiceId, setSelectedServiceId] = useState<string>();
  const [incidentFilter, setIncidentFilter] = useState<IncidentFilter>("all");
  const [isAutoRefreshEnabled, setAutoRefreshEnabled] = useState(false);

  const refresh = useCallback(() => {
    setSnapshot((current) => ({
      ...current,
      generatedAt: new Date().toISOString(),
    }));
  }, []);

  useEffect(() => {
    if (!isAutoRefreshEnabled) return;
    const timer = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [isAutoRefreshEnabled, refresh]);

  const acknowledgeIncident = useCallback((incidentId: string) => {
    setSnapshot((current) => ({
      ...current,
      incidents: current.incidents.map((incident) =>
        incident.id === incidentId
          ? { ...incident, status: "acknowledged" }
          : incident,
      ),
    }));
  }, []);

  const neighborhood = useMemo(
    () =>
      selectedServiceId === undefined
        ? undefined
        : getServiceNeighborhood(snapshot, selectedServiceId),
    [selectedServiceId, snapshot.edges],
  );
  const incidents = useMemo(
    () => filterIncidents(snapshot, incidentFilter, selectedServiceId),
    [incidentFilter, selectedServiceId, snapshot],
  );

  return {
    snapshot,
    selectedServiceId,
    incidentFilter,
    incidents,
    neighborhood,
    isAutoRefreshEnabled,
    selectService: setSelectedServiceId,
    setIncidentFilter,
    acknowledgeIncident,
    refresh,
    setAutoRefreshEnabled,
  };
}
