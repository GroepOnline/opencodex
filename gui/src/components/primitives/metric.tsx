import type { ReactNode } from "react";

export function Metric({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="metric-reading">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export function MetricGroup({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <dl className="metric-list" aria-label={label}>
      {children}
    </dl>
  );
}
