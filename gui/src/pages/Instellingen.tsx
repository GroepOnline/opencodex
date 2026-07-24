import { useI18n, LOCALES } from "../i18n/shared";
import { IconX } from "../icons";

export type Theme = "light" | "dark" | "system";

export function readTheme(): Theme {
  try {
    const t = localStorage.getItem("ocx-theme");
    if (t === "light" || t === "dark") return t;
  } catch { /* ignore */ }
  return "system";
}

export function applyTheme(next: Theme) {
  try {
    if (next === "system") {
      localStorage.removeItem("ocx-theme");
      document.documentElement.removeAttribute("data-theme");
    } else {
      localStorage.setItem("ocx-theme", next);
      document.documentElement.setAttribute("data-theme", next);
    }
  } catch { /* ignore */ }
}

const THEMES: { value: Theme; labelNl: string; labelEn: string }[] = [
  { value: "light", labelNl: "Licht", labelEn: "Light" },
  { value: "dark", labelNl: "Donker", labelEn: "Dark" },
  { value: "system", labelNl: "Systeem", labelEn: "System" },
];

export default function Instellingen({ onClose }: { apiBase: string; onClose: () => void }) {
  const { locale, setLocale, t } = useI18n();
  const theme = readTheme();

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card" style={{ maxWidth: 420 }}>
        <div className="modal-head">
          <h3>{t("dash.settingsSection")}</h3>
          <button className="btn-icon" onClick={onClose} aria-label={t("common.close")}>
            <IconX />
          </button>
        </div>

        {/* Taal — Language */}
        <div className="setting-row">
          <div className="setting-label">
            <div className="title">{t("lang.label")}</div>
            <div className="desc">{LOCALES.find(l => l.code === locale)?.name ?? locale}</div>
          </div>
          <div className="custom-select" style={{ position: "relative", display: "inline-block" }}>
            <select
              className="select-sm"
              value={locale}
              onChange={e => setLocale(e.target.value as typeof locale)}
            >
              {LOCALES.map(l => (
                <option key={l.code} value={l.code}>{l.name}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Weergave — Theme */}
        <div className="setting-row">
          <div className="setting-label">
            <div className="title">{t("theme.label")}</div>
            <div className="desc">
              {THEMES.find(th => th.value === theme)?.labelNl ?? theme}
            </div>
          </div>
          <div className="usage-segmented" style={{ flexShrink: 0 }}>
            {THEMES.map(th => (
              <button
                key={th.value}
                className={`usage-segmented-btn${theme === th.value ? " active" : ""}`}
                onClick={() => applyTheme(th.value)}
              >
                {locale === "nl" ? th.labelNl : th.labelEn}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
