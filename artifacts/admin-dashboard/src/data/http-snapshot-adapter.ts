import { demoSnapshot } from "./demo-snapshot";
import type { DashboardSnapshot, DashboardSnapshotAdapter } from "../types/dashboard";

export interface DashboardSnapshotResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<DashboardSnapshot>;
}

export type DashboardSnapshotFetcher = (
  input: string,
  init: RequestInit,
) => Promise<DashboardSnapshotResponse>;

interface HttpDashboardSnapshotAdapterOptions {
  baseUrl: string;
  initialSnapshot?: DashboardSnapshot;
  fetchSnapshot?: DashboardSnapshotFetcher;
}

export function normalizeAdminApiBaseUrl(baseUrl: string): string {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
  if (normalizedBaseUrl.length === 0)
    throw new Error("VITE_ADMIN_API_URL must not be empty");
  return normalizedBaseUrl;
}

export function createHttpDashboardSnapshotAdapter({
  baseUrl,
  initialSnapshot = demoSnapshot,
  fetchSnapshot = fetch,
}: HttpDashboardSnapshotAdapterOptions): DashboardSnapshotAdapter {
  const endpoint = `${normalizeAdminApiBaseUrl(baseUrl)}/api/admin/dashboard`;

  return {
    initialSnapshot,
    async loadSnapshot() {
      const response = await fetchSnapshot(endpoint, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok)
        throw new Error(`Admin dashboard request failed: ${response.status} ${response.statusText}`);
      return response.json();
    },
  };
}
