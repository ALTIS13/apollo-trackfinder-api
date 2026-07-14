import { AdminSidebar } from "./components/AdminSidebar";
import { CommandBar } from "./components/CommandBar";
import { DeploymentsTable } from "./components/DeploymentsTable";
import { IncidentRail } from "./components/IncidentRail";
import { ProviderTable } from "./components/ProviderTable";
import { SummaryStrip } from "./components/SummaryStrip";
import { TopologyPanel } from "./components/TopologyPanel";
import { demoDashboardAdapter } from "./data/demo-snapshot";
import { useDashboardState } from "./hooks/use-dashboard-state";
import { getOpenIncidentCount } from "./lib/dashboard-model";
import type { DashboardSnapshotAdapter } from "./types/dashboard";

interface AppProps {
  adapter?: DashboardSnapshotAdapter;
}

export default function App({ adapter = demoDashboardAdapter }: AppProps) {
  const dashboard = useDashboardState(adapter);
  const openIncidentCount =
    dashboard.snapshot === undefined ? 0 : getOpenIncidentCount(dashboard.snapshot);

  return (
    <div className="admin-shell">
      <AdminSidebar openIncidentCount={openIncidentCount} />
      <div className="dashboard-frame">
        <CommandBar
          connectionState={dashboard.connectionState}
          lastUpdatedAt={dashboard.lastUpdatedAt}
          isAutoRefreshEnabled={dashboard.isAutoRefreshEnabled}
          onAutoRefreshChange={dashboard.setAutoRefreshEnabled}
          onRefresh={dashboard.refresh}
        />
        <main className="dashboard-main">
          {dashboard.snapshot === undefined ? (
            <section className="empty-state" aria-live="polite">Нет сохраненного снимка</section>
          ) : (
            <>
              <SummaryStrip metrics={dashboard.snapshot.metrics} />
              <div className="operational-layout">
              <TopologyPanel
                snapshot={dashboard.snapshot}
                selectedServiceId={dashboard.selectedServiceId}
                neighborhood={dashboard.neighborhood}
                onSelectService={dashboard.selectService}
              />
              <IncidentRail
                incidents={dashboard.incidents}
                filter={dashboard.incidentFilter}
                canAcknowledge={dashboard.canAcknowledgeIncidents}
                onFilterChange={dashboard.setIncidentFilter}
                onAcknowledge={dashboard.acknowledgeIncident}
                onFocusService={dashboard.selectService}
              />
                <div className="detail-tables">
                  <DeploymentsTable modules={dashboard.snapshot.modules} />
                  <ProviderTable providers={dashboard.snapshot.providers} />
                </div>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
