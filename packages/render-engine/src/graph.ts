/**
 * Build an FFmpeg render job (structured argv + temp files) from the canonical
 * project. This is the export side of the shared composition model in
 * @motif/editor-core (evaluate.ts + motion.ts): the same rules decide which
 * clips are visible, transition tails, keyframes, animations and audio routing.
 */
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fontFile, type Clip, type Keyframe, type Project, type RenderPreset, type Track } from "@motif/project-schema";
import { clipEnd, framesToSeconds, isTrackAudible, projectDuration, fittedSize, motionSpec, motionExprs, colorMatrix, type MotionSpec } from "@motif/editor-core";
import { filterPath, runFfmpeg } from "./ffmpeg.js";

export interface RenderJobSpec {
  args: string[];
  durationSec: number;
  tempDir: string;
  filterGraph: string;
  cleanup: () => Promise<void>;
}

export interface BuildOptions {
  outputPath: string;
  /** directory holding the bundled fonts (FONTS in project-schema) */
  fontDir?: string;
  /** legacy single font file override */
  fontFile?: string;
  /** Optional sub-range in frames [start, end). Defaults to the whole project. */
  range?: { start: number; end: number };
  overwrite?: boolean;
}

const FONT_CANDIDATES = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
  "/Library/Fonts/Arial Bold.ttf",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "C:/Windows/Fonts/arialbd.ttf",
  "C:/Windows/Fonts/arial.ttf",
];

export function findDefaultFont(): string | undefined {
  if (process.env.MOTIF_FONT && existsSync(process.env.MOTIF_FONT)) return process.env.MOTIF_FONT;
  return FONT_CANDIDATES.find((f) => existsSync(f));
}

const n = (v: number) => (Math.round(v * 1e6) / 1e6).toString();
const hexAlpha = (hex: string, alpha: number) => `0x${hex.replace("#", "")}@${n(alpha)}`;
const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

/** FFmpeg expression for a keyframed property as a function of local time `tv` (seconds). */
export function keyframeExpr(kfs: Keyframe[] | undefined, fallback: number, fpsNum: number, fpsDen: number, tv: string): string {
  if (!kfs || kfs.length === 0) return n(fallback);
  const sec = (f: number) => (f * fpsDen) / fpsNum;
  let expr = n(kfs[kfs.length - 1]!.value);
  for (let i = kfs.length - 2; i >= 0; i--) {
    const a = kfs[i]!;
    const b = kfs[i + 1]!;
    const ta = sec(a.frame);
    const tb = sec(b.frame);
    const u = `((${tv})-${n(ta)})/${n(tb - ta)}`;
    let e: string;
    switch (a.easing) {
      case "easeIn":
        e = `(${u})*(${u})`;
        break;
      case "easeOut":
        e = `(1-(1-(${u}))*(1-(${u})))`;
        break;
      case "easeInOut":
        e = `if(lt(${u},0.5),2*(${u})*(${u}),1-pow(-2*(${u})+2,2)/2)`;
        break;
      case "hold":
        e = "0";
        break;
      default:
        e = `(${u})`;
    }
    expr = `if(lt(${tv},${n(tb)}),${n(a.value)}+${n(b.value - a.value)}*${e},${expr})`;
  }
  return `if(lt(${tv},${n(sec(kfs[0]!.frame))}),${n(kfs[0]!.value)},${expr})`;
}

function atempoChain(r: number): string[] {
  const out: string[] = [];
  let x = r;
  while (x < 0.5) {
    out.push("atempo=0.5");
    x /= 0.5;
  }
  while (x > 2) {
    out.push("atempo=2");
    x /= 2;
  }
  if (Math.abs(x - 1) > 1e-9) out.push(`atempo=${n(x)}`);
  return out;
}

