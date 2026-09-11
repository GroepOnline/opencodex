import type { ReactNode } from "react";

/** Exclusive choice row. Call sites keep their existing button class contracts. */
export function SegmentedControl({
  label,
  className = "usage-segmented",
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

export function SegmentedOption({
  pressed,
  label,
  className,
  onClick,
  children,
}: {
  pressed: boolean;
  label: string;
  className?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
