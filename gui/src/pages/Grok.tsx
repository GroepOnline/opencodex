import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { EmptyState, Notice, Switch } from "../ui";
import { IconChevron } from "../icons";
import { useT, type TKey } from "../i18n/shared";
import { readJsonOrThrow } from "../fetch-json";
import {
  readSessionListCache,
  writeSessionListCache,
} from "../session-list-cache";
import { PageSubtitle } from "../components/primitives/page-header";
import { ProfileBar } from "../components/primitives/profile-bar";
import {
  CollapsibleGroup,
  CollapsibleGroupCount,
  CollapsibleGroupHead,
  CollapsibleGroupName,
  CollapsibleGroupStack,
  CollapsibleGroupToggle,
} from "../components/primitives/collapsible-group";
import { makeCollapseStore, toggleInSet } from "./collapse-store";
import { grokGroupView, type GrokCandidate } from "./grok-groups";

type TFn = (key: TKey, vars?: Record<string, string | number>) => string;

interface GrokStatusModel {
  alias: string;
  id: string;
  contextWindow?: number;
}

interface GrokStatus {
  configPath: string;
  present: boolean;
  baseUrl: string | null;
  models: GrokStatusModel[];
  candidates: GrokCandidate[];
  excluded: string[];
}

/** Same collapse store the Desktop page uses; Grok groups start collapsed. */
const GROUP_COLLAPSE = makeCollapseStore("ocx.grok.collapsedGroups.v2");

const GROUPS = [
  { id: "native", tkey: "grok.groupNative" as TKey },
  { id: "routed", tkey: "grok.groupRouted" as TKey },
] as const;

const DEFAULT_COLLAPSED_GROUPS = new Set(GROUPS.map((group) => group.id));

/** Same context formatting the Desktop page uses, so the two surfaces read alike. */
function formatContext(value: number | undefined, t: TFn): string {
  if (!value) return "—";
  // 1 MiB and above is a whole "1M": providers report 2^20 (1048576), and
  // 1048576 / 1e6 = 1.048576 reads as a bug.
  if (value >= 1_048_576)
    return t("claudeDesktop.contextM", { n: Math.round(value / 1_048_576) });
  return value >= 1_000_000
    ? t("claudeDesktop.contextM", { n: value / 1_000_000 })
    : t("claudeDesktop.contextK", { n: Math.round(value / 1_000) });
}

function GrokPage({ children }: { children: ReactNode }) {
  return <section className="grok-page">{children}</section>;
}

/** Grok has no `.page-head`; wrapping in PageHeader would add flex layout. */
function GrokPageHeader({
  title,
  description,
}: {
  title: ReactNode;
  description: ReactNode;
}) {
  return (
    <>
      <h2 className="page-title">{title}</h2>
      <PageSubtitle>{description}</PageSubtitle>
    </>
  );
}

function GrokLoadError({
  error,
  retryLabel,
  onRetry,
}: {
  error: string;
  retryLabel: string;
  onRetry: () => void;
}) {
  return (
    <GrokPage>
      <div className="alert alert-err" role="alert">
        {error}
      </div>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
        {retryLabel}
      </button>
    </GrokPage>
  );
}

function GrokCollapseToolbar({
  disabled,
  collapseLabel,
  expandLabel,
  onCollapseAll,
  onExpandAll,
}: {
  disabled: boolean;
  collapseLabel: string;
  expandLabel: string;
  onCollapseAll: () => void;
  onExpandAll: () => void;
}) {
  return (
    <div className="row" style={{ gap: 6, margin: "2px 0 10px" }}>
      <button
        type="button"
        className="btn btn-ghost btn-sm text-caption"
        onClick={onCollapseAll}
        disabled={disabled}
      >
        <IconChevron width={13} height={13} aria-hidden="true" />{" "}
        {collapseLabel}
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-sm text-caption"
        onClick={onExpandAll}
        disabled={disabled}
      >
        <IconChevron
          width={13}
          height={13}
          aria-hidden="true"
          style={{ transform: "rotate(90deg)" }}
        />{" "}
        {expandLabel}
      </button>
    </div>
  );
}

function GrokEndpoint({ label, baseUrl }: { label: string; baseUrl: string }) {
  return (
    <div className="grok-endpoint">
      <span>{label}</span>
      <code>{baseUrl}</code>
    </div>
  );
}

function GrokModelList({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div id={id} className="grok-model-list">
      {children}
    </div>
  );
}

function GrokModelRow({
  id,
  alias,
  enabled,
  context,
  disabled,
  toggleLabel,
  onToggle,
}: {
  id: string;
  alias: string | null;
  enabled: boolean;
  context: string;
  disabled: boolean;
  toggleLabel: string;
  onToggle: () => void;
}) {
  return (
    <div className="grok-model-row">
      <Switch
        on={enabled}
        onClick={onToggle}
        disabled={disabled}
        label={toggleLabel}
      />
      <span className="grok-model-names">
        <strong title={id}>{id}</strong>
        <code title={alias ?? undefined}>{alias ?? "—"}</code>
      </span>
      <span className="claude-model-context">{context}</span>
    </div>
  );
}

