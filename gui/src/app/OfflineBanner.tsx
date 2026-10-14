import { IconAlert } from "../icons";
import { useT } from "../i18n/shared";

export default function OfflineBanner({ onOpenSystem }: { onOpenSystem: () => void }) {
  const t = useT();
  return (
    <div className="offline-banner" role="alert">
      <IconAlert size={15} aria-hidden />
      <span>{t("offline.banner")}</span>
      <button type="button" className="link-btn" onClick={onOpenSystem}>
        {t("offline.toSystem")}
      </button>
    </div>
  );
}
