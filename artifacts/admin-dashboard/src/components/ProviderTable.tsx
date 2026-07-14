import { RadioTower } from "lucide-react";
import type { HealthStatus, ProviderHealth } from "../types/dashboard";

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

interface ProviderTableProps {
  providers: ProviderHealth[];
}

function getTrendLabel(values: number[]): string {
  if (values.length < 2 || values.every((value) => value === 0)) return "нет данных";
  const difference = values.at(-1)! - values[0];
  if (Math.abs(difference) < 20) return "стабильно";
  return difference > 0 ? "растет" : "снижается";
}

function ProviderTrend({ provider }: { provider: ProviderHealth }) {
  const maximum = Math.max(...provider.latencyTrendMs, 1);
  const trendLabel = getTrendLabel(provider.latencyTrendMs);

  return (
    <span className="provider-trend">
      <span className="provider-trend-label">Тренд: {trendLabel}</span>
      <span className="provider-trend-bars" aria-hidden="true">
        {provider.latencyTrendMs.map((value, index) => (
          <span key={index} style={{ height: `${Math.max((value / maximum) * 100, 8)}%` }} />
        ))}
      </span>
    </span>
  );
}

export function ProviderTable({ providers }: ProviderTableProps) {
  return (
    <section className="data-panel providers-panel" id="providers" aria-labelledby="providers-title">
      <div className="data-panel-header">
        <span className="panel-title-icon info" aria-hidden="true"><RadioTower /></span>
        <div>
          <h2 id="providers-title">Провайдеры</h2>
          <p>Здоровье внешних источников</p>
        </div>
      </div>
      <div className="table-scroll">
        <table aria-label="Состояние провайдеров">
          <thead>
            <tr>
              <th scope="col">Провайдер</th>
              <th scope="col">Статус</th>
              <th scope="col">Задержка</th>
              <th scope="col">Динамика</th>
              <th scope="col">Проверка</th>
            </tr>
          </thead>
          <tbody>
            {providers.map((provider) => (
              <tr key={provider.id}>
                <th scope="row"><strong>{provider.name}</strong></th>
                <td>
                  <span className="status-cell" data-status={provider.status}>
                    {healthLabels[provider.status]}
                  </span>
                </td>
                <td>{provider.latencyMs > 0 ? `${provider.latencyMs} мс` : "Нет данных"}</td>
                <td><ProviderTrend provider={provider} /></td>
                <td>
                  <span className="checked-at">
                    Проверено
                    <time dateTime={provider.lastCheckedAt}>
                      {checkedAtFormatter.format(new Date(provider.lastCheckedAt))}
                    </time>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
