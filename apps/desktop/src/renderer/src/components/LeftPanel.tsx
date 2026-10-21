import { useEffect, useState } from "react";
import type { MediaAsset } from "@motif/project-schema";
import { FONTS, LOOKS, TRANSITION_KINDS } from "@motif/project-schema";
import {
  addAsset,
  updateAsset,
  removeAsset,
  insertMediaClip,
  insertTextClip,
  insertShapeClip,
  captionCues,
  toSrt,
  parseSrt,
  importCaptions,
  secondsToFrames,
  framesToSeconds,
  findClip,
  splitClip,
  rippleDelete,
  clipEnd,
  applyLook,
  setTransition,
  wordsToCues,
  insertCaptionCues,
  detachAudio,
  updateClip,
} from "@motif/editor-core";
import { EditorSession, useSession, type LeftTab } from "../editorStore";
import { Icon, type IconName } from "../icons";

export async function importIntoSession(session: EditorSession, res: { assets: MediaAsset[]; errors: { file: string; error: string }[] }) {
  let added = 0;
  session.run("Import media", (p) => {
    let next = p;
    for (const a of res.assets) {
      if (next.assets.find((x) => x.fingerprint && x.fingerprint === a.fingerprint)) continue;
      next = addAsset(next, a);
      added++;
    }
    return next;
  });
  if (res.errors.length) session.toast(`${res.errors.length} file(s) could not be imported: ${res.errors[0]!.file} — ${res.errors[0]!.error}`, "error");
  else if (added) session.toast(`Imported ${added} file${added > 1 ? "s" : ""}`, "ok");
  else if (res.assets.length) session.toast("Those files are already in the project", "info");
  for (const a of res.assets) derive(session, a);
}

export function derive(session: EditorSession, a: MediaAsset) {
  if (session.ui.derived[a.id] || session.ui.missing.has(a.id)) return;
  session.setUi({ derived: { ...session.ui.derived, [a.id]: { assetId: a.id } } });
  window.motif.deriveMedia(a).then((d) => session.setUi({ derived: { ...session.ui.derived, [a.id]: d } }));
}

/** Run a main-process job, tracking progress in the UI. Resolves with its result. */
export function runJob<T>(session: EditorSession, label: string, start: () => Promise<{ jobId: string }>): Promise<T> {
  return new Promise((resolve, reject) => {
    session.setUi({ job: { label, fraction: null } });
    let jobId = "";
    const offP = window.motif.onJobProgress((e) => e.jobId === jobId && session.setUi({ job: { label, fraction: e.fraction } }));
    const offD = window.motif.onJobDone((e) => {
      if (e.jobId !== jobId) return;
      offP();
      offD();
      session.setUi({ job: null });
      (session as any).currentJob = null;
      if (e.ok) resolve(e.result as T);
      else reject(new Error(e.cancelled ? "cancelled" : e.error));
    });
    start()
      .then((r) => {
        jobId = r.jobId;
        (session as any).currentJob = jobId;
      })
      .catch((e) => {
        offP();
        offD();
        session.setUi({ job: null });
        reject(e);
      });
  });
}

const RAIL: [LeftTab, IconName, string][] = [
  ["media", "media", "Media"],
  ["audio", "audio", "Audio"],
  ["text", "text", "Text"],
  ["shapes", "shapes", "Shapes"],
  ["effects", "filters", "Filters"],
  ["transitions", "transitions", "Transitions"],
  ["captions", "captions", "Captions"],
  ["ai", "wand", "AI tools"],
];

