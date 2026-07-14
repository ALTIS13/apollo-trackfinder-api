import { RefreshCw } from "lucide-react";
import { IncidentRail } from "./components/IncidentRail";
import { SummaryStrip } from "./components/SummaryStrip";
import { TopologyPanel } from "./components/TopologyPanel";
import { useDashboardState } from "./hooks/use-dashboard-state";

export default function App() {
  const dashboard = useDashboardState();

  return (
    <div className="dashboard-shell">
      <header className="dashboard-header">
        <h1>Apollo TF</h1>
        <label>
          <input
            type="checkbox"
            checked={dashboard.isAutoRefreshEnabled}
            onChange={(event) =>
              dashboard.setAutoRefreshEnabled(event.currentTarget.checked)
            }
          />
          Автообновление
        </label>
        <button type="button" onClick={dashboard.refresh}>
          <RefreshCw aria-hidden="true" />
          Обновить
        </button>
      </header>
      <main>
        <SummaryStrip metrics={dashboard.snapshot.metrics} />
        <div className="dashboard-content">
          <TopologyPanel
            snapshot={dashboard.snapshot}
            selectedServiceId={dashboard.selectedServiceId}
            neighborhood={dashboard.neighborhood}
            onSelectService={dashboard.selectService}
          />
          <IncidentRail
            incidents={dashboard.incidents}
            filter={dashboard.incidentFilter}
            onFilterChange={dashboard.setIncidentFilter}
            onAcknowledge={dashboard.acknowledgeIncident}
            onFocusService={dashboard.selectService}
          />
        </div>
      </main>
    </div>
  );
}
