/* Settings sheet — design-system v2 Motion 5 (pane slide). Config lives here,
   not on the dashboard: language, theme, skin. Destructive actions do NOT live
   here (those sit in the Systeem danger zone). */
import { useEffect, useRef, useState } from "react";
import { IconGithub, IconMonitor, IconMoon, IconSun, IconX } from "../icons";
import { useI18n, useT, LOCALES, type Locale, type TKey } from "../i18n/shared";
import { Select } from "../ui";

type Theme = "light" | "dark" | "system";
type Skin = "devin" | "strak";

const STYLE_KEY = "ocx-style";

function readSkin(): Skin {
  return document.documentElement.getAttribute("data-style") === "strak" ? "strak" : "devin";
}

const THEME_OPTIONS: { id: Theme; tkey: TKey; Icon: typeof IconSun }[] = [
  { id: "light", tkey: "theme.light", Icon: IconSun },
  { id: "dark", tkey: "theme.dark", Icon: IconMoon },
  { id: "system", tkey: "theme.system", Icon: IconMonitor },
];

export default function SettingsSheet({
  theme,
  onTheme,
  onClose,
}: {
  theme: Theme;
  onTheme: (next: Theme) => void;
  onClose: () => void;
}) {
  const t = useT();
  const { locale, setLocale } = useI18n();
  const [skin, setSkin] = useState<Skin>(readSkin);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const applySkin = (next: Skin) => {
    setSkin(next);
    document.documentElement.setAttribute("data-style", next);
    try { localStorage.setItem(STYLE_KEY, next); } catch { /* private mode */ }
  };

  return (
    <div className="sheet-scrim" onClick={onClose}>
      <aside
        className="settings-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t("settings.title")}
        onClick={e => e.stopPropagation()}
      >
        <div className="sheet-head">
          <h2>{t("settings.title")}</h2>
          <button
            ref={closeRef}
            type="button"
            className="gbtn"
            onClick={onClose}
            aria-label={t("common.close")}
            title={t("common.close")}
          >
            <IconX />
          </button>
        </div>

        <div className="sheet-section">
          <div className="sheet-label">{t("lang.label")}</div>
          <Select
            value={locale}
            options={LOCALES.map(l => ({ value: l.code, label: l.name }))}
            onChange={v => setLocale(v as Locale)}
            label={t("lang.label")}
            portal={false}
            style={{ width: "100%" }}
          />
        </div>

        <div className="sheet-section">
          <div className="sheet-label">{t("theme.label")}</div>
          <div className="seg" role="group" aria-label={t("theme.label")}>
            {THEME_OPTIONS.map(({ id, tkey, Icon }) => (
              <button
                key={id}
                type="button"
                className={theme === id ? "on" : ""}
                aria-pressed={theme === id}
                onClick={() => onTheme(id)}
              >
                <Icon size={13} aria-hidden /> {t(tkey)}
              </button>
            ))}
          </div>
        </div>

        <div className="sheet-section">
          <div className="sheet-label">{t("settings.skin")}</div>
          <div className="seg" role="group" aria-label={t("settings.skin")}>
            <button type="button" className={skin === "devin" ? "on" : ""} aria-pressed={skin === "devin"} onClick={() => applySkin("devin")}>
              {t("skin.devin")}
            </button>
            <button type="button" className={skin === "strak" ? "on" : ""} aria-pressed={skin === "strak"} onClick={() => applySkin("strak")}>
              {t("skin.strak")}
            </button>
          </div>
        </div>

        <div className="sheet-foot">
          <a className="sidebar-link" href="https://github.com/GroepOnline/opencodex" target="_blank" rel="noreferrer">
            <IconGithub /> {t("common.github")}
          </a>
        </div>
      </aside>
    </div>
  );
}