/** Pixel-space filters applied after scaling (shared parameters with preview). */
function colorFilters(c: Clip): string[] {
  const col = c.color;
  const f: string[] = [];
  const sat = col.saturation * (1 - col.grayscale);
  if (col.brightness !== 0 || col.contrast !== 1 || sat !== 1) f.push(`eq=brightness=${n(col.brightness)}:contrast=${n(col.contrast)}:saturation=${n(sat)}`);
  if (col.hue) f.push(`hue=h=${n(col.hue)}`);
  if (col.sepia || col.temperature) {
    const m = colorMatrix(col.sepia, col.temperature);
    const k = ["r", "g", "b"];
    f.push("colorchannelmixer=" + m.flatMap((row, i) => row.map((v, j) => `${k[i]}${k[j]}=${n(v)}`)).join(":"));
  }
  if (col.invert) f.push("negate");
  if (col.blur > 0) f.push(`gblur=sigma=${n(col.blur)}`);
  if (col.vignette > 0) f.push(`vignette=angle=${n(0.15 + col.vignette * 0.75)}`);
  return f;
}

function alphaFades(spec: MotionSpec, lo: number, fpsN: number): string[] {
  const out: string[] = [];
  for (const r of spec.alpha) {
    if (r.dir === "in") {
      if (lo >= r.N) continue;
      out.push(`fade=t=in:st=0:d=${n((r.N - lo) / fpsN)}:alpha=1`);
    } else {
      const st = (spec.dur - r.N - lo) / fpsN;
      out.push(`fade=t=out:st=${n(Math.max(0, st))}:d=${n(r.N / fpsN)}:alpha=1`);
    }
  }
  return out;
}

async function makeMask(tempDir: string, name: string, w: number, h: number, shape: "ellipse" | "rect", mw: number, mh: number, cx: number, cy: number, feather: number, invert: boolean): Promise<string> {
  const out = join(tempDir, name);
  const rx = Math.max(1, (w * mw) / 2);
  const ry = Math.max(1, (h * mh) / 2);
  const x0 = w / 2 + cx * w;
  const y0 = h / 2 + cy * h;
  // Analytic soft edge (no blur filter): deterministic across CPUs/SIMD paths.
  const d = shape === "ellipse" ? `hypot((X-${n(x0)})/${n(rx)},(Y-${n(y0)})/${n(ry)})` : `max(abs(X-${n(x0)})/${n(rx)},abs(Y-${n(y0)})/${n(ry)})`;
  const edge = Math.max(1, feather * Math.min(w, h)); // feather width in pixels
  const r = Math.min(rx, ry);
  const inside = `clip((1-${d})*${n(r)}/${n(edge)}+0.5,0,1)`;
  const lum = invert ? `255*(1-${inside})` : `255*${inside}`;
  const vf = `format=gray,geq=lum='${lum}'`;
  await runFfmpeg(["-y", "-f", "lavfi", "-i", `color=c=black:s=${even(w)}x${even(h)}:d=1`, "-vf", vf, "-frames:v", "1", out]);
  return out;
}

interface VisualItem {
  clip: Clip;
  track: Track;
  t0: number;
  t1: number;
}

