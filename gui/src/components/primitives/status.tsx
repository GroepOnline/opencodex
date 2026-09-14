import type { ReactNode } from "react";

type StatusTone = "neutral" | "success" | "warning" | "error";

export function Status({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: StatusTone;
}) {
  return (
    <span className="status" data-tone={tone}>
      {children}
    </span>
  );
}

export function StatusDot({ tone = "neutral" }: { tone?: StatusTone }) {
  return <span className="status-dot" data-tone={tone} aria-hidden="true" />;
}
