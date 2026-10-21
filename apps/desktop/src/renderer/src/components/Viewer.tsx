/**
 * Interactive preview compositor (Canvas 2D). It evaluates the SAME
 * composition model as the exporter (editor-core visualLayersAt / propertyAt),
 * decoding with pooled <video>/<img> elements served over motif-media://.
 * See docs/ADRs/0003-preview-render.md for the known differences vs export.
 */
import { useEffect, useRef, useState } from "react";
import type { Project, Clip } from "@motif/project-schema";
import { visualLayersAt, audioSources, projectDuration, framesToSeconds, secondsToFrames, sourceSecondsAt, clipEnd, fittedSize, formatTimecode, propertyAt, isTrackAudible } from "@motif/editor-core";
import { EditorSession, useSession } from "../editorStore";

type El = HTMLVideoElement | HTMLImageElement;

class MediaPool {
  private els = new Map<string, El>();
  /** called when any element gets a new decodable frame (load/seek finished) */
  onFrame: () => void = () => {};
  get(key: string, assetId: string, kind: "video" | "image" | "audio"): El {
    let el = this.els.get(key);
    if (!el) {
      if (kind === "image") {
        const img = new Image();
        img.onload = () => this.onFrame();
        img.src = window.motif.mediaUrl(assetId);
        el = img;
      } else {
        const v = document.createElement("video");
        v.preload = "auto";
        v.muted = true;
        v.playsInline = true;
        v.addEventListener("loadeddata", () => this.onFrame());
        v.addEventListener("seeked", () => this.onFrame());
        v.onerror = () => console.warn("MOTIF media error", assetId, v.error?.code, v.error?.message);
        v.src = window.motif.mediaUrl(assetId);
        el = v;
      }
      this.els.set(key, el);
    }
    return el;
  }
  retain(keys: Set<string>) {
    for (const [k, el] of this.els)
      if (!keys.has(k)) {
        if (el instanceof HTMLVideoElement) {
          el.pause();
          el.removeAttribute("src");
          el.load();
        }
        this.els.delete(k);
      }
  }
  all() {
    return [...this.els.entries()];
  }
  dispose() {
    this.retain(new Set());
  }
}

function ready(el: El) {
  return el instanceof HTMLImageElement ? el.complete && el.naturalWidth > 0 : el.readyState >= 2;
}

function drawText(ctx: CanvasRenderingContext2D, c: Clip, W: number, H: number, k: number, alpha: number, ox: number, oy: number) {
  if (!c.text) return;
  const fs = Math.round(c.text.fontSize * (H / 1080) * c.transform.scale) * k;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `700 ${fs}px "DejaVu Sans", Inter, system-ui, sans-serif`;
  ctx.textBaseline = "top";
  const lines = c.text.content.split("\n");
  const lh = fs * 1.2;
  const total = lh * lines.length;
  let y = c.text.align === "lower-third" ? H * k * 0.85 - total / 2 : c.text.align === "top" ? H * k * 0.08 : (H * k - total) / 2;
  y += oy * k;
  const xOff = ox * k;
  for (const line of lines) {
    const w = ctx.measureText(line).width;
    const x = (W * k - w) / 2 + xOff;
    if (c.text.boxColor) {
      const pad = fs * 0.35;
      ctx.fillStyle = c.text.boxColor;
      ctx.globalAlpha = alpha * c.text.boxOpacity;
      ctx.fillRect(x - pad, y - pad, w + pad * 2, fs + pad * 2);
      ctx.globalAlpha = alpha;
    }
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillText(line, x + 2 * k, y + 2 * k);
    ctx.fillStyle = c.text.color;
    ctx.fillText(line, x, y);
    y += lh;
  }
  ctx.restore();
}

