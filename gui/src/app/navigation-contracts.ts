import type { ComponentType } from "react";
import type { View } from "../app-routing";
import type { TKey } from "../i18n/shared";

/** Application-owned navigation contracts; chrome components render them without owning policy. */
export interface WorkspaceDestination {
  view: View;
  tkey: TKey;
  icon: ComponentType<{ size?: 13 | 15 | 18 | 24; "aria-hidden"?: boolean }>;
}

export interface WorkspaceSubTab {
  sub: string | null;
  tkey: TKey;
}
