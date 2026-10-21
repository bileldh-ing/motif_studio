import { useEffect, useState } from "react";
import type { MediaAsset } from "@motif/project-schema";
import { addAsset, updateAsset, removeAsset, insertMediaClip, insertTextClip, captionCues, toSrt, parseSrt, importCaptions, secondsToFrames, framesToSeconds, findClip, splitClip, rippleDelete, clipEnd } from "@motif/editor-core";
import { EditorSession, useSession } from "../editorStore";

export async function importIntoSession(session: EditorSession, res: { assets: MediaAsset[]; errors: { file: string; error: string }[] }) {
  let added = 0;
  session.run("Import media", (p) => {
    let next = p;
    for (const a of res.assets) {
      const dup = next.assets.find((x) => x.fingerprint && x.fingerprint === a.fingerprint);
      if (dup) continue;
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

const TABS = [
  ["media", "Media"],
  ["text", "Text"],
  ["audio", "Audio"],
  ["captions", "Captions"],
  ["tools", "Smart tools"],
] as const;

export function LeftPanel({ session }: { session: EditorSession }) {
  const { project, ui } = useSession(session);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"name" | "kind" | "duration">("name");
  const [filter, setFilter] = useState<"all" | "video" | "audio" | "image" | "fav">("all");

  useEffect(() => {
    for (const a of project.assets) derive(session, a);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.assets.length]);

  const assets = project.assets
    .filter((a) => (filter === "all" ? true : filter === "fav" ? a.favorite : a.kind === filter))
    .filter((a) => a.name.toLowerCase().includes(q.toLowerCase()) || a.tags.some((t) => t.includes(q.toLowerCase())))
    .sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name) : sort === "kind" ? a.kind.localeCompare(b.kind) : b.meta.durationSec - a.meta.durationSec));

  const addAtPlayhead = (a: MediaAsset) => {
    const track = a.kind === "audio" ? project.tracks.find((t) => t.kind === "audio") : project.tracks.find((t) => t.kind === "video" && !t.locked);
    if (!track) return session.toast("Add a track first", "error");
    session.run("Add clip", (p) => insertMediaClip(p, { trackId: track.id, assetId: a.id, start: ui.playhead, findFreeSlot: true }).project);
  };

  return (
    <div className="left">
      <div className="tabs" role="tablist">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={ui.leftTab === k} className={ui.leftTab === k ? "on" : ""} onClick={() => session.setUi({ leftTab: k })}>{label}</button>
        ))}
      </div>

      {ui.leftTab === "media" && (
        <div
          className="panel-body"
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("Files")) e.preventDefault();
          }}
          onDrop={async (e) => {
            e.preventDefault();
            const paths = [...e.dataTransfer.files].map((f) => window.motif.pathForFile(f)).filter(Boolean);
            if (paths.length) importIntoSession(session, await window.motif.importMediaPaths(paths));
          }}
        >
          <div className="bin-tools">
            <button className="primary" onClick={async () => importIntoSession(session, await window.motif.importMediaDialog())}>Import</button>
            <input className="search" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search media" />
          </div>
          <div className="bin-tools">
            <select className="mini" value={filter} onChange={(e) => setFilter(e.target.value as any)} aria-label="Filter">
              <option value="all">All</option>
              <option value="video">Video</option>
              <option value="audio">Audio</option>
              <option value="image">Images</option>
              <option value="fav">Favorites</option>
            </select>
            <select className="mini" value={sort} onChange={(e) => setSort(e.target.value as any)} aria-label="Sort">
              <option value="name">Name</option>
              <option value="kind">Type</option>
              <option value="duration">Duration</option>
            </select>
          </div>
          {assets.length === 0 ? (
            <div className="empty drop-hint">{project.assets.length ? "Nothing matches." : "Drop video, audio or images here, or click Import."}</div>
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
                    title={`${a.name}\n${a.meta.width ? `${a.meta.width}×${a.meta.height} ` : ""}${a.meta.videoCodec ?? ""} ${a.meta.audioCodec ?? ""}\nDouble-click to add at playhead`}
                  >
                    <div className="bin-thumb">
                      {d?.thumbnailUrl ? <img src={d.thumbnailUrl} alt="" /> : a.kind === "audio" ? <span className="audio-glyph">♪</span> : <span className="dim small">{d?.error ? "No preview" : "…"}</span>}
                      {a.kind !== "image" && <span className="dur">{a.meta.durationSec.toFixed(1)}s</span>}
                      {a.meta.variableFrameRate && <span className="vfr" title="Variable frame rate footage">VFR</span>}
                    </div>
                    <div className="bin-name">{missing ? "⚠ " : ""}{a.name}</div>
                    <div className="bin-actions">
                      <button title={a.favorite ? "Unfavorite" : "Favorite"} onClick={() => session.run("Favorite", (p) => updateAsset(p, a.id, { favorite: !a.favorite }))}>{a.favorite ? "★" : "☆"}</button>
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
                        <button onClick={() => addAtPlayhead(a)}>Add</button>
                      )}
                      <button
                        title={used ? "In use on the timeline" : "Remove from project (file stays on disk)"}
                        disabled={used}
                        onClick={() => session.run("Remove media", (p) => removeAsset(p, a.id))}
                      >✕</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {ui.leftTab === "text" && (
        <div className="panel-body">
          <p className="hint">Drag onto a track, or click to add at the playhead.</p>
          {[
            { k: "title", label: "Title", sample: "Your title", cls: "t-title" },
            { k: "caption", label: "Caption", sample: "Caption text", cls: "t-caption" },
            { k: "lower", label: "Lower third", sample: "Name · Role", cls: "t-lower" },
          ].map((t) => (
            <button
              key={t.k}
              className={"text-preset " + t.cls}
              draggable
              onDragStart={(e) => e.dataTransfer.setData("application/x-motif-text", t.k === "caption" ? "caption" : "title")}
              onClick={() => {
                const track = project.tracks.find((x) => x.kind === "text");
                if (!track) return session.toast("Add a text track first", "error");
                const fps = project.profile.fps;
                session.run("Add text", (p) => {
                  const r = insertTextClip(p, { trackId: track.id, start: ui.playhead, duration: secondsToFrames(3, fps), content: t.sample, role: t.k === "caption" ? "caption" : "title", findFreeSlot: true });
                  if (t.k === "lower") {
                    const c = findClip(r.project, r.clipId)!.clip;
                    return { ...r.project, tracks: r.project.tracks.map((tr) => ({ ...tr, clips: tr.clips.map((x) => (x.id === c.id ? { ...x, text: { ...x.text!, align: "lower-third" as const, fontSize: 60, boxColor: "#1b1d24" } } : x)) })) };
                  }
                  return r.project;
                });
              }}
            >
              <span>{t.sample}</span>
              <small>{t.label}</small>
            </button>
          ))}
        </div>
      )}

      {ui.leftTab === "audio" && (
        <div className="panel-body">
          <p className="hint">MOTIF ships no stock music. Import your own licensed audio and it appears here.</p>
          {project.assets.filter((a) => a.kind === "audio").map((a) => (
            <div key={a.id} className="audio-row" draggable onDragStart={(e) => e.dataTransfer.setData("application/x-motif-asset", a.id)}>
              <span>♪ {a.name}</span>
              <span className="dim small">{a.meta.durationSec.toFixed(1)}s</span>
              <button onClick={() => addAtPlayhead(a)}>Add</button>
            </div>
          ))}
          <button onClick={async () => importIntoSession(session, await window.motif.importMediaDialog())}>Import audio…</button>
        </div>
      )}

      {ui.leftTab === "captions" && <CaptionsPanel session={session} />}
      {ui.leftTab === "tools" && <ToolsPanel session={session} />}
    </div>
  );
}

