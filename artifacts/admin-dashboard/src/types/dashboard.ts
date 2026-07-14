export type HealthStatus = "healthy" | "warning" | "degraded" | "unknown";
export type IncidentSeverity = "critical" | "warning" | "info";
export type IncidentStatus = "open" | "acknowledged" | "resolved";
export type IncidentFilter = "all" | "open";
export type DashboardConnectionState =
  | "live"
  | "stale"
  | "offline"
  | "refreshing";

export interface DashboardMetric {
  id: string;
  label: string;
  value: string;
  change: string;
  trend: number[];
}

export interface ServiceModule {
  id: string;
  name: string;
  status: HealthStatus;
  version: string;
  availableVersion?: string;
  lastDeploymentAt: string;
  requestsPerMinute: number;
}

export interface ServiceEdge {
  id: string;
  source: string;
  target: string;
  status: HealthStatus;
  requestsPerMinute: number;
}

export interface Incident {
  id: string;
  title: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  serviceId: string;
  createdAt: string;
}

export interface ProviderHealth {
  id: string;
  name: string;
  status: HealthStatus;
  latencyMs: number;
  latencyTrendMs: number[];
  lastCheckedAt: string;
}

export interface DashboardSnapshot {
  generatedAt: string;
  metrics: DashboardMetric[];
  modules: ServiceModule[];
  edges: ServiceEdge[];
  incidents: Incident[];
  providers: ProviderHealth[];
}

export interface DashboardSnapshotAdapter {
  initialSnapshot?: DashboardSnapshot;
  loadSnapshot: () => Promise<DashboardSnapshot>;
}
