import {
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { Locale, TFn } from "../../i18n/shared";
import { Panel, PanelHeader } from "../primitives/panel";
import { PageTab, PageTabPanel, PageTabs } from "../primitives/page-tabs";
import type { StorageCleanupTab, TrashEntry } from "./storage-types";
import { AutoCleanupPolicyPanel } from "./auto-cleanup-policy-panel";
import { ArchivedCleanupPanel } from "./archived-cleanup-panel";
import { QuarantineTrashPanel } from "./quarantine-trash-panel";

export function StorageCleanupCard({
  apiBase,
  locale,
  t,
  archivedCount,
  showQuarantine,
  trashReloadToken,
  onDone,
  onTrashEntriesChange,
}: {
  apiBase: string;
  locale: Locale;
  t: TFn;
  archivedCount: number;
  showQuarantine: boolean;
  trashReloadToken: number;
  onDone: () => void;
  onTrashEntriesChange: (entries: TrashEntry[]) => void;
}) {
  const [tab, setTab] = useState<StorageCleanupTab>("policy");
  const policyTabRef = useRef<HTMLButtonElement>(null);
  const quarantineTabRef = useRef<HTMLButtonElement>(null);
  const tabs: Array<{
    id: StorageCleanupTab;
    label: string;
    ref: typeof policyTabRef;
  }> = [
    {
      id: "policy",
      label: t("storage.cleanupCard.tab.policy"),
      ref: policyTabRef,
    },
    {
      id: "quarantine",
      label: t("storage.cleanupCard.tab.quarantine"),
      ref: quarantineTabRef,
    },
  ];

  const selectTab = (next: StorageCleanupTab) => {
    setTab(next);
    window.requestAnimationFrame(() =>
      (next === "policy" ? policyTabRef : quarantineTabRef).current?.focus(),
    );
  };

  const handleTabKey = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      selectTab(tab === "policy" ? "quarantine" : "policy");
    } else if (event.key === "Home") {
      event.preventDefault();
      selectTab("policy");
    } else if (event.key === "End") {
      event.preventDefault();
      selectTab("quarantine");
    }
  };

  return (
    <Panel
      titleId="storage-cleanup-card-title"
      className="panel storage-cleanup-card"
    >
      <PageTabs
        label={t("storage.cleanupCard.tabs")}
        className="usage-segmented storage-cleanup-card__tabs"
      >
        {tabs.map(({ id, label, ref }) => (
          <PageTab
            key={id}
            id={`storage-cleanup-tab-${id}`}
            controls={`storage-cleanup-panel-${id}`}
            selected={tab === id}
            className={`usage-segmented-btn${tab === id ? " active" : ""}`}
            ref={ref}
            onKeyDown={handleTabKey}
            onClick={() => selectTab(id)}
          >
            {label}
          </PageTab>
        ))}
      </PageTabs>
      <PanelHeader
        titleId="storage-cleanup-card-title"
        title={t("storage.cleanupCard.title")}
      />

      <div className="storage-cleanup-card__stack">
        <PageTabPanel
          id="storage-cleanup-panel-policy"
          labelledBy="storage-cleanup-tab-policy"
          className="storage-cleanup-card__body storage-cleanup-policy-split"
          data-active={tab === "policy" ? "true" : "false"}
          aria-hidden={tab !== "policy"}
          {...(tab !== "policy" ? { inert: true } : {})}
        >
          <AutoCleanupPolicyPanel
            apiBase={apiBase}
            locale={locale}
            t={t}
            onDone={onDone}
          />
          <aside
            className="storage-cleanup-manual"
            aria-labelledby="storage-cleanup-manual-title"
          >
            <h4
              id="storage-cleanup-manual-title"
              className="storage-cleanup-manual__title"
            >
              {t("storage.cleanup.title")}
            </h4>
            {archivedCount > 0 ? (
              <ArchivedCleanupPanel
                apiBase={apiBase}
                locale={locale}
                t={t}
                onDone={onDone}
              />
            ) : (
              <p className="muted storage-manual-panel__status">
                {t("storage.cleanup.noArchives")}
              </p>
            )}
          </aside>
        </PageTabPanel>

        <PageTabPanel
          id="storage-cleanup-panel-quarantine"
          labelledBy="storage-cleanup-tab-quarantine"
          className="storage-cleanup-card__body"
          data-active={tab === "quarantine" ? "true" : "false"}
          aria-hidden={tab !== "quarantine"}
          {...(tab !== "quarantine" ? { inert: true } : {})}
        >
          {showQuarantine ? (
            <QuarantineTrashPanel
              apiBase={apiBase}
              locale={locale}
              t={t}
              onDone={onDone}
              reloadToken={trashReloadToken}
              onEntriesChange={onTrashEntriesChange}
            />
          ) : (
            <p className="muted storage-manual-panel__status">
              {t("storage.trash.empty")}
            </p>
          )}
        </PageTabPanel>
      </div>
    </Panel>
  );
}
