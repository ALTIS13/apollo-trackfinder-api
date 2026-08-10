import { Activity, Boxes, Siren, TriangleAlert, Users } from "lucide-react";
import type { DashboardMetric } from "../types/dashboard";

interface SummaryStripProps {
  metrics: DashboardMetric[];
}

const metricIcons = {
  "active-modules": Boxes,
  "active-users": Users,
  "parser-warnings": TriangleAlert,
  "open-incidents": Siren,
} as const;

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
    <section className="summary-strip" id="summary" aria-label="Сводка">
      {metrics.map((metric) => {
        const Icon =
          metricIcons[metric.id as keyof typeof metricIcons] ?? Activity;
        return (
          <article
            className="summary-metric"
            data-metric={metric.id}
            key={metric.id}
          >
            <span className="metric-icon" aria-hidden="true">
              <Icon />
            </span>
            <span className="metric-label">{metric.label}</span>
            <strong>{metric.value}</strong>
            <span className="metric-change">{metric.change}</span>
            <MetricTrend values={metric.trend} />
          </article>
        );
      })}
    </section>
  );
}
