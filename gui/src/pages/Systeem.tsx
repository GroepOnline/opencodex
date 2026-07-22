import { useEffect, useRef, useState, type ReactNode } from "react";
import Storage from "./Storage";
import ApiKeys from "./ApiKeys";
import CodexAuth from "./CodexAuth";
import ClaudeCode from "./ClaudeCode";
import { formatUptime } from "../formatUptime";
import { formatBytes } from "../format-bytes";
import { useI18n } from "../i18n/shared";
import { IconChevron, IconRefresh } from "../icons";

interface HealthData { status: string; version: string; uptime: number }

type UpdateChannel = "latest" | "preview";

interface UpdateCheckData {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  canUpdate: boolean;
  command: string;
  reason?: string;
}

interface StorageSummary { total?: { bytes: number; fileCount: number } }

function Sectie({ label, waarde, acties, children }: {
  label: string;
  waarde?: ReactNode;
  acties?: ReactNode;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="voegen-rij">
        <span className="voegen-label">{label}</span>
        {waarde !== undefined && <span className="voegen-waarde">{waarde}</span>}
        <span className="voegen-rij-acties">
          {acties}
          {children !== undefined && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setOpen(o => !o)}
              aria-expanded={open}
            >
              <IconChevron style={{ transform: open ? "rotate(90deg)" : undefined }} />
              {open ? "Sluit" : "Beheer"}
            </button>
          )}
        </span>
      </div>
      {open && children !== undefined && (
        <div style={{ padding: "8px 0 24px", borderBottom: "1px solid var(--rvs-licht)" }}>{children}</div>
      )}
    </>
  );
}