export function LeftPanel({ session }: { session: EditorSession }) {
  const { ui } = useSession(session);
  const [hover, setHover] = useState<{ y: number; label: string } | null>(null);
  return (
    <div className="left">
      <nav className="rail glass-panel" aria-label="Library">
        {RAIL.map(([k, icon, label]) => (
          <button
            key={k}
            className={"rail-btn" + (ui.leftTab === k ? " on" : "")}
            aria-label={label}
            aria-pressed={ui.leftTab === k}
            onClick={() => session.setUi({ leftTab: k })}
            onPointerEnter={(e) => setHover({ y: (e.currentTarget as HTMLElement).offsetTop, label })}
            onPointerLeave={() => setHover(null)}
          >
            <Icon name={icon} size={19} />
          </button>
        ))}
        {hover && <div className="rail-tip glass" style={{ top: hover.y + 4 }}>{hover.label}</div>}
      </nav>
      <div className="library glass-panel">
        {ui.leftTab === "media" && <MediaTab session={session} />}
        {ui.leftTab === "audio" && <AudioTab session={session} />}
        {ui.leftTab === "text" && <TextTab session={session} />}
        {ui.leftTab === "shapes" && <ShapesTab session={session} />}
        {ui.leftTab === "effects" && <FiltersTab session={session} />}
        {ui.leftTab === "transitions" && <TransitionsTab session={session} />}
        {ui.leftTab === "captions" && <CaptionsTab session={session} />}
        {ui.leftTab === "ai" && <AiTab session={session} />}
      </div>
    </div>
  );
}

