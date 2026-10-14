import { useEffect, useRef, useState } from "react";
import type { Locale, TFn } from "../../../i18n/shared";
import { Panel, PanelHeader } from "../../../components/primitives/panel";
import { formatTokens } from "../../../format-tokens";
import { buildHeatmap, type Range, type UsageDay } from "../model/usage-report";
import WeekDayBars from "./WeekDayBars";
export default function UsageHeatmapPanel({
  range,
  heatmap,
  weekBars,
  locale,
  t,
}: {
  range: Range;
  heatmap: ReturnType<typeof buildHeatmap>;
  weekBars: UsageDay[];
  locale: Locale;
  t: TFn;
}) {
  const heatmapRef = useRef<HTMLDivElement | null>(null);
  const [hoverCell, setHoverCell] = useState<{
    weekIndex: number;
    dayIndex: number;
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    const element = heatmapRef.current;
    if (!element) return;
    const pinRight = () => {
      element.scrollLeft = element.scrollWidth;
    };
    pinRight();
    const observer = new ResizeObserver(pinRight);
    observer.observe(element);
    return () => observer.disconnect();
  }, [heatmap, range]);

  return (
    <Panel titleId="usage-heatmap-title" style={{ marginTop: 16 }}>
      <PanelHeader
        titleId="usage-heatmap-title"
        title={t("usage.section.heatmap")}
      />
      {range === "7d" ? (
        <WeekDayBars weekBars={weekBars} locale={locale} t={t} />
      ) : (
        <div
          className="heatmap"
          ref={heatmapRef}
          role="img"
          aria-labelledby="usage-heatmap-title"
        >
          <div
            className="heatmap-months"
            style={{
              gridTemplateColumns: `28px repeat(${heatmap.weeks.length}, calc(var(--hm-cell) + var(--hm-gap)))`,
            }}
          >
            <span className="heatmap-day-spacer" />
            {heatmap.months.map((month) => (
              <span
                key={`${month.label}-${month.col}`}
                className="heatmap-month"
                style={{ gridColumn: month.col + 2 }}
              >
                {month.label}
              </span>
            ))}
          </div>
          <div className="heatmap-body">
            <div className="heatmap-days">
              <span />
              <span>{t("usage.dayMon")}</span>
              <span />
              <span>{t("usage.dayWed")}</span>
              <span />
              <span>{t("usage.dayFri")}</span>
              <span />
            </div>
            <div
              className="heatmap-grid"
              style={{
                gridTemplateColumns: `repeat(${heatmap.weeks.length}, var(--hm-cell))`,
              }}
            >
              {heatmap.weeks.map((week, weekIndex) => (
                <div
                  key={week[0]?.date || `week-${weekIndex}`}
                  className="heatmap-week"
                >
                  {week.map((cell, dayIndex) => (
                    <div
                      key={cell.date || `pad-${weekIndex}-${dayIndex}`}
                      className={`heatmap-cell heatmap-cell-${cell.level}`}
                      onMouseEnter={(event) => {
                        if (!cell.date) return;
                        const rect =
                          event.currentTarget.getBoundingClientRect();
                        setHoverCell({
                          weekIndex,
                          dayIndex,
                          x: rect.left + rect.width / 2,
                          y: rect.top,
                        });
                      }}
                      onMouseLeave={() =>
                        setHoverCell((current) =>
                          current?.weekIndex === weekIndex &&
                          current.dayIndex === dayIndex
                            ? null
                            : current,
                        )
                      }
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
          {hoverCell &&
            (() => {
              const cell =
                heatmap.weeks[hoverCell.weekIndex]?.[hoverCell.dayIndex];
              if (!cell?.date) return null;
              return (
                <div
                  className="heatmap-tip"
                  role="tooltip"
                  style={{ left: hoverCell.x, top: hoverCell.y }}
                >
                  <div className="heatmap-tip-date">{cell.date}</div>
                  <div className="heatmap-tip-val">
                    {t("usage.heatmap.tooltipTokens", {
                      tokens: formatTokens(cell.totalTokens, locale),
                    })}
                  </div>
                  <div className="heatmap-tip-req muted">
                    {t("usage.heatmap.tooltipRequests", {
                      requests: cell.requests,
                    })}
                  </div>
                </div>
              );
            })()}
          <div className="heatmap-legend muted">
            <span>{t("usage.heatmap.less")}</span>
            {[0, 1, 2, 3, 4].map((level) => (
              <span
                key={level}
                className={`heatmap-cell heatmap-cell-${level}`}
              />
            ))}
            <span>{t("usage.heatmap.more")}</span>
          </div>
        </div>
      )}
    </Panel>
  );
}
