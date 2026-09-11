import type {
  ComponentPropsWithoutRef,
  CSSProperties,
  KeyboardEventHandler,
  ReactNode,
  Ref,
} from "react";

/** Tab strip. Call sites keep their existing class contracts. */
export function PageTabs({
  label,
  className = "page-tabs",
  style,
  children,
}: {
  label: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <div className={className} role="tablist" aria-label={label} style={style}>
      {children}
    </div>
  );
}

/** Default roving focus for tab strips without a page-owned navigation guard. */
const navigateTabs: KeyboardEventHandler<HTMLButtonElement> = (event) => {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
  if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;

  const tablist = event.currentTarget.closest('[role="tablist"]');
  if (!tablist) return;
  const tabs = Array.from(tablist.querySelectorAll<HTMLButtonElement>('button[role="tab"]:not(:disabled)'))
    .filter(tab => tab.closest('[role="tablist"]') === tablist && !tab.hidden);
  const current = tabs.indexOf(event.currentTarget);
  if (current < 0 || tabs.length === 0) return;
  const index = event.key === "Home" ? 0
    : event.key === "End" ? tabs.length - 1
      : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  event.preventDefault();
  tabs[index]?.focus();
  tabs[index]?.click();
};

export function PageTab({
  id,
  controls,
  selected,
  className,
  onClick,
  onKeyDown,
  ref,
  children,
}: {
  id: string;
  controls: string;
  selected: boolean;
  className?: string;
  onClick: () => void;
  onKeyDown?: KeyboardEventHandler<HTMLButtonElement>;
  ref?: Ref<HTMLButtonElement>;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      id={id}
      ref={ref}
      aria-selected={selected}
      aria-controls={controls}
      tabIndex={selected ? 0 : -1}
      className={className ?? `page-tab${selected ? " page-tab--active" : ""}`}
      onClick={onClick}
      onKeyDown={onKeyDown ?? navigateTabs}
    >
      {children}
    </button>
  );
}

export function PageTabPanel({
  id,
  labelledBy,
  hidden,
  className,
  children,
  ...props
}: {
  id: string;
  labelledBy: string;
  hidden?: boolean;
  className?: string;
  children: ReactNode;
} & Omit<
  ComponentPropsWithoutRef<"div">,
  "id" | "className" | "children" | "hidden"
>) {
  return (
    <div
      {...props}
      role="tabpanel"
      id={id}
      aria-labelledby={labelledBy}
      hidden={hidden}
      className={className}
    >
      {children}
    </div>
  );
}
