import type { ReactNode } from "react";

export function PageHeader({
  title,
  titleId,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  titleId?: string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={className ? `page-head ${className}` : "page-head"}>
      <div>
        <h2 id={titleId}>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="page-head-actions">{actions}</div> : null}
    </div>
  );
}
