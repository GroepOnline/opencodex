import type { ComponentPropsWithoutRef, ReactNode } from "react";

/** Stack of collapsible operational groups. Preserves `.ocx-group-stack`. */
export function CollapsibleGroupStack({
  label,
  className = "ocx-group-stack",
  children,
}: {
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className} aria-label={label}>
      {children}
    </div>
  );
}

/** One collapsible group. Bare section tags stay inside this primitive. */
export function CollapsibleGroup({
  collapsed,
  labelledBy,
  className,
  children,
  ...props
}: {
  collapsed: boolean;
  labelledBy: string;
  children: ReactNode;
} & Omit<ComponentPropsWithoutRef<"section">, "children">) {
  return (
    <section
      className={["ocx-group", collapsed ? "collapsed" : "", className]
        .filter(Boolean)
        .join(" ")}
      aria-labelledby={labelledBy}
      {...props}
    >
      {children}
    </section>
  );
}

export function CollapsibleGroupHead({
  collapsed,
  children,
}: {
  collapsed: boolean;
  children: ReactNode;
}) {
  return (
    <header className={`ocx-group-head${collapsed ? "" : " open"}`}>
      {children}
    </header>
  );
}

export function CollapsibleGroupToggle({
  titleId,
  controls,
  expanded,
  onClick,
  children,
}: {
  titleId: string;
  controls: string;
  expanded: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <h3 id={titleId} className="ocx-group-heading">
      <button
        type="button"
        className="ocx-group-toggle"
        aria-expanded={expanded}
        aria-controls={controls}
        onClick={onClick}
      >
        {children}
      </button>
    </h3>
  );
}

export function CollapsibleGroupName({ children }: { children: ReactNode }) {
  return <span className="ocx-group-name">{children}</span>;
}

export function CollapsibleGroupCount({ children }: { children: ReactNode }) {
  return <span className="ocx-group-count">{children}</span>;
}
