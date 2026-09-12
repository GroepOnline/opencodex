import { useCallback, useMemo, useState } from "react";
import {
  type ComboItem,
  comboModelId,
  emptyDraft,
  filterCombos,
  groupCombos,
} from "../combo-workspace-data";
import { AddComboModal } from "./combo-workspace-add-modal";
import { DetailPanel } from "./combo-workspace-detail-panel";
import { RemoveComboDialog, UnsavedLeaveDialog } from "./combo-workspace-dialogs";
import { OverviewPanel } from "./combo-workspace-overview-panel";
import {
  ComboWorkspaceMain,
  ComboWorkspaceRail,
  ComboWorkspaceRoot,
} from "./combo-workspace-rail";
import type { ComboWorkspaceProps } from "./combo-workspace-types";

export type { ModelOption, ProviderOption, ComboWorkspaceProps } from "./combo-workspace-types";

export default function ComboWorkspace({
  combos,
  providers,
  models,
  cataloguedComboIds,
  loading,
  onRefresh,
  onSave,
  onRemove,
  onAdd,
  adding,
  onCloseAdd,
  onCreated,
}: ComboWorkspaceProps) {
  const providerMap = useMemo(
    () => Object.fromEntries(providers.map((provider) => [provider.name, { disabled: provider.disabled }])),
    [providers],
  );
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingSelect, setPendingSelect] = useState<string | null | undefined>(undefined);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [localBaseline, setLocalBaseline] = useState<ComboItem | null>(null);
  const firstComboDraft = useMemo(() => emptyDraft(), []);

  const filtered = useMemo(() => filterCombos(combos, query), [combos, query]);
  const sections = useMemo(() => groupCombos(filtered), [filtered]);
  const existingComboAliases = useMemo(
    () => combos.flatMap((combo) => combo.alias ? [combo.alias] : []),
    [combos],
  );
  const activeId = selectedId && combos.some((c) => c.id === selectedId) ? selectedId : null;
  const selected = combos.find((c) => c.id === activeId) ?? null;
  const baseline = selected && localBaseline?.id === selected.id ? localBaseline : selected;

  const [detailDirty, setDetailDirty] = useState(false);

  // Identity constraints for the detail editor: every OTHER combo's id (rename
  // collisions) and alias (public-name uniqueness), collected in one pass.
  const otherComboIds: string[] = [];
  const otherComboAliases: string[] = [];
  if (baseline) {
    for (const combo of combos) {
      if (combo.id === baseline.id) continue;
      otherComboIds.push(combo.id);
      if (combo.alias) otherComboAliases.push(combo.alias);
    }
  }

  const trySelect = useCallback((id: string | null) => {
    if (id === activeId) return;
    if (!detailDirty) {
      setSelectedId(id);
      setLocalBaseline(null);
      return;
    }
    setPendingSelect(id);
  }, [activeId, detailDirty]);

  const confirmDiscard = () => {
    if (pendingSelect === undefined) return;
    setSelectedId(pendingSelect);
    setLocalBaseline(null);
    setDetailDirty(false);
    setPendingSelect(undefined);
  };

  const cancelPending = () => setPendingSelect(undefined);

  const showUnsaved = pendingSelect !== undefined && detailDirty;
  const creatingFirstCombo = !loading && combos.length === 0;
  const handleAdd = () => {
    if (creatingFirstCombo) {
      document.getElementById("cwi-edit-id")?.focus();
      return;
    }
    onAdd();
  };

  return (
    <ComboWorkspaceRoot>
      <ComboWorkspaceRail
        combosCount={combos.length}
        query={query}
        onQuery={setQuery}
        groups={[
          { key: "failover", labelKey: "cws.group.failover", items: sections.failover },
          { key: "round-robin", labelKey: "cws.group.roundRobin", items: sections.roundRobin },
        ]}
        emptyFiltered={filtered.length === 0 && combos.length > 0}
        activeId={activeId}
        onAdd={handleAdd}
        onSelect={trySelect}
      />

      <ComboWorkspaceMain>
        {baseline ? (
          <DetailPanel
            key={baseline.id}
            baseline={baseline}
            otherIds={otherComboIds}
            otherAliases={otherComboAliases}
            providerMap={providerMap}
            providers={providers}
            models={models}
            onBack={() => trySelect(null)}
            onSaved={(item) => {
              setDetailDirty(false);
              // A rename retires the old id: follow the combo to its new key so the
              // detail panel (keyed by id) remounts against the refreshed baseline.
              if (item.id !== baseline.id) {
                setSelectedId(item.id);
                setLocalBaseline(null);
              } else {
                setLocalBaseline(item);
              }
              onRefresh();
            }}
            onRequestRemove={() => setRemoveId(baseline.id)}
            onSave={onSave}
            onDirtyChange={setDetailDirty}
          />
        ) : creatingFirstCombo ? (
          <DetailPanel
            key="first-combo"
            baseline={firstComboDraft}
            isCreate
            otherIds={[]}
            otherAliases={[]}
            providerMap={providerMap}
            providers={providers}
            models={models}
            onSaved={(item) => {
              setDetailDirty(false);
              setSelectedId(item.id);
              setLocalBaseline(item);
              onCreated(item.id);
            }}
            onSave={onSave}
            onDirtyChange={setDetailDirty}
          />
        ) : (
          <OverviewPanel
            combos={combos}
            cataloguedComboIds={cataloguedComboIds}
            onSelect={(id) => trySelect(id)}
            onAdd={onAdd}
          />
        )}
      </ComboWorkspaceMain>

      {adding && !creatingFirstCombo && (
        <AddComboModal
          existingIds={combos.map((c) => c.id)}
          existingAliases={existingComboAliases}
          providerMap={providerMap}
          providers={providers}
          models={models}
          onClose={onCloseAdd}
          onSubmit={async (item) => {
            const res = await onSave(item, true);
            if (res.ok) {
              onCloseAdd();
              onCreated(item.id);
              setSelectedId(item.id);
              setLocalBaseline(null);
            }
            return res;
          }}
        />
      )}

      {removeId && (
        <RemoveComboDialog
          model={combos.find((c) => c.id === removeId)?.model ?? comboModelId(removeId)}
          onCancel={() => setRemoveId(null)}
          onConfirm={() => {
            void (async () => {
              const res = await onRemove(removeId);
              setRemoveId(null);
              if (res.ok) {
                if (activeId === removeId) {
                  setSelectedId(null);
                  setLocalBaseline(null);
                }
                onRefresh();
              }
            })();
          }}
        />
      )}

      {showUnsaved && (
        <UnsavedLeaveDialog onKeep={cancelPending} onDiscard={confirmDiscard} />
      )}
    </ComboWorkspaceRoot>
  );
}
