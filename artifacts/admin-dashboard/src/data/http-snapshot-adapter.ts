import { demoSnapshot } from "./demo-snapshot";
import { parseDashboardSnapshot } from "./dashboard-snapshot-schema";
import type { DashboardSnapshot, DashboardSnapshotAdapter } from "../types/dashboard";

const ADMIN_DASHBOARD_ENDPOINT = "/api/admin/dashboard";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export interface DashboardSnapshotResponse {
  ok: boolean;
  status?: number;
  statusText?: string;
  json: () => Promise<unknown>;
}

export type DashboardSnapshotFetcher = (
  input: string,
  init: RequestInit,
) => Promise<DashboardSnapshotResponse>;

interface HttpDashboardSnapshotAdapterOptions {
  initialSnapshot?: DashboardSnapshot;
  fetchSnapshot?: DashboardSnapshotFetcher;
  timeoutMs?: number;
}

export function createHttpDashboardSnapshotAdapter({
  initialSnapshot = demoSnapshot,
  fetchSnapshot = fetch,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}: HttpDashboardSnapshotAdapterOptions): DashboardSnapshotAdapter {
  let inFlightRequest: Promise<DashboardSnapshot> | undefined;

  const requestSnapshot = async () => {
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Admin dashboard request timed out after ${timeoutMs}ms`));
        controller.abort();
      }, timeoutMs);
    });

    try {
      const response = await Promise.race([
        fetchSnapshot(ADMIN_DASHBOARD_ENDPOINT, {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        }),
        timeout,
      ]);
      if (!response.ok) {
        throw new Error(
          `Admin dashboard request failed: ${response.status ?? 0} ${response.statusText ?? "Unknown Error"}`,
        );
      }
      return parseDashboardSnapshot(await response.json());
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  };

  return {
    mode: "http",
    capabilities: {
      canAcknowledgeIncidents: false,
    },
    initialSnapshot,
    loadSnapshot() {
      if (inFlightRequest !== undefined) return inFlightRequest;
      inFlightRequest = requestSnapshot().finally(() => {
        inFlightRequest = undefined;
      });
      return inFlightRequest;
    },
  };
}
