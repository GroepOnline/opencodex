import { useT } from "../../i18n/shared";

export default function Brand({ version }: { version: string }) {
  const t = useT();
  return (
    <div className="brand">
      <span className="brand-logo" role="img" aria-label={t("app.logoAria")} />
      <span className="name">opencodex</span>
      <span className="ver">v{version}</span>
    </div>
  );
}
