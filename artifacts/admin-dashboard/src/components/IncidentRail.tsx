import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
const severityIcons = {
  critical: CircleAlert,
  warning: TriangleAlert,
  info: Info,
} as const;

interface IncidentRailProps {
  incidents: Incident[];
  filter: IncidentFilter;
  canAcknowledge: boolean;
  onFilterChange: (filter: IncidentFilter) => void;
  onAcknowledge: (incidentId: string) => void;
  onFocusService: (serviceId: string) => void;
}

export function IncidentRail({
  incidents,
  filter,
  canAcknowledge,
  onFilterChange,
  onAcknowledge,
  onFocusService,
}: IncidentRailProps) {
  const [announcement, setAnnouncement] = useState("");
  const feedbackRef = useRef<HTMLParagraphElement>(null);
  const shouldFocusFeedbackRef = useRef(false);

  useEffect(() => {
    if (!shouldFocusFeedbackRef.current) return;
    shouldFocusFeedbackRef.current = false;
    feedbackRef.current?.focus();
  }, [announcement]);

  return (
    <aside className="incident-rail" id="incidents" aria-label="Инциденты">
      <div className="incident-rail-header">
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
      </div>
      {!canAcknowledge ? (
        <p className="incident-readonly-note" role="note">
          Удаленные инциденты доступны только для чтения
        </p>
      ) : null}
      <p
        ref={feedbackRef}
        role="status"
        aria-label="Состояние инцидентов"
        aria-live="polite"
        tabIndex={-1}
      >
        {announcement}
      </p>
      {incidents.length === 0 ? <p>Инцидентов нет</p> : null}
      <div className="incident-list">
        {incidents.map((incident) => {
          const SeverityIcon = severityIcons[incident.severity];
          return (
            <article
              className="incident-row"
              data-severity={incident.severity}
              key={incident.id}
            >
            <span className="incident-severity">
              <SeverityIcon aria-hidden="true" />
              {severityLabels[incident.severity]}
            </span>
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
            <button
              type="button"
              disabled={!canAcknowledge || incident.status !== "open"}
              onClick={() => {
                shouldFocusFeedbackRef.current = filter === "open";
                onAcknowledge(incident.id);
                setAnnouncement(`Инцидент «${incident.title}» подтвержден`);
              }}
              aria-label={
                !canAcknowledge && incident.status === "open"
                  ? `Инцидент ${incident.title}: подтверждение недоступно в режиме только для чтения`
                  : incident.status === "open"
                  ? `Подтвердить инцидент ${incident.title}`
                  : incident.status === "acknowledged"
                    ? `Инцидент ${incident.title} подтвержден`
                    : `Инцидент ${incident.title} закрыт`
              }
            >
              {incident.status !== "open" ? <CircleCheck aria-hidden="true" /> : null}
              {incident.status === "open"
                ? canAcknowledge
                  ? "Подтвердить"
                  : "Только чтение"
                : incident.status === "acknowledged"
                  ? "Подтверждено"
                  : "Закрыто"}
            </button>
          </article>
          );
        })}
      </div>
    </aside>
  );
}
