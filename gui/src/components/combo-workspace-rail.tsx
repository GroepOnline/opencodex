import type { ReactNode } from "react";
import type { ComboItem } from "../combo-workspace-data";
import { IconChevron, IconPlus, IconSearch, IconShuffle } from "../icons";
import { useT, type TKey } from "../i18n/shared";

export function ComboWorkspaceRoot({ children }: { children: ReactNode }) {
  return <div className="combos-workspace-root">{children}</div>;
}

export function ComboWorkspaceMain({ children }: { children: ReactNode }) {
  return <div className="combos-workspace-main">{children}</div>;
}

export function ComboWorkspaceRailHeader({
  count,
  onAdd,
}: {
  count: number;
  onAdd: () => void;
}) {
  const t = useT();
  return (
    <div className="combos-workspace-rail-header">
      <div>
        <div className="combos-workspace-rail-title">{t("nav.combos")}</div>
        <div className="combos-workspace-rail-count">{count}</div>
      </div>
      <button type="button" className="btn btn-primary btn-sm" onClick={onAdd} aria-label={t("cws.add")}>
        <IconPlus width={15} height={15} /> {t("cws.add")}
      </button>
    </div>
  );
}

export function ComboWorkspaceRailSearch({
  query,
  onQuery,
}: {
  query: string;
  onQuery: (query: string) => void;
}) {
  const t = useT();
  return (
    <div className="cwi-search-row">
      <div className="cwi-search-wrap">
        <IconSearch className="cwi-search-icon" aria-hidden="true" />
        <input
          className="input cwi-search-input"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder={t("cws.searchPlaceholder")}
          aria-label={t("cws.searchPlaceholder")}
        />
      </div>
    </div>
  );
}

export function ComboWorkspaceRailGroup({
  labelKey,
  count,
  children,
}: {
  labelKey: TKey;
  count: number;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div className="combos-workspace-rail-group">
      <div className="combos-workspace-rail-group-head">
        <span className="pwi-dot" aria-hidden="true" />
        {t(labelKey)}
        <span className="combos-workspace-rail-count">{count}</span>
      </div>
      {children}
    </div>
  );
}

export function ComboWorkspaceRailRow({
  item,
  selected,
  onSelect,
}: {
  item: ComboItem;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      className={`combos-workspace-rail-row${selected ? " combos-workspace-rail-row--selected" : ""}`}
      onClick={() => onSelect(item.id)}
      aria-current={selected ? "true" : undefined}
    >
      <span className="combos-workspace-rail-icon" aria-hidden="true">
        <IconShuffle width={15} height={15} />
      </span>
      <span className="combos-workspace-rail-name">{item.model}</span>
      <span className="combos-workspace-rail-meta">
        {item.targets.length === 1
          ? t("cws.targetCountOne")
          : t("cws.targetCount", { count: item.targets.length })}
      </span>
      <IconChevron className="combos-workspace-rail-chevron" aria-hidden="true" />
    </button>
  );
}

export function ComboWorkspaceRail({
  combosCount,
  query,
  onQuery,
  groups,
  emptyFiltered,
  activeId,
  onAdd,
  onSelect,
}: {
  combosCount: number;
  query: string;
  onQuery: (query: string) => void;
  groups: readonly { key: string; labelKey: TKey; items: ComboItem[] }[];
  emptyFiltered: boolean;
  activeId: string | null;
  onAdd: () => void;
  onSelect: (id: string) => void;
}) {
  const t = useT();
  return (
    <aside className="combos-workspace-rail" aria-label={t("cws.railAria")}>
      <ComboWorkspaceRailHeader count={combosCount} onAdd={onAdd} />
      <ComboWorkspaceRailSearch query={query} onQuery={onQuery} />
      <div className="combos-workspace-rail-list">
        {emptyFiltered ? (
          <p className="muted" style={{ padding: "16px" }}>{t("cws.noSearchResults")}</p>
        ) : (
          groups.map(({ key, labelKey, items }) =>
            items.length > 0 ? (
              <ComboWorkspaceRailGroup key={key} labelKey={labelKey} count={items.length}>
                {items.map((item) => (
                  <ComboWorkspaceRailRow
                    key={item.id}
                    item={item}
                    selected={activeId === item.id}
                    onSelect={onSelect}
                  />
                ))}
              </ComboWorkspaceRailGroup>
            ) : null,
          )
        )}
      </div>
    </aside>
  );
}
