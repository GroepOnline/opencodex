import type { ReactNode } from "react";

export function SectionHeader({
  title,
  meta,
}: {
  title: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <div className="section-header">
      <h3 className="pws-dashboard-section-title">{title}</h3>
      {meta ? <span className="section-header-meta">{meta}</span> : null}
    </div>
  );
}
