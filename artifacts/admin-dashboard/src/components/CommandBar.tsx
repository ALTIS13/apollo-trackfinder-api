import { CircleDot, RefreshCw } from "lucide-react";
import type { DashboardConnectionState } from "../types/dashboard";

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

interface CommandBarProps {
  connectionState: DashboardConnectionState;
  lastUpdatedAt?: string;
  isAutoRefreshEnabled: boolean;
  onAutoRefreshChange: (enabled: boolean) => void;
  onRefresh: () => Promise<void>;
}

export function CommandBar({
  connectionState,
  lastUpdatedAt,
  isAutoRefreshEnabled,
  onAutoRefreshChange,
  onRefresh,
}: CommandBarProps) {
  const isRefreshing = connectionState === "refreshing";

  return (
    <header className="command-bar">
      <div className="command-context">
        <span className="environment-label">
          <CircleDot aria-hidden="true" />
          Продакшн
        </span>
        <span className="command-title">Операционный контур</span>
      </div>
      <div className="command-actions">
        <span
          className="connection-status"
          data-state={connectionState}
          role="status"
          aria-live="polite"
          data-testid="dashboard-connection-status"
        >
          {connectionLabels[connectionState]}
        </span>
        <span className="updated-at">
          Обновлено:
          {lastUpdatedAt === undefined ? (
            " нет данных"
          ) : (
            <time dateTime={lastUpdatedAt}>
              {updatedAtFormatter.format(new Date(lastUpdatedAt))}
            </time>
          )}
        </span>
        <label className="auto-refresh-control">
          <input
            aria-label="Автообновление"
            type="checkbox"
            checked={isAutoRefreshEnabled}
            onChange={(event) => onAutoRefreshChange(event.currentTarget.checked)}
          />
          <span className="toggle-track" aria-hidden="true"><span /></span>
          <span>Авто: 15 с</span>
        </label>
        <button
          className="refresh-button"
          type="button"
          aria-label={isRefreshing ? "Обновление" : "Обновить"}
          disabled={isRefreshing}
          onClick={() => void onRefresh()}
        >
          <RefreshCw aria-hidden="true" />
          <span>{isRefreshing ? "Обновление" : "Обновить"}</span>
        </button>
      </div>
    </header>
  );
}
