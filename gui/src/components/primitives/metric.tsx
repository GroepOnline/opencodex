import type { ReactNode } from "react";

export function Metric({
  label,
  value,
  className = "metric-reading",
}: {
  label: ReactNode;
  value: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export function MetricGroup({
  label,
  children,
  className = "metric-list",
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <dl className={className} aria-label={label}>
      {children}
    </dl>
  );
}
