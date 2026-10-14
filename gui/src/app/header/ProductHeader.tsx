import type { Ref } from "react";
import type { Route, View } from "../../app-routing";
import WorkspaceNavigation from "../../components/WorkspaceNavigation";
import { VIEW_TABS } from "../navigation";
import Brand from "./Brand";
import SessionIdentity from "./SessionIdentity";
import ProxyStatus from "./ProxyStatus";
import SettingsTrigger from "./SettingsTrigger";

/** Signaal's compact chrome; no data fetching or implicit auth inference. */
export default function ProductHeader({
  activeView,
  navigateTo,
  version,
  proxyOnline,
  identityEmail,
  settingsTriggerRef,
  onOpenSettings,
}: {
  activeView: View;
  navigateTo: (next: Route) => void;
  version: string;
  proxyOnline: boolean | null;
  identityEmail: string | null;
  settingsTriggerRef: Ref<HTMLButtonElement>;
  onOpenSettings: (instant: boolean) => void;
}) {
  return (
    <header className="topbar">
      <Brand version={version} />
      <WorkspaceNavigation
        destinations={VIEW_TABS}
        active={activeView}
        onNavigate={(view) => navigateTo({ view, sub: null })}
      />
      <div className="topbar-right">
        <SessionIdentity email={identityEmail} />
        <ProxyStatus online={proxyOnline} />
        <SettingsTrigger buttonRef={settingsTriggerRef} onOpen={onOpenSettings} />
      </div>
    </header>
  );
}
