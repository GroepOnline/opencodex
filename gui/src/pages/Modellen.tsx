import { useState } from "react";
import Models from "./Models";
import Combos from "./Combos";
import Subagents from "./Subagents";
import { useT, type TKey } from "../i18n/shared";

type Tab = "modellen" | "combos" | "subagents";

const TABS: { id: Tab; labelKey: TKey }[] = [
  { id: "modellen", labelKey: "nav.models" },
  { id: "combos", labelKey: "nav.combos" },
  { id: "subagents", labelKey: "nav.subagents" },
];

const TAB_IDS = new Set<Tab>(["modellen", "combos", "subagents"]);

/** Modellen-view: routing/catalogus met combos en sub-agent delegatie als tabs binnen de view. */
export default function Modellen({ apiBase, target }: { apiBase: string; target?: string }) {
  const t = useT();
  const [tab, setTab] = useState<Tab>(() => TAB_IDS.has(target as Tab) ? target as Tab : "modellen");
  // Deep links like #combos / #subagents open the matching tab straight away. Adjust during render
  // when the routed target changes (React's documented alternative to syncing state in an effect).
  const [seenTarget, setSeenTarget] = useState(target);
  if (target !== seenTarget) {
    setSeenTarget(target);
    if (TAB_IDS.has(target as Tab)) setTab(target as Tab);
  }
  return (
    <>
      <div className="depas-viewkop">
        <h2>{t("nav.models")}</h2>
      </div>
      <p className="depas-viewsub">{t("mod.subtitle")}</p>
      <div className="usage-segmented" role="tablist" aria-label={t("mod.tablistAria")} style={{ marginBottom: 24 }}>
        {TABS.map(({ id, labelKey }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`usage-segmented-btn${tab === id ? " active" : ""}`}
            onClick={() => setTab(id)}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>
      {tab === "modellen" && <Models apiBase={apiBase} />}
      {tab === "combos" && <Combos apiBase={apiBase} />}
      {tab === "subagents" && <Subagents apiBase={apiBase} />}
    </>
  );
}
