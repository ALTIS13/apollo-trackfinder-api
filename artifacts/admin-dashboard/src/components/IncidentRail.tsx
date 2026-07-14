import {
  ChevronDown,
  CircleAlert,
  CircleCheck,
  FileTerminal,
  Info,
  TriangleAlert,
} from "lucide-react";
import { useReducedMotion } from "framer-motion";
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
  selectedIncidentId?: string;
  onFilterChange: (filter: IncidentFilter) => void;
  onAcknowledge: (incidentId: string) => void;
  onFocusService: (serviceId: string) => void;
  onOpenIncident: (incidentId?: string) => void;
}

export function IncidentRail({
  incidents,
  filter,
  canAcknowledge,
  selectedIncidentId,
  onFilterChange,
  onAcknowledge,
  onFocusService,
  onOpenIncident,
}: IncidentRailProps) {
  const [announcement, setAnnouncement] = useState("");
  const reducedMotion = useReducedMotion() ?? false;
  const feedbackRef = useRef<HTMLParagraphElement>(null);
  const selectedRowRef = useRef<HTMLElement>(null);
  const shouldFocusFeedbackRef = useRef(false);

  useEffect(() => {
    if (!shouldFocusFeedbackRef.current) return;
    shouldFocusFeedbackRef.current = false;
    feedbackRef.current?.focus();
  }, [announcement]);

  useEffect(() => {
    if (selectedIncidentId === undefined) return;
    selectedRowRef.current?.scrollIntoView({
      behavior: reducedMotion ? "auto" : "smooth",
      block: "nearest",
    });
  }, [reducedMotion, selectedIncidentId]);

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
          const isExpanded = incident.id === selectedIncidentId;
          const diagnosticId = `incident-diagnostic-${incident.id}`;
          return (
            <article
              className="incident-row"
              data-severity={incident.severity}
              data-selected={isExpanded ? "true" : undefined}
              key={incident.id}
              ref={isExpanded ? selectedRowRef : undefined}
            >
            <span className="incident-severity">
              <SeverityIcon aria-hidden="true" />
              {severityLabels[incident.severity]}
            </span>
            <button
              type="button"
              className="incident-title"
              onClick={() => {
                onFocusService(incident.serviceId);
                if (incident.diagnostic !== undefined)
                  onOpenIncident(incident.id);
              }}
              aria-label={`Показать сервис: ${incident.title}`}
              aria-expanded={
                incident.diagnostic === undefined ? undefined : isExpanded
              }
              aria-controls={
                incident.diagnostic === undefined ? undefined : diagnosticId
              }
            >
              {incident.title}
            </button>
            <time dateTime={incident.createdAt}>
              {incidentTimeFormatter.format(new Date(incident.createdAt))}
            </time>
            <div className="incident-actions">
              {incident.diagnostic === undefined ? null : (
                <button
                  type="button"
                  className="incident-journal-toggle"
                  aria-expanded={isExpanded}
                  aria-controls={diagnosticId}
                  onClick={() =>
                    onOpenIncident(isExpanded ? undefined : incident.id)
                  }
                >
                  <FileTerminal aria-hidden="true" />
                  Журнал
                  <ChevronDown aria-hidden="true" />
                </button>
              )}
              <button
                type="button"
                className="incident-acknowledge"
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
            </div>
            {!isExpanded || incident.diagnostic === undefined ? null : (
              <section
                className="incident-diagnostic"
                id={diagnosticId}
                aria-label={`Журнал инцидента ${incident.title}`}
              >
                <div className="incident-diagnostic-heading">
                  <span>Последняя запись</span>
                  <time dateTime={incident.diagnostic.observedAt}>
                    {incidentTimeFormatter.format(
                      new Date(incident.diagnostic.observedAt),
                    )}
                  </time>
                </div>
                {incident.diagnostic.code === undefined ? null : (
                  <p className="incident-diagnostic-code">
                    <span>Код ошибки</span>
                    <code>{incident.diagnostic.code}</code>
                  </p>
                )}
                <p>{incident.diagnostic.message}</p>
                {incident.diagnostic.logExcerpt === undefined ? null : (
                  <pre>{incident.diagnostic.logExcerpt}</pre>
                )}
              </section>
            )}
          </article>
          );
        })}
      </div>
    </aside>
  );
}
