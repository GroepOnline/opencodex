import type { ReactNode } from "react";

/** Numeric reading in a card grid. Preserves existing `.stat` class contracts. */
export function Stat({
  label,
  value,
  hint,
  title,
  valueClassName = "stat-value",
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  title?: string;
  valueClassName?: string;
}) {
  return (
    <div className="stat" title={title}>
      <div className="muted">{label}</div>
      <div className={valueClassName}>{value}</div>
      {hint}
    </div>
  );
}

export function StatGroup({
  label,
  className = "usage-cards",
  children,
}: {
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className} role="group" aria-label={label}>
      {children}
    </div>
  );
}
