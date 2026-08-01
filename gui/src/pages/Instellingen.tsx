import { useState } from "react";
import { useI18n, LOCALES } from "../i18n/shared";
import { IconX } from "../icons";
import { applyTheme, readTheme, type Theme } from "../theme";

const THEMES: { value: Theme; labelNl: string; labelEn: string }[] = [
  { value: "light", labelNl: "Licht", labelEn: "Light" },
  { value: "dark", labelNl: "Donker", labelEn: "Dark" },
  { value: "system", labelNl: "Systeem", labelEn: "System" },
];

export default function Instellingen({ onClose }: { apiBase: string; onClose: () => void }) {
  const { locale, setLocale, t } = useI18n();
  const [theme, setTheme] = useState<Theme>(() => readTheme());

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="modal-card" style={{ maxWidth: 420 }}>
        <div className="modal-head">
          <h3 id="settings-title">{t("dash.settingsSection")}</h3>
          <button type="button" className="btn-icon" onClick={onClose} aria-label={t("common.close")}>
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
              aria-label={t("lang.label")}
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
                type="button"
                className={`usage-segmented-btn${theme === th.value ? " active" : ""}`}
                onClick={() => { applyTheme(th.value); setTheme(th.value); }}
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
