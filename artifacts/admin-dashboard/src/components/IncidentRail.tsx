import type { Incident, IncidentFilter } from "../types/dashboard";

const severityLabels = {
  critical: "Критический",
  warning: "Предупреждение",
  info: "Информация",
} as const;
const incidentTimeFormatter = new Intl.DateTimeFormat("ru-RU", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Moscow",
});

interface IncidentRailProps {
  incidents: Incident[];
  filter: IncidentFilter;
  onFilterChange: (filter: IncidentFilter) => void;
  onAcknowledge: (incidentId: string) => void;
  onFocusService: (serviceId: string) => void;
}

export function IncidentRail({
  incidents,
  filter,
  onFilterChange,
  onAcknowledge,
  onFocusService,
}: IncidentRailProps) {
  return (
    <aside className="incident-rail" aria-label="Инциденты">
      <header>
        <h2>Инциденты</h2>
        <div className="incident-filters" aria-label="Фильтр инцидентов">
          <button
            type="button"
            aria-pressed={filter === "all"}
            onClick={() => onFilterChange("all")}
          >
            Все
          </button>
          <button
            type="button"
            aria-pressed={filter === "open"}
            onClick={() => onFilterChange("open")}
          >
            Открытые
          </button>
        </div>
      </header>
      {incidents.length === 0 ? <p>Инцидентов нет</p> : null}
      <div className="incident-list">
        {incidents.map((incident) => (
          <article
            className="incident-row"
            data-severity={incident.severity}
            key={incident.id}
          >
            <span>{severityLabels[incident.severity]}</span>
            <button
              type="button"
              className="incident-title"
              onClick={() => onFocusService(incident.serviceId)}
              aria-label={`Показать сервис: ${incident.title}`}
            >
              {incident.title}
            </button>
            <time dateTime={incident.createdAt}>
              {incidentTimeFormatter.format(new Date(incident.createdAt))}
            </time>
            {incident.status === "open" ? (
              <button
                type="button"
                onClick={() => onAcknowledge(incident.id)}
                aria-label={`Подтвердить инцидент ${incident.title}`}
              >
                Подтвердить
              </button>
            ) : (
              <span>
                {incident.status === "acknowledged"
                  ? "Подтверждено"
                  : "Закрыто"}
              </span>
            )}
          </article>
        ))}
      </div>
    </aside>
  );
}
