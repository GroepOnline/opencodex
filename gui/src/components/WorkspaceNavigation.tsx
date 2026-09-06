import { LayoutGroup, m, useReducedMotion } from "motion/react";
import { useId, useState, type ComponentType } from "react";
import type { View } from "../app-routing";
import { useT, type TKey } from "../i18n/shared";

export interface WorkspaceDestination {
  view: View;
  tkey: TKey;
  icon: ComponentType<{ size?: 13 | 15 | 18 | 24; "aria-hidden"?: boolean }>;
}

export default function WorkspaceNavigation({
  destinations,
  active,
  onNavigate,
}: {
  destinations: readonly WorkspaceDestination[];
  active: View;
  onNavigate: (view: View) => void;
}) {
  const t = useT();
  const reduceMotion = useReducedMotion();
  const groupId = useId();
  const [keyboardNavigation, setKeyboardNavigation] = useState(false);
  return (
    <nav className="workspace-navigation view-tabs" aria-label={t("nav.views")}>
      <LayoutGroup id={groupId}>
        {destinations.map(({ view, tkey, icon: Icon }) => (
          <button
            key={view}
            type="button"
            className={`workspace-destination view-tab${active === view ? " active" : ""}`}
            aria-current={active === view ? "page" : undefined}
            onClick={(event) => {
              setKeyboardNavigation(event.detail === 0);
              onNavigate(view);
            }}
          >
            {active === view && (
              <m.span
                className="workspace-selection"
                layoutId="selection"
                transition={
                  reduceMotion || keyboardNavigation
                    ? { duration: 0 }
                    : { type: "spring", visualDuration: 0.18, bounce: 0 }
                }
                aria-hidden
              />
            )}
            <Icon size={18} aria-hidden />
            <span>{t(tkey)}</span>
          </button>
        ))}
      </LayoutGroup>
    </nav>
  );
}
