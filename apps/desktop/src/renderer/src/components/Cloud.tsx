import { useEffect, useState } from "react";
import type { CloudLink, CloudStatus, OpenedProject, UpdateState } from "../../../shared/api";
import type { Project } from "@motif/project-schema";

/** Sign-in card: device flow (opens the browser) or email/password, plus a configurable server. */
export function CloudSignIn({ status, onChange }: { status: CloudStatus; onChange: (s: CloudStatus) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [server, setServer] = useState(status.server);
  const [code, setCode] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(status.error ?? null);
  const [busy, setBusy] = useState(false);
  useEffect(
    () =>
      window.motif.onCloudSignedIn(async (e) => {
        setCode(null);
        if (!e.ok) return setErr(e.error ?? "Sign-in failed");
        onChange(await window.motif.cloudStatus());
      }),
    [onChange],
  );
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e: any) {
      setErr(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="cloud-signin glass-panel">
      <h2>MOTIF Cloud</h2>
      <p className="dim">Optional. Back up projects with version history, open them on another computer and share a workspace with your team. Editing, AI and exports stay local and unlimited without an account.</p>
      {code ? (
        <div className="device-code">
          <div className="dim">Approve this code in your browser</div>
          <div className="code">{code}</div>
          <button onClick={() => (window.motif.cloudDeviceCancel(), setCode(null))}>Cancel</button>
        </div>
      ) : (
        <>
          <button className="primary" disabled={busy} onClick={() => run(async () => setCode((await window.motif.cloudDeviceStart()).userCode))}>Sign in with browser</button>
          <div className="or"><span>or</span></div>
          <form className="cloud-form" onSubmit={(e) => (e.preventDefault(), run(async () => onChange(await window.motif.cloudLogin(email, password))))}>
            <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required aria-label="Email" />
            <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required aria-label="Password" />
            <button disabled={busy}>Sign in</button>
          </form>
        </>
      )}
      <details className="server">
        <summary>Server: {status.server}</summary>
        <div className="row">
          <input value={server} onChange={(e) => setServer(e.target.value)} aria-label="Cloud server URL" />
          <button onClick={() => run(async () => onChange(await window.motif.cloudSetServer(server)))}>Use</button>
        </div>
      </details>
      {!status.keychain && <p className="warn small">Your system keychain is unavailable, so the session token is stored unencrypted in your profile folder.</p>}
      {err && <div className="error-line" role="alert">{err}</div>}
    </div>
  );
}

/** Home → Cloud projects: browse workspaces, open the head or any version. */
export function CloudHome({ onOpen }: { onOpen: (o: OpenedProject) => void }) {
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [ws, setWs] = useState<string>("");
  const [rows, setRows] = useState<{ id: string; title: string; headVersion: number; updatedAt: string }[] | null>(null);
  const [versionsFor, setVersionsFor] = useState<{ id: string; list: { version: number; message: string; createdAt: string }[] } | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => void window.motif.cloudStatus().then(setStatus), []);
  useEffect(() => window.motif.onCloudProgress((p) => setProgress(`${p.stage} ${p.name ?? ""} ${p.total ? `(${Math.min(p.done + 1, p.total)}/${p.total})` : ""}`)), []);
  useEffect(() => {
    if (status?.signedIn && status.workspaces?.length && !ws) setWs(status.workspaces[0]!.id);
  }, [status, ws]);
  useEffect(() => {
    if (!ws) return;
    setRows(null);
    window.motif.cloudProjects(ws).then(setRows).catch((e) => setErr(e.message));
  }, [ws]);
  if (!status) return <div className="empty">Checking MOTIF Cloud…</div>;
  if (!status.signedIn) return <CloudSignIn status={status} onChange={setStatus} />;
  const open = async (id: string, version?: number) => {
    setErr(null);
    setProgress("downloading");
    try {
      onOpen(await window.motif.cloudDownload(id, version));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setProgress(null);
    }
  };
  return (
    <section className="recent">
      <div className="recent-head">
        <h2>Cloud projects</h2>
        <select value={ws} onChange={(e) => setWs(e.target.value)} aria-label="Workspace">
          {status.workspaces!.map((w) => (
            <option key={w.id} value={w.id}>{w.name} · {w.plan}</option>
          ))}
        </select>
        <span className="grow" />
        <span className="dim small">{status.user?.email}</span>
        <button onClick={async () => setStatus(await window.motif.cloudLogout())}>Sign out</button>
      </div>
      {progress && <div className="job-pill glass"><span className="spinner" /> {progress}</div>}
      {err && <div className="error-line" role="alert">{err}</div>}
      {rows === null ? (
        <div className="empty">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="empty">No cloud projects yet. Open a project and press Cloud in the top bar to upload it.</div>
      ) : (
        <div className="recent-grid">
          {rows.map((r) => (
            <div key={r.id} className="recent-card glass-panel">
              <button className="recent-open" onClick={() => open(r.id)} disabled={!!progress}>
                <div className="recent-thumb cloud"><span>☁ v{r.headVersion}</span></div>
                <div className="recent-title">{r.title}</div>
                <div className="recent-meta">Updated {new Date(r.updatedAt).toLocaleString()}</div>
              </button>
              <div className="recent-actions">
                <button onClick={async () => setVersionsFor({ id: r.id, list: await window.motif.cloudVersions(r.id) })}>History</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {versionsFor && (
        <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && setVersionsFor(null)}>
          <div className="modal glass-strong" role="dialog" aria-modal="true">
            <h3>Version history</h3>
            <div className="version-list">
              {versionsFor.list.map((v) => (
                <div key={v.version} className="version-row">
                  <b>v{v.version}</b>
                  <span>{v.message || "—"}</span>
                  <span className="dim small">{new Date(v.createdAt).toLocaleString()}</span>
                  <button onClick={() => (setVersionsFor(null), open(versionsFor.id, v.version))}>Open</button>
                </div>
              ))}
            </div>
            <div className="modal-actions"><button onClick={() => setVersionsFor(null)}>Close</button></div>
          </div>
        </div>
      )}
    </section>
  );
}

/** Editor → Cloud: upload/sync the open project, resolving conflicts explicitly. */
export function CloudSyncDialog({ path, project, onClose, onSynced }: { path: string; project: Project; onClose: () => void; onSynced: (msg: string) => void }) {
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [link, setLink] = useState<CloudLink | null>(null);
  const [ws, setWs] = useState("");
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    window.motif.cloudStatus().then(setStatus);
    window.motif.cloudLink(path).then((l) => (setLink(l), l && setWs(l.workspaceId)));
  }, [path]);
  useEffect(() => {
    if (status?.workspaces?.length && !ws) setWs(status.workspaces[0]!.id);
  }, [status, ws]);
  useEffect(() => window.motif.onCloudProgress((p) => setProgress(`${p.stage[0]!.toUpperCase()}${p.stage.slice(1)} ${p.name ?? ""} ${p.total ? `${Math.min(p.done + 1, p.total)}/${p.total}` : ""}`)), []);
  const push = async (o: { force?: boolean; asNew?: boolean } = {}) => {
    setErr(null);
    setConflict(null);
    setProgress("Preparing");
    try {
      const r = await window.motif.cloudUpload(path, project, { workspaceId: ws, message, ...o });
      if (!r.ok) return setConflict(r.message);
      setLink(r.link);
      onSynced(`Synced to MOTIF Cloud · v${r.link.version}`);
      onClose();
    } catch (e: any) {
      setErr(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    } finally {
      setProgress(null);
    }
  };
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && !progress && onClose()}>
      <div className="modal glass-strong cloud-dialog" role="dialog" aria-modal="true" aria-labelledby="cloud-h">
        <h3 id="cloud-h">☁ MOTIF Cloud</h3>
        {!status ? (
          <div className="dim">Checking…</div>
        ) : !status.signedIn ? (
          <CloudSignIn status={status} onChange={setStatus} />
        ) : (
          <>
            <p className="dim">{link ? `Linked to cloud v${link.version}. Uploading saves a new version; media already in the cloud is skipped.` : "Upload this project and its media. Only changed media is transferred next time."}</p>
            <label className="field">
              <span>Workspace</span>
              <select value={ws} onChange={(e) => setWs(e.target.value)} disabled={!!link}>
                {status.workspaces!.map((w) => (
                  <option key={w.id} value={w.id} disabled={w.role === "viewer"}>{w.name} · {w.plan}{w.role === "viewer" ? " (view only)" : ""}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Version note</span>
              <input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="What changed?" maxLength={200} />
            </label>
            {progress && <div className="job-pill glass"><span className="spinner" /> {progress}</div>}
            {conflict && (
              <div className="conflict" role="alert">
                <b>Someone changed the cloud copy.</b>
                <p>{conflict}</p>
                <div className="modal-actions">
                  <button onClick={() => push({ asNew: true })}>Keep both (upload as new)</button>
                  <button className="danger" onClick={() => push({ force: true })}>Overwrite cloud</button>
                </div>
              </div>
            )}
            {err && <div className="error-line" role="alert">{err}</div>}
            <div className="modal-actions">
              <button onClick={onClose} disabled={!!progress}>Close</button>
              <button className="primary" disabled={!!progress || !ws} onClick={() => push()}>{link ? "Sync new version" : "Upload to cloud"}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function UpdateBadge() {
  const [s, setS] = useState<UpdateState | null>(null);
  useEffect(() => {
    window.motif.updateState().then(setS);
    return window.motif.onUpdate(setS);
  }, []);
  if (!s || s.state === "disabled" || s.state === "idle" || s.state === "none" || s.state === "checking") return null;
  if (s.state === "ready") return <button className="update-pill" onClick={() => window.motif.installUpdate()}>Restart to update to {s.version}</button>;
  if (s.state === "error") return null;
  return <span className="update-pill">Downloading {s.version}{s.state === "downloading" && s.percent != null ? ` ${s.percent}%` : ""}</span>;
}
