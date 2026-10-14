import { useState } from "react";
import type { Locale, TFn } from "../../../i18n/shared";
import { formatTokens } from "../../../format-tokens";
import { modelLabel } from "../../../model-display";
import { modelColor, type UsageDay } from "../model/usage-report";
export default function WeekDayBars({
  weekBars,
  locale,
  t,
}: {
  weekBars: UsageDay[];
  locale: Locale;
  t: TFn;
}) {
  const [hoverDay, setHoverDay] = useState<string | null>(null);
  const max = Math.max(1, ...weekBars.map((day) => day.totalTokens));

  return (
    <div className="daybars" role="img" aria-label={t("usage.section.heatmap")}>
      {weekBars.map((day) => {
        const percentage = Math.round((day.totalTokens / max) * 100);
        const label = day.date.slice(5);
        return (
          <div
            key={day.date}
            className="daybar"
            onMouseEnter={() => setHoverDay(day.date)}
            onMouseLeave={() =>
              setHoverDay((current) => (current === day.date ? null : current))
            }
          >
            <div className="daybar-track">
              <div
                className="daybar-stack"
                style={{ height: `${percentage}%` }}
              >
                {day.models.map((model) => (
                  <div
                    key={`${model.provider}/${model.model}`}
                    className="daybar-seg"
                    style={{
                      flexGrow: model.totalTokens,
                      background: modelColor(model.model, model.provider),
                    }}
                  />
                ))}
                {day.models.length === 0 && day.totalTokens > 0 && (
                  <div
                    className="daybar-seg"
                    style={{ flexGrow: 1, background: "var(--green)" }}
                  />
                )}
              </div>
            </div>
            {hoverDay === day.date && day.totalTokens > 0 && (
              <div className="daybar-tip" role="tooltip">
                <div className="daybar-tip-date">{day.date}</div>
                {day.models.slice(0, 8).map((model) => (
                  <div
                    key={`${model.provider}/${model.model}`}
                    className="daybar-tip-row"
                  >
                    <span
                      className="daybar-tip-swatch"
                      style={{
                        background: modelColor(model.model, model.provider),
                      }}
                    />
                    <span className="daybar-tip-name">
                      {modelLabel(model.model)}
                    </span>
                    <span className="daybar-tip-val">
                      {formatTokens(model.totalTokens, locale)}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <span className="daybar-count">
              {formatTokens(day.totalTokens, locale)}
            </span>
            <span className="daybar-label muted">{label}</span>
          </div>
        );
      })}
    </div>
  );
}
