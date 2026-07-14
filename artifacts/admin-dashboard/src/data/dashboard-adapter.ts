import { demoDashboardAdapter } from "./demo-snapshot";
import {
  createHttpDashboardSnapshotAdapter,
  type DashboardSnapshotFetcher,
} from "./http-snapshot-adapter";
import type { DashboardSnapshotAdapter } from "../types/dashboard";

export function createDashboardAdapterForEnvironment(
  useHttpAdapter: boolean,
  fetchSnapshot?: DashboardSnapshotFetcher,
): DashboardSnapshotAdapter {
  if (useHttpAdapter)
    return createHttpDashboardSnapshotAdapter({ fetchSnapshot });
  return demoDashboardAdapter;
}
