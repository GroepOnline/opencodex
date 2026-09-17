import type { ReactNode } from "react";
import { Metric, MetricGroup } from "./primitives/metric";

interface MetricItem {
  label: string;
  value: ReactNode;
}

/** Related readings share one definition list, not a collection of action cards. */
export default function MetricList({
  label,
  metrics,
}: {
  label: string;
  metrics: readonly MetricItem[];
}) {
  return (
    <MetricGroup label={label}>
      {metrics.map((metric) => (
        <Metric key={metric.label} label={metric.label} value={metric.value} />
      ))}
    </MetricGroup>
  );
}
