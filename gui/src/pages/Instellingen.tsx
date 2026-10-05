import { useEffect, useState, type ReactNode } from "react";
import { useI18n, LOCALES, type Locale } from "../i18n/shared";
import { IconX } from "../icons";
import { applyTheme, readTheme, type Theme } from "../theme";
import { Switch } from "../ui";
import { Modal, ModalCard, ModalHead } from "../components/primitives/modal";
import {
  SegmentedControl,
  SegmentedOption,
} from "../components/primitives/segmented-control";
import {
  isPostHogTelemetryAllowed,
  readPostHogPreference,
  writePostHogPreference,
  type PostHogPreference,
} from "../posthog";

const THEMES: {
  value: Theme;
  labelKey: "theme.light" | "theme.dark" | "theme.system";
}[] = [
  { value: "light", labelKey: "theme.light" },
  { value: "dark", labelKey: "theme.dark" },
  { value: "system", labelKey: "theme.system" },
];

function SettingRow({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="setting-row">
      <div className="setting-label">
        <div className="title">{title}</div>
        <div className="desc">{description}</div>
      </div>
      {children}
    </div>
  );
}

function LanguageSetting({
  locale,
  onLocale,
  label,
}: {
  locale: Locale;
  onLocale: (next: Locale) => void;
  label: string;
}) {
  return (
    <div
      className="custom-select"
      style={{ position: "relative", display: "inline-block" }}
    >
      <select
        className="select-sm"
        aria-label={label}
        value={locale}
        onChange={(e) => onLocale(e.target.value as Locale)}
      >
        {LOCALES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function ThemeSetting({
  theme,
  onTheme,
  label,
  optionLabel,
}: {
  theme: Theme;
  onTheme: (next: Theme) => void;
  label: string;
  optionLabel: (key: (typeof THEMES)[number]["labelKey"]) => string;
}) {
  return (
    <div style={{ flexShrink: 0 }}>
      <SegmentedControl label={label} className="usage-segmented">
        {THEMES.map((th) => (
          <SegmentedOption
            key={th.value}
            pressed={theme === th.value}
            label={optionLabel(th.labelKey)}
            className={`usage-segmented-btn${theme === th.value ? " active" : ""}`}
            onClick={() => onTheme(th.value)}
          >
            {optionLabel(th.labelKey)}
          </SegmentedOption>
        ))}
      </SegmentedControl>
    </div>
  );
}

export default function Instellingen({
  onClose,
}: {
  apiBase: string;
  onClose: () => void;
}) {
  const { locale, setLocale, t } = useI18n();
  const [theme, setTheme] = useState<Theme>(() => readTheme());
  const [telemetry, setTelemetry] = useState<PostHogPreference>(() =>
    typeof window === "undefined" ? null : readPostHogPreference(localStorage),
  );
  const titleId = "settings-title";

  useEffect(() => {
    if (typeof window === "undefined") return;
    writePostHogPreference(localStorage, telemetry);
    if (telemetry === "0") {
      // Reload applies the opt-out immediately: posthog-js is initialized
      // once at startup and keeps queueing without a page load.
      window.location.reload();
    }
  }, [telemetry]);

  const telemetryOn = isPostHogTelemetryAllowed(
    typeof window === "undefined" ? undefined : localStorage,
    typeof navigator === "undefined"
      ? undefined
      : (navigator.doNotTrack ?? null),
  );

  return (
    <Modal
      aria-labelledby={titleId}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <ModalCard style={{ maxWidth: 420 }}>
        <ModalHead
          titleId={titleId}
          title={t("dash.settingsSection")}
          actions={
            <button
              type="button"
              className="btn-icon"
              onClick={onClose}
              aria-label={t("common.close")}
            >
              <IconX />
            </button>
          }
        />

        <SettingRow
          title={t("lang.label")}
          description={LOCALES.find((l) => l.code === locale)?.name ?? locale}
        >
          <LanguageSetting
            locale={locale}
            onLocale={setLocale}
            label={t("lang.label")}
          />
        </SettingRow>

        <SettingRow
          title={t("theme.label")}
          description={t(
            THEMES.find((th) => th.value === theme)?.labelKey ?? "theme.system",
          )}
        >
          <ThemeSetting
            theme={theme}
            onTheme={(next) => {
              applyTheme(next);
              setTheme(next);
            }}
            label={t("theme.label")}
            optionLabel={(key) => t(key)}
          />
        </SettingRow>

        <SettingRow
          title={t("telemetry.label")}
          description={t(
            telemetryOn ? "telemetry.stateOn" : "telemetry.stateOff",
          )}
        >
          <Switch
            on={telemetryOn}
            onClick={() => setTelemetry(telemetry === "0" ? "1" : "0")}
            label={t("telemetry.label")}
          />
        </SettingRow>
      </ModalCard>
    </Modal>
  );
}
