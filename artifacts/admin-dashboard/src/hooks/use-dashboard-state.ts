import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  filterIncidents,
  getServiceNeighborhood,
} from "../lib/dashboard-model";
import type {
  DashboardConnectionState,
  DashboardSnapshot,
  DashboardSnapshotAdapter,
  IncidentFilter,
} from "../types/dashboard";

const REFRESH_INTERVAL_MS = 15_000;

export function useDashboardState(
  adapter: DashboardSnapshotAdapter,
) {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | undefined>(
    adapter.initialSnapshot,
  );
  const [connectionState, setConnectionState] =
    useState<DashboardConnectionState>(
      adapter.initialSnapshot === undefined ? "refreshing" : "live",
    );
  const [selectedServiceId, setSelectedServiceId] = useState<string>();
  const [incidentFilter, setIncidentFilter] = useState<IncidentFilter>("all");
  const [isAutoRefreshEnabled, setAutoRefreshEnabled] = useState(false);
  const snapshotRef = useRef(snapshot);
  const requestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setConnectionState("refreshing");
    try {
      const nextSnapshot = await adapter.loadSnapshot();
      if (requestId !== requestIdRef.current) return;
      snapshotRef.current = nextSnapshot;
      setSnapshot(nextSnapshot);
      setConnectionState("live");
    } catch {
      if (requestId !== requestIdRef.current) return;
      setConnectionState(
        snapshotRef.current === undefined ? "offline" : "stale",
      );
    }
  }, [adapter]);

  useEffect(() => {
    if (adapter.initialSnapshot === undefined) void refresh();
  }, [adapter.initialSnapshot, refresh]);

  useEffect(() => {
    if (!isAutoRefreshEnabled) return;
    const timer = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [isAutoRefreshEnabled, refresh]);

  const acknowledgeIncident = useCallback((incidentId: string) => {
    setSnapshot((current) => {
      if (current === undefined) return current;
      const nextSnapshot: DashboardSnapshot = {
        ...current,
        incidents: current.incidents.map((incident) =>
          incident.id === incidentId
            ? { ...incident, status: "acknowledged" }
            : incident,
        ),
      };
      snapshotRef.current = nextSnapshot;
      return nextSnapshot;
    });
  }, []);

  const neighborhood = useMemo(
    () =>
      selectedServiceId === undefined || snapshot === undefined
        ? undefined
        : getServiceNeighborhood(snapshot, selectedServiceId),
    [selectedServiceId, snapshot],
  );
  const incidents = useMemo(
    () =>
      snapshot === undefined
        ? []
        : filterIncidents(snapshot, incidentFilter, selectedServiceId),
    [incidentFilter, selectedServiceId, snapshot],
  );

  return {
    snapshot,
    connectionState,
    lastUpdatedAt: snapshot?.generatedAt,
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