export function Viewer({ session }: { session: EditorSession }) {
  const { project, ui } = useSession(session);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const pool = useRef(new MediaPool());
  const audioPool = useRef(new MediaPool());
  const [buffering, setBuffering] = useState(false);
  const [quality, setQuality] = useState<0.25 | 0.5 | 1>(0.5);
  const [box, setBox] = useState({ w: 640, h: 360 });
  const raf = useRef(0);
  const drawRef = useRef<(p: Project, f: number, playing: boolean) => void>(() => {});
  const clock = useRef({ startPerf: 0, startFrame: 0 });

  const { width: W, height: H, fps } = project.profile;

  useEffect(() => {
    pool.current.onFrame = () => {
      if (!session.ui.playing) requestAnimationFrame(() => drawRef.current(session.project, session.ui.playhead, false));
    };
    window.motif.getSettings().then((s) => setQuality(s.previewScale));
    return () => {
      pool.current.dispose();
      audioPool.current.dispose();
    };
  }, []);

  // fit canvas into available box
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const s = Math.min((r.width - 16) / W, (r.height - 16) / H);
      setBox({ w: Math.max(80, W * s), h: Math.max(45, H * s) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [W, H]);

  const draw = (p: Project, frame: number, playing: boolean) => {
    const cv = canvasRef.current;
    if (!cv) return;
    const k = quality * Math.min(1, 1920 / Math.max(W, H)) * 1;
    const cw = Math.round(W * k);
    const ch = Math.round(H * k);
    if (cv.width !== cw || cv.height !== ch) {
      cv.width = cw;
      cv.height = ch;
    }
    const ctx = cv.getContext("2d")!;
    ctx.fillStyle = p.profile.background;
    ctx.fillRect(0, 0, cw, ch);
    const layers = visualLayersAt(p, frame);
    const live = new Set<string>();
    let waiting = false;
    for (const L of layers) {
      const c = L.clip;
      if (c.kind === "color") {
        ctx.globalAlpha = L.opacity;
        ctx.fillStyle = c.fillColor ?? "#000";
        ctx.fillRect(0, 0, cw, ch);
        ctx.globalAlpha = 1;
        continue;
      }
      if (c.kind === "text") {
        drawText(ctx, c, W, H, k, L.opacity, L.x, L.y);
        continue;
      }
      const asset = p.assets.find((a) => a.id === c.assetId);
      if (!asset || !asset.meta.hasVideo) continue;
      if (session.ui.missing.has(asset.id)) {
        ctx.fillStyle = "#3a1d24";
        ctx.fillRect(0, 0, cw, ch);
        ctx.fillStyle = "#ff8a9a";
        ctx.font = `${14}px system-ui`;
        ctx.fillText(`Media offline: ${asset.name}`, 12, 22);
        continue;
      }
      const key = c.id;
      live.add(key);
      const el = pool.current.get(key, asset.id, asset.kind === "image" ? "image" : "video");
      if (el instanceof HTMLVideoElement) {
        const want = Math.min(L.sourceSeconds, Math.max(0, asset.meta.durationSec - 0.04));
        const speed = c.speed.num / c.speed.den;
        if (playing && frame < clipEnd(c)) {
          if (el.playbackRate !== speed) el.playbackRate = speed;
          if (el.paused) {
            el.currentTime = want;
            el.play().catch(() => {});
          } else if (Math.abs(el.currentTime - want) > 0.25) el.currentTime = want;
        } else {
          if (!el.paused) el.pause();
          if (Math.abs(el.currentTime - want) > 0.5 / (fps.num / fps.den)) el.currentTime = want;
        }
        if (el.seeking) waiting = true;
      }
      if (!ready(el)) {
        waiting = true;
        continue;
      }
      const sw = el instanceof HTMLVideoElement ? el.videoWidth : el.naturalWidth;
      const sh = el instanceof HTMLVideoElement ? el.videoHeight : el.naturalHeight;
      const size = fittedSize(sw, sh, W, H, L.scale);
      ctx.save();
      ctx.globalAlpha = L.opacity;
      const col = c.color;
      if (col.brightness !== 0 || col.contrast !== 1 || col.saturation !== 1)
        ctx.filter = `brightness(${1 + col.brightness}) contrast(${col.contrast}) saturate(${col.saturation})`;
      ctx.translate((W / 2 + L.x) * k, (H / 2 + L.y) * k);
      if (L.rotation) ctx.rotate((L.rotation * Math.PI) / 180);
      ctx.drawImage(el, (-size.w / 2) * k, (-size.h / 2) * k, size.w * k, size.h * k);
      ctx.restore();
    }
    pool.current.retain(live);
    (window as any).__motifPreview = pool.current.all().map(([k, e]) => (e instanceof HTMLVideoElement ? { k, rs: e.readyState, net: e.networkState, err: e.error?.code, t: e.currentTime, seeking: e.seeking } : { k, img: (e as HTMLImageElement).complete }));
    setBuffering(waiting);
  };

  // audio preview: one element per audible clip
  const syncAudio = (p: Project, frame: number, playing: boolean) => {
    const live = new Set<string>();
    if (playing) {
      for (const { clip: c, track } of audioSources(p)) {
        if (frame < c.start || frame >= clipEnd(c) || session.ui.missing.has(c.assetId!)) continue;
        live.add(c.id);
        const el = audioPool.current.get(c.id, c.assetId!, "audio") as HTMLVideoElement;
        el.muted = false;
        const local = frame - c.start;
        let g = Math.pow(10, (propertyAt(c, "volume", local) + track.volumeDb) / 20);
        if (c.audio.fadeInFrames && local < c.audio.fadeInFrames) g *= local / c.audio.fadeInFrames;
        const toEnd = clipEnd(c) - frame;
        if (c.audio.fadeOutFrames && toEnd < c.audio.fadeOutFrames) g *= toEnd / c.audio.fadeOutFrames;
        el.volume = Math.max(0, Math.min(1, g));
        const want = sourceSecondsAt(c, frame, fps);
        const speed = c.speed.num / c.speed.den;
        el.playbackRate = speed;
        if (el.paused) {
          el.currentTime = want;
          el.play().catch(() => {});
        } else if (Math.abs(el.currentTime - want) > 0.2) el.currentTime = want;
        void isTrackAudible;
      }
    }
    audioPool.current.retain(live);
  };

  // playback loop: master clock = performance.now(), frames derived from it
  useEffect(() => {
    if (!ui.playing) {
      draw(session.project, ui.playhead, false);
      syncAudio(session.project, ui.playhead, false);
      return;
    }
    clock.current = { startPerf: performance.now(), startFrame: ui.playhead };
    const end = session.project.outPoint ?? projectDuration(session.project);
    const tick = () => {
      const elapsed = (performance.now() - clock.current.startPerf) / 1000;
      const frame = clock.current.startFrame + secondsToFrames(elapsed, fps);
      if (frame >= end) {
        session.setUi({ playing: false, playhead: Math.max(0, end - 1) });
        return;
      }
      draw(session.project, frame, true);
      syncAudio(session.project, frame, true);
      if (frame !== session.ui.playhead) session.setUi({ playhead: frame });
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf.current);
      syncAudio(session.project, 0, false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ui.playing]);

  // redraw on edits / seeks while paused; also once media finishes loading
  useEffect(() => {
    if (ui.playing) return;
    draw(project, ui.playhead, false);
    const t = setInterval(() => draw(session.project, session.ui.playhead, false), 250);
    const stop = setTimeout(() => clearInterval(t), 1500);
    return () => {
      clearInterval(t);
      clearTimeout(stop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, ui.playhead, ui.playing, quality, ui.missing]);

  drawRef.current = draw;
  const total = projectDuration(project);
  return (
    <div className="viewer">
      <div className="viewer-stage" ref={wrapRef}>
        <canvas ref={canvasRef} style={{ width: box.w, height: box.h }} aria-label="Preview" />
        {buffering && !ui.playing && <div className="buffering">Loading frame…</div>}
        {quality < 1 && <div className="quality-badge" title="Preview is drawn at reduced resolution; export uses full quality">Preview {Math.round(quality * 100)}%</div>}
      </div>
      <div className="transport">
        <span className="tc">{formatTimecode(ui.playhead, fps)}</span>
        <div className="transport-btns">
          <button title="Go to start (Home)" onClick={() => session.setUi({ playhead: 0 })}>«</button>
          <button title="Previous frame (←)" onClick={() => session.setUi({ playhead: Math.max(0, ui.playhead - 1) })}>◀︎</button>
          <button className="play" title="Play/pause (Space)" disabled={total === 0} onClick={() => session.setUi({ playing: !ui.playing })}>
            {ui.playing ? "❚❚" : "▶"}
          </button>
          <button title="Next frame (→)" onClick={() => session.setUi({ playhead: ui.playhead + 1 })}>▶︎</button>
          <button title="Go to end (End)" onClick={() => session.setUi({ playhead: Math.max(0, total - 1) })}>»</button>
        </div>
        <span className="tc dim">{formatTimecode(total, fps)}</span>
        <select
          className="mini"
          value={quality}
          aria-label="Preview quality"
          onChange={(e) => {
            const q = Number(e.target.value) as 0.25 | 0.5 | 1;
            setQuality(q);
            window.motif.setSettings({ previewScale: q });
          }}
        >
          <option value={0.25}>Quarter</option>
          <option value={0.5}>Half</option>
          <option value={1}>Full</option>
        </select>
        <span className="dim small">{framesToSeconds(total, fps).toFixed(1)} s</span>
      </div>
    </div>
  );
}