function CaptionsPanel({ session }: { session: EditorSession }) {
  const { project, ui } = useSession(session);
  const fps = project.profile.fps;
  const cues = project.tracks.flatMap((t) => t.clips.filter((c) => c.kind === "text" && c.text?.role === "caption").map((c) => ({ c, t }))).sort((a, b) => a.c.start - b.c.start);
  return (
    <div className="panel-body">
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
        <button
          disabled={!cues.length}
          onClick={async () => {
            const out = await window.motif.exportSrtDialog(toSrt(captionCues(project)), project.title);
            if (out) session.toast("Saved captions", "ok");
          }}
        >Export SRT</button>
      </div>
      <div className="ai-note">
        <strong>Auto captions (speech-to-text)</strong>
        <p>Not available yet. It needs the optional local Whisper worker (Phase 6). Import an SRT or type captions below; they burn into the export and save as SRT.</p>
      </div>
      {cues.length === 0 ? (
        <div className="empty">No captions yet. Add one from the Text tab.</div>
      ) : (
        <div className="cue-list">
          {cues.map(({ c }) => (
            <div key={c.id} className={"cue" + (ui.selection.includes(c.id) ? " on" : "")}>
              <button className="cue-time" onClick={() => session.setUi({ playhead: c.start, selection: [c.id] })}>{framesToSeconds(c.start, fps).toFixed(2)}s</button>
              <textarea
                value={c.text!.content}
                rows={2}
                onChange={(e) => session.runCoalesced("Edit caption", `${c.id}:text`, (p) => ({ ...p, tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.map((x) => (x.id === c.id ? { ...x, text: { ...x.text!, content: e.target.value }, name: e.target.value.slice(0, 32) } : x)) })) }))}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ToolsPanel({ session }: { session: EditorSession }) {
  const { project, ui } = useSession(session);
  const [threshold, setThreshold] = useState(-35);
  const [minSec, setMinSec] = useState(0.6);
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<{ clipId: string; ranges: { start: number; end: number }[] } | null>(null);
  const sel = ui.selection[0] ? findClip(project, ui.selection[0]) : null;
  const asset = sel?.clip.assetId ? project.assets.find((a) => a.id === sel.clip.assetId) : undefined;
  const fps = project.profile.fps;

  const detect = async () => {
    if (!sel || !asset) return;
    setBusy(true);
    try {
      const r = await window.motif.detectSilences(asset, { thresholdDb: threshold, minSec });
      const c = sel.clip;
      const speed = c.speed.num / c.speed.den;
      // map source seconds -> timeline frames inside this clip
      const ranges = r
        .map((x) => ({
          start: c.start + Math.ceil(((secondsToFrames(x.startSec, fps) - c.sourceIn) * c.speed.den) / c.speed.num),
          end: c.start + Math.floor(((secondsToFrames(x.endSec, fps) - c.sourceIn) * c.speed.den) / c.speed.num),
        }))
        .map((x) => ({ start: Math.max(x.start, c.start), end: Math.min(x.end, clipEnd(c)) }))
        .filter((x) => x.end - x.start >= 2);
      void speed;
      setFound({ clipId: c.id, ranges });
      session.toast(ranges.length ? `Found ${ranges.length} silent section(s)` : "No silences found with these settings", ranges.length ? "ok" : "info");
    } catch (e: any) {
      session.toast(e.message, "error");
    } finally {
      setBusy(false);
    }
  };

  const removeAll = () => {
    if (!found) return;
    session.run("Remove silences", (p) => {
      let next = p;
      let currentId = found.clipId;
      // work from the end so earlier frame numbers stay valid
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
          next = s.project;
          next = rippleDelete(next, s.rightId);
          currentId = s.leftId;
        } else {
          next = rippleDelete(next, target);
        }
      }
      return next;
    });
    setFound(null);
  };

  return (
    <div className="panel-body">
      <div className="tool-card">
        <strong>Remove silences</strong>
        <p className="hint">Runs locally with FFmpeg. Nothing leaves your computer. Select an audio or video clip with sound.</p>
        <label className="field"><span>Threshold {threshold} dB</span><input type="range" min={-60} max={-15} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} /></label>
        <label className="field"><span>Min length {minSec.toFixed(1)} s</span><input type="range" min={0.2} max={3} step={0.1} value={minSec} onChange={(e) => setMinSec(Number(e.target.value))} /></label>
        <button className="primary" disabled={!asset?.meta.hasAudio || busy} onClick={detect}>{busy ? "Analyzing…" : "Find silences"}</button>
        {!asset?.meta.hasAudio && <p className="hint">Select a clip that has audio.</p>}
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
      {[
        ["Auto captions", "Needs the optional local Whisper worker (Phase 6)."],
        ["Background removal", "Needs a segmentation model (Phase 6)."],
        ["Auto reframe", "Needs subject tracking (Phase 6)."],
        ["Voice enhance", "Planned: local denoise model."],
      ].map(([t, why]) => (
        <div key={t} className="tool-card disabled" aria-disabled>
          <strong>{t}</strong>
          <p className="hint">{why}</p>
        </div>
      ))}
    </div>
  );
}
