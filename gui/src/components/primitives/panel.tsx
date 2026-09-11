import type { ComponentPropsWithoutRef, CSSProperties, ReactNode } from "react";

/** Landmark section for operational reports. Bare section tags stay inside this primitive. */
export function Panel({
  titleId,
  className = "panel",
  style,
  children,
  ...props
}: {
  titleId: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
} & Omit<
  ComponentPropsWithoutRef<"section">,
  "className" | "style" | "children"
>) {
  return (
    <section
      className={className}
      style={style}
      {...props}
      aria-labelledby={titleId}
    >
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
