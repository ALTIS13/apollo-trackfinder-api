import type { DashboardSnapshot } from "@workspace/admin-dashboard-contract";

export type {
  DashboardMetric,
  DashboardSnapshot,
  HealthStatus,
  Incident,
  IncidentDiagnostic,
  IncidentSeverity,
  IncidentStatus,
  ProviderHealth,
  ServiceEdge,
  ServiceModule,
} from "@workspace/admin-dashboard-contract";

export type IncidentFilter = "all" | "open";
export type DashboardConnectionState =
  | "live"
  | "stale"
  | "offline"
  | "refreshing";

export type DashboardAdapterMode = "demo" | "http";

export interface DashboardAdapterCapabilities {
  canAcknowledgeIncidents: boolean;
}

export interface DashboardSnapshotAdapter {
  mode: DashboardAdapterMode;
  capabilities: DashboardAdapterCapabilities;
  initialSnapshot?: DashboardSnapshot;
  loadSnapshot: () => Promise<DashboardSnapshot>;
}
