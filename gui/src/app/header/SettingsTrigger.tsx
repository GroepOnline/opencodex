import type { Ref } from "react";
import { IconSettings } from "../../icons";
import { useT } from "../../i18n/shared";

/** Preserve pointer/keyboard distinction for the SettingsSheet transition. */
export default function SettingsTrigger({
  buttonRef,
  onOpen,
}: {
  buttonRef: Ref<HTMLButtonElement>;
  onOpen: (instant: boolean) => void;
}) {
  const t = useT();
  return (
    <button
      ref={buttonRef}
      type="button"
      className="gbtn"
      onClick={(event) => onOpen(event.detail === 0)}
      aria-label={t("settings.open")}
      title={t("settings.open")}
    >
      <IconSettings />
    </button>
  );
}
