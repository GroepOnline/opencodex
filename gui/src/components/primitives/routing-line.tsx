import type { ReactNode } from "react";

/** Supplied identity and context beside its evidence. This is a reading, not a
 * routing graph: callers must not infer accounts, hops or runtime health. */
export function RoutingLine({
  identity,
  context,
  evidence,
}: {
  identity?: ReactNode;
  context: ReactNode;
  evidence: ReactNode;
}) {
  return (
    <div className="routing-line">
      {identity ? <div className="routing-line-identity">{identity}</div> : null}
      <div className="routing-line-context">
        <span>{context}</span>
        <span className="routing-line-rule" aria-hidden />
        <span className="routing-line-evidence">{evidence}</span>
      </div>
    </div>
  );
}
