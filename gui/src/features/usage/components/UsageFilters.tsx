import type { TFn } from "../../../i18n/shared";
import { SegmentedControl, SegmentedOption } from "../../../components/primitives/segmented-control";
import type { Range, UsageSurface } from "../model/usage-report";
export default function UsageFilters({
  surface,
  range,
  onSurface,
  onRange,
  t,
}: {
  surface: UsageSurface;
  range: Range;
  onSurface: (surface: UsageSurface) => void;
  onRange: (range: Range) => void;
  t: TFn;
}) {
  return (
    <div className="usage-filters">
      <SegmentedControl label={t("logs.filter.surface.label")}>
        {(["all", "codex", "claude", "grok"] as UsageSurface[]).map(
          (choice) => {
            const label = t(`logs.filter.surface.${choice}`);
            return (
              <SegmentedOption
                key={choice}
                pressed={surface === choice}
                label={label}
                className={`usage-segmented-btn usage-source-btn${surface === choice ? " active" : ""}`}
                onClick={() => onSurface(choice)}
              >
                {choice === "codex" && (
                  <img
                    className="usage-source-mark"
                    src="/provider-icons/openai.svg"
                    alt=""
                    aria-hidden="true"
                  />
                )}
                {choice === "claude" && (
                  <img
                    className="usage-source-mark"
                    src="/provider-icons/claude.svg"
                    alt=""
                    aria-hidden="true"
                  />
                )}
                {choice === "grok" && (
                  <img
                    className="usage-source-mark"
                    src="/provider-icons/grok.svg"
                    alt=""
                    aria-hidden="true"
                  />
                )}
                <span
                  className={
                    choice === "all"
                      ? "usage-source-label"
                      : "usage-source-label usage-source-label-collapsible"
                  }
                >
                  {label}
                </span>
              </SegmentedOption>
            );
          },
        )}
      </SegmentedControl>
      <SegmentedControl label={t("usage.title")}>
        {(["all", "30d", "7d"] as Range[]).map((choice) => {
          const label = t(`usage.range.${choice}`);
          return (
            <SegmentedOption
              key={choice}
              pressed={range === choice}
              label={label}
              className={`usage-segmented-btn${range === choice ? " active" : ""}`}
              onClick={() => onRange(choice)}
            >
              {label}
            </SegmentedOption>
          );
        })}
      </SegmentedControl>
    </div>
  );
}
