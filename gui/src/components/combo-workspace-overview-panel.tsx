import type { ComboItem } from "../combo-workspace-data";
import { buildComboAttention, groupCombos } from "../combo-workspace-data";
import { IconAlert, IconChevron, IconPlus } from "../icons";
import { useT, type TFn } from "../i18n/shared";

function attentionCopy(
  reason: "empty-targets" | "few-targets" | "catalog-omitted",
  t: TFn,
): string {
  switch (reason) {
    case "empty-targets":
      return t("cws.attention.empty");
    case "catalog-omitted":
      return t("cws.attention.catalogOmitted");
    case "few-targets":
      return t("cws.attention.few");
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

export function ComboOverviewHead({
  onAdd,
}: {
  onAdd: () => void;
}) {
  const t = useT();
  return (
    <div className="combos-workspace-overview-head">
      <h2 className="combos-workspace-overview-title">{t("cws.overviewTitle")}</h2>
      <button type="button" className="btn btn-primary btn-sm" onClick={onAdd}>
        <IconPlus width={15} height={15} /> {t("cws.add")}
      </button>
    </div>
  );
}

export function ComboCountStrip({
  total,
  failover,
  roundRobin,
}: {
  total: number;
  failover: number;
  roundRobin: number;
}) {
  const t = useT();
  return (
    <div className="cwi-count-strip">
      <div className="cwi-count-pill"><strong>{total}</strong><span>{t("cws.count.total")}</span></div>
      <div className="cwi-count-pill"><strong>{failover}</strong><span>{t("cws.count.failover")}</span></div>
      <div className="cwi-count-pill"><strong>{roundRobin}</strong><span>{t("cws.count.roundRobin")}</span></div>
    </div>
  );
}

export function ComboHowSection() {
  const t = useT();
  return (
    <section className="pwi-section" aria-label={t("cws.howTitle")}>
      <h3 className="pwi-section-title">{t("cws.howTitle")}</h3>
      <p className="muted" style={{ margin: 0 }}>{t("cws.howBody")}</p>
    </section>
  );
}

export function ComboAttentionSection({
  items,
  onSelect,
}: {
  items: ReturnType<typeof buildComboAttention>;
  onSelect: (id: string) => void;
}) {
  const t = useT();
  if (items.length === 0) return null;
  return (
    <section className="pwi-section" aria-label={t("cws.attentionTitle")}>
      <h3 className="pwi-section-title">{t("cws.attentionTitle")}</h3>
      <div className="cwi-attention-list">
        {items.map((item) => (
          <button
            key={`${item.id}:${item.reason}`}
            type="button"
            className="cwi-attention-row"
            onClick={() => onSelect(item.id)}
          >
            <IconAlert width={15} height={15} aria-hidden="true" />
            <code className="chip">{item.model}</code>
            <span className="muted">{attentionCopy(item.reason, t)}</span>
            <IconChevron width={15} height={15} style={{ marginLeft: "auto" }} aria-hidden="true" />
          </button>
        ))}
      </div>
    </section>
  );
}

export function OverviewPanel({
  combos,
  cataloguedComboIds,
  onSelect,
  onAdd,
}: {
  combos: ComboItem[];
  cataloguedComboIds?: ReadonlySet<string>;
  onSelect: (id: string) => void;
  onAdd: () => void;
}) {
  const t = useT();
  const sections = groupCombos(combos);
  const attention = buildComboAttention(combos, { cataloguedComboIds });

  return (
    <div className="combos-workspace-overview">
      <ComboOverviewHead onAdd={onAdd} />
      <p className="muted" style={{ marginTop: 0, maxWidth: "62ch" }}>{t("cws.overviewBlurb")}</p>
      <ComboCountStrip
        total={combos.length}
        failover={sections.failover.length}
        roundRobin={sections.roundRobin.length}
      />
      <ComboHowSection />
      <ComboAttentionSection items={attention} onSelect={onSelect} />
    </div>
  );
}
