import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import ClaudeCode from "./ClaudeCode";
import ClaudeDesktop from "./ClaudeDesktop";
import { useT } from "../i18n/shared";
import {
  PageTab,
  PageTabPanel,
  PageTabs,
} from "../components/primitives/page-tabs";

type ClaudeTab = "code" | "desktop";

function ClaudePage({ children }: { children: ReactNode }) {
  return <section className="claude-page ocx-page-root">{children}</section>;
}

export default function Claude({ apiBase }: { apiBase: string }) {
  const [tab, setTab] = useState<ClaudeTab>("code");
  const t = useT();
  const codeTabRef = useRef<HTMLButtonElement>(null);
  const desktopTabRef = useRef<HTMLButtonElement>(null);

  const selectTab = (next: ClaudeTab) => {
    setTab(next);
    window.requestAnimationFrame(() =>
      (next === "code" ? codeTabRef : desktopTabRef).current?.focus(),
    );
  };

  const handleTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      selectTab(tab === "code" ? "desktop" : "code");
    } else if (event.key === "Home") {
      event.preventDefault();
      selectTab("code");
    } else if (event.key === "End") {
      event.preventDefault();
      selectTab("desktop");
    }
  };

  return (
    <ClaudePage>
      <PageTabs label={t("claude.tabsLabel")} className="claude-tabs">
        <PageTab
          id="claude-code-tab"
          controls="claude-code-panel"
          selected={tab === "code"}
          className={tab === "code" ? "active" : ""}
          ref={codeTabRef}
          onKeyDown={handleTabKey}
          onClick={() => selectTab("code")}
        >
          {t("claude.tabCode")}
        </PageTab>
        <PageTab
          id="claude-desktop-tab"
          controls="claude-desktop-panel"
          selected={tab === "desktop"}
          className={tab === "desktop" ? "active" : ""}
          ref={desktopTabRef}
          onKeyDown={handleTabKey}
          onClick={() => selectTab("desktop")}
        >
          {t("claude.tabDesktop")}
        </PageTab>
      </PageTabs>

      {/* Both stay mounted so draft/UI state survives tab switches; Desktop pauses polls while hidden. */}
      <PageTabPanel
        id="claude-code-panel"
        labelledBy="claude-code-tab"
        hidden={tab !== "code"}
      >
        <ClaudeCode key={apiBase} apiBase={apiBase} />
      </PageTabPanel>
      <PageTabPanel
        id="claude-desktop-panel"
        labelledBy="claude-desktop-tab"
        hidden={tab !== "desktop"}
      >
        <ClaudeDesktop
          key={apiBase}
          apiBase={apiBase}
          active={tab === "desktop"}
        />
      </PageTabPanel>
    </ClaudePage>
  );
}
