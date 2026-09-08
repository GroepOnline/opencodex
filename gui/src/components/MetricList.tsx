import type { ReactNode } from "react";

interface Metric {
  label: string;
  value: ReactNode;
}

/** Related readings share one definition list, not a collection of action cards. */
export default function MetricList({
  label,
  metrics,
}: {
  label: string;
  metrics: readonly Metric[];
}) {
  return (
    <dl className="metric-list" aria-label={label}>
      {metrics.map((metric) => (
        <div className="metric-reading" key={metric.label}>
          <dt>{metric.label}</dt>
          <dd>{metric.value}</dd>
        </div>
      ))}
    </dl>
  );
}
