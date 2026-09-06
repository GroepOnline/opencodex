import { Button } from "../components/primitives/button";
import { IconChevron, IconShuffle } from "../icons";
import { useT } from "../i18n/shared";
import type { ComboItem } from "../combo-workspace-data";

type ModelsCombosSummaryProps = {
  combos: ComboItem[] | null;
  combosError: boolean;
  combosOpen: boolean;
  toggleCombosOpen: () => void;
};

export function ModelsCombosSummary({
  combos,
  combosError,
  combosOpen,
  toggleCombosOpen,
}: ModelsCombosSummaryProps) {
  const t = useT();
  return (
    <>
      {combos !== null && !combosError && combos.length === 0 && (
        <div className="card models-combos-card">
          <div className="row models-combos-empty-head">
            <div className="row models-field-row" style={{ minWidth: 0 }}>
              <IconShuffle
                width={15}
                height={15}
                aria-hidden="true"
                style={{ flexShrink: 0 }}
              />
              <strong>{t("nav.combos")}</strong>
              <span className="muted text-label">
                {t("models.combosEmpty")}
              </span>
            </div>
            <Button
              variant="outline"
              size="sm"
              nativeButton={false}
              render={<a href="#combos" aria-label={t("models.combosSetup")} />}
              aria-label={t("models.combosSetup")}
            >
              {t("models.combosSetup")}
            </Button>
          </div>
        </div>
      )}
      {combos !== null && !combosError && combos.length > 0 && (
        <div className="card models-combos-card">
          <div
            className={`row group-head models-field-row${combosOpen ? " open" : ""}`}
          >
            <Button
              type="button"
              className="row models-field-row"
              aria-expanded={combosOpen}
              onClick={toggleCombosOpen}
              style={{
                flex: 1,
                background: "none",
                border: "none",
                padding: 0,
                cursor: "pointer",
                font: "inherit",
                color: "inherit",
                textAlign: "left",
                minWidth: 0,
              }}
            >
              <IconChevron
                style={{
                  width: 14,
                  height: 14,
                  color: "var(--muted)",
                  flexShrink: 0,
                  transform: combosOpen ? "rotate(90deg)" : "none",
                  transition: "transform .12s",
                }}
              />
              <IconShuffle
                width={15}
                height={15}
                aria-hidden="true"
                style={{ flexShrink: 0 }}
              />
              <strong>{t("nav.combos")}</strong>
              <span className="muted mono text-label">
                {t("models.combosActive", { count: combos.length })}
              </span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              nativeButton={false}
              render={<a href="#combos" aria-label={t("models.combosSetup")} />}
              aria-label={t("models.combosSetup")}
            >
              {t("models.combosSetup")}
            </Button>
          </div>
          {combosOpen && (
            <div>
              {combos.map((c) => (
                <div key={c.id} className="row models-combo-row">
                  <span className="mono leading-ui">{c.model}</span>
                  <span className="muted text-label">
                    {c.strategy} · {c.targets.length}
                  </span>
                </div>
              ))}
              <a className="row muted models-combos-add" href="#combos">
                + {t("models.combosAdd")}
              </a>
            </div>
          )}
        </div>
      )}
    </>
  );
}
