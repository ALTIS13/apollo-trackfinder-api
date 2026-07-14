import { RefreshCw } from "lucide-react";
import { IncidentRail } from "./components/IncidentRail";
import { SummaryStrip } from "./components/SummaryStrip";
import { TopologyPanel } from "./components/TopologyPanel";
import { demoDashboardAdapter } from "./data/demo-snapshot";
import { useDashboardState } from "./hooks/use-dashboard-state";
import type {
  DashboardConnectionState,
  DashboardSnapshotAdapter,
} from "./types/dashboard";

const connectionLabels: Record<DashboardConnectionState, string> = {
  live: "Актуально",
  stale: "Данные устарели",
  offline: "Нет связи",
  refreshing: "Обновление",
};
const updatedAtFormatter = new Intl.DateTimeFormat("ru-RU", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Moscow",
});

interface AppProps {
  adapter?: DashboardSnapshotAdapter;
}

export default function App({ adapter = demoDashboardAdapter }: AppProps) {
  const dashboard = useDashboardState(adapter);
  const isRefreshing = dashboard.connectionState === "refreshing";

  return (
    <div className="dashboard-shell">
      <header className="dashboard-header">
        <h1>Apollo TF</h1>
        <span
          role="status"
          aria-live="polite"
          data-testid="dashboard-connection-status"
        >
          {connectionLabels[dashboard.connectionState]}
        </span>
        <span>
          Обновлено:{" "}
          {dashboard.lastUpdatedAt === undefined ? (
            "нет данных"
          ) : (
            <time dateTime={dashboard.lastUpdatedAt}>
              {updatedAtFormatter.format(new Date(dashboard.lastUpdatedAt))}
            </time>
          )}
        </span>
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
        <button
          type="button"
          aria-label={isRefreshing ? "Обновление" : "Обновить"}
          disabled={isRefreshing}
          onClick={() => void dashboard.refresh()}
        >
          <RefreshCw aria-hidden="true" />
          {isRefreshing ? "Обновление" : "Обновить"}
        </button>
      </header>
      <main>
        {dashboard.snapshot === undefined ? (
          <p>Нет сохраненного снимка</p>
        ) : (
          <>
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
          </>
        )}
      </main>
    </div>
  );
}
