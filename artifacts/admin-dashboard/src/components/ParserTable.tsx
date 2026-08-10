import { ScanSearch } from "lucide-react";
import type { HealthStatus, ParserHealth } from "../types/dashboard";

const healthLabels: Record<HealthStatus, string> = {
  healthy: "Работает",
  warning: "Предупреждение",
  degraded: "Деградация",
  unknown: "Нет данных",
};
const checkedAtFormatter = new Intl.DateTimeFormat("ru-RU", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZone: "Europe/Moscow",
});

interface ParserTableProps {
  parsers: ParserHealth[];
}

export function ParserTable({ parsers }: ParserTableProps) {
  return (
    <section
      className="data-panel parsers-panel"
      id="parsers"
      aria-labelledby="parsers-title"
    >
      <div className="data-panel-header">
        <span className="panel-title-icon parser" aria-hidden="true">
          <ScanSearch />
        </span>
        <div>
          <h2 id="parsers-title">Парсеры</h2>
          <p>Качество поисковых адаптеров и отсев обрезанных треков</p>
        </div>
      </div>
      <div className="table-scroll">
        <table aria-label="Состояние поисковых парсеров">
          <thead>
            <tr>
              <th scope="col">Парсер</th>
              <th scope="col">Версия</th>
              <th scope="col">Статус</th>
              <th scope="col">Запросы/мин</th>
              <th scope="col">Ошибки/мин</th>
              <th scope="col">Демо отклонено/мин</th>
              <th scope="col">Проверка</th>
            </tr>
          </thead>
          <tbody>
            {parsers.map((parser) => (
              <tr key={parser.id}>
                <th scope="row">
                  <span className="table-service">
                    <ScanSearch aria-hidden="true" />
                    <span>
                      <strong>{parser.name}</strong>
                      <small>{parser.id}</small>
                    </span>
                  </span>
                </th>
                <td><code>{parser.version}</code></td>
                <td>
                  <span className="status-cell" data-status={parser.status}>
                    {healthLabels[parser.status]}
                  </span>
                </td>
                <td className="parser-count">{parser.requestsPerMinute}</td>
                <td
                  className="parser-count"
                  data-alert={parser.failuresPerMinute > 0 || undefined}
                >
                  {parser.failuresPerMinute}
                </td>
                <td
                  className="parser-count"
                  data-alert={parser.previewsRejectedPerMinute > 0 || undefined}
                >
                  {parser.previewsRejectedPerMinute}
                </td>
                <td>
                  {parser.lastCheckedAt === undefined ? (
                    <span className="table-empty-value">Не проверялся</span>
                  ) : (
                    <span className="checked-at">
                      Проверено
                      <time dateTime={parser.lastCheckedAt}>
                        {checkedAtFormatter.format(new Date(parser.lastCheckedAt))}
                      </time>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
