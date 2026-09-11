import type { ReactNode } from "react";

export function PageHeader({
  title,
  titleId,
  titleClassName,
  description,
  descriptionClassName,
  actions,
  actionsClassName = "page-head-actions",
  className,
}: {
  title: ReactNode;
  titleId?: string;
  titleClassName?: string;
  description?: ReactNode;
  descriptionClassName?: string;
  actions?: ReactNode;
  actionsClassName?: string;
  className?: string;
}) {
  return (
    <div className={className ? `page-head ${className}` : "page-head"}>
      <div>
        <h2 id={titleId} className={titleClassName}>
          {title}
        </h2>
        {description ? (
          <p className={descriptionClassName}>{description}</p>
        ) : null}
      </div>
      {actions ? <div className={actionsClassName}>{actions}</div> : null}
    </div>
  );
}

/** Subtitle that sits under page chrome, not inside `.page-head`. */
export function PageSubtitle({
  children,
  className = "page-sub",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <p className={className}>{children}</p>;
}
