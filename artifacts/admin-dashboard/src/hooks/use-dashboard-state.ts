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

function applyLocalAcknowledgements(
  snapshot: DashboardSnapshot,
  acknowledgedIncidentIds: ReadonlySet<string>,
): DashboardSnapshot {
  return {
    ...snapshot,
    incidents: snapshot.incidents.map((incident) =>
      acknowledgedIncidentIds.has(incident.id) && incident.status === "open"
        ? { ...incident, status: "acknowledged" }
        : incident,
    ),
  };
}

export function useDashboardState(
  adapter: DashboardSnapshotAdapter,
) {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | undefined>(
    adapter.initialSnapshot,
  );
  const [connectionState, setConnectionState] =
    useState<DashboardConnectionState>(
      adapter.mode === "http" || adapter.initialSnapshot === undefined
        ? "refreshing"
        : "live",
    );
  const [selectedServiceId, setSelectedServiceId] = useState<string>();
  const [incidentFilter, setIncidentFilter] = useState<IncidentFilter>("all");
  const [isAutoRefreshEnabled, setAutoRefreshEnabled] = useState(false);
  const snapshotRef = useRef(snapshot);
  const hasVerifiedRemoteSnapshotRef = useRef(false);
  const refreshPromiseRef = useRef<Promise<void> | undefined>(undefined);
  const acknowledgedIncidentIdsRef = useRef(new Set<string>());

  const refresh = useCallback(() => {
    if (refreshPromiseRef.current !== undefined)
      return refreshPromiseRef.current;

    const request = (async () => {
      await Promise.resolve();
      setConnectionState("refreshing");
      try {
        const adapterSnapshot = await adapter.loadSnapshot();
        const nextSnapshot = adapter.capabilities.canAcknowledgeIncidents
          ? applyLocalAcknowledgements(
              adapterSnapshot,
              acknowledgedIncidentIdsRef.current,
            )
          : adapterSnapshot;
        snapshotRef.current = nextSnapshot;
        hasVerifiedRemoteSnapshotRef.current = adapter.mode === "http";
        setSnapshot(nextSnapshot);
        setConnectionState("live");
      } catch {
        const hasLastKnownGood =
          adapter.mode === "http"
            ? hasVerifiedRemoteSnapshotRef.current
            : snapshotRef.current !== undefined;
        setConnectionState(hasLastKnownGood ? "stale" : "offline");
      } finally {
        refreshPromiseRef.current = undefined;
      }
    })();
    refreshPromiseRef.current = request;
    return request;
  }, [adapter]);

  useEffect(() => {
    if (adapter.mode === "http" || adapter.initialSnapshot === undefined)
      void refresh();
  }, [adapter.initialSnapshot, adapter.mode, refresh]);

  useEffect(() => {
    if (!isAutoRefreshEnabled) return;
    const timer = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [isAutoRefreshEnabled, refresh]);

  const acknowledgeIncident = useCallback((incidentId: string) => {
    if (!adapter.capabilities.canAcknowledgeIncidents) return;
    acknowledgedIncidentIdsRef.current.add(incidentId);
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
  }, [adapter.capabilities.canAcknowledgeIncidents]);

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
    canAcknowledgeIncidents: adapter.capabilities.canAcknowledgeIncidents,
    selectService: setSelectedServiceId,
    setIncidentFilter,
    acknowledgeIncident,
    refresh,
    setAutoRefreshEnabled,
  };
}
