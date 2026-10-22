import { useEffect, useState } from "react";
import type { AppInfo, OpenedProject, RecentProject } from "../../../shared/api";
import { CloudHome, UpdateBadge } from "./Cloud";

const ASPECTS = [
  { key: "16:9", label: "Landscape", hint: "YouTube, tutorials" },
  { key: "9:16", label: "Vertical", hint: "Shorts, Reels, TikTok" },
  { key: "1:1", label: "Square", hint: "Feed posts" },
  { key: "4:5", label: "Portrait", hint: "Instagram feed" },
  { key: "21:9", label: "Cinema", hint: "Widescreen" },
];
const RATES = ["23.976", "24", "25", "29.97", "30", "50", "59.94", "60"];

function ago(iso: string) {
  if (!iso) return "";
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

export function Home({ onOpen }: { onOpen: (o: OpenedProject) => void }) {
  const [recent, setRecent] = useState<RecentProject[] | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [title, setTitle] = useState("Untitled project");
  const [aspect, setAspect] = useState("16:9");
  const [fps, setFps] = useState("30");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<{ path: string; at: string } | null>(null);
  const [view, setView] = useState<"projects" | "cloud">("projects");

  const refresh = () => window.motif.listRecent().then(setRecent).catch((e) => setErr(e.message));
  useEffect(() => {
    refresh();
    window.motif.appInfo().then(setInfo);
  }, []);

  const act = async (label: string, fn: () => Promise<OpenedProject | null>) => {
    setBusy(label);
    setErr(null);
    try {
      const o = await fn();
      if (o) onOpen(o);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  const openRecent = async (r: RecentProject) => {
    if (!r.exists) return setErr("That project file was moved or deleted.");
    const rec = await window.motif.hasRecovery(r.path);
    if (rec.recoveryNewer) return setRecovery({ path: r.path, at: rec.recoveredAt! });
    act("open", () => window.motif.openProject(r.path));
  };

  const filtered = (recent ?? []).filter((r) => r.title.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="home app-bg">
      <aside className="home-side glass-panel">
        <div className="brand-btn static">
          <span className="logo-orb" aria-hidden />
          <span className="brand-txt"><b>MOTIF</b><small>Video Studio</small></span>
        </div>
        <nav>
          <button className={"nav-item" + (view === "projects" ? " active" : "")} onClick={() => setView("projects")}>Projects</button>
          <button className={"nav-item" + (view === "cloud" ? " active" : "")} onClick={() => setView("cloud")}>Cloud projects</button>
          <button className="nav-item" disabled title="AI generation needs a provider key (Phase 6)">AI create</button>
        </nav>
        <div className="side-foot">
          <UpdateBadge />
          {info ? (
            <>
              <div>v{info.version} · {info.platform}</div>
              <div className={info.ffmpeg ? "ok" : "bad"}>{info.ffmpeg ? info.ffmpeg.replace("ffmpeg version ", "FFmpeg ").split(" Copyright")[0] : "FFmpeg not found — install it or set MOTIF_FFMPEG"}</div>
              {!info.font && <div className="bad">No title font found; set MOTIF_FONT</div>}
            </>
          ) : (
            "Checking tools…"
          )}
        </div>
      </aside>

      <main className="home-main">
        {view === "cloud" ? <CloudHome onOpen={onOpen} /> : <>
        <section className="new-card glass-panel">
          <h1>Start something new</h1>
          <p className="dim">Local-first editing with AI captions, 4K export and studio-grade tools. Nothing leaves your machine.</p>
          <div className="new-row">
            <label className="field grow">
              <span>Name</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
            </label>
            <label className="field">
              <span>Frame rate</span>
              <select value={fps} onChange={(e) => setFps(e.target.value)}>
                {RATES.map((r) => (
                  <option key={r} value={r}>{r} fps</option>
                ))}
              </select>
            </label>
          </div>
          <div className="aspect-grid" role="radiogroup" aria-label="Canvas">
            {ASPECTS.map((a) => {
              const [w, h] = a.key.split(":").map(Number) as [number, number];
              const k = 34 / Math.max(w, h);
              return (
                <button key={a.key} role="radio" aria-checked={aspect === a.key} className={"aspect" + (aspect === a.key ? " on" : "")} onClick={() => setAspect(a.key)}>
                  <span className="aspect-box" style={{ width: w * k, height: h * k }} />
                  <strong>{a.key}</strong>
                  <small>{a.label}</small>
                  <small className="dim">{a.hint}</small>
                </button>
              );
            })}
          </div>
          <div className="new-actions">
            <button className="primary" disabled={!!busy} onClick={() => act("create", () => window.motif.createProject({ title, aspect, fps }))}>
              {busy === "create" ? "Creating…" : "New project"}
            </button>
            <button disabled={!!busy} onClick={() => act("openfile", () => window.motif.openProjectDialog())}>Open…</button>
            <button disabled={!!busy || !info?.ffmpeg} onClick={() => act("demo", () => window.motif.createDemoProject())} title="Generates sample media locally with FFmpeg">
              {busy === "demo" ? "Building demo…" : "Try the demo project"}
            </button>
          </div>
          {err && <div className="error-line" role="alert">{err}</div>}
        </section>

        <section className="recent">
          <div className="recent-head">
            <h2>Recent</h2>
            <input className="search" placeholder="Search projects" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search projects" />
          </div>
          {recent === null ? (
            <div className="empty">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="empty">{recent.length ? "No projects match." : "Your projects will appear here. Create one or try the demo."}</div>
          ) : (
            <div className="recent-grid">
              {filtered.map((r) => (
                <div key={r.path} className={"recent-card glass-panel" + (r.exists ? "" : " gone")}>
                  <button className="recent-open" onClick={() => openRecent(r)} disabled={!!busy}>
                    <div className="recent-thumb" style={{ aspectRatio: r.width && r.height ? `${r.width}/${r.height}` : "16/9" }}>
                      <span>{r.width ? `${r.width}×${r.height}` : "?"}</span>
                    </div>
                    <div className="recent-title">{r.title}</div>
                    <div className="recent-meta">
                      {r.exists ? `${r.fps} fps · ${r.clipCount} clips · ${ago(r.updatedAt)}` : "File missing"}
                      {r.missingMedia > 0 && <span className="warn"> · {r.missingMedia} offline</span>}
                    </div>
                  </button>
                  <div className="recent-actions">
                    {r.exists && (
                      <>
                        <button
                          onClick={async () => {
                            const t = prompt("Rename project", r.title);
                            if (t) {
                              await window.motif.renameProject(r.path, t);
                              refresh();
                            }
                          }}
                        >Rename</button>
                        <button onClick={() => act("dup", () => window.motif.duplicateProject(r.path))}>Duplicate</button>
                      </>
                    )}
                    <button
                      onClick={async () => {
                        if (confirm(`Remove "${r.title}" from recent projects? The file stays on disk.`)) {
                          await window.motif.removeRecent(r.path);
                          refresh();
                        }
                      }}
                    >Remove</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
        </>}
      </main>

      {recovery && (
        <div className="modal-back">
          <div className="modal glass-strong" role="dialog" aria-modal="true" aria-labelledby="rec-h">
            <h3 id="rec-h">Unsaved changes found</h3>
            <p>MOTIF autosaved changes to this project at {new Date(recovery.at).toLocaleString()} that were never saved. Restore them?</p>
            <div className="modal-actions">
              <button onClick={() => { const p = recovery.path; setRecovery(null); act("open", () => window.motif.openProject(p)); }}>Open last saved</button>
              <button className="primary" onClick={() => { const p = recovery.path; setRecovery(null); act("open", () => window.motif.openProject(p, { preferRecovery: true })); }}>Restore autosave</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
