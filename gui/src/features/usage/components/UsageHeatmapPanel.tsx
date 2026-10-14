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
        <>
        <div
          className="heatmap"
          ref={heatmapRef}
          aria-hidden="true"
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
        <details className="usage-heatmap-data" style={{ marginTop: 12 }}>
          <summary className="text-control" style={{ cursor: "pointer", padding: "12px 0", minHeight: 44 }}>
            {t("usage.section.heatmap")} — {t("usage.col.requests")} / {t("usage.col.tokens")}
          </summary>
          <div className="tbl-wrap usage-scroll">
            <table className="tbl">
              <caption className="sr-only">{t("usage.section.heatmap")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("logs.col.time")}</th>
                  <th scope="col" className="num">{t("usage.col.requests")}</th>
                  <th scope="col" className="num">{t("usage.col.tokens")}</th>
                </tr>
              </thead>
              <tbody>
                {heatmap.weeks.flat().filter((cell) => cell.date).map((cell) => (
                  <tr key={cell.date}>
                    <th scope="row"><time dateTime={cell.date}>{cell.date}</time></th>
                    <td className="num">{cell.requests}</td>
                    <td className="num mono">{formatTokens(cell.totalTokens, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
        </>
      )}
    </Panel>
  );
}
