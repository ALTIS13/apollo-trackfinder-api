import type { DashboardSnapshot } from "../types/dashboard";

export const demoSnapshot: DashboardSnapshot = {
  generatedAt: "2026-07-14T09:30:00.000Z",
  metrics: [
    { id: "active-modules", label: "Active modules", value: "5", change: "Stable" },
    { id: "searches-per-minute", label: "Searches / min", value: "1,284", change: "+8.4%" },
    { id: "queue-depth", label: "Queue depth", value: "36", change: "-12.1%" },
    { id: "error-rate", label: "Error rate", value: "1.8%", change: "+0.6%" },
  ],
  modules: [
    { id: "public-web", name: "Public Web", status: "healthy", version: "2.14.0", requestsPerMinute: 1284 },
    { id: "core-api", name: "Core API", status: "warning", version: "2.14.0", requestsPerMinute: 1284 },
    { id: "account-integrations", name: "Account Integrations", status: "healthy", version: "2.13.4", requestsPerMinute: 244 },
    { id: "search-media", name: "Search Media", status: "healthy", version: "2.14.0", requestsPerMinute: 894 },
    { id: "download-worker", name: "Download Worker", status: "degraded", version: "2.13.9", requestsPerMinute: 146 },
  ],
  edges: [
    { id: "public-web-core-api", source: "public-web", target: "core-api", status: "healthy", requestsPerMinute: 1284 },
    { id: "core-api-account-integrations", source: "core-api", target: "account-integrations", status: "healthy", requestsPerMinute: 244 },
    { id: "core-api-search-media", source: "core-api", target: "search-media", status: "healthy", requestsPerMinute: 894 },
    { id: "core-api-download-worker", source: "core-api", target: "download-worker", status: "degraded", requestsPerMinute: 146 },
  ],
  incidents: [
    { id: "incident-download-errors", title: "Download worker errors", severity: "critical", status: "open", serviceId: "download-worker", createdAt: "2026-07-14T09:18:00.000Z" },
    { id: "incident-soundcloud-degradation", title: "SoundCloud degradation", severity: "warning", status: "open", serviceId: "search-media", createdAt: "2026-07-14T09:12:00.000Z" },
    { id: "incident-account-latency", title: "Account integration latency", severity: "info", status: "resolved", serviceId: "account-integrations", createdAt: "2026-07-14T08:46:00.000Z" },
  ],
  providers: [
    { id: "soundcloud", name: "SoundCloud", status: "warning", latencyMs: 812 },
    { id: "youtube", name: "YouTube", status: "healthy", latencyMs: 183 },
  ],
};