/**
 * Grok Build surface: per-model switches over the candidate catalog, plus save/apply.
 *
 * The page writes ONLY the selection (config.json, via /api/grok/selection) and asks the
 * proxy to re-run the guarded sync (/api/grok/apply). The fence itself is written only
 * by injectGrokConfig — the same path `ocx start`/`ensure`/`restart` use. Aliases shown
 * here come from readGrokStatus (what the writer actually wrote), never computed.
 */
export default function Grok({ apiBase }: { apiBase: string }) {
  const t = useT();
  const cacheKey = `ocx.grok.status.v1:${apiBase}`;
  const cached = readSessionListCache<GrokStatus>(cacheKey);
  const [status, setStatus] = useState<GrokStatus | null>(() => cached);
  const [loading, setLoading] = useState(() => !cached);
  const [error, setError] = useState("");
  const [excluded, setExcluded] = useState<Set<string>>(
    () => new Set(cached?.excluded ?? []),
  );
  const [savedExcluded, setSavedExcluded] = useState<Set<string>>(
    () => new Set(cached?.excluded ?? []),
  );
  // null = no stored preference; groups start collapsed so the list opens on demand.
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => GROUP_COLLAPSE.read() ?? new Set(DEFAULT_COLLAPSED_GROUPS),
  );
  const [pending, setPending] = useState<"save" | "apply" | null>(null);
  const [message, setMessage] = useState<{
    tone: "ok" | "err";
    text: string;
  } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const hasCacheRef = useRef(Boolean(cached));

  const load = useCallback(async () => {
    if (!hasCacheRef.current) setLoading(true);
    setError("");
    try {
      const response = await fetch(`${apiBase}/api/grok`);
      const payload = await readJsonOrThrow<GrokStatus & { error?: string }>(
        response,
        t("grok.loadFail"),
      );
      if (!payload) throw new Error(t("grok.loadFail"));
      // Tolerate an older proxy that predates the selection routes: the page degrades
      // to the read-only fence view instead of crashing on a missing field.
      const next = {
        ...payload,
        candidates: payload.candidates ?? [],
        excluded: payload.excluded ?? [],
      };
      setStatus(next);
      const saved = new Set(payload.excluded ?? []);
      setExcluded(saved);
      setSavedExcluded(saved);
      hasCacheRef.current = true;
      writeSessionListCache(cacheKey, next);
    } catch (err) {
      if (!hasCacheRef.current) {
        setError(err instanceof Error ? err.message : t("grok.loadFail"));
      }
    } finally {
      setLoading(false);
    }
  }, [apiBase, cacheKey, t]);

  // Deferred like the Desktop page: kicking the fetch off synchronously inside the effect
  // triggers cascading renders (and the react-doctor lint that guards against them).
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const dirty = useMemo(
    () =>
      excluded.size !== savedExcluded.size ||
      [...excluded].some((id) => !savedExcluded.has(id)),
    [excluded, savedExcluded],
  );

  const aliasById = useMemo(
    () => new Map((status?.models ?? []).map((m) => [m.id, m.alias])),
    [status],
  );

  const toggleGroup = (id: string) => {
    const next = toggleInSet(collapsed, id);
    GROUP_COLLAPSE.write(next);
    setCollapsed(next);
  };

  const setAllCollapsed = (nextCollapsed: boolean) => {
    const next = nextCollapsed
      ? new Set(GROUPS.map((group) => group.id))
      : new Set<string>();
    GROUP_COLLAPSE.write(next);
    setCollapsed(next);
  };

  const toggleModel = (id: string, currentlyExcluded: boolean) => {
    setExcluded((current) => {
      const next = new Set(current);
      if (currentlyExcluded) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const save = async (applyAfter: boolean) => {
    if (pending) return;
    setPending("save");
    setMessage(null);
    try {
      const response = await fetch(`${apiBase}/api/grok/selection`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ excluded: [...excluded] }),
      });
      await readJsonOrThrow<{ error?: string }>(response, t("grok.saveFailed"));
      setSavedExcluded(new Set(excluded));

      if (applyAfter) {
        setPending("apply");
        const applied = await fetch(`${apiBase}/api/grok/apply`, {
          method: "POST",
        });
        // Apply errors use `{ message, skippedReason }` (not always `error`); preserve that
        // actionable copy for orphan-marker repair and policy skips.
        if (!applied.ok) {
          const failed = (await applied.json().catch(() => ({}))) as {
            message?: string;
            error?: string;
          };
          throw new Error(
            failed.message ?? failed.error ?? t("grok.applyFailed"),
          );
        }
        const payload = (await applied.json().catch(() => ({}))) as {
          message?: string;
          skippedReason?: string;
        };
        // A policy skip is not success theatre: the Grok config did NOT change
        // (non-loopback bind, or no ~/.grok), so say that instead of "applied".
        if (payload.skippedReason) {
          setMessage({
            tone: "err",
            text: payload.message ?? t("grok.applySkipped"),
          });
          setAnnouncement(payload.message ?? t("grok.applySkipped"));
        } else {
          setMessage({ tone: "ok", text: t("grok.savedApplied") });
          setAnnouncement(t("grok.savedApplied"));
        }
        await load();
      } else {
        setMessage({ tone: "ok", text: t("grok.saved") });
        setAnnouncement(t("grok.saved"));
        if (status) {
          writeSessionListCache(cacheKey, {
            ...status,
            excluded: [...excluded],
          });
        }
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : t("grok.saveFailed");
      setMessage({ tone: "err", text });
      setAnnouncement(text);
    } finally {
      setPending(null);
    }
  };

  if (loading) {
    return (
      <GrokPage>
        <PageSubtitle>{t("grok.loading")}</PageSubtitle>
      </GrokPage>
    );
  }

  if (error) {
    return (
      <GrokLoadError
        error={error}
        retryLabel={t("common.retry")}
        onRetry={() => void load()}
      />
    );
  }

  return (
    <GrokPage>
      <GrokPageHeader
        title={t("grok.title")}
        description={t("grok.subtitle")}
      />

      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
      {message && <Notice tone={message.tone}>{message.text}</Notice>}

      {status && status.candidates.length > 0 && (
        <ProfileBar
          dirty={dirty}
          status={dirty ? t("grok.unsaved") : t("grok.upToDate")}
        >
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!dirty || pending !== null}
            onClick={() => void save(false)}
          >
            {pending === "save" ? t("grok.saving") : t("common.save")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!dirty || pending !== null}
            onClick={() => void save(true)}
          >
            {pending === "apply"
              ? t("grok.applying")
              : pending === "save"
                ? t("grok.saving")
                : t("grok.saveApply")}
          </button>
        </ProfileBar>
      )}

      {!status?.present ? (
        // Absent is a normal state, not a failure: Grok simply is not wired up yet. Name the
        // action that wires it rather than leaving an empty panel.
        <EmptyState title={t("grok.notConfiguredTitle")}>
          {t("grok.notConfiguredHint")}
          <br />
          <code>{status?.configPath}</code>
        </EmptyState>
      ) : (
        <>
          <GrokEndpoint
            label={t("grok.endpoint")}
            baseUrl={status.baseUrl ?? "—"}
          />
          <PageSubtitle>
            <code>{status.configPath}</code>
          </PageSubtitle>
        </>
      )}

      {status && status.candidates.length > 0 && (
        <CollapsibleGroupStack>
          <GrokCollapseToolbar
            disabled={pending !== null}
            collapseLabel={t("models.collapseAll")}
            expandLabel={t("models.expandAll")}
            onCollapseAll={() => setAllCollapsed(true)}
            onExpandAll={() => setAllCollapsed(false)}
          />
          {GROUPS.map((group) => {
            const view = grokGroupView(
              status.candidates,
              aliasById,
              excluded,
              group.id,
            );
            if (view.total === 0) return null;
            const isCollapsed = collapsed.has(group.id);
            return (
              <CollapsibleGroup
                key={group.id}
                collapsed={isCollapsed}
                labelledBy={`grok-group-${group.id}`}
              >
                <CollapsibleGroupHead collapsed={isCollapsed}>
                  <CollapsibleGroupToggle
                    titleId={`grok-group-${group.id}`}
                    controls={`grok-group-body-${group.id}`}
                    expanded={!isCollapsed}
                    onClick={() => toggleGroup(group.id)}
                  >
                    <IconChevron
                      className="ocx-chevron"
                      width={15}
                      height={15}
                      aria-hidden="true"
                      style={{
                        transform: isCollapsed ? "none" : "rotate(90deg)",
                      }}
                    />
                    <CollapsibleGroupName>{t(group.tkey)}</CollapsibleGroupName>
                    <CollapsibleGroupCount>
                      {t("grok.enabledCount", {
                        on: view.enabled,
                        total: view.total,
                      })}
                    </CollapsibleGroupCount>
                  </CollapsibleGroupToggle>
                </CollapsibleGroupHead>
                {!isCollapsed && (
                  <GrokModelList id={`grok-group-body-${group.id}`}>
                    {view.rows.map((model) => (
                      <GrokModelRow
                        key={model.id}
                        id={model.id}
                        alias={model.alias}
                        enabled={model.enabled}
                        context={formatContext(model.contextWindow, t)}
                        disabled={pending !== null}
                        toggleLabel={t("grok.toggleModel", { id: model.id })}
                        onToggle={() => toggleModel(model.id, !model.enabled)}
                      />
                    ))}
                  </GrokModelList>
                )}
              </CollapsibleGroup>
            );
          })}
        </CollapsibleGroupStack>
      )}
    </GrokPage>
  );
}
