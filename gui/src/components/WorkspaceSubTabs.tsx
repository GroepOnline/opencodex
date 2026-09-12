import { LayoutGroup, m, useReducedMotion } from "motion/react";
import { useId, useState } from "react";
import type { TKey } from "../i18n/shared";
import { useT } from "../i18n/shared";

export interface WorkspaceSubTab {
  sub: string | null;
  tkey: TKey;
}

/** Second-level navigation under the topbar: a segmented rail whose selection
 *  pill travels between destinations with a shared-layout spring. Pointer
 *  navigation animates; keyboard and reduced motion switch instantly. */
export default function WorkspaceSubTabs({
  tabs,
  active,
  label,
  onNavigate,
}: {
  tabs: readonly WorkspaceSubTab[];
  active: string | null;
  label: string;
  onNavigate: (sub: string | null) => void;
}) {
  const t = useT();
  const reduceMotion = useReducedMotion();
  const groupId = useId();
  const [keyboardNavigation, setKeyboardNavigation] = useState(false);
  return (
    <nav className="sub-tabs" aria-label={label}>
      <LayoutGroup id={groupId}>
        {tabs.map(({ sub, tkey }) => {
          const selected = active === sub;
          return (
            <button
              key={sub ?? "home"}
              type="button"
              className={`sub-tab${selected ? " active" : ""}`}
              onClick={(event) => {
                setKeyboardNavigation(event.detail === 0);
                onNavigate(sub);
              }}
              aria-current={selected ? "page" : undefined}
            >
              {selected && (
                <m.span
                  className="sub-tab-indicator"
                  layoutId="sub-tab-selection"
                  transition={
                    reduceMotion || keyboardNavigation
                      ? { duration: 0 }
                      : { type: "spring", visualDuration: 0.22, bounce: 0.12 }
                  }
                  aria-hidden
                />
              )}
              <span>{t(tkey)}</span>
            </button>
          );
        })}
      </LayoutGroup>
    </nav>
  );
}
