import { demoDashboardAdapter } from "./demo-snapshot";
import {
  createHttpDashboardSnapshotAdapter,
  type DashboardSnapshotFetcher,
} from "./http-snapshot-adapter";
import type { DashboardSnapshotAdapter } from "../types/dashboard";

export function createDashboardAdapterForEnvironment(
  apiBaseUrl: string | undefined,
  fetchSnapshot?: DashboardSnapshotFetcher,
): DashboardSnapshotAdapter {
  if (apiBaseUrl?.trim().length)
    return createHttpDashboardSnapshotAdapter({
      baseUrl: apiBaseUrl,
      fetchSnapshot,
    });
  return demoDashboardAdapter;
}
