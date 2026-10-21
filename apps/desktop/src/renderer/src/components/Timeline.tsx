/**
 * Multitrack timeline. Only clips intersecting the visible window are
 * rendered (horizontal virtualization), and drag previews are kept in local
 * state so the project document is committed once per gesture (one undo step).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Clip, Project, Track } from "@motif/project-schema";
import {
  clipEnd,
  projectDuration,
  framesToSeconds,
  moveClip,
  trimStart,
  trimEnd,
  snap,
  snapPoints,
  addTrack,
  updateTrack,
  removeTrack,
  insertMediaClip,
  insertTextClip,
  formatTimecode,
} from "@motif/editor-core";
import { EditorSession, useSession } from "../editorStore";

const HEADER_W = 168;
const RULER_H = 28;
const TRACK_H: Record<Track["kind"], number> = { video: 64, text: 40, audio: 56 };

type Drag =
  | { kind: "move"; clipId: string; fromTrack: string; grabOffset: number; frame: number; trackId: string; startX: number; moved: boolean }
  | { kind: "trimL" | "trimR"; clipId: string; frame: number }
  | { kind: "scrub" };

export function Timeline({ session }: { session: EditorSession }) {
  const { project, ui } = useSession(session);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollX, setScrollX] = useState(0);
  const [viewW, setViewW] = useState(1000);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [snapLine, setSnapLine] = useState<number | null>(null);
  const [snapping, setSnapping] = useState(true);
  const fps = project.profile.fps;
  const ppf = ui.zoom; // pixels per frame
  const total = Math.max(projectDuration(project), Math.round((fps.num / fps.den) * 30));
  const contentW = (total + Math.round((fps.num / fps.den) * 20)) * ppf;

  useEffect(() => {
    window.motif.getSettings().then((s) => setSnapping(s.snapping));
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth - HEADER_W));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // keep playhead visible while playing
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !ui.playing) return;
    const x = ui.playhead * ppf;
    if (x > el.scrollLeft + viewW - 40) el.scrollLeft = x - 80;
  }, [ui.playhead, ui.playing, ppf, viewW]);

  const frameAtClientX = (clientX: number) => {
    const el = scrollRef.current!;
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.round((clientX - r.left - HEADER_W + el.scrollLeft) / ppf));
  };

  const trackAtClientY = (clientY: number): Track | null => {
    const rows = scrollRef.current!.querySelectorAll<HTMLElement>("[data-track-row]");
    for (const row of rows) {
      const r = row.getBoundingClientRect();
      if (clientY >= r.top && clientY < r.bottom) return project.tracks.find((t) => t.id === row.dataset.trackRow) ?? null;
    }
    return null;
  };

  const snapFrame = (f: number, ignore: string[]) => {
    if (!snapping) return { frame: f, snappedTo: null as number | null };
    return snap(f, snapPoints(project, ui.playhead, ignore), Math.max(1, Math.round(8 / ppf)));
  };

  // ------------------------------------------------------------ pointer handlers
  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      if (drag.kind === "scrub") {
        session.setUi({ playhead: frameAtClientX(e.clientX), playing: false });
        return;
      }
      const raw = frameAtClientX(e.clientX);
      if (drag.kind === "move") {
        const target = trackAtClientY(e.clientY);
        const start = Math.max(0, raw - drag.grabOffset);
        const c = project.tracks.flatMap((t) => t.clips).find((x) => x.id === drag.clipId)!;
        const s1 = snapFrame(start, [drag.clipId]);
        const s2 = snapFrame(start + c.duration, [drag.clipId]);
        let frame = start;
        let line: number | null = null;
        if (s1.snappedTo !== null) {
          frame = s1.frame;
          line = s1.frame;
        } else if (s2.snappedTo !== null) {
          frame = s2.frame - c.duration;
          line = s2.frame;
        }
        setSnapLine(line);
        setDrag({ ...drag, frame: Math.max(0, frame), trackId: target?.id ?? drag.trackId, moved: drag.moved || Math.abs(e.clientX - drag.startX) > 3 });
      } else {
        const s = snapFrame(raw, [drag.clipId]);
        setSnapLine(s.snappedTo);
        setDrag({ ...drag, frame: s.frame });
      }
    };
    const onUp = () => {
      if (drag.kind === "move" && drag.moved) {
        const id = drag.clipId;
        session.run("Move clip", (p) => moveClip(p, id, drag.frame, drag.trackId !== drag.fromTrack ? drag.trackId : undefined));
      } else if (drag.kind === "trimL") session.run("Trim clip start", (p) => trimStart(p, drag.clipId, drag.frame));
      else if (drag.kind === "trimR") session.run("Trim clip end", (p) => trimEnd(p, drag.clipId, drag.frame));
      setDrag(null);
      setSnapLine(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDrag(null);
        setSnapLine(null);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, project, ppf, snapping]);

  // ------------------------------------------------------------ drop from media bin
  const onDrop = (e: React.DragEvent, track: Track) => {
    e.preventDefault();
    const assetId = e.dataTransfer.getData("application/x-motif-asset");
    const textPreset = e.dataTransfer.getData("application/x-motif-text");
    const frame = frameAtClientX(e.clientX);
    if (assetId) {
      session.run("Add clip", (p) => {
        const asset = p.assets.find((a) => a.id === assetId)!;
        let target = track;
        if (asset.kind === "audio" && track.kind !== "audio") target = p.tracks.find((t) => t.kind === "audio") ?? track;
        return insertMediaClip(p, { trackId: target.id, assetId, start: frame, findFreeSlot: true }).project;
      });
    } else if (textPreset) {
      const role = textPreset === "caption" ? "caption" : "title";
      session.run("Add text", (p) =>
        insertTextClip(p, { trackId: track.kind === "audio" ? p.tracks.find((t) => t.kind === "text")!.id : track.id, start: frame, duration: Math.round((fps.num / fps.den) * 3), content: role === "caption" ? "Caption text" : "Your title", role, findFreeSlot: true }).project,
      );
    }
  };

  // ------------------------------------------------------------ ruler ticks
  const ticks = useMemo(() => {
    const fpsN = fps.num / fps.den;
    const secPerTick = [0.5, 1, 2, 5, 10, 30, 60, 120, 300].find((s) => s * fpsN * ppf >= 70) ?? 600;
    const out: { x: number; label: string }[] = [];
    const startSec = Math.floor(framesToSeconds(scrollX / ppf, fps) / secPerTick) * secPerTick;
    for (let s = startSec; s * fpsN * ppf < scrollX + viewW + 100; s += secPerTick) {
      const m = Math.floor(s / 60);
      const r = s - m * 60;
      out.push({ x: s * fpsN * ppf, label: `${m}:${String(Math.floor(r)).padStart(2, "0")}${r % 1 ? ".5" : ""}` });
    }
    return out;
  }, [scrollX, viewW, ppf, fps]);

  const visible = (c: Clip) => (clipEnd(c) * ppf >= scrollX - 50 && c.start * ppf <= scrollX + viewW + 50);

  const renderClip = (c: Clip, track: Track) => {
    let start = c.start;
    let dur = c.duration;
    let ghost = false;
    if (drag && "clipId" in drag && drag.clipId === c.id) {
      if (drag.kind === "move") {
        if (drag.trackId !== track.id) ghost = true;
        start = drag.frame;
      } else if (drag.kind === "trimL") {
        dur = clipEnd(c) - drag.frame;
        start = drag.frame;
      } else dur = drag.frame - c.start;
    }
    if (!visible({ ...c, start, duration: dur })) return null;
    const asset = c.assetId ? project.assets.find((a) => a.id === c.assetId) : undefined;
    const d = asset ? ui.derived[asset.id] : undefined;
    const sel = ui.selection.includes(c.id);
    const missing = asset && ui.missing.has(asset.id);
    const peaks = d?.peaks;
    const speed = c.speed.num / c.speed.den;
    return (
      <div
        key={c.id}
        className={`clip clip-${c.kind === "media" ? track.kind : c.kind}${sel ? " sel" : ""}${ghost ? " ghost" : ""}${missing ? " missing" : ""}${c.enabled ? "" : " disabled"}`}
        style={{ left: start * ppf, width: Math.max(4, dur * ppf) }}
        role="button"
        tabIndex={-1}
        aria-label={`${c.name || c.kind} clip`}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          if (track.locked) return session.toast(`Track "${track.name}" is locked`, "error");
          const multi = e.shiftKey || e.metaKey || e.ctrlKey;
          session.setUi({ selection: multi ? (sel ? ui.selection.filter((x) => x !== c.id) : [...ui.selection, c.id]) : [c.id] });
          const f = frameAtClientX(e.clientX);
          setDrag({ kind: "move", clipId: c.id, fromTrack: track.id, trackId: track.id, grabOffset: f - c.start, frame: c.start, startX: e.clientX, moved: false });
        }}
        title={`${c.name}\n${formatTimecode(c.start, fps)} → ${formatTimecode(clipEnd(c), fps)}${speed !== 1 ? `\nSpeed ${speed}×` : ""}`}
      >
        {d?.filmstripUrl && track.kind === "video" && <div className="filmstrip" style={{ backgroundImage: `url("${d.filmstripUrl}")` }} />}
        {peaks && track.kind === "audio" && <Waveform peaks={peaks} clip={c} ppf={ppf} fps={fps.num / fps.den} />}
        {c.transitionIn && <div className="xfade" style={{ width: c.transitionIn.frames * ppf }} title={`Crossfade ${c.transitionIn.frames} frames`} />}
        <span className="clip-label">
          {missing ? "⚠ " : ""}
          {c.kind === "text" ? `T  ${c.text?.content ?? ""}` : c.name}
          {speed !== 1 ? `  ${speed}×` : ""}
          {Object.keys(c.keyframes).length ? "  ◆" : ""}
        </span>
        <div className="handle l" onPointerDown={(e) => { e.stopPropagation(); if (!track.locked) setDrag({ kind: "trimL", clipId: c.id, frame: c.start }); }} />
        <div className="handle r" onPointerDown={(e) => { e.stopPropagation(); if (!track.locked) setDrag({ kind: "trimR", clipId: c.id, frame: clipEnd(c) }); }} />
      </div>
    );
  };

  return (
    <div className="timeline">
      <div className="tl-toolbar">
        <button onClick={() => session.run("Add video track", (p) => addTrack(p, "video").project)}>+ Video</button>
        <button onClick={() => session.run("Add text track", (p) => addTrack(p, "text").project)}>+ Text</button>
        <button onClick={() => session.run("Add audio track", (p) => addTrack(p, "audio").project)}>+ Audio</button>
        <span className="sep" />
        <label className="check">
          <input type="checkbox" checked={snapping} onChange={(e) => { setSnapping(e.target.checked); window.motif.setSettings({ snapping: e.target.checked }); }} /> Snap
        </label>
        <span className="grow" />
        <span className="dim small">Zoom</span>
        <input type="range" min={0.2} max={24} step={0.1} value={ppf} aria-label="Timeline zoom" onChange={(e) => session.setUi({ zoom: Number(e.target.value) })} />
        <button onClick={() => session.setUi({ zoom: Math.max(0.2, Math.min(24, (viewW - 40) / Math.max(1, projectDuration(project)))) })}>Fit</button>
      </div>
      <div className="tl-scroll" ref={scrollRef} onScroll={(e) => setScrollX((e.target as HTMLDivElement).scrollLeft)}>
        <div className="tl-inner" style={{ width: contentW + HEADER_W }}>
          <div className="ruler" style={{ height: RULER_H }} onPointerDown={(e) => { session.setUi({ playhead: frameAtClientX(e.clientX), playing: false }); setDrag({ kind: "scrub" }); }}>
            <div className="ruler-corner" style={{ width: HEADER_W }} />
            {ticks.map((t) => (
              <div key={t.x} className="tick" style={{ left: HEADER_W + t.x }}><span>{t.label}</span></div>
            ))}
            {project.markers.map((m) => (
              <div key={m.id} className="marker" style={{ left: HEADER_W + m.frame * ppf, background: m.color }} title={m.label || "Marker"} />
            ))}
          </div>
          {[...project.tracks].reverse().map((t) => (
            <div key={t.id} className={`track track-${t.kind}${t.hidden || t.muted ? " dim-track" : ""}`} data-track-row={t.id} style={{ height: TRACK_H[t.kind] }}>
              <div className="track-head" style={{ width: HEADER_W }}>
                <input
                  className="track-name"
                  defaultValue={t.name}
                  aria-label="Track name"
                  onBlur={(e) => e.target.value !== t.name && session.run("Rename track", (p) => updateTrack(p, t.id, { name: e.target.value || t.name }))}
                  onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                />
                <div className="track-btns">
                  {t.kind !== "audio" && (
                    <button className={t.hidden ? "on" : ""} title={t.hidden ? "Show track" : "Hide track"} onClick={() => session.run("Toggle visibility", (p) => updateTrack(p, t.id, { hidden: !t.hidden }))}>{t.hidden ? "Hidden" : "Show"}</button>
                  )}
                  {t.kind !== "text" && (
                    <>
                      <button className={t.muted ? "on" : ""} title="Mute" onClick={() => session.run("Mute track", (p) => updateTrack(p, t.id, { muted: !t.muted }))}>M</button>
                      <button className={t.solo ? "on" : ""} title="Solo" onClick={() => session.run("Solo track", (p) => updateTrack(p, t.id, { solo: !t.solo }))}>S</button>
                    </>
                  )}
                  <button className={t.locked ? "on" : ""} title={t.locked ? "Unlock" : "Lock"} onClick={() => session.run("Lock track", (p) => updateTrack(p, t.id, { locked: !t.locked }))}>{t.locked ? "Locked" : "Lock"}</button>
                  {t.clips.length === 0 && project.tracks.length > 1 && (
                    <button title="Delete empty track" onClick={() => session.run("Delete track", (p) => removeTrack(p, t.id))}>✕</button>
                  )}
                </div>
              </div>
              <div
                className="track-lane"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => onDrop(e, t)}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  session.setUi({ selection: [], playhead: frameAtClientX(e.clientX), playing: false });
                }}
              >
                {t.clips.map((c) => renderClip(c, t))}
                {drag?.kind === "move" && drag.trackId === t.id && drag.fromTrack !== t.id && (() => {
                  const c = project.tracks.flatMap((x) => x.clips).find((x) => x.id === drag.clipId)!;
                  return <div className="clip ghost-target" style={{ left: drag.frame * ppf, width: c.duration * ppf }} />;
                })()}
              </div>
            </div>
          ))}
          {snapLine !== null && <div className="snapline" style={{ left: HEADER_W + snapLine * ppf }} />}
          <div className="playhead" style={{ left: HEADER_W + ui.playhead * ppf }}><div className="playhead-cap" /></div>
        </div>
      </div>
    </div>
  );
}

function Waveform({ peaks, clip, ppf, fps }: { peaks: number[]; clip: Clip; ppf: number; fps: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const w = Math.max(4, Math.min(8000, Math.round(clip.duration * ppf)));
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    cv.width = w;
    cv.height = 40;
    const ctx = cv.getContext("2d")!;
    ctx.clearRect(0, 0, w, 40);
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    const speed = clip.speed.num / clip.speed.den;
    const startSec = clip.sourceIn / fps;
    let max = 0.01;
    for (const v of peaks) if (v > max) max = v;
    for (let x = 0; x < w; x++) {
      const sec = startSec + ((x / ppf) / fps) * speed;
      const v = peaks[Math.floor(sec * 50)] ?? 0;
      const h = Math.max(1, (v / max) * 36);
      ctx.fillRect(x, 20 - h / 2, 1, h);
    }
  }, [peaks, clip, ppf, fps, w]);
  return <canvas ref={ref} className="waveform" style={{ width: w, height: "100%" }} />;
}

export type { Project };
