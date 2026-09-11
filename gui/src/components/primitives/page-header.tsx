import type { ReactNode } from "react";

export function PageHeader({
  title,
  titleId,
  description,
  descriptionClassName,
  actions,
  actionsClassName = "page-head-actions",
  className,
}: {
  title: ReactNode;
  titleId?: string;
  description?: ReactNode;
  descriptionClassName?: string;
  actions?: ReactNode;
  actionsClassName?: string;
  className?: string;
}) {
  return (
    <div className={className ? `page-head ${className}` : "page-head"}>
      <div>
        <h2 id={titleId}>{title}</h2>
        {description ? (
          <p className={descriptionClassName}>{description}</p>
        ) : null}
      </div>
      {actions ? <div className={actionsClassName}>{actions}</div> : null}
    </div>
  );
}
