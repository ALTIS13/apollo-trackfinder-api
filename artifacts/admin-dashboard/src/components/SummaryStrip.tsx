import type { DashboardMetric } from "../types/dashboard";

interface SummaryStripProps {
  metrics: DashboardMetric[];
}

function MetricTrend({ values }: { values: number[] }) {
  const maximum = Math.max(...values, 1);

  return (
    <span className="metric-trend" aria-hidden="true">
      {values.map((value, index) => (
        <span
          key={index}
          style={{ height: `${Math.max((value / maximum) * 100, 8)}%` }}
        />
      ))}
    </span>
  );
}

export function SummaryStrip({ metrics }: SummaryStripProps) {
  return (
    <section className="summary-strip" aria-label="Сводка">
      {metrics.map((metric) => (
        <article className="summary-metric" key={metric.id}>
          <span>{metric.label}</span>
          <strong>{metric.value}</strong>
          <span>{metric.change}</span>
          <MetricTrend values={metric.trend} />
        </article>
      ))}
    </section>
  );
}
