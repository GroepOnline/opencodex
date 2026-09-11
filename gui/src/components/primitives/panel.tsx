import type { CSSProperties, ReactNode } from "react";

/** Landmark section for operational reports. Bare section tags stay inside this primitive. */
export function Panel({
  titleId,
  className = "panel",
  style,
  children,
}: {
  titleId: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <section className={className} aria-labelledby={titleId} style={style}>
      {children}
    </section>
  );
}

export function PanelHeader({
  titleId,
  title,
  actions,
}: {
  titleId: string;
  title: ReactNode;
  actions?: ReactNode;
}) {
  if (!actions) {
    return (
      <h3 id={titleId} className="panel-title">
        {title}
      </h3>
    );
  }

  return (
    <div className="panel-head">
      <h3 id={titleId} className="panel-title">
        {title}
      </h3>
      {actions}
    </div>
  );
}
