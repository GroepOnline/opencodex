import type { ReactNode, Ref } from "react";

/** Sticky detail pane. Page CSS class contracts stay on the call site. */
export function Inspector({
  id,
  label,
  populated = false,
  className = "inspector",
  children,
}: {
  id?: string;
  label: string;
  populated?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <aside
      id={id}
      className={populated ? `${className} is-populated` : className}
      aria-label={label}
    >
      {children}
    </aside>
  );
}

export function InspectorHeading({
  kicker,
  title,
  badge,
  headingRef,
  className = "inspector-heading",
  kickerClassName = "inspector-kicker",
}: {
  kicker?: ReactNode;
  title: ReactNode;
  badge?: ReactNode;
  headingRef?: Ref<HTMLHeadingElement>;
  className?: string;
  kickerClassName?: string;
}) {
  return (
    <div className={className}>
      {kicker ? <span className={kickerClassName}>{kicker}</span> : null}
      <h3 ref={headingRef} tabIndex={-1}>
        {title}
      </h3>
      {badge}
    </div>
  );
}

export function InspectorActions({
  className = "inspector-actions",
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={className}>{children}</div>;
}
