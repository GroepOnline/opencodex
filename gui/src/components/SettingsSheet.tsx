/* Application preferences; destructive actions remain in System. */
import { useRef, type RefObject } from "react";
import { IconGithub, IconMonitor, IconMoon, IconSun, IconX } from "../icons";
import { useI18n, useT, LOCALES, type Locale, type TKey } from "../i18n/shared";
import { Select } from "../ui";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "./primitives/sheet";
import { Button } from "./primitives/button";
import { ToggleGroup, ToggleGroupItem } from "./primitives/toggle-group";

type Theme = "light" | "dark" | "system";
const THEME_OPTIONS: { id: Theme; tkey: TKey; Icon: typeof IconSun }[] = [
  { id: "light", tkey: "theme.light", Icon: IconSun },
  { id: "dark", tkey: "theme.dark", Icon: IconMoon },
  { id: "system", tkey: "theme.system", Icon: IconMonitor },
];

export default function SettingsSheet({
  open,
  returnFocusRef,
  instant,
  theme,
  onTheme,
  onClose,
}: {
  open: boolean;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  instant: boolean;
  theme: Theme;
  onTheme: (next: Theme) => void;
  onClose: () => void;
}) {
  const t = useT();
  const { locale, setLocale } = useI18n();
  const closeRef = useRef<HTMLButtonElement>(null);

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        initialFocus={closeRef}
        finalFocus={returnFocusRef}
        showCloseButton={false}
        data-instant={instant || undefined}
        aria-describedby={undefined}
      >
        <SheetHeader className="flex-row items-center justify-between">
          <SheetTitle>{t("settings.title")}</SheetTitle>
          <SheetClose
            render={<Button variant="ghost" size="icon-lg" />}
            ref={closeRef}
            type="button"
            aria-label={t("common.close")}
            title={t("common.close")}
          >
            <IconX aria-hidden />
          </SheetClose>
        </SheetHeader>
        <div className="settings-sheet-body">
          <div className="sheet-section">
            <div className="sheet-label">{t("lang.label")}</div>
            <Select
              value={locale}
              options={LOCALES.map((l) => ({ value: l.code, label: l.name }))}
              onChange={(v) => setLocale(v as Locale)}
              label={t("lang.label")}
              portal={false}
              style={{ width: "100%" }}
            />
          </div>

          <div className="sheet-section">
            <div className="sheet-label">{t("theme.label")}</div>
            <ToggleGroup
              value={[theme]}
              variant="outline"
              aria-label={t("theme.label")}
              onValueChange={(values) => {
                const next = values[0];
                if (next === "light" || next === "dark" || next === "system")
                  onTheme(next);
              }}
            >
              {THEME_OPTIONS.map(({ id, tkey, Icon }) => (
                <ToggleGroupItem key={id} value={id}>
                  <Icon aria-hidden /> {t(tkey)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>

          <div className="sheet-foot">
            <a
              className="sidebar-link"
              href="https://github.com/GroepOnline/opencodex"
              target="_blank"
              rel="noreferrer"
            >
              <IconGithub /> {t("common.github")}
            </a>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