/** Systeem: proxy-status, versie/update, opslag, API-info, Codex Auth en de gevarenzone. */
export default function Systeem({ apiBase, health, healthFailed }: {
  apiBase: string;
  health: HealthData | null;
  healthFailed: boolean;
}) {
  const { locale } = useI18n();
  const online = !healthFailed && health?.status === "ok";

  const [updateCheck, setUpdateCheck] = useState<UpdateCheckData | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [storage, setStorage] = useState<StorageSummary | null>(null);
  const [stopOpen, setStopOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [copied, setCopied] = useState(false);
  const stopDialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBase}/api/storage`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (!cancelled && data) setStorage(data as StorageSummary); })
      .catch(() => { /* summary optional */ });
    return () => { cancelled = true; };
  }, [apiBase]);

  useEffect(() => {
    const dialog = stopDialogRef.current;
    if (!dialog) return;
    if (stopOpen && !dialog.open) dialog.showModal();
    if (!stopOpen && dialog.open) dialog.close();
  }, [stopOpen]);

  const checkUpdate = async () => {
    setUpdateBusy(true);
    setUpdateMsg(null);
    const channel: UpdateChannel = health?.version.includes("-preview.") ? "preview" : "latest";
    try {
      const res = await fetch(`${apiBase}/api/update/check?tag=${channel}`);
      const data = await res.json() as UpdateCheckData & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "update check mislukt");
      setUpdateCheck(data);
      if (!data.updateAvailable) setUpdateMsg("Je draait de nieuwste versie.");
    } catch (err) {
      setUpdateMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setUpdateBusy(false);
    }
  };

  const runUpdate = async () => {
    if (!updateCheck?.canUpdate) return;
    setUpdateBusy(true);
    setUpdateMsg(null);
    const channel: UpdateChannel = health?.version.includes("-preview.") ? "preview" : "latest";
    try {
      const res = await fetch(`${apiBase}/api/update/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag: channel, restart: true }),
      });
      const data = await res.json() as { job?: unknown; error?: string };
      if (!res.ok || !data.job) throw new Error(data.error ?? "update starten mislukt");
      setUpdateMsg("Update draait. De proxy herstart zichzelf zo.");
    } catch (err) {
      setUpdateMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setUpdateBusy(false);
    }
  };

  const runSync = async () => {
    setSyncBusy(true);
    setSyncMsg(null);
    try {
      const res = await fetch(`${apiBase}/api/sync`, { method: "POST" });
      const data = await res.json() as { added?: number; message?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? "sync mislukt");
      setSyncMsg(`Klaar. ${data.added ?? 0} modellen toegevoegd.`);
    } catch (err) {
      setSyncMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncBusy(false);
    }
  };

  const stopProxy = async () => {
    setStopping(true);
    try { await fetch(`${apiBase}/api/stop`, { method: "POST" }); } catch { /* verbinding valt weg */ }
    setStopOpen(false);
  };

  const endpoint = window.location.origin;

  const copyEndpoint = () => {
    navigator.clipboard.writeText(endpoint).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => { /* clipboard geblokkeerd */ });
  };

  return (
    <>
      <div className="depas-viewkop">
        <h2>Systeem</h2>
      </div>
      <p className="depas-viewsub">De proxy zelf: status, versie, opslag en beheer.</p>

      <dl className="voegen-lijst" style={{ margin: 0 }}>
        <div className="voegen-rij">
          <dt className="voegen-label">Proxy</dt>
          <dd>
            <span className={`stempel ${online ? "stempel--online" : "stempel--offline"}`}>
              {online ? "Online" : "Offline"}
            </span>
          </dd>
          {health && (
            <dd className="voegen-waarde" style={{ marginLeft: "auto" }}>
              {formatUptime(health.uptime, locale)} in dienst
            </dd>
          )}
        </div>
        <div className="voegen-rij">
          <dt className="voegen-label">Versie</dt>
          <dd className="voegen-waarde">v{health?.version ?? "—"}</dd>
          <dd className="voegen-rij-acties">
            {updateCheck?.canUpdate && updateCheck.updateAvailable ? (
              <button type="button" className="btn btn-primary btn-sm" onClick={() => void runUpdate()} disabled={updateBusy}>
                Update naar {updateCheck.latestVersion}
              </button>
            ) : (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void checkUpdate()} disabled={updateBusy} aria-busy={updateBusy}>
                {updateBusy ? <span className="spin" /> : <IconRefresh />} Check update
              </button>
            )}
          </dd>
        </div>
        {updateMsg && (
          <div className="voegen-rij" role="status">
            <span className="voegen-waarde">{updateMsg}</span>
          </div>
        )}
        <div className="voegen-rij">
          <dt className="voegen-label">Modellencatalogus</dt>
          <dd className="voegen-waarde">{syncMsg ?? "Sync haalt de nieuwste modellen op bij elke leverancier."}</dd>
          <dd className="voegen-rij-acties">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void runSync()} disabled={syncBusy} aria-busy={syncBusy}>
              {syncBusy ? <span className="spin" /> : <IconRefresh />} Sync modellen
            </button>
          </dd>
        </div>
      </dl>

      <Sectie
        label="Opslag"
        waarde={storage?.total ? `${formatBytes(storage.total.bytes, locale)} · ${storage.total.fileCount} bestanden` : "—"}
      >
        <Storage apiBase={apiBase} />
      </Sectie>

      <Sectie
        label="API-endpoint"
        waarde={endpoint}
        acties={
          <button type="button" className="btn btn-ghost btn-sm" onClick={copyEndpoint}>
            {copied ? "Gekopieerd" : "Kopieer"}
          </button>
        }
      >
        <ApiKeys apiBase={apiBase} />
      </Sectie>

      <Sectie label="Codex Auth" waarde="ChatGPT-accountpool voor de openai-leverancier">
        <CodexAuth apiBase={apiBase} />
      </Sectie>

      <Sectie label="Claude Code" waarde="Claude-integratie en agent-injectie">
        <ClaudeCode apiBase={apiBase} />
      </Sectie>

      <div className="gevarenzone">
        <div className="gevarenzone-kop">Gevarenzone</div>
        <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <span className="text-control muted">Stopt de proxy volledig. Codex en Cursor verliezen hun verbinding.</span>
          <button type="button" className="btn btn-wijn btn-sm" onClick={() => setStopOpen(true)} disabled={stopping}>
            Stop proxy
          </button>
        </div>
      </div>

      <dialog
        ref={stopDialogRef}
        className="modal-overlay"
        style={{ display: stopOpen ? "flex" : "none", border: "none", margin: 0, maxWidth: "none", maxHeight: "none", width: "100%", height: "100%" }}
        aria-labelledby="stop-proxy-title"
        onCancel={event => { event.preventDefault(); setStopOpen(false); }}
      >
        <div className="modal-card">
          <div className="modal-head">
            <h3 id="stop-proxy-title">Proxy stoppen?</h3>
          </div>
          <div className="modal-desc">Codex en Cursor verliezen hun verbinding.</div>
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setStopOpen(false)}>Laat draaien</button>
            <button type="button" className="btn btn-wijn" onClick={() => void stopProxy()} disabled={stopping}>
              {stopping ? "Stopt…" : "Stop proxy"}
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
