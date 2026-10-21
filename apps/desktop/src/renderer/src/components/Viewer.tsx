/**
 * Interactive preview compositor (Canvas 2D). It evaluates the SAME
 * composition model as the exporter (editor-core visualLayersAt + motion)
 * and the same effect parameters: crop, flip, colour (via an SVG filter that
 * mirrors the FFmpeg chain), blur, vignette, chroma key, masks, background
 * blur fill, shapes and styled text. On-canvas handles move/scale/rotate the
 * selected layer, Figma style.
 */
import { useEffect, useRef, useState } from "react";
import { FONTS, type Clip, type Project } from "@motif/project-schema";
import {
  visualLayersAt,
  audioSources,
  projectDuration,
  framesToSeconds,
  secondsToFrames,
  clipSourceSeconds,
  clipEnd,
  fittedSize,
  formatTimecode,
  propertyAt,
  colorMatrix,
  findClip,
  updateClip,
  setKeyframe,
  type VisualLayer,
} from "@motif/editor-core";
import { EditorSession, useSession } from "../editorStore";
import { Icon } from "../icons";

type El = HTMLVideoElement | HTMLImageElement;

class MediaPool {
  private els = new Map<string, El>();
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

const ready = (el: El) => (el instanceof HTMLImageElement ? el.complete && el.naturalWidth > 0 : el.readyState >= 2);

// ---------------------------------------------------------------- colour filter (SVG) mirroring FFmpeg's eq/hue/ccm/negate
const filterCache = new Map<string, string>();
let filterHost: SVGSVGElement | null = null;
function colorFilterUrl(c: Clip): string | null {
  const col = c.color;
  const sat = col.saturation * (1 - col.grayscale);
  const needs = col.brightness !== 0 || col.contrast !== 1 || sat !== 1 || col.hue !== 0 || col.sepia !== 0 || col.temperature !== 0 || col.invert;
  if (!needs) return null;
  const key = [col.brightness, col.contrast, sat, col.hue, col.sepia, col.temperature, col.invert].join("|");
  const hit = filterCache.get(key);
  if (hit) return hit;
  if (!filterHost) {
    filterHost = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    filterHost.setAttribute("width", "0");
    filterHost.setAttribute("height", "0");
    filterHost.style.position = "absolute";
    document.body.appendChild(filterHost);
  }
  const id = `mf${filterCache.size}`;
  const f = document.createElementNS("http://www.w3.org/2000/svg", "filter");
  f.setAttribute("id", id);
  f.setAttribute("color-interpolation-filters", "sRGB");
  const slope = col.contrast;
  const icpt = 0.5 - 0.5 * col.contrast + col.brightness;
  let html = `<feComponentTransfer><feFuncR type="linear" slope="${slope}" intercept="${icpt}"/><feFuncG type="linear" slope="${slope}" intercept="${icpt}"/><feFuncB type="linear" slope="${slope}" intercept="${icpt}"/></feComponentTransfer>`;
  if (sat !== 1) html += `<feColorMatrix type="saturate" values="${sat}"/>`;
  if (col.hue) html += `<feColorMatrix type="hueRotate" values="${col.hue}"/>`;
  if (col.sepia || col.temperature) {
    const m = colorMatrix(col.sepia, col.temperature);
    html += `<feColorMatrix type="matrix" values="${m.map((r) => `${r.join(" ")} 0 0`).join(" ")} 0 0 0 1 0"/>`;
  }
  if (col.invert) html += `<feComponentTransfer><feFuncR type="table" tableValues="1 0"/><feFuncG type="table" tableValues="1 0"/><feFuncB type="table" tableValues="1 0"/></feComponentTransfer>`;
  f.innerHTML = html;
  filterHost.appendChild(f);
  const url = `url(#${id})`;
  filterCache.set(key, url);
  return url;
}

function hexRgb(h: string): [number, number, number] {
  const v = parseInt(h.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** CPU chroma key matching FFmpeg's chromakey (UV distance, similarity, blend). */
function chromaKey(ctx: CanvasRenderingContext2D, w: number, h: number, c: Clip) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const [kr, kg, kb] = hexRgb(c.chroma.color);
  const ku = -0.169 * kr - 0.331 * kg + 0.5 * kb + 128;
  const kv = 0.5 * kr - 0.419 * kg - 0.081 * kb + 128;
  const sim = c.chroma.similarity;
  const blend = c.chroma.blend;
  for (let i = 0; i < d.length; i += 4) {
    const u = -0.169 * d[i]! - 0.331 * d[i + 1]! + 0.5 * d[i + 2]! + 128;
    const v = 0.5 * d[i]! - 0.419 * d[i + 1]! - 0.081 * d[i + 2]! + 128;
    const diff = Math.sqrt(((u - ku) ** 2 + (v - kv) ** 2) / (255 * 255 * 2));
    const a = blend > 0.0001 ? Math.max(0, Math.min(1, (diff - sim) / blend)) : diff > sim ? 1 : 0;
    d[i + 3] = d[i + 3]! * a;
  }
  ctx.putImageData(img, 0, 0);
}

export interface LayerBox {
  clipId: string;
  cx: number;
  cy: number;
  w: number;
  h: number;
  rot: number;
}

function fontCss(c: Clip, px: number) {
  const f = FONTS.find((x) => x.id === c.text?.font) ?? FONTS[0]!;
  return `${c.text?.bold ? 700 : 400} ${px}px "${f.css}", system-ui, sans-serif`;
}

function drawText(ctx: CanvasRenderingContext2D, c: Clip, W: number, H: number, k: number, L: VisualLayer, boxes: LayerBox[]) {
  if (!c.text) return;
  const t = c.text;
  const fs = Math.round(t.fontSize * (H / 1080) * c.transform.scale) * k * (L.scale / Math.max(0.0001, c.transform.scale));
  ctx.save();
  ctx.globalAlpha = L.opacity;
  ctx.font = fontCss(c, fs);
  ctx.textBaseline = "top";
  const lines = t.content.split("\n");
  const lh = fs * 1.2;
  const total = lh * lines.length;
  let y = t.align === "lower-third" ? H * k * 0.85 - total / 2 : t.align === "top" ? H * k * 0.08 : (H * k - total) / 2;
  y += L.y * k;
  const startY = y;
  let maxW = 0;
  for (const line of lines) {
    const w = ctx.measureText(line).width;
    maxW = Math.max(maxW, w);
    const x = (W * k - w) / 2 + L.x * k;
    if (t.boxColor) {
      const pad = fs * 0.35;
      ctx.fillStyle = t.boxColor;
      ctx.globalAlpha = L.opacity * t.boxOpacity;
      ctx.fillRect(x - pad, y - pad, w + pad * 2, fs + pad * 2);
      ctx.globalAlpha = L.opacity;
    }
    if (t.shadow) {
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillText(line, x + 2 * k * (H / 1080), y + 2 * k * (H / 1080));
    }
    if (t.strokeWidth > 0) {
      ctx.strokeStyle = t.strokeColor;
      ctx.lineJoin = "round";
      ctx.lineWidth = 2 * t.strokeWidth * (H / 1080) * k;
      ctx.strokeText(line, x, y);
    }
    ctx.fillStyle = t.color;
    ctx.fillText(line, x, y);
    y += lh;
  }
  ctx.restore();
  boxes.push({ clipId: c.id, cx: W / 2 + L.x, cy: (startY + total / 2) / k, w: maxW / k + 16, h: total / k + 8, rot: 0 });
}

const offA = document.createElement("canvas");
const offB = document.createElement("canvas");

export function Viewer({ session }: { session: EditorSession }) {
  const { project, ui } = useSession(session);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const pool = useRef(new MediaPool());
  const audioPool = useRef(new MediaPool());
  const [buffering, setBuffering] = useState(false);
  const [quality, setQuality] = useState<0.25 | 0.5 | 1>(0.5);
  const [box, setBox] = useState({ w: 640, h: 360 });
  const [boxes, setBoxes] = useState<LayerBox[]>([]);
  const [volume, setVolume] = useState(1);
  const raf = useRef(0);
  const clock = useRef({ startPerf: 0, startFrame: 0 });
  const drawRef = useRef<(p: Project, f: number, playing: boolean) => void>(() => {});
  const { width: W, height: H, fps } = project.profile;

  useEffect(() => {
    pool.current.onFrame = () => {
      if (!session.ui.playing) requestAnimationFrame(() => drawRef.current(session.project, session.ui.playhead, false));
    };
    window.motif.getSettings().then((s) => setQuality(s.previewScale));
    document.fonts?.ready.then(() => drawRef.current(session.project, session.ui.playhead, false));
    return () => {
      pool.current.dispose();
      audioPool.current.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const s = Math.min((r.width - 40) / W, (r.height - 96) / H);
      setBox({ w: Math.max(80, W * s), h: Math.max(45, H * s) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [W, H]);

  const drawMedia = (ctx: CanvasRenderingContext2D, L: VisualLayer, el: El, k: number, out: LayerBox[]) => {
    const c = L.clip;
    const sw = el instanceof HTMLVideoElement ? el.videoWidth : el.naturalWidth;
    const sh = el instanceof HTMLVideoElement ? el.videoHeight : el.naturalHeight;
    if (!sw || !sh) return;
    const cr = c.crop;
    const sx = sw * cr.l;
    const sy = sh * cr.t;
    const cw = Math.max(2, sw * (1 - cr.l - cr.r));
    const ch = Math.max(2, sh * (1 - cr.t - cr.b));
    const fit = fittedSize(cw, ch, W, H, 1);
    const dw = fit.w * L.scale;
    const dh = fit.h * L.scale;
    out.push({ clipId: c.id, cx: W / 2 + L.x, cy: H / 2 + L.y, w: dw, h: dh, rot: L.rotation });

    // background blur fill, behind the layer
    if (c.bgFill === "blur") {
      const cover = Math.max(W / cw, H / ch);
      ctx.save();
      ctx.globalAlpha = L.opacity / Math.max(0.0001, c.transform.opacity);
      ctx.filter = `blur(${(Math.max(W, H) / 40) * k}px) brightness(0.92)`;
      ctx.drawImage(el, sx, sy, cw, ch, (W * k - cw * cover * k) / 2, (H * k - ch * cover * k) / 2, cw * cover * k, ch * cover * k);
      ctx.restore();
    }
    // render the layer at its on-screen size into an offscreen canvas, apply effects there
    const ow = Math.max(2, Math.round(dw * k));
    const oh = Math.max(2, Math.round(dh * k));
    offA.width = ow;
    offA.height = oh;
    const o = offA.getContext("2d", { willReadFrequently: c.chroma.enabled })!;
    o.save();
    if (c.flipH || c.flipV) {
      o.translate(c.flipH ? ow : 0, c.flipV ? oh : 0);
      o.scale(c.flipH ? -1 : 1, c.flipV ? -1 : 1);
    }
    o.drawImage(el, sx, sy, cw, ch, 0, 0, ow, oh);
    o.restore();
    if (c.chroma.enabled) chromaKey(o, ow, oh, c);
    if (c.mask.shape !== "none") {
      offB.width = ow;
      offB.height = oh;
      const m = offB.getContext("2d")!;
      m.clearRect(0, 0, ow, oh);
      const feather = c.mask.feather * Math.min(ow, oh) * 0.5;
      m.filter = feather > 0.5 ? `blur(${feather}px)` : "none";
      m.fillStyle = "#fff";
      if (c.mask.invert) {
        m.fillRect(0, 0, ow, oh);
        m.globalCompositeOperation = "destination-out";
      }
      const mx = ow / 2 + c.mask.cx * ow;
      const my = oh / 2 + c.mask.cy * oh;
      m.beginPath();
      if (c.mask.shape === "ellipse") m.ellipse(mx, my, (ow * c.mask.w) / 2, (oh * c.mask.h) / 2, 0, 0, Math.PI * 2);
      else m.rect(mx - (ow * c.mask.w) / 2, my - (oh * c.mask.h) / 2, ow * c.mask.w, oh * c.mask.h);
      m.fill();
      o.globalCompositeOperation = "destination-in";
      o.drawImage(offB, 0, 0);
      o.globalCompositeOperation = "source-over";
    }
    // colour (SVG filter mirroring eq/hue/ccm/negate) + blur, then vignette
    const fUrl = colorFilterUrl(c);
    const blur = c.color.blur > 0 ? `blur(${c.color.blur * k}px)` : "";
    let src: HTMLCanvasElement = offA;
    if (fUrl || blur) {
      offB.width = ow;
      offB.height = oh;
      const b = offB.getContext("2d")!;
      b.filter = [fUrl, blur].filter(Boolean).join(" ");
      b.drawImage(offA, 0, 0);
      b.filter = "none";
      src = offB;
    }
    if (c.color.vignette > 0) {
      const v = src.getContext("2d")!;
      const g = v.createRadialGradient(ow / 2, oh / 2, Math.min(ow, oh) * 0.25, ow / 2, oh / 2, Math.hypot(ow, oh) / 2);
      g.addColorStop(0, "rgba(0,0,0,0)");
      g.addColorStop(1, `rgba(0,0,0,${0.35 + c.color.vignette * 0.6})`);
      v.globalCompositeOperation = "source-atop";
      v.fillStyle = g;
      v.fillRect(0, 0, ow, oh);
      v.globalCompositeOperation = "source-over";
    }
    ctx.save();
    ctx.globalAlpha = L.opacity;
    ctx.translate((W / 2 + L.x) * k, (H / 2 + L.y) * k);
    if (L.rotation) ctx.rotate((L.rotation * Math.PI) / 180);
    ctx.drawImage(src, -ow / 2, -oh / 2);
    ctx.restore();
  };

  const draw = (p: Project, frame: number, playing: boolean) => {
    const cv = canvasRef.current;
    if (!cv) return;
    const k = quality * Math.min(1, 1920 / Math.max(W, H));
    const cw = Math.round(W * k);
    const chh = Math.round(H * k);
    if (cv.width !== cw || cv.height !== chh) {
      cv.width = cw;
      cv.height = chh;
    }
    const ctx = cv.getContext("2d")!;
    ctx.fillStyle = p.profile.background;
    ctx.fillRect(0, 0, cw, chh);
    const layers = visualLayersAt(p, frame);
    const live = new Set<string>();
    const out: LayerBox[] = [];
    let waiting = false;
    for (const L of layers) {
      const c = L.clip;
      if (c.kind === "color") {
        ctx.globalAlpha = L.opacity;
        ctx.fillStyle = c.fillColor ?? "#000";
        ctx.fillRect(0, 0, cw, chh);
        ctx.globalAlpha = 1;
        continue;
      }
      if (c.kind === "text") {
        drawText(ctx, c, W, H, k, L, out);
        continue;
      }
      if (c.kind === "shape" && c.shape) {
        const w = c.shape.w * L.scale;
        const h = c.shape.h * L.scale;
        ctx.save();
        ctx.globalAlpha = L.opacity;
        ctx.translate((W / 2 + L.x) * k, (H / 2 + L.y) * k);
        if (L.rotation) ctx.rotate((L.rotation * Math.PI) / 180);
        ctx.fillStyle = c.shape.fill;
        ctx.beginPath();
        if (c.shape.type === "ellipse") ctx.ellipse(0, 0, (w * k) / 2, (h * k) / 2, 0, 0, Math.PI * 2);
        else ctx.rect((-w * k) / 2, (-h * k) / 2, w * k, h * k);
        ctx.fill();
        ctx.restore();
        out.push({ clipId: c.id, cx: W / 2 + L.x, cy: H / 2 + L.y, w, h, rot: L.rotation });
        continue;
      }
      const asset = p.assets.find((a) => a.id === c.assetId);
      if (!asset || !asset.meta.hasVideo) continue;
      if (session.ui.missing.has(asset.id)) {
        ctx.fillStyle = "#3a1d24";
        ctx.fillRect(0, 0, cw, chh);
        ctx.fillStyle = "#ff8a9a";
        ctx.font = `14px system-ui`;
        ctx.fillText(`Media offline: ${asset.name}`, 12, 22);
        continue;
      }
      live.add(c.id);
      const el = pool.current.get(c.id, asset.id, asset.kind === "image" ? "image" : "video");
      if (el instanceof HTMLVideoElement) {
        const want = Math.min(Math.max(0, L.sourceSeconds), Math.max(0, asset.meta.durationSec - 0.04));
        const speed = c.speed.num / c.speed.den;
        const seekOnly = c.freeze || c.reverse;
        if (playing && frame < clipEnd(c) && !seekOnly) {
          if (el.playbackRate !== speed) el.playbackRate = speed;
          if (el.paused) {
            el.currentTime = want;
            el.play().catch(() => {});
          } else if (Math.abs(el.currentTime - want) > 0.25) el.currentTime = want;
        } else {
          if (!el.paused) el.pause();
          if (Math.abs(el.currentTime - want) > 0.5 / (fps.num / fps.den) && !el.seeking) el.currentTime = want;
        }
        if (el.seeking) waiting = true;
      }
      if (!ready(el)) {
        waiting = true;
        continue;
      }
      drawMedia(ctx, L, el, k, out);
    }
    pool.current.retain(live);
    (window as any).__motifPreview = pool.current.all().map(([key, e]) => (e instanceof HTMLVideoElement ? { k: key, rs: e.readyState, t: e.currentTime } : { k: key, img: (e as HTMLImageElement).complete }));
    setBuffering(waiting);
    setBoxes(out);
  };
  drawRef.current = draw;

  const syncAudio = (p: Project, frame: number, playing: boolean) => {
    const live = new Set<string>();
    if (playing) {
      for (const { clip: c, track } of audioSources(p)) {
        if (frame < c.start || frame >= clipEnd(c) || session.ui.missing.has(c.assetId!) || c.freeze || c.reverse) continue;
        live.add(c.id);
        const el = audioPool.current.get(c.id, c.assetId!, "audio") as HTMLVideoElement;
        el.muted = false;
        const local = frame - c.start;
        let g = Math.pow(10, (propertyAt(c, "volume", local) + track.volumeDb) / 20);
        if (c.audio.fadeInFrames && local < c.audio.fadeInFrames) g *= local / c.audio.fadeInFrames;
        const toEnd = clipEnd(c) - frame;
        if (c.audio.fadeOutFrames && toEnd < c.audio.fadeOutFrames) g *= toEnd / c.audio.fadeOutFrames;
        el.volume = Math.max(0, Math.min(1, g * volume));
        const want = clipSourceSeconds(c, frame, fps);
        el.playbackRate = c.speed.num / c.speed.den;
        if (el.paused) {
          el.currentTime = want;
          el.play().catch(() => {});
        } else if (Math.abs(el.currentTime - want) > 0.2) el.currentTime = want;
      }
    }
    audioPool.current.retain(live);
  };

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

  useEffect(() => {
    if (ui.playing) return;
    draw(project, ui.playhead, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, ui.playhead, ui.playing, quality, ui.missing]);

  // ---------------------------------------------------------------- on-canvas transform handles
  const sel = ui.selection[0];
  const selBox = boxes.find((b) => b.clipId === sel);
  const dispK = box.w / W;
  const startDrag = (e: React.PointerEvent, mode: "move" | "scale" | "rotate") => {
    if (!selBox || !sel) return;
    e.stopPropagation();
    e.preventDefault();
    const hit = findClip(session.project, sel);
    if (!hit || hit.track.locked) return;
    const c0 = hit.clip;
    const local = Math.max(0, Math.min(c0.duration - 1, session.ui.playhead - c0.start));
    const x0 = e.clientX;
    const y0 = e.clientY;
    const startX = propertyAt(c0, "x", local);
    const startY = propertyAt(c0, "y", local);
    const startScale = propertyAt(c0, "scale", local);
    const startRot = propertyAt(c0, "rotation", local);
    const rect = (e.currentTarget.closest(".stage-frame") as HTMLElement).getBoundingClientRect();
    const cxScreen = rect.left + selBox.cx * dispK;
    const cyScreen = rect.top + selBox.cy * dispK;
    const d0 = Math.hypot(x0 - cxScreen, y0 - cyScreen);
    const a0 = Math.atan2(y0 - cyScreen, x0 - cxScreen);
    session.setUi({ cursorChip: null });
    const write = (prop: "x" | "y" | "scale" | "rotation", v: number) => (p: Project) => {
      const c = findClip(p, sel)!.clip;
      if (c.keyframes[prop]?.length && session.ui.playhead >= c.start && session.ui.playhead < clipEnd(c)) return setKeyframe(p, sel, prop, local, v);
      return updateClip(p, sel, { transform: { ...c.transform, [prop]: v } });
    };
    const move = (ev: PointerEvent) => {
      if (mode === "move") {
        let nx = startX + (ev.clientX - x0) / dispK;
        let ny = startY + (ev.clientY - y0) / dispK;
        // snap to canvas centre lines (Figma-like smart guides)
        if (Math.abs(nx) < 8 / dispK) nx = 0;
        if (Math.abs(ny) < 8 / dispK) ny = 0;
        session.runCoalesced("Move layer", `${sel}:drag`, (p) => write("y", Math.round(ny))(write("x", Math.round(nx))(p)));
        session.setUi({ cursorChip: { x: ev.clientX, y: ev.clientY, text: `X ${Math.round(nx)}  Y ${Math.round(ny)}` }, guides: { v: nx === 0, h: ny === 0 } });
      } else if (mode === "scale") {
        const d = Math.hypot(ev.clientX - cxScreen, ev.clientY - cyScreen);
        const s = Math.max(0.05, Math.min(5, (startScale * d) / Math.max(1, d0)));
        session.runCoalesced("Scale layer", `${sel}:drag`, write("scale", Math.round(s * 1000) / 1000));
        session.setUi({ cursorChip: { x: ev.clientX, y: ev.clientY, text: `${Math.round(s * 100)}%` } });
      } else {
        const a = Math.atan2(ev.clientY - cyScreen, ev.clientX - cxScreen);
        let deg = startRot + ((a - a0) * 180) / Math.PI;
        if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
        deg = ((((deg + 180) % 360) + 360) % 360) - 180;
        session.runCoalesced("Rotate layer", `${sel}:drag`, write("rotation", Math.round(deg * 10) / 10));
        session.setUi({ cursorChip: { x: ev.clientX, y: ev.clientY, text: `${Math.round(deg)}°` } });
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      session.setUi({ cursorChip: null, guides: null });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };

  const total = projectDuration(project);
  const progress = total ? ui.playhead / total : 0;
  const pickLayer = (e: React.PointerEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / dispK;
    const y = (e.clientY - rect.top) / dispK;
    const hitBox = [...boxes].reverse().find((b) => Math.abs(x - b.cx) <= b.w / 2 && Math.abs(y - b.cy) <= b.h / 2);
    session.setUi({ selection: hitBox ? [hitBox.clipId] : [] });
  };

  return (
    <div className="viewer" ref={wrapRef}>
      <div className="stage-frame" style={{ width: box.w, height: box.h }} onPointerDown={pickLayer}>
        <canvas ref={canvasRef} style={{ width: box.w, height: box.h }} aria-label="Preview" />
        {ui.guides?.v && <div className="guide v" />}
        {ui.guides?.h && <div className="guide h" />}
        {selBox && !ui.playing && (
          <div
            className="sel-box"
            style={{ left: (selBox.cx - selBox.w / 2) * dispK, top: (selBox.cy - selBox.h / 2) * dispK, width: selBox.w * dispK, height: selBox.h * dispK, transform: `rotate(${selBox.rot}deg)` }}
            onPointerDown={(e) => startDrag(e, "move")}
          >
            {(["nw", "ne", "sw", "se"] as const).map((h) => (
              <div key={h} className={`handle-dot ${h}`} onPointerDown={(e) => startDrag(e, "scale")} />
            ))}
            <div className="rot-handle" onPointerDown={(e) => startDrag(e, "rotate")} title="Rotate (Shift snaps 15°)" />
          </div>
        )}
        {buffering && !ui.playing && <div className="buffering">Loading frame…</div>}
        {quality < 1 && <div className="quality-badge" title="Preview is drawn at reduced resolution; export uses full quality">Preview {Math.round(quality * 100)}%</div>}
      </div>

      <div className="viewer-pills">
        <div className="pill glass">
          <select className="pill-select" value={`${W}x${H}`} disabled title="Canvas size is set when the project is created">
            <option>{W >= H ? (Math.abs(W / H - 16 / 9) < 0.01 ? "16:9" : `${W}:${H}`) : Math.abs(H / W - 16 / 9) < 0.01 ? "9:16" : `${W}:${H}`}</option>
          </select>
          <select
            className="pill-select"
            value={quality}
            aria-label="Preview quality"
            onChange={(e) => {
              const q = Number(e.target.value) as 0.25 | 0.5 | 1;
              setQuality(q);
              window.motif.setSettings({ previewScale: q });
            }}
          >
            <option value={0.25}>¼</option>
            <option value={0.5}>½</option>
            <option value={1}>Full</option>
          </select>
        </div>
        <div className="pill glass transport">
          <button className="icon-btn" title="Go to start (Home)" onClick={() => session.setUi({ playhead: 0 })}><Icon name="prev" size={15} /></button>
          <button className="icon-btn" title="Previous frame (←)" onClick={() => session.setUi({ playhead: Math.max(0, ui.playhead - 1) })}><Icon name="stepb" size={15} /></button>
          <button className="icon-btn play" title="Play / pause (Space)" disabled={total === 0} onClick={() => session.setUi({ playing: !ui.playing })}>
            <Icon name={ui.playing ? "pause" : "play"} size={15} />
          </button>
          <button className="icon-btn" title="Next frame (→)" onClick={() => session.setUi({ playhead: ui.playhead + 1 })}><Icon name="stepf" size={15} /></button>
          <button className="icon-btn" title="Go to end (End)" onClick={() => session.setUi({ playhead: Math.max(0, total - 1) })}><Icon name="next" size={15} /></button>
          <span className="tc">{formatTimecode(ui.playhead, fps)}<span className="dim"> / {formatTimecode(total, fps)}</span></span>
          <div
            className="scrubber"
            onPointerDown={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const set = (x: number) => session.setUi({ playing: false, playhead: Math.max(0, Math.min(total - 1, Math.round(((x - r.left) / r.width) * total))) });
              set(e.clientX);
              const mv = (ev: PointerEvent) => set(ev.clientX);
              window.addEventListener("pointermove", mv);
              window.addEventListener("pointerup", () => window.removeEventListener("pointermove", mv), { once: true });
            }}
          >
            <div className="scrub-fill" style={{ width: `${progress * 100}%` }} />
          </div>
        </div>
        <div className="pill glass">
          <button className="icon-btn" title="Crop selected clip" disabled={!sel} onClick={() => session.setUi({ inspectorTab: "video" })}><Icon name="crop" size={15} /></button>
          <button className="icon-btn" title="Adjust colour" disabled={!sel} onClick={() => session.setUi({ inspectorTab: "adjust" })}><Icon name="adjust" size={15} /></button>
          <button className="icon-btn" title="Fullscreen preview" onClick={() => (document.fullscreenElement ? document.exitFullscreen() : wrapRef.current?.requestFullscreen())}><Icon name="fullscreen" size={15} /></button>
        </div>
      </div>
      <div className="vol-pill glass" title="Preview volume">
        <Icon name="volume" size={14} />
        <input type="range" min={0} max={1} step={0.01} value={volume} onChange={(e) => setVolume(Number(e.target.value))} aria-label="Preview volume" />
        <Icon name="mute" size={14} />
      </div>
      <span hidden>{framesToSeconds(total, fps)}</span>
    </div>
  );
}

