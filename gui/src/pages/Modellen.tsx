import { useState, type ReactNode } from "react";
import Models from "./Models";
import Combos from "./Combos";
import Subagents from "./Subagents";
import { useT, type TKey } from "../i18n/shared";
import { PageHeader, PageSubtitle } from "../components/primitives/page-header";
import { PageTab, PageTabs } from "../components/primitives/page-tabs";

type Tab = "modellen" | "combos" | "subagents";

const TABS: { id: Tab; labelKey: TKey }[] = [
  { id: "modellen", labelKey: "nav.models" },
  { id: "combos", labelKey: "nav.combos" },
  { id: "subagents", labelKey: "nav.subagents" },
];

const TAB_IDS = new Set<Tab>(["modellen", "combos", "subagents"]);

function ModellenTabPanel({
  tab,
  children,
}: {
  tab: Tab;
  children: ReactNode;
}) {
  return (
    <>
      {TABS.map(({ id }) => (
        <div
          key={id}
          id={`modellen-panel-${id}`}
          role="tabpanel"
          aria-labelledby={`modellen-tab-${id}`}
          hidden={tab !== id}
        >
          {tab === id ? children : null}
        </div>
      ))}
    </>
  );
}

/** Modellen-view: routing/catalogus met combos en sub-agent delegatie als tabs binnen de view. */
export default function Modellen({
  apiBase,
  target,
}: {
  apiBase: string;
  target?: string;
}) {
  const t = useT();
  const [tab, setTab] = useState<Tab>(() =>
    TAB_IDS.has(target as Tab) ? (target as Tab) : "modellen",
  );
  // Deep links like #combos / #subagents open the matching tab straight away. Adjust during render
  // when the routed target changes (React's documented alternative to syncing state in an effect).
  const [seenTarget, setSeenTarget] = useState(target);
  if (target !== seenTarget) {
    setSeenTarget(target);
    // Reset to the default tab when the routed target is absent or invalid, so navigating
    // #modellen/combos -> #modellen doesn't leave the URL and the shown tab disagreeing.
    setTab(TAB_IDS.has(target as Tab) ? (target as Tab) : "modellen");
  }
  return (
    <>
      <PageHeader title={t("nav.models")} />
      <PageSubtitle>{t("mod.subtitle")}</PageSubtitle>
      <PageTabs
        label={t("mod.tablistAria")}
        className="usage-segmented"
        style={{ marginBottom: 24 }}
      >
        {TABS.map(({ id, labelKey }) => (
          <PageTab
            key={id}
            id={`modellen-tab-${id}`}
            controls={`modellen-panel-${id}`}
            selected={tab === id}
            className={`usage-segmented-btn${tab === id ? " active" : ""}`}
            onClick={() => setTab(id)}
          >
            {t(labelKey)}
          </PageTab>
        ))}
      </PageTabs>
      <ModellenTabPanel tab={tab}>
        {tab === "modellen" && <Models apiBase={apiBase} />}
        {tab === "combos" && <Combos apiBase={apiBase} />}
        {tab === "subagents" && <Subagents apiBase={apiBase} />}
      </ModellenTabPanel>
    </>
  );
}
