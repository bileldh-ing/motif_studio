/**
 * Multitrack timeline with Figma-like tools: Select (V), Blade (B), Hand (H).
 * Only clips intersecting the visible window are rendered, and drag previews
 * live in local state so the project is committed once per gesture (one undo step).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Clip, Track } from "@motif/project-schema";
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
  insertShapeClip,
  splitClip,
  formatTimecode,
  setClipSpeed,
  findClip,
  addMarker,
  rippleDelete,
} from "@motif/editor-core";
import { EditorSession, useSession } from "../editorStore";
import { Icon } from "../icons";

const HEADER_W = 176;
const RULER_H = 34;
const TRACK_H: Record<Track["kind"], number> = { video: 58, text: 38, audio: 48 };

type Drag =
  | { kind: "move"; clipId: string; fromTrack: string; grabOffset: number; frame: number; trackId: string; startX: number; moved: boolean }
  | { kind: "trimL" | "trimR"; clipId: string; frame: number }
  | { kind: "scrub" }
  | { kind: "pan"; startX: number; scroll0: number };

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

export function Timeline({ session }: { session: EditorSession }) {
  const { project, ui } = useSession(session);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollX, setScrollX] = useState(0);
  const [viewW, setViewW] = useState(1000);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [snapLine, setSnapLine] = useState<number | null>(null);
  const [snapping, setSnapping] = useState(true);
  const [bladeAt, setBladeAt] = useState<number | null>(null);
  const fps = project.profile.fps;
  const fpsN = fps.num / fps.den;
  const ppf = ui.zoom;
  const total = Math.max(projectDuration(project), Math.round(fpsN * 30));
  const contentW = (total + Math.round(fpsN * 20)) * ppf;

  useEffect(() => {
    window.motif.getSettings().then((s) => setSnapping(s.snapping));
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth - HEADER_W));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
  const snapFrame = (f: number, ignore: string[]) => (snapping ? snap(f, snapPoints(project, ui.playhead, ignore), Math.max(1, Math.round(8 / ppf))) : { frame: f, snappedTo: null as number | null });

  // ------------------------------------------------------------ pointer gestures
  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      if (drag.kind === "scrub") {
        const f = frameAtClientX(e.clientX);
        session.setUi({ playhead: f, playing: false, cursorChip: { x: e.clientX, y: e.clientY, text: formatTimecode(f, fps) } });
        return;
      }
      if (drag.kind === "pan") {
        scrollRef.current!.scrollLeft = drag.scroll0 - (e.clientX - drag.startX);
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
        const moved = drag.moved || Math.abs(e.clientX - drag.startX) > 3;
        setDrag({ ...drag, frame: Math.max(0, frame), trackId: target?.id ?? drag.trackId, moved });
        if (moved) session.setUi({ cursorChip: { x: e.clientX, y: e.clientY, text: `${formatTimecode(Math.max(0, frame), fps)}${target && target.id !== drag.fromTrack ? `  → ${target.name}` : ""}` } });
      } else {
        const s = snapFrame(raw, [drag.clipId]);
        setSnapLine(s.snappedTo);
        setDrag({ ...drag, frame: s.frame });
        const c = project.tracks.flatMap((t) => t.clips).find((x) => x.id === drag.clipId)!;
        const len = drag.kind === "trimL" ? clipEnd(c) - s.frame : s.frame - c.start;
        session.setUi({ cursorChip: { x: e.clientX, y: e.clientY, text: `${framesToSeconds(Math.max(0, len), fps).toFixed(2)} s` } });
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
      session.setUi({ cursorChip: null });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDrag(null);
        setSnapLine(null);
        session.setUi({ cursorChip: null });
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

  const onDrop = (e: React.DragEvent, track: Track) => {
    e.preventDefault();
    const assetId = e.dataTransfer.getData("application/x-motif-asset");
    const textPreset = e.dataTransfer.getData("application/x-motif-text");
    const shape = e.dataTransfer.getData("application/x-motif-shape");
    const frame = frameAtClientX(e.clientX);
    if (assetId) {
      session.run("Add clip", (p) => {
        const asset = p.assets.find((a) => a.id === assetId)!;
        let target = track;
        if (asset.kind === "audio" && track.kind !== "audio") target = p.tracks.find((t) => t.kind === "audio") ?? track;
        if (asset.kind !== "audio" && track.kind !== "video") target = p.tracks.find((t) => t.kind === "video") ?? track;
        return insertMediaClip(p, { trackId: target.id, assetId, start: frame, findFreeSlot: true }).project;
      });
    } else if (textPreset) {
      const role = textPreset === "caption" ? "caption" : "title";
      session.run("Add text", (p) =>
        insertTextClip(p, { trackId: track.kind === "audio" ? p.tracks.find((t) => t.kind === "text")!.id : track.id, start: frame, duration: Math.round(fpsN * 3), content: role === "caption" ? "Caption text" : "Your title", role, findFreeSlot: true }).project,
      );
    } else if (shape) {
      const [type, fill] = shape.split("|") as ["rect" | "ellipse", string];
      session.run("Add shape", (p) => insertShapeClip(p, { trackId: track.kind === "audio" ? p.tracks.find((t) => t.kind === "video")!.id : track.id, start: frame, duration: Math.round(fpsN * 3), type, fill }).project);
    }
  };

  const ticks = useMemo(() => {
    const secPerTick = [0.5, 1, 2, 5, 10, 30, 60, 120, 300].find((s) => s * fpsN * ppf >= 90) ?? 600;
    const out: { x: number; label: string; minor: number[] }[] = [];
    const startSec = Math.floor(framesToSeconds(scrollX / ppf, fps) / secPerTick) * secPerTick;
    for (let s = startSec; s * fpsN * ppf < scrollX + viewW + 100; s += secPerTick) {
      const m = Math.floor(s / 60);
      const r = s - m * 60;
      const minor = [1, 2, 3, 4].map((i) => (s + (secPerTick * i) / 5) * fpsN * ppf);
      out.push({ x: s * fpsN * ppf, label: `${String(m).padStart(2, "0")}:${String(Math.floor(r)).padStart(2, "0")}`, minor });
    }
    return out;
  }, [scrollX, viewW, ppf, fps, fpsN]);

  const visible = (c: Clip) => clipEnd(c) * ppf >= scrollX - 50 && c.start * ppf <= scrollX + viewW + 50;
  const selClip = ui.selection[0] ? findClip(project, ui.selection[0]) : null;
  const selSpeed = selClip ? selClip.clip.speed.num / selClip.clip.speed.den : 1;

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
    const speed = c.speed.num / c.speed.den;
    const kindCls = c.kind === "media" ? (track.kind === "audio" ? "audio" : asset?.kind === "audio" ? "audio" : "video") : c.kind;
    const badges = [c.reverse && "⟲", c.freeze && "❄", c.chroma.enabled && "Key", c.mask.shape !== "none" && "Mask", c.color.look && c.color.look, speed !== 1 && `${speed}×`, Object.keys(c.keyframes).length > 0 && "◆"].filter(Boolean) as string[];
    return (
      <div
        key={c.id}
        className={`clip clip-${kindCls}${sel ? " sel" : ""}${ghost ? " ghost" : ""}${missing ? " missing" : ""}${c.enabled ? "" : " disabled"}`}
        style={{ left: start * ppf, width: Math.max(6, dur * ppf) }}
        data-clip={c.id}
        onPointerMove={(e) => ui.tool === "blade" && setBladeAt(frameAtClientX(e.clientX))}
        onPointerLeave={() => setBladeAt(null)}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          if (track.locked) return session.toast(`Track "${track.name}" is locked`, "error");
          if (ui.tool === "hand") return setDrag({ kind: "pan", startX: e.clientX, scroll0: scrollRef.current!.scrollLeft });
          if (ui.tool === "blade") {
            const f = frameAtClientX(e.clientX);
            const s = snapFrame(f, []).frame;
            session.run("Blade split", (p) => splitClip(p, c.id, s > c.start && s < clipEnd(c) ? s : f).project);
            return;
          }
          const multi = e.shiftKey || e.metaKey || e.ctrlKey;
          session.setUi({ selection: multi ? (sel ? ui.selection.filter((x) => x !== c.id) : [...ui.selection, c.id]) : [c.id] });
          const f = frameAtClientX(e.clientX);
          setDrag({ kind: "move", clipId: c.id, fromTrack: track.id, trackId: track.id, grabOffset: f - c.start, frame: c.start, startX: e.clientX, moved: false });
        }}
        title={`${c.name}\n${formatTimecode(c.start, fps)} → ${formatTimecode(clipEnd(c), fps)}`}
      >
        {d?.filmstripUrl && kindCls === "video" && <div className="filmstrip" style={{ backgroundImage: `url("${d.filmstripUrl}")` }} />}
        {d?.thumbnailUrl && kindCls === "video" && <img className="clip-thumb" src={d.thumbnailUrl} alt="" draggable={false} />}
        {d?.peaks && kindCls === "audio" && <Waveform peaks={d.peaks} clip={c} ppf={ppf} fps={fpsN} />}
        {c.transitionIn && <div className="xfade" style={{ width: c.transitionIn.frames * ppf }} title={`${c.transitionIn.kind} ${c.transitionIn.frames} frames`} />}
        <span className="clip-label">
          {missing ? "⚠ " : ""}
          {c.kind === "text" ? `T  ${c.text?.content ?? ""}` : c.name}
        </span>
        {badges.length > 0 && <span className="clip-badges">{badges.map((b) => <i key={b}>{b}</i>)}</span>}
        {ui.tool === "select" && (
          <>
            <div className="handle l" onPointerDown={(e) => { e.stopPropagation(); if (!track.locked) setDrag({ kind: "trimL", clipId: c.id, frame: c.start }); }} />
            <div className="handle r" onPointerDown={(e) => { e.stopPropagation(); if (!track.locked) setDrag({ kind: "trimR", clipId: c.id, frame: clipEnd(c) }); }} />
          </>
        )}
      </div>
    );
  };

  const counts: Record<string, number> = {};
  const label = (t: Track) => {
    const base = t.kind === "video" ? "MEDIA" : t.kind === "audio" ? "AUDIO" : "TEXT";
    counts[base] = (counts[base] ?? 0) + 1;
    return t.name;
  };

  return (
    <div className={`timeline glass-panel tool-${ui.tool}`}>
      <div className="tl-toolbar">
        <div className="speed-ctl" title="Speed of the selected clip">
          <span>Speed</span>
          <input
            type="range"
            min={0}
            max={SPEEDS.length - 1}
            step={1}
            disabled={!selClip || selClip.clip.kind !== "media"}
            value={Math.max(0, SPEEDS.indexOf(SPEEDS.reduce((a, b) => (Math.abs(b - selSpeed) < Math.abs(a - selSpeed) ? b : a))))}
            onChange={(e) => {
              const s = SPEEDS[Number(e.target.value)]!;
              const r = s === 1.25 ? { num: 5, den: 4 } : s === 0.75 ? { num: 3, den: 4 } : s === 1.5 ? { num: 3, den: 2 } : s < 1 ? { num: 1, den: Math.round(1 / s) } : { num: s, den: 1 };
              if (selClip) session.run("Change speed", (p) => setClipSpeed(p, selClip.clip.id, r));
            }}
          />
          <b className="chip">{selSpeed}X</b>
        </div>
        <span className="sep" />
        <div className="seg-tools" role="radiogroup" aria-label="Timeline tool">
          {([
            ["select", "select", "Select (V)"],
            ["blade", "blade", "Blade (B): click a clip to cut"],
            ["hand", "hand", "Hand (H): drag to pan"],
          ] as const).map(([k, icon, tip]) => (
            <button key={k} role="radio" aria-checked={ui.tool === k} className={"icon-btn" + (ui.tool === k ? " on" : "")} title={tip} onClick={() => session.setUi({ tool: k })}>
              <Icon name={icon} size={16} />
            </button>
          ))}
        </div>
        <span className="sep" />
        <button className="icon-btn" title="Add marker (M)" onClick={() => session.run("Add marker", (p) => addMarker(p, ui.playhead))}><Icon name="marker" size={16} /></button>
        <button className="icon-btn" title="Split at playhead (S)" onClick={() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "s" }))}><Icon name="split" size={16} /></button>
        <button className="icon-btn" title="Delete (Del)" disabled={!ui.selection.length} onClick={() => { session.run("Delete", (p) => ui.selection.reduce((acc, id) => (findClip(acc, id) ? rippleDelete(acc, id) : acc), p)); session.setUi({ selection: [] }); }}><Icon name="trash" size={16} /></button>
        <span className="sep" />
        <button className="text-btn" onClick={() => session.run("Add video track", (p) => addTrack(p, "video").project)}><Icon name="plus" size={13} /> Video</button>
        <button className="text-btn" onClick={() => session.run("Add text track", (p) => addTrack(p, "text").project)}><Icon name="plus" size={13} /> Text</button>
        <button className="text-btn" onClick={() => session.run("Add audio track", (p) => addTrack(p, "audio").project)}><Icon name="plus" size={13} /> Audio</button>
        <span className="grow" />
        <button className={"icon-btn" + (snapping ? " on" : "")} title="Snapping" aria-pressed={snapping} onClick={() => { setSnapping(!snapping); window.motif.setSettings({ snapping: !snapping }); }}><Icon name="magnet" size={16} /></button>
        <button className="icon-btn" title="Zoom out (−)" onClick={() => session.setUi({ zoom: Math.max(0.2, ppf / 1.25) })}><Icon name="zoomout" size={16} /></button>
        <input className="zoom" type="range" min={0.2} max={24} step={0.1} value={ppf} aria-label="Timeline zoom" onChange={(e) => session.setUi({ zoom: Number(e.target.value) })} />
        <button className="icon-btn" title="Zoom in (+)" onClick={() => session.setUi({ zoom: Math.min(24, ppf * 1.25) })}><Icon name="zoomin" size={16} /></button>
        <button className="text-btn" onClick={() => session.setUi({ zoom: Math.max(0.2, Math.min(24, (viewW - 40) / Math.max(1, projectDuration(project)))) })}>Fit</button>
      </div>
      <div
        className="tl-scroll"
        ref={scrollRef}
        onScroll={(e) => setScrollX((e.target as HTMLDivElement).scrollLeft)}
        onWheel={(e) => {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            session.setUi({ zoom: Math.max(0.2, Math.min(24, ppf * (e.deltaY < 0 ? 1.15 : 1 / 1.15))) });
          }
        }}
      >
        <div className="tl-inner" style={{ width: contentW + HEADER_W }}>
          <div className="ruler" style={{ height: RULER_H }} onPointerDown={(e) => { const f = frameAtClientX(e.clientX); session.setUi({ playhead: f, playing: false }); setDrag({ kind: "scrub" }); }}>
            <div className="ruler-corner" style={{ width: HEADER_W }} />
            {ticks.map((t) => (
              <div key={t.x}>
                <div className="tick" style={{ left: HEADER_W + t.x }}><span>{t.label}</span></div>
                {t.minor.map((m) => <div key={m} className="tick-dot" style={{ left: HEADER_W + m }} />)}
              </div>
            ))}
            {project.markers.map((m) => (
              <div key={m.id} className="marker" style={{ left: HEADER_W + m.frame * ppf, background: m.color }} title={m.label || "Marker"} />
            ))}
            {project.inPoint !== undefined && project.outPoint !== undefined && (
              <div className="io-range" style={{ left: HEADER_W + project.inPoint * ppf, width: (project.outPoint - project.inPoint) * ppf }} />
            )}
          </div>
          {[...project.tracks].reverse().map((t) => (
            <div key={t.id} className={`track track-${t.kind}${t.hidden || t.muted ? " dim-track" : ""}`} data-track-row={t.id} style={{ height: TRACK_H[t.kind] }}>
              <div className="track-head" style={{ width: HEADER_W }}>
                <input
                  className="track-name"
                  defaultValue={label(t)}
                  aria-label="Track name"
                  onBlur={(e) => e.target.value !== t.name && session.run("Rename track", (p) => updateTrack(p, t.id, { name: e.target.value || t.name }))}
                  onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                />
                <div className="track-btns">
                  {t.kind !== "audio" ? (
                    <button className={"round-btn" + (t.hidden ? " on" : "")} title={t.hidden ? "Show track" : "Hide track"} onClick={() => session.run("Toggle visibility", (p) => updateTrack(p, t.id, { hidden: !t.hidden }))}><Icon name={t.hidden ? "eyeoff" : "eye"} size={13} /></button>
                  ) : (
                    <button className={"round-btn" + (t.muted ? " on" : "")} title={t.muted ? "Unmute" : "Mute"} onClick={() => session.run("Mute track", (p) => updateTrack(p, t.id, { muted: !t.muted }))}><Icon name={t.muted ? "mute" : "volume"} size={13} /></button>
                  )}
                  {t.kind === "video" && <button className={"round-btn" + (t.muted ? " on" : "")} title="Mute clip audio on this track" onClick={() => session.run("Mute track", (p) => updateTrack(p, t.id, { muted: !t.muted }))}><Icon name={t.muted ? "mute" : "volume"} size={13} /></button>}
                  <button className={"round-btn" + (t.locked ? " on" : "")} title={t.locked ? "Unlock" : "Lock"} onClick={() => session.run("Lock track", (p) => updateTrack(p, t.id, { locked: !t.locked }))}><Icon name={t.locked ? "lock" : "unlock"} size={13} /></button>
                  {t.kind === "audio" && <button className={"round-btn small" + (t.solo ? " on" : "")} title="Solo" onClick={() => session.run("Solo track", (p) => updateTrack(p, t.id, { solo: !t.solo }))}>S</button>}
                  {t.clips.length === 0 && project.tracks.length > 1 && (
                    <button className="round-btn small" title="Delete empty track" onClick={() => session.run("Delete track", (p) => removeTrack(p, t.id))}><Icon name="x" size={11} /></button>
                  )}
                </div>
              </div>
              <div
                className="track-lane"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => onDrop(e, t)}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  if (ui.tool === "hand") return setDrag({ kind: "pan", startX: e.clientX, scroll0: scrollRef.current!.scrollLeft });
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
          {bladeAt !== null && ui.tool === "blade" && <div className="bladeline" style={{ left: HEADER_W + bladeAt * ppf }} />}
          <div className="playhead" style={{ left: HEADER_W + ui.playhead * ppf }}>
            <div
              className="playhead-cap"
              onPointerDown={(e) => {
                e.stopPropagation();
                setDrag({ kind: "scrub" });
              }}
              title={formatTimecode(ui.playhead, fps)}
            />
          </div>
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
    const g = ctx.createLinearGradient(0, 0, 0, 40);
    g.addColorStop(0, "#5fe3ff");
    g.addColorStop(1, "#1c9bff");
    ctx.fillStyle = g;
    ctx.shadowColor = "rgba(64,200,255,0.8)";
    ctx.shadowBlur = 6;
    const speed = clip.speed.num / clip.speed.den;
    const startSec = clip.sourceIn / fps;
    let max = 0.01;
    for (const v of peaks) if (v > max) max = v;
    for (let x = 0; x < w; x += 3) {
      const sec = startSec + (x / ppf / fps) * speed;
      const v = peaks[Math.floor(sec * 50)] ?? 0;
      const h = Math.max(2, (v / max) * 34);
      ctx.beginPath();
      ctx.roundRect(x, 20 - h / 2, 2, h, 1);
      ctx.fill();
    }
  }, [peaks, clip, ppf, fps, w]);
  return <canvas ref={ref} className="waveform" style={{ width: w, height: "100%" }} />;
}
