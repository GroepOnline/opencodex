import { useState } from "react";
import Models from "./Models";
import Combos from "./Combos";
import Subagents from "./Subagents";

type Tab = "modellen" | "combos" | "subagents";

const TABS: { id: Tab; label: string }[] = [
  { id: "modellen", label: "Modellen" },
  { id: "combos", label: "Combos" },
  { id: "subagents", label: "Sub-agents" },
];

/** Modellen-view: routing/catalogus met combos en sub-agent delegatie als tabs binnen de view. */
export default function Modellen({ apiBase }: { apiBase: string }) {
  const [tab, setTab] = useState<Tab>("modellen");
  return (
    <>
      <div className="depas-viewkop">
        <h2>Modellen</h2>
      </div>
      <p className="depas-viewsub">Catalogus, routing en delegatie voor sub-agents.</p>
      <div className="usage-segmented" role="tablist" aria-label="Modellen-onderdelen" style={{ marginBottom: 24 }}>
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`usage-segmented-btn${tab === id ? " active" : ""}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "modellen" && <Models apiBase={apiBase} />}
      {tab === "combos" && <Combos apiBase={apiBase} />}
      {tab === "subagents" && <Subagents apiBase={apiBase} />}
    </>
  );
}
