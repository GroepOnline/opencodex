import type { KeyboardEventHandler, ReactNode } from "react";

/** Underline tab strip. Preserves existing `.page-tabs` / `.page-tab` class contracts. */
export function PageTabs({
  label,
  className = "page-tabs",
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className} role="tablist" aria-label={label}>
      {children}
    </div>
  );
}

export function PageTab({
  id,
  controls,
  selected,
  onClick,
  onKeyDown,
  children,
}: {
  id: string;
  controls: string;
  selected: boolean;
  onClick: () => void;
  onKeyDown?: KeyboardEventHandler<HTMLButtonElement>;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      id={id}
      aria-selected={selected}
      aria-controls={controls}
      tabIndex={selected ? 0 : -1}
      className={`page-tab${selected ? " page-tab--active" : ""}`}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      {children}
    </button>
  );
}

export function PageTabPanel({
  id,
  labelledBy,
  hidden,
  children,
}: {
  id: string;
  labelledBy: string;
  hidden: boolean;
  children: ReactNode;
}) {
  return (
    <div role="tabpanel" id={id} aria-labelledby={labelledBy} hidden={hidden}>
      {children}
    </div>
  );
}
