import { LayoutGroup, m, useReducedMotion } from "motion/react";
import {
  createContext,
  useContext,
  useId,
  useState,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type KeyboardEventHandler,
  type ReactNode,
  type Ref,
} from "react";

/** Shared between a tablist and its tabs so the selection indicator can travel. */
const PageTabsContext = createContext<{
  layoutId: string;
  instant: boolean;
  markKeyboard: (instant: boolean) => void;
} | null>(null);

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
  const groupId = useId();
  const reduceMotion = useReducedMotion();
  const [keyboardNavigation, setKeyboardNavigation] = useState(false);
  return (
    <div className={className} role="tablist" aria-label={label} style={style}>
      <LayoutGroup id={groupId}>
        <PageTabsContext.Provider
          value={{
            layoutId: "page-tab-selection",
            instant: Boolean(reduceMotion) || keyboardNavigation,
            markKeyboard: setKeyboardNavigation,
          }}
        >
          {children}
        </PageTabsContext.Provider>
      </LayoutGroup>
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

/** Travelling underline. Rendered only inside the selected tab of a PageTabs strip. */
export function PageTabIndicator({
  className = "page-tab-indicator",
}: {
  className?: string;
}) {
  const ctx = useContext(PageTabsContext);
  if (!ctx) return null;
  return (
    <m.span
      className={className}
      layoutId={ctx.layoutId}
      transition={
        ctx.instant
          ? { duration: 0 }
          : { type: "spring", visualDuration: 0.22, bounce: 0.1 }
      }
      aria-hidden
    />
  );
}

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
  const ctx = useContext(PageTabsContext);
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
      onClick={(event) => {
        ctx?.markKeyboard(event.detail === 0);
        onClick();
      }}
      onKeyDown={onKeyDown ?? navigateTabs}
    >
      {selected ? <PageTabIndicator /> : null}
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
