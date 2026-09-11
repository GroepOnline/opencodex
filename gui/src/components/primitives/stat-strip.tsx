import type { ReactNode } from "react";

/** Horizontal KPI strip. Preserves existing `.stat-strip` class contracts. */
export function StatStrip({
  label,
  className = "stat-strip",
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className} role="group" aria-label={label}>
      {children}
    </div>
  );
}

export function StatStripItem({
  label,
  value,
}: {
  label: ReactNode;
  value: ReactNode;
}) {
  return (
    <div className="stat-strip-item">
      <span className="stat-strip-waarde">{value}</span>
      <span className="stat-strip-label">{label}</span>
    </div>
  );
}