function MediaTab({ session }: { session: EditorSession }) {
  const { project, ui } = useSession(session);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "video" | "image" | "audio" | "fav">("all");
  useEffect(() => {
    for (const a of project.assets) derive(session, a);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.assets.length]);
  const assets = project.assets
    .filter((a) => (filter === "all" ? true : filter === "fav" ? a.favorite : a.kind === filter))
    .filter((a) => a.name.toLowerCase().includes(q.toLowerCase()));
  const addAtPlayhead = (a: MediaAsset) => {
    const track = a.kind === "audio" ? project.tracks.find((t) => t.kind === "audio") : project.tracks.find((t) => t.kind === "video" && !t.locked);
    if (!track) return session.toast("Add a track first", "error");
    session.run("Add clip", (p) => insertMediaClip(p, { trackId: track.id, assetId: a.id, start: ui.playhead, findFreeSlot: true }).project);
  };
  return (
    <div
      className="panel-body"
      onDragOver={(e) => e.dataTransfer.types.includes("Files") && e.preventDefault()}
      onDrop={async (e) => {
        e.preventDefault();
        const paths = [...e.dataTransfer.files].map((f) => window.motif.pathForFile(f)).filter(Boolean);
        if (paths.length) importIntoSession(session, await window.motif.importMediaPaths(paths));
      }}
    >
      <div className="panel-head">
        <button className="import-btn" onClick={async () => importIntoSession(session, await window.motif.importMediaDialog())}>
          <Icon name="export" size={15} style={{ transform: "rotate(180deg)" }} /> Import media
        </button>
      </div>
      <div className="seg-pill" role="tablist">
        {([["all", "All Media"], ["video", "Video"], ["image", "Image"], ["audio", "Sound"], ["fav", "★"]] as const).map(([k, l]) => (
          <button key={k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>{l}</button>
        ))}
      </div>
      <div className="search-wrap">
        <Icon name="search" size={14} />
        <input placeholder="Search media" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search media" />
      </div>
      {assets.length === 0 ? (
        <div className="empty drop-hint">{project.assets.length ? "Nothing matches." : "Drop video, audio or images here, or click Import media."}</div>
      ) : (
        <div className="bin-grid">
          {assets.map((a) => {
            const d = ui.derived[a.id];
            const missing = ui.missing.has(a.id);
            const used = project.tracks.some((t) => t.clips.some((c) => c.assetId === a.id));
            return (
              <div
                key={a.id}
                className={"bin-item" + (missing ? " missing" : "")}
                draggable={!missing}
                onDragStart={(e) => e.dataTransfer.setData("application/x-motif-asset", a.id)}
                onDoubleClick={() => !missing && addAtPlayhead(a)}
                title={`${a.name}\n${a.meta.width ? `${a.meta.width}×${a.meta.height} ` : ""}${a.meta.videoCodec ?? ""} ${a.meta.audioCodec ?? ""}\nDouble-click to add at the playhead`}
              >
                <div className="bin-thumb">
                  {d?.thumbnailUrl ? <img src={d.thumbnailUrl} alt="" draggable={false} /> : a.kind === "audio" ? <MiniWave peaks={d?.peaks} /> : <span className="dim small">{d?.error ? "No preview" : "…"}</span>}
                  {a.kind !== "image" && <span className="dur">{a.meta.durationSec.toFixed(1)}s</span>}
                  {a.meta.variableFrameRate && <span className="vfr" title="Variable frame rate footage">VFR</span>}
                  <div className="bin-hover">
                    <button title={a.favorite ? "Unfavourite" : "Favourite"} onClick={() => session.run("Favourite", (p) => updateAsset(p, a.id, { favorite: !a.favorite }))}>{a.favorite ? "★" : "☆"}</button>
                    {missing ? (
                      <button
                        onClick={async () => {
                          const r = await window.motif.relinkAsset(a.id);
                          if (!r) return;
                          session.run("Relink media", (p) => updateAsset(p, a.id, { path: r.path, meta: r.meta, fingerprint: r.fingerprint, name: r.name }));
                          const m = new Set(session.ui.missing);
                          m.delete(a.id);
                          session.setUi({ missing: m });
                          derive(session, { ...a, ...r });
                        }}
                      >Relink</button>
                    ) : (
                      <button title="Add at playhead" onClick={() => addAtPlayhead(a)}><Icon name="plus" size={13} /></button>
                    )}
                    <button title={used ? "In use on the timeline" : "Remove from project (file stays on disk)"} disabled={used} onClick={() => session.run("Remove media", (p) => removeAsset(p, a.id))}><Icon name="x" size={12} /></button>
                  </div>
                </div>
                <div className="bin-name">{missing ? "⚠ " : ""}{a.name}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function MiniWave({ peaks }: { peaks?: number[] }) {
  if (!peaks?.length) return <Icon name="wave" size={28} />;
  const n = 28;
  const step = Math.max(1, Math.floor(peaks.length / n));
  const max = Math.max(0.01, ...peaks);
  return (
    <div className="mini-wave">
      {Array.from({ length: n }, (_, i) => (
        <i key={i} style={{ height: `${Math.max(8, ((peaks[i * step] ?? 0) / max) * 90)}%` }} />
      ))}
    </div>
  );
}

function AudioTab({ session }: { session: EditorSession }) {
  const { project, ui } = useSession(session);
  const [text, setText] = useState("Welcome to my channel! Today we are making something amazing.");
  const [voice, setVoice] = useState("slt");
  const [voices, setVoices] = useState<{ id: string; label: string }[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    window.motif.voices().then(setVoices);
  }, []);
  const addAudio = (a: MediaAsset, at: number) => {
    session.run("Add audio", (p) => {
      let next = p.assets.some((x) => x.id === a.id) ? p : addAsset(p, a);
      const track = next.tracks.find((t) => t.kind === "audio")!;
      next = insertMediaClip(next, { trackId: track.id, assetId: a.id, start: at, findFreeSlot: true }).project;
      return next;
    });
    derive(session, a);
  };
  return (
    <div className="panel-body">
      <div className="tool-card">
        <strong><Icon name="mic" size={14} /> Text to speech</strong>
        <p className="hint">Offline voices (libflite). The voice-over lands on the audio track at the playhead.</p>
        <textarea rows={3} value={text} maxLength={3000} onChange={(e) => setText(e.target.value)} aria-label="Text to speak" />
        <div className="chip-grid">
          {voices.map((v) => (
            <button key={v.id} className={voice === v.id ? "on" : ""} onClick={() => setVoice(v.id)}>{v.label}</button>
          ))}
        </div>
        <button
          className="primary"
          disabled={busy || !text.trim()}
          onClick={async () => {
            setBusy(true);
            try {
              const a = await window.motif.textToSpeech(text, voice);
              addAudio(a, ui.playhead);
              session.toast("Voice-over added", "ok");
            } catch (e: any) {
              session.toast(e.message, "error");
            } finally {
              setBusy(false);
            }
          }}
        >{busy ? "Generating…" : "Generate voice-over"}</button>
      </div>
      <h5 className="list-title">Your sounds</h5>
      {project.assets.filter((a) => a.kind === "audio").map((a) => (
        <div key={a.id} className="audio-row" draggable onDragStart={(e) => e.dataTransfer.setData("application/x-motif-asset", a.id)}>
          <Icon name="audio" size={14} />
          <span className="ellipsis">{a.name}</span>
          <span className="dim small">{a.meta.durationSec.toFixed(1)}s</span>
          <button className="icon-btn" onClick={() => addAudio(a, ui.playhead)}><Icon name="plus" size={13} /></button>
        </div>
      ))}
      <button onClick={async () => importIntoSession(session, await window.motif.importMediaDialog())}>Import music…</button>
      <p className="hint">MOTIF ships no stock music. Use audio you own or have a licence for.</p>
    </div>
  );
}

function TextTab({ session }: { session: EditorSession }) {
  const { project, ui } = useSession(session);
  const fps = project.profile.fps;
  const presets = [
    { k: "title", label: "Bold title", sample: "Your title", style: { font: "poppins", fontSize: 110, bold: true, strokeWidth: 0, shadow: true } },
    { k: "neon", label: "Neon", sample: "NEON NIGHTS", style: { font: "bebas", fontSize: 150, color: "#7ff7ff", strokeColor: "#ff2bd6", strokeWidth: 3, shadow: true } },
    { k: "impact", label: "Impact", sample: "BREAKING", style: { font: "anton", fontSize: 140, color: "#ffffff", strokeColor: "#000000", strokeWidth: 6, shadow: false } },
    { k: "elegant", label: "Elegant", sample: "Chapter One", style: { font: "playfair", fontSize: 100, bold: false, color: "#f5e6c8", shadow: true } },
    { k: "script", label: "Script", sample: "Summer vibes", style: { font: "pacifico", fontSize: 110, color: "#ffd166", shadow: true } },
    { k: "lower", label: "Lower third", sample: "Bilel · Creator", style: { font: "poppins", fontSize: 54, align: "lower-third", boxColor: "#14151c", boxOpacity: 0.8 } },
    { k: "caption", label: "Caption", sample: "Caption text", style: { font: "poppins", fontSize: 54, align: "lower-third", boxColor: "#000000", boxOpacity: 0.55 }, role: "caption" },
  ] as const;
  return (
    <div className="panel-body">
      <p className="hint">Click to add at the playhead, or drag onto a track.</p>
      <div className="text-grid">
        {presets.map((t) => {
          const f = FONTS.find((x) => x.id === t.style.font)!;
          return (
            <button
              key={t.k}
              className="text-preset"
              draggable
              onDragStart={(e) => e.dataTransfer.setData("application/x-motif-text", t.k === "caption" ? "caption" : "title")}
              onClick={() => {
                const track = project.tracks.find((x) => x.kind === "text" && !x.locked);
                if (!track) return session.toast("Add a text track first", "error");
                session.run("Add text", (p) => {
                  const r = insertTextClip(p, { trackId: track.id, start: ui.playhead, duration: secondsToFrames(3, fps), content: t.sample, role: "role" in t ? t.role : "title", findFreeSlot: true });
                  const c = findClip(r.project, r.clipId)!.clip;
                  return updateClip(r.project, r.clipId, { text: { ...c.text!, ...(t.style as object) } });
                });
              }}
            >
              <span style={{ fontFamily: f.css, color: ("color" in t.style ? t.style.color : "#fff") as string, WebkitTextStroke: "strokeWidth" in t.style && t.style.strokeWidth ? `1px ${t.style.strokeColor}` : undefined }}>{t.sample}</span>
              <small>{t.label}</small>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ShapesTab({ session }: { session: EditorSession }) {
  const { project, ui } = useSession(session);
  const fps = project.profile.fps;
  const colors = ["#8b6cff", "#ff7a3d", "#20c9a6", "#ff4f8b", "#ffd166", "#ffffff", "#111111"];
  const [color, setColor] = useState(colors[0]!);
  const add = (type: "rect" | "ellipse") => {
    const track = project.tracks.find((t) => t.kind === "video" && t.name !== "Video 1" && !t.locked) ?? project.tracks.find((t) => t.kind === "video");
    if (!track) return;
    session.run("Add shape", (p) => insertShapeClip(p, { trackId: track.id, start: ui.playhead, duration: secondsToFrames(3, fps), type, fill: color }).project);
  };
  return (
    <div className="panel-body">
      <div className="swatches">
        {colors.map((c) => (
          <button key={c} className={"swatch" + (c === color ? " on" : "")} style={{ background: c }} aria-label={`Colour ${c}`} onClick={() => setColor(c)} />
        ))}
        <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label="Custom colour" />
      </div>
      <div className="shape-grid">
        <button draggable onDragStart={(e) => e.dataTransfer.setData("application/x-motif-shape", `rect|${color}`)} onClick={() => add("rect")}><span className="shape-rect" style={{ background: color }} />Rectangle</button>
        <button draggable onDragStart={(e) => e.dataTransfer.setData("application/x-motif-shape", `ellipse|${color}`)} onClick={() => add("ellipse")}><span className="shape-ellipse" style={{ background: color }} />Circle</button>
      </div>
      <p className="hint">Shapes are vector layers: move, scale and rotate them on the canvas, animate them and mask them.</p>
    </div>
  );
}

function FiltersTab({ session }: { session: EditorSession }) {
  const { project, ui } = useSession(session);
  const sel = ui.selection.map((id) => findClip(project, id)).filter((h) => h && h.clip.kind === "media" && h.track.kind !== "audio");
  const thumb = sel[0] ? ui.derived[sel[0].clip.assetId!]?.thumbnailUrl : project.assets.map((a) => ui.derived[a.id]?.thumbnailUrl).find(Boolean);
  return (
    <div className="panel-body">
      <p className="hint">{sel.length ? `Applies to ${sel.length} selected clip${sel.length > 1 ? "s" : ""}.` : "Select a video or image clip, then pick a filter."}</p>
      <div className="filter-grid">
        {[{ id: "", label: "None" }, ...LOOKS].map((l) => (
          <button
            key={l.id || "none"}
            disabled={!sel.length}
            className={sel[0]?.clip.color.look === l.id ? "on" : ""}
            onClick={() => session.run(`Filter ${l.label}`, (p) => sel.reduce((acc, h) => applyLook(acc, h!.clip.id, l.id || null), p))}
          >
            <span className={`filter-thumb look-${l.id || "none"}`} style={thumb ? { backgroundImage: `url("${thumb}")` } : undefined} />
            {l.label}
          </button>
        ))}
      </div>
      <p className="hint">Fine-tune brightness, temperature, blur and more under Adjust in the inspector.</p>
    </div>
  );
}

function TransitionsTab({ session }: { session: EditorSession }) {
  const { project, ui } = useSession(session);
  const fps = project.profile.fps;
  const hit = ui.selection[0] ? findClip(project, ui.selection[0]) : null;
  const hasPrev = hit ? hit.track.clips.some((c) => clipEnd(c) === hit.clip.start) : false;
  return (
    <div className="panel-body">
      <p className="hint">{hit ? (hasPrev ? "Applies between the selected clip and the one before it." : "The selected clip needs a clip right before it on the same track.") : "Select the second of two touching clips."}</p>
      <div className="trans-grid">
        {TRANSITION_KINDS.map((k) => (
          <button key={k} disabled={!hasPrev} className={hit?.clip.transitionIn?.kind === k ? "on" : ""} onClick={() => session.run("Transition", (p) => setTransition(p, hit!.clip.id, k, hit!.clip.transitionIn?.frames ?? secondsToFrames(0.5, fps)))}>
            <span className={`trans-thumb t-${k}`}><i /><b /></span>
            {k.replace(/-/g, " ")}
          </button>
        ))}
      </div>
      {hit?.clip.transitionIn && <button onClick={() => session.run("Remove transition", (p) => setTransition(p, hit.clip.id, null, 0))}>Remove transition</button>}
    </div>
  );
}

function CaptionsTab({ session }: { session: EditorSession }) {
  const { project, ui } = useSession(session);
  const fps = project.profile.fps;
  const [model, setModel] = useState<"tiny" | "base" | "small">("base");
  const [lang, setLang] = useState("");
  const [status, setStatus] = useState<{ whisper: boolean; message?: string } | null>(null);
  useEffect(() => {
    window.motif.aiStatus().then(setStatus);
  }, []);
  const cues = project.tracks.flatMap((t) => t.clips.filter((c) => c.kind === "text" && c.text?.role === "caption")).sort((a, b) => a.start - b.start);
  // what to transcribe: selected clip with audio, else the first clip on the timeline that has audio
  const sources = project.tracks.flatMap((t) => (t.kind === "text" ? [] : t.clips.filter((c) => c.kind === "media" && project.assets.find((a) => a.id === c.assetId)?.meta.hasAudio && !c.audio.muted)));
  const target = (ui.selection[0] && sources.find((c) => c.id === ui.selection[0])) || sources[0];
  const auto = async () => {
    if (!target) return session.toast("Add a clip with speech first", "error");
    const asset = project.assets.find((a) => a.id === target.assetId)!;
    try {
      const tr = await runJob<{ segments: { start: number; end: number; text: string; words: { start: number; end: number; word: string }[] }[]; language: string }>(session, "Transcribing speech", () => window.motif.transcribe(asset, { model, ...(lang ? { language: lang } : {}) }));
      const words = tr.segments.flatMap((s) => (s.words.length ? s.words : [{ start: s.start, end: s.end, word: s.text }]));
      // source seconds -> timeline seconds for this clip
      const speed = target.speed.num / target.speed.den;
      const srcIn = framesToSeconds(target.sourceIn, fps);
      const clipStart = framesToSeconds(target.start, fps);
      const clipLen = framesToSeconds(target.duration, fps);
      const mapped = words
        .map((w) => ({ ...w, start: clipStart + (w.start - srcIn) / speed, end: clipStart + (w.end - srcIn) / speed }))
        .filter((w) => w.end > clipStart && w.start < clipStart + clipLen);
      const list = wordsToCues(mapped, 6, 3);
      let count = 0;
      session.run("Auto captions", (p) => {
        const r = insertCaptionCues(p, list);
        count = r.count;
        return r.project;
      });
      session.toast(`Added ${count} captions (${tr.language || "auto"})`, "ok");
    } catch (e: any) {
      if (e.message !== "cancelled") session.toast(e.message, "error");
    }
  };
  return (
    <div className="panel-body">
      <div className="tool-card accent">
        <strong><Icon name="sparkle" size={14} /> Auto captions</strong>
        <p className="hint">Speech-to-text with Whisper, running locally on your CPU. Your media never leaves this computer. The model downloads once on first use.</p>
        {status && !status.whisper && <p className="warn-line">{status.message}</p>}
        <div className="row-2">
          <label className="field"><span>Accuracy</span>
            <select value={model} onChange={(e) => setModel(e.target.value as any)}>
              <option value="tiny">Fast (tiny)</option>
              <option value="base">Balanced (base)</option>
              <option value="small">Accurate (small)</option>
            </select>
          </label>
          <label className="field"><span>Language</span>
            <select value={lang} onChange={(e) => setLang(e.target.value)}>
              <option value="">Auto-detect</option>
              <option value="en">English</option>
              <option value="fr">Français</option>
              <option value="ar">العربية</option>
              <option value="es">Español</option>
              <option value="de">Deutsch</option>
            </select>
          </label>
        </div>
        <button className="primary" disabled={!status?.whisper || !!ui.job || !target} onClick={auto}>
          {ui.job ? "Working…" : target ? `Generate captions for "${target.name.slice(0, 18)}"` : "Add a clip with speech"}
        </button>
      </div>
      <div className="bin-tools">
        <button
          onClick={async () => {
            const srt = await window.motif.importSrtDialog();
            if (!srt) return;
            const parsed = parseSrt(srt);
            if (!parsed.length) return session.toast("No captions found in that file", "error");
            const track = project.tracks.find((t) => t.kind === "text");
            if (!track) return session.toast("Add a text track first", "error");
            if (session.run("Import captions", (p) => importCaptions(p, track.id, parsed))) session.toast(`Imported ${parsed.length} captions`, "ok");
          }}
        >Import SRT</button>
        <button disabled={!cues.length} onClick={async () => { if (await window.motif.exportSrtDialog(toSrt(captionCues(project)), project.title)) session.toast("Saved captions", "ok"); }}>Export SRT</button>
      </div>
      {cues.length === 0 ? (
        <div className="empty">No captions yet.</div>
      ) : (
        <div className="cue-list">
          {cues.map((c) => (
            <div key={c.id} className={"cue" + (ui.selection.includes(c.id) ? " on" : "")}>
              <button className="cue-time" onClick={() => session.setUi({ playhead: c.start, selection: [c.id] })}>{framesToSeconds(c.start, fps).toFixed(1)}s</button>
              <textarea
                value={c.text!.content}
                rows={2}
                onChange={(e) => session.runCoalesced("Edit caption", `${c.id}:text`, (p) => updateClip(p, c.id, { text: { ...findClip(p, c.id)!.clip.text!, content: e.target.value }, name: e.target.value.slice(0, 32) }))}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AiTab({ session }: { session: EditorSession }) {
  const { project, ui } = useSession(session);
  const [threshold, setThreshold] = useState(-35);
  const [minSec, setMinSec] = useState(0.6);
  const [found, setFound] = useState<{ clipId: string; ranges: { start: number; end: number }[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const sel = ui.selection[0] ? findClip(project, ui.selection[0]) : null;
  const asset = sel?.clip.assetId ? project.assets.find((a) => a.id === sel.clip.assetId) : undefined;
  const fps = project.profile.fps;

  const detect = async () => {
    if (!sel || !asset) return;
    setBusy("silence");
    try {
      const r = await window.motif.detectSilences(asset, { thresholdDb: threshold, minSec });
      const c = sel.clip;
      const ranges = r
        .map((x) => ({
          start: c.start + Math.ceil(((secondsToFrames(x.startSec, fps) - c.sourceIn) * c.speed.den) / c.speed.num),
          end: c.start + Math.floor(((secondsToFrames(x.endSec, fps) - c.sourceIn) * c.speed.den) / c.speed.num),
        }))
        .map((x) => ({ start: Math.max(x.start, c.start), end: Math.min(x.end, clipEnd(c)) }))
        .filter((x) => x.end - x.start >= 2);
      setFound({ clipId: c.id, ranges });
      session.toast(ranges.length ? `Found ${ranges.length} silent section(s)` : "No silences found with these settings", ranges.length ? "ok" : "info");
    } catch (e: any) {
      session.toast(e.message, "error");
    } finally {
      setBusy(null);
    }
  };
  const removeAll = () => {
    if (!found) return;
    session.run("Remove silences", (p) => {
      let next = p;
      let currentId = found.clipId;
      for (const r of [...found.ranges].sort((a, b) => b.start - a.start)) {
        const hit = findClip(next, currentId);
        if (!hit) break;
        let target = currentId;
        if (r.end < clipEnd(hit.clip)) {
          const s = splitClip(next, target, r.end);
          next = s.project;
          target = s.leftId;
        }
        const h2 = findClip(next, target)!;
        if (r.start > h2.clip.start) {
          const s = splitClip(next, target, r.start);
          next = rippleDelete(s.project, s.rightId);
          currentId = s.leftId;
        } else next = rippleDelete(next, target);
      }
      return next;
    });
    setFound(null);
  };

  return (
    <div className="panel-body">
      <p className="hint">Every tool here runs locally. {sel ? `Selected: ${sel.clip.name}` : "Select a clip first."}</p>
      <div className="tool-card">
        <strong><Icon name="scissorsAudio" size={14} /> Remove silences</strong>
        <label className="field"><span>Threshold {threshold} dB</span><input type="range" min={-60} max={-15} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} /></label>
        <label className="field"><span>Min length {minSec.toFixed(1)} s</span><input type="range" min={0.2} max={3} step={0.1} value={minSec} onChange={(e) => setMinSec(Number(e.target.value))} /></label>
        <button className="primary" disabled={!asset?.meta.hasAudio || !!busy} onClick={detect}>{busy === "silence" ? "Analysing…" : "Find silences"}</button>
        {found && found.ranges.length > 0 && (
          <>
            <ul className="ranges">
              {found.ranges.map((r, i) => (
                <li key={i}><button className="link" onClick={() => session.setUi({ playhead: r.start })}>{framesToSeconds(r.start, fps).toFixed(2)}s – {framesToSeconds(r.end, fps).toFixed(2)}s</button></li>
              ))}
            </ul>
            <button onClick={removeAll}>Cut {found.ranges.length} section(s) and close gaps</button>
          </>
        )}
      </div>
      <div className="tool-card">
        <strong><Icon name="stabilize" size={14} /> Stabilize</strong>
        <p className="hint">Two-pass vid.stab analysis. Creates a stabilized copy and swaps it into the clip; your original file is untouched.</p>
        <button
          disabled={asset?.kind !== "video" || !!ui.job}
          onClick={async () => {
            try {
              const a = await runJob<MediaAsset>(session, "Stabilizing", () => window.motif.stabilize(asset!));
              session.run("Stabilize", (p) => updateClip(addAsset(p, a), sel!.clip.id, { assetId: a.id, name: a.name }));
              derive(session, a);
              session.toast("Stabilized", "ok");
            } catch (e: any) {
              if (e.message !== "cancelled") session.toast(e.message, "error");
            }
          }}
        >Stabilize clip</button>
      </div>
      <div className="tool-card">
        <strong><Icon name="audio" size={14} /> Extract audio</strong>
        <p className="hint">Detaches the sound onto an audio track (as a new WAV) and mutes the video clip.</p>
        <button
          disabled={asset?.kind !== "video" || !asset.meta.hasAudio || !!busy}
          onClick={async () => {
            setBusy("extract");
            try {
              const a = await window.motif.extractAudio(asset!);
              session.run("Extract audio", (p) => detachAudio(addAsset(p, a), sel!.clip.id, a.id).project);
              derive(session, a);
            } catch (e: any) {
              session.toast(e.message, "error");
            } finally {
              setBusy(null);
            }
          }}
        >{busy === "extract" ? "Extracting…" : "Extract audio"}</button>
      </div>
      <div className="tool-card">
        <strong><Icon name="captions" size={14} /> Auto captions</strong>
        <button onClick={() => session.setUi({ leftTab: "captions" })}>Open captions</button>
      </div>
      <div className="tool-card disabled" aria-disabled>
        <strong>Background removal · Auto reframe</strong>
        <p className="hint">Planned: needs a segmentation model (not bundled yet). Use Chroma key or Mask meanwhile.</p>
      </div>
    </div>
  );
}