export async function buildRenderJob(project: Project, preset: RenderPreset, opts: BuildOptions): Promise<RenderJobSpec> {
  const fps = project.profile.fps;
  const fpsN = fps.num / fps.den;
  const { width: W, height: H } = project.profile;
  const fpsStr = `${fps.num}/${fps.den}`;
  const kind = preset.kind ?? "video";
  const range = opts.range ?? { start: 0, end: projectDuration(project) };
  if (kind === "frame") range.end = range.start + 1;
  if (range.end <= range.start) throw new Error("Nothing to export: the timeline is empty.");
  const rangeStartSec = framesToSeconds(range.start, fps);
  const D = framesToSeconds(range.end - range.start, fps);
  const sec = (f: number) => framesToSeconds(f, fps);
  const tempDir = await mkdtemp(join(tmpdir(), "motif-render-"));
  const inputs: string[] = [];
  const chains: string[] = [];
  let inputIndex = 0;
  const legacyFont = opts.fontFile ?? findDefaultFont();
  const resolveFont = (id: string, bold: boolean) => {
    if (opts.fontDir) {
      const f = join(opts.fontDir, fontFile(id, bold));
      if (existsSync(f)) return f;
    }
    return legacyFont;
  };

  const wantVideo = kind !== "audio";
  const wantAudio = kind === "video" || kind === "audio";

  // ---------------------------------------------------------------- video
  if (wantVideo) {
    chains.push(`color=c=${hexAlpha(project.profile.background, 1)}:s=${W}x${H}:r=${fpsStr}:d=${n(D)},format=yuv420p,setsar=1[base0]`);
    let last = "base0";
    const items: VisualItem[] = [];
    for (const track of project.tracks) {
      if (track.kind === "audio" || track.hidden) continue;
      const sorted = [...track.clips].sort((a, b) => a.start - b.start);
      sorted.forEach((c, i) => {
        if (!c.enabled) return;
        const next = sorted[i + 1];
        const tail = next && next.enabled && next.transitionIn && next.start === clipEnd(c) ? next.transitionIn.frames : 0;
        const t0 = Math.max(c.start, range.start);
        const t1 = Math.min(clipEnd(c) + tail, range.end);
        if (t1 > t0) items.push({ clip: c, track, t0, t1 });
      });
    }

    let k = 0;
    for (const it of items) {
      const c = it.clip;
      const id = k++;
      const winFrames = it.t1 - it.t0;
      const winDur = sec(winFrames);
      const lo = it.t0 - c.start; // local frame at window start
      const shift = sec(it.t0) - rangeStartSec;
      const speed = c.speed.num / c.speed.den;
      const spec = motionSpec(c, W, H);
      const L = `((t)*${n(fpsN)}+${lo})`; // local frame expression in layer time (before shift)
      const Lout = `((t-${n(shift)})*${n(fpsN)}+${lo})`; // local frame in output time (overlay)
      const mo = motionExprs(spec, L);
      const moOut = motionExprs(spec, Lout);
      const tvLocal = `(t+${n(sec(lo))})`;
      const tvOut = `(t-${n(shift)}+${n(sec(lo))})`;
      const parts: string[] = [];
      let bgChain: string | null = null;
      let baseW = W;
      let baseH = H;

      if (c.kind === "media") {
        const asset = project.assets.find((a) => a.id === c.assetId);
        if (!asset) throw new Error(`Clip "${c.name}" references missing media.`);
        if (!asset.meta.hasVideo) continue;
        const src = asset.proxyPath ?? asset.path;
        if (asset.kind === "image") {
          inputs.push("-loop", "1", "-framerate", fpsStr, "-t", n(winDur + 0.5), "-i", src);
          parts.push(`[${inputIndex}:v]setpts=PTS-STARTPTS`, `fps=${fpsStr}`);
        } else if (c.freeze) {
          inputs.push("-ss", n(sec(c.sourceIn)), "-t", "0.5", "-i", src);
          parts.push(`[${inputIndex}:v]trim=end_frame=1`, "setpts=PTS-STARTPTS", `tpad=stop_mode=clone:stop_duration=${n(winDur + 1)}`, `fps=${fpsStr}`);
        } else if (c.reverse) {
          const span = c.duration * speed; // source frames covered
          const hiLocal = Math.min(lo + winFrames, c.duration);
          const sHi = c.sourceIn + span - hiLocal * speed;
          const sLo = c.sourceIn + span - lo * speed;
          inputs.push("-ss", n(sec(Math.max(0, sHi))), "-t", n(sec(sLo - sHi) + 0.05), "-i", src);
          parts.push(`[${inputIndex}:v]trim=duration=${n(sec(sLo - sHi))}`, "reverse", `setpts=(PTS-STARTPTS)/${n(speed)}`, `fps=${fpsStr}`);
        } else {
          const srcStart = sec(c.sourceIn) + sec(lo) * speed;
          inputs.push("-ss", n(srcStart), "-t", n(winDur * speed + 0.25), "-i", src);
          parts.push(`[${inputIndex}:v]setpts=(PTS-STARTPTS)/${n(speed)}`, `fps=${fpsStr}`);
        }
        inputIndex++;
        parts.push(`tpad=stop_mode=clone:stop_duration=${n(winDur + 1)}`, `trim=duration=${n(winDur)}`, "setsar=1");
        const sw = asset.meta.width ?? W;
        const sh = asset.meta.height ?? H;
        if (c.bgFill === "blur") {
          parts.push("split[m" + id + "][bgs" + id + "]");
          chains.push(parts.join(",").replace(/,split\[/, ",split["));
          parts.length = 0;
          parts.push(`[m${id}]null`);
          bgChain = `[bgs${id}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=${n(Math.max(W, H) / 40)},eq=brightness=-0.08,format=yuva420p`;
        }
        // crop
        const cr = c.crop;
        const cw = even(sw * (1 - cr.l - cr.r));
        const ch = even(sh * (1 - cr.t - cr.b));
        if (cr.l || cr.t || cr.r || cr.b) parts.push(`crop=${cw}:${ch}:${n(sw * cr.l)}:${n(sh * cr.t)}`);
        parts.push(`scale=${cw}:${ch}`);
        if (c.flipH) parts.push("hflip");
        if (c.flipV) parts.push("vflip");
        parts.push("format=yuva420p");
        if (c.chroma.enabled) parts.push(`chromakey=color=${hexAlpha(c.chroma.color, 1).split("@")[0]}:similarity=${n(c.chroma.similarity)}:blend=${n(c.chroma.blend)}`);
        if (c.mask.shape !== "none") {
          const mpath = await makeMask(tempDir, `mask_${id}.png`, cw, ch, c.mask.shape, c.mask.w, c.mask.h, c.mask.cx, c.mask.cy, c.mask.feather, c.mask.invert);
          inputs.push("-loop", "1", "-framerate", fpsStr, "-t", n(winDur + 1), "-i", mpath);
          const mi = inputIndex++;
          chains.push(`[${mi}:v]format=gray,scale=${cw}:${ch},trim=duration=${n(winDur)}[mk${id}]`);
          parts.push(`split[ma${id}][mb${id}]`);
          chains.push(parts.join(","));
          chains.push(`[mb${id}]alphaextract[mal${id}]`, `[mal${id}][mk${id}]blend=all_mode=multiply[mam${id}]`);
          parts.length = 0;
          parts.push(`[ma${id}][mam${id}]alphamerge`);
        }
        const fit = fittedSize(cw, ch, W, H, 1);
        baseW = fit.w;
        baseH = fit.h;
      } else if (c.kind === "shape" && c.shape) {
        const sw = even(c.shape.w);
        const sh = even(c.shape.h);
        parts.push(`color=c=${hexAlpha(c.shape.fill, 1)}:s=${sw}x${sh}:r=${fpsStr}:d=${n(winDur)}`, "format=yuva420p");
        if (c.shape.type === "ellipse") {
          const mpath = await makeMask(tempDir, `shape_${id}.png`, sw, sh, "ellipse", 1, 1, 0, 0, 0.01, false);
          inputs.push("-loop", "1", "-framerate", fpsStr, "-t", n(winDur + 1), "-i", mpath);
          const mi = inputIndex++;
          chains.push(`[${mi}:v]format=gray,scale=${sw}:${sh},trim=duration=${n(winDur)}[mk${id}]`);
          chains.push(parts.join(",") + `[shp${id}]`);
          parts.length = 0;
          parts.push(`[shp${id}][mk${id}]alphamerge`);
        }
        baseW = sw;
        baseH = sh;
      } else if (c.kind === "color") {
        parts.push(`color=c=${hexAlpha(c.fillColor ?? "#000000", 1)}:s=${W}x${H}:r=${fpsStr}:d=${n(winDur)}`, "format=yuva420p");
      } else {
        if (!c.text) continue;
        const font = resolveFont(c.text.font, c.text.bold);
        if (!font) throw new Error("No font available for titles. Set MOTIF_FONT to a .ttf file.");
        const textFile = join(tempDir, `text_${id}.txt`);
        await writeFile(textFile, c.text.content, "utf8");
        const fs = Math.round(c.text.fontSize * (H / 1080) * c.transform.scale);
        const yExpr = c.text.align === "lower-third" ? "h*0.85-text_h/2" : c.text.align === "top" ? "h*0.08" : "(h-text_h)/2";
        const box = c.text.boxColor ? `:box=1:boxcolor=${hexAlpha(c.text.boxColor, c.text.boxOpacity)}:boxborderw=${Math.round(fs * 0.35)}` : "";
        const stroke = c.text.strokeWidth > 0 ? `:borderw=${n(c.text.strokeWidth * (H / 1080))}:bordercolor=${hexAlpha(c.text.strokeColor, 1)}` : "";
        const shadow = c.text.shadow ? `:shadowcolor=black@0.45:shadowx=${Math.max(1, Math.round(2 * (H / 1080)))}:shadowy=${Math.max(1, Math.round(2 * (H / 1080)))}` : "";
        parts.push(
          `color=c=black@0.0:s=${W}x${H}:r=${fpsStr}:d=${n(winDur)}`,
          "format=yuva420p",
          `drawtext=fontfile=${filterPath(font)}:textfile=${filterPath(textFile)}:fontsize=${fs}:fontcolor=${hexAlpha(c.text.color, 1)}:x=(w-text_w)/2:y=${yExpr}:line_spacing=${Math.round(fs * 0.2)}${box}${stroke}${shadow}`,
        );
      }

      // scale (static or animated by keyframes / motion)
      const isFull = c.kind === "text" || c.kind === "color";
      const kfScale = c.keyframes.scale?.length ? keyframeExpr(c.keyframes.scale, c.transform.scale, fps.num, fps.den, tvLocal) : null;
      const staticScale = isFull ? 1 : c.transform.scale;
      if (kfScale || mo.scale !== "1") {
        const se = `(${kfScale ?? n(staticScale)})*(${mo.scale})`;
        parts.push(`scale=w='max(2,2*trunc(${baseW}*${se}/2))':h='max(2,2*trunc(${baseH}*${se}/2))':eval=frame`);
      } else if (!isFull) parts.push(`scale=${even(baseW * staticScale)}:${even(baseH * staticScale)}`);
      parts.push("setsar=1");
      if (c.kind === "media") parts.push(...colorFilters(c));
      parts.push("format=yuva420p");
      // rotation
      const rk = c.keyframes.rotation;
      if (rk && rk.length) {
        const ae = `(${keyframeExpr(rk, c.transform.rotation, fps.num, fps.den, tvLocal)})*PI/180`;
        parts.push(`rotate=a='${ae}':c=none:ow='hypot(iw,ih)':oh='hypot(iw,ih)'`);
      } else if (c.transform.rotation && !isFull) {
        const a = (c.transform.rotation * Math.PI) / 180;
        parts.push(`rotate=${n(a)}:c=none:ow=rotw(${n(a)}):oh=roth(${n(a)})`);
      }
      if (c.transform.opacity < 1) parts.push(`colorchannelmixer=aa=${n(c.transform.opacity)}`);
      const fades = alphaFades(spec, lo, fpsN);
      parts.push(...fades);
      parts.push(`setpts=PTS+${n(shift)}/TB`);
      chains.push(parts.join(",") + `[v${id}]`);

      const xe = keyframeExpr(c.keyframes.x, c.transform.x, fps.num, fps.den, tvOut);
      const ye = keyframeExpr(c.keyframes.y, c.transform.y, fps.num, fps.den, tvOut);
      const endT = shift + winDur;
      const enable = `between(t,${n(shift)},${n(endT - 1e-4)})`;
      if (bgChain) {
        chains.push(`${bgChain},${fades.length ? fades.join(",") + "," : ""}setpts=PTS+${n(shift)}/TB[bg${id}]`);
        chains.push(`[${last}][bg${id}]overlay=x=0:y=0:eof_action=pass:format=auto:enable='${enable}'[ob${id}]`);
        last = `ob${id}`;
      }
      const xPos = `(main_w-overlay_w)/2+${xe}+${moOut.dx}`;
      const yPos = `(main_h-overlay_h)/2+${ye}+${moOut.dy}`;
      chains.push(`[${last}][v${id}]overlay=x='${xPos}':y='${yPos}':eval=frame:eof_action=pass:format=auto:enable='${enable}'[ov${id}]`);
      last = `ov${id}`;
    }

    const outW = kind === "frame" || kind === "gif" || kind === "video" ? preset.width : W;
    const outH = kind === "frame" || kind === "gif" || kind === "video" ? preset.height : H;
    const presetFps = `${preset.fps.num}/${preset.fps.den}`;
    const needsScale = outW !== W || outH !== H;
    const scaleStr = needsScale
      ? `scale=${outW}:${outH}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2:color=${hexAlpha(project.profile.background, 1)},`
      : "";
    if (kind === "gif") {
      chains.push(`[${last}]${scaleStr}fps=${presetFps},trim=duration=${n(D)},split[g1][g2]`, `[g1]palettegen=stats_mode=diff[pal]`, `[g2][pal]paletteuse=dither=bayer:bayer_scale=4[vout]`);
    } else if (kind === "frame") {
      chains.push(`[${last}]${scaleStr}format=rgb24,trim=end_frame=1[vout]`);
    } else {
      const pix = preset.videoCodec === "prores_ks" ? "yuv422p10le" : "yuv420p";
      chains.push(`[${last}]${scaleStr}fps=${presetFps},format=${pix},trim=duration=${n(D)}[vout]`);
    }
  }

  // ---------------------------------------------------------------- audio
  if (wantAudio) {
    const SR = project.profile.sampleRate;
    const audioLabels: string[] = [];
    chains.push(`anullsrc=r=${SR}:cl=stereo,atrim=duration=${n(D)}[asil]`);
    audioLabels.push("asil");
    let ak = 0;
    for (const track of project.tracks) {
      if (track.kind === "text" || !isTrackAudible(project, track)) continue;
      for (const c of track.clips) {
        if (!c.enabled || c.audio.muted || c.kind !== "media" || c.freeze) continue;
        const asset = project.assets.find((a) => a.id === c.assetId);
        if (!asset?.meta.hasAudio) continue;
        const t0 = Math.max(c.start, range.start);
        const t1 = Math.min(clipEnd(c), range.end);
        if (t1 <= t0) continue;
        const speed = c.speed.num / c.speed.den;
        const lo = t0 - c.start;
        const winDur = sec(t1 - t0);
        const src = asset.proxyPath ?? asset.path;
        const parts: string[] = [];
        if (c.reverse) {
          const span = c.duration * speed;
          const hiLocal = t1 - c.start;
          const sHi = c.sourceIn + span - hiLocal * speed;
          const sLo = c.sourceIn + span - lo * speed;
          inputs.push("-ss", n(sec(Math.max(0, sHi))), "-t", n(sec(sLo - sHi) + 0.05), "-i", src);
          parts.push(`[${inputIndex}:a]atrim=duration=${n(sec(sLo - sHi))}`, "areverse", `aresample=${SR}`);
        } else {
          const srcStart = sec(c.sourceIn) + sec(lo) * speed;
          inputs.push("-ss", n(srcStart), "-t", n(winDur * speed + 0.1), "-i", src);
          parts.push(`[${inputIndex}:a]aresample=${SR}`);
        }
        inputIndex++;
        const gainDb = c.audio.gainDb + track.volumeDb;
        const Lg = Math.min(1, 1 - c.audio.pan);
        const Rg = Math.min(1, 1 + c.audio.pan);
        parts.push("aformat=sample_fmts=fltp:channel_layouts=stereo", "asetpts=PTS-STARTPTS");
        if (c.audio.denoise) parts.push("afftdn=nf=-25");
        if (c.audio.pitch) parts.push(`rubberband=pitch=${n(Math.pow(2, c.audio.pitch / 12))}`);
        parts.push(...atempoChain(speed), `atrim=duration=${n(winDur)}`, `volume=${n(gainDb)}dB`);
        if (c.audio.pan !== 0) parts.push(`pan=stereo|c0=${n(Lg)}*c0|c1=${n(Rg)}*c1`);
        const fin = c.audio.fadeInFrames - lo;
        if (fin > 0) parts.push(`afade=t=in:st=0:d=${n(sec(fin))}`);
        if (c.audio.fadeOutFrames > 0) {
          const fo = Math.min(c.audio.fadeOutFrames, c.duration);
          const st = sec(clipEnd(c) - fo - t0);
          if (st < winDur) parts.push(`afade=t=out:st=${n(Math.max(0, st))}:d=${n(sec(fo))}`);
        }
        const delayMs = Math.round((sec(t0) - rangeStartSec) * 1000);
        parts.push(`adelay=${delayMs}|${delayMs}`);
        const lab = `a${ak++}`;
        chains.push(parts.join(",") + `[${lab}]`);
        audioLabels.push(lab);
      }
    }
    chains.push(
      `${audioLabels.map((l) => `[${l}]`).join("")}amix=inputs=${audioLabels.length}:duration=first:dropout_transition=0:normalize=0,atrim=duration=${n(D)},aformat=sample_fmts=fltp:channel_layouts=stereo[aout]`,
    );
  }

  const filterGraph = chains.join(";\n");
  const codec: string[] = [];
  const vb = preset.bitrateMbps;
  const rate = (crfArgs: string[]) => (vb ? ["-b:v", `${vb}M`, "-maxrate", `${vb * 1.5}M`, "-bufsize", `${vb * 2}M`] : crfArgs);
  if (kind === "video") {
    switch (preset.videoCodec) {
      case "libx264":
        codec.push("-c:v", "libx264", "-preset", preset.preset, ...rate(["-crf", String(preset.crf)]), "-profile:v", "high");
        break;
      case "libx265":
        codec.push("-c:v", "libx265", "-preset", preset.preset, ...rate(["-crf", String(Math.min(51, preset.crf + 4))]), "-tag:v", "hvc1", "-x265-params", "log-level=error");
        break;
      case "libsvtav1": {
        const p = { ultrafast: 12, veryfast: 10, fast: 9, medium: 8, slow: 5 }[preset.preset];
        codec.push("-c:v", "libsvtav1", "-preset", String(p), ...rate(["-crf", String(Math.min(63, preset.crf + 12))]));
        break;
      }
      case "libvpx-vp9":
        codec.push("-c:v", "libvpx-vp9", ...(vb ? ["-b:v", `${vb}M`] : ["-crf", String(preset.crf), "-b:v", "0"]), "-row-mt", "1", "-deadline", "good", "-cpu-used", "4");
        break;
      case "prores_ks":
        codec.push("-c:v", "prores_ks", "-profile:v", "2");
        break;
      default:
        throw new Error(`Unsupported video codec ${preset.videoCodec}`);
    }
    if (preset.container === "mp4" || preset.container === "mov") codec.push("-movflags", "+faststart");
  } else if (kind === "gif") {
    codec.push("-c:v", "gif", "-loop", "0");
  } else if (kind === "frame") {
    codec.push("-c:v", "png", "-frames:v", "1");
  }
  if (wantAudio && preset.audioCodec !== "none") {
    if (preset.audioCodec === "pcm_s16le") codec.push("-c:a", "pcm_s16le");
    else codec.push("-c:a", preset.audioCodec, "-b:a", `${preset.audioBitrateK}k`);
    codec.push("-ar", String(preset.audioCodec === "libopus" ? 48000 : project.profile.sampleRate), "-ac", "2");
  }

  let graphArgs: string[];
  if (filterGraph.length > 60_000) {
    const scriptPath = join(tempDir, "graph.txt");
    await writeFile(scriptPath, filterGraph, "utf8");
    graphArgs = ["-/filter_complex", scriptPath];
  } else graphArgs = ["-filter_complex", filterGraph];

  const maps: string[] = [];
  if (wantVideo) maps.push("-map", "[vout]");
  if (wantAudio && preset.audioCodec !== "none") maps.push("-map", "[aout]");

  const args = [
    opts.overwrite === false ? "-n" : "-y",
    ...inputs,
    ...graphArgs,
    ...maps,
    ...codec,
    ...(kind === "frame" ? [] : ["-t", n(D)]),
    ...(kind === "frame" || kind === "gif" ? [] : ["-metadata", `title=${project.title}`, "-metadata", "encoder=MOTIF Studio"]),
    opts.outputPath,
  ];

  return { args, durationSec: D, tempDir, filterGraph, cleanup: () => rm(tempDir, { recursive: true, force: true }) };
}
