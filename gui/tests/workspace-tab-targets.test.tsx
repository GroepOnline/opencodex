import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import Modellen from "../src/pages/Modellen";
import ProviderCatalog from "../src/components/provider-catalog/ProviderCatalog";
import ProviderDetails from "../src/components/provider-workspace/ProviderDetails";
import { DetailPanel } from "../src/components/combo-workspace-detail-panel";
import { LanguageProvider } from "../src/i18n/provider";
import { seedDicts } from "./helpers/locales";

await seedDicts();

async function expectValidTabTargets(children: ReactNode, expectedTabs: number) {
  const window = new Window();
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { language: "en-US" } });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: window.localStorage });
  try {
    window.document.body.innerHTML = renderToStaticMarkup(<LanguageProvider>{children}</LanguageProvider>);
    const tabs = window.document.querySelectorAll('[role="tab"]');
    expect(tabs).toHaveLength(expectedTabs);
    for (const tab of tabs) {
      const id = tab.getAttribute("aria-controls");
      expect(id).toBeTruthy();
      const panel = window.document.getElementById(id ?? "");
      expect(panel).not.toBeNull();
      expect(panel?.getAttribute("role")).toBe("tabpanel");
      expect(panel?.getAttribute("aria-labelledby")).toBe(tab.id);
      const selected = tab.getAttribute("aria-selected") === "true";
      expect(panel?.hidden).toBe(!selected);
      // Shells only: no hidden editor, account controller or polling subtree.
      if (!selected) expect(panel?.childElementCount).toBe(0);
    }
    const ids = Array.from(window.document.querySelectorAll("[id]"), element => element.id);
    expect(new Set(ids).size).toBe(ids.length);
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
    if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
    await window.happyDOM.close();
  }
}

for (const target of ["modellen", "combos", "subagents"]) {
  test(`Modellen keeps inactive panel targets when ${target} is selected`, async () => {
    await expectValidTabTargets(<Modellen apiBase="http://localhost" target={target} />, 3);
  });
}

for (const initialTier of ["accounts", "free", "paid"] as const) {
  test(`provider catalog keeps all targets in ${initialTier}`, async () => {
    await expectValidTabTargets(
      <ProviderCatalog presets={[]} initialTier={initialTier} onSelectPreset={() => {}} onSelectCustom={() => {}} />,
      3,
    );
  });
}

test("combo editor keeps the About panel addressable without mounting it", async () => {
  await expectValidTabTargets(
    <DetailPanel
      baseline={{ id: "test", model: "combo/test", alias: null, strategy: "failover", stickyLimit: 1, defaultEffort: null, targets: [] }}
      otherIds={[]} otherAliases={[]} providerMap={{}} providers={[]} models={[]}
      onSaved={() => {}} onSave={async () => ({ ok: true })} onDirtyChange={() => {}}
    />,
    2,
  );
});

test("provider detail shells match its dynamically available tabs", async () => {
  await expectValidTabTargets(
    <ProviderDetails
      item={{ name: "local", adapter: "openai-chat", baseUrl: "http://localhost:11434/v1", authMode: "local" }}
      availableModels={[]} hasLiveModels={false} selectedModels={[]}
      onDeselect={() => {}} apiBase="http://localhost"
    />,
    4,
  );
});
