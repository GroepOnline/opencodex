export function ProgressTrack({
  value,
  max = 100,
  label,
  className = "dash-bar-track",
  fillClassName = "dash-bar-fill",
}: {
  value: number;
  max?: number;
  label?: string;
  className?: string;
  fillClassName?: string;
}) {
  const safeMax = Number.isFinite(max) && max > 0 ? max : 100;
  const safeValue = Number.isFinite(value) ? Math.min(safeMax, Math.max(0, value)) : 0;
  const percentage = (safeValue / safeMax) * 100;

  return (
    <span
      className={className}
      {...(label
        ? {
            role: "progressbar",
            "aria-label": label,
            "aria-valuemin": 0,
            "aria-valuemax": safeMax,
            "aria-valuenow": safeValue,
          }
        : { "aria-hidden": true })}
    >
      <span className={fillClassName} style={{ width: `${percentage}%` }} />
    </span>
  );
}
