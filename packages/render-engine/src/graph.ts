/**
 * Build an FFmpeg render job (structured argv + temp files) from the canonical
 * project. This is the export side of the shared composition model in
 * @motif/editor-core/evaluate: the same rules decide which clips are visible,
 * crossfade tails, keyframe interpolation and audio routing.
 *
 * Supported in export (and therefore offered in the UI):
 *  - media clips (video/image), colour clips, text clips (title/caption)
 *  - static transform: x/y offset, scale, rotation, opacity
 *  - keyframes: x, y, scale (all easings)
 *  - colour adjust: brightness/contrast/saturation (eq filter)
 *  - same-track crossfade transitions
 *  - speed 0.25x..4x (video setpts, audio atempo)
 *  - audio: gain, pan, fade in/out, track volume, mute/solo
 */
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clip, Keyframe, Project, RenderPreset, Track } from "@motif/project-schema";
import { clipEnd, framesToSeconds, isTrackAudible, projectDuration, fittedSize, interpolate } from "@motif/editor-core";
import { filterPath } from "./ffmpeg.js";

export interface RenderJobSpec {
  args: string[];
  durationSec: number;
  tempDir: string;
  filterGraph: string;
  cleanup: () => Promise<void>;
}

export interface BuildOptions {
  outputPath: string;
  fontFile?: string;
  /** Optional sub-range in frames [inPoint, outPoint). Defaults to the whole project. */
  range?: { start: number; end: number };
  overwrite?: boolean;
}

const FONT_CANDIDATES = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
  "/Library/Fonts/Arial Bold.ttf",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
  "C:/Windows/Fonts/arialbd.ttf",
  "C:/Windows/Fonts/arial.ttf",
];

export function findDefaultFont(): string | undefined {
  if (process.env.MOTIF_FONT && existsSync(process.env.MOTIF_FONT)) return process.env.MOTIF_FONT;
  return FONT_CANDIDATES.find((f) => existsSync(f));
}

const n = (v: number) => (Math.round(v * 1e6) / 1e6).toString();

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
    const seg = `${n(a.value)}+${n(b.value - a.value)}*${e}`;
    expr = `if(lt(${tv},${n(tb)}),${seg},${expr})`;
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

function hexAlpha(hex: string, alpha: number) {
  return `0x${hex.replace("#", "")}@${n(alpha)}`;
}

interface VisualItem {
  clip: Clip;
  track: Track;
  t0: number; // timeline frames (window start)
  t1: number; // window end incl. crossfade tail
}

export async function buildRenderJob(project: Project, preset: RenderPreset, opts: BuildOptions): Promise<RenderJobSpec> {
  const fps = project.profile.fps;
  const { width: W, height: H } = project.profile;
  const fpsStr = `${fps.num}/${fps.den}`;
  const range = opts.range ?? { start: 0, end: projectDuration(project) };
  if (range.end <= range.start) throw new Error("Nothing to export: the timeline is empty.");
  const rangeStartSec = framesToSeconds(range.start, fps);
  const D = framesToSeconds(range.end - range.start, fps);
  const sec = (f: number) => framesToSeconds(f, fps);
  const tempDir = await mkdtemp(join(tmpdir(), "motif-render-"));
  const inputs: string[] = [];
  const chains: string[] = [];
  let inputIndex = 0;
  const font = opts.fontFile ?? findDefaultFont();

  // ---------------------------------------------------------------- video
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
    const label = `v${k++}`;
    const winDur = sec(it.t1 - it.t0);
    const localOffsetFrames = it.t0 - c.start; // >0 when range starts inside the clip
    const shift = sec(it.t0) - rangeStartSec; // timeline position inside the output
    const speed = c.speed.num / c.speed.den;
    const parts: string[] = [];
    let w = W;
    let h = H;
    let isFullCanvasLayer = false;

    if (c.kind === "media") {
      const asset = project.assets.find((a) => a.id === c.assetId);
      if (!asset) throw new Error(`Clip "${c.name}" references missing media.`);
      if (!asset.meta.hasVideo) continue;
      const srcStart = sec(c.sourceIn) + sec(localOffsetFrames) * speed;
      const span = winDur * speed;
      if (asset.kind === "image") {
        inputs.push("-loop", "1", "-framerate", fpsStr, "-t", n(winDur + 0.5), "-i", asset.proxyPath ?? asset.path);
        parts.push(`[${inputIndex}:v]setpts=PTS-STARTPTS`);
      } else {
        inputs.push("-ss", n(srcStart), "-t", n(span + 0.25), "-i", asset.proxyPath ?? asset.path);
        parts.push(`[${inputIndex}:v]setpts=(PTS-STARTPTS)/${n(speed)}`);
      }
      inputIndex++;
      // Hold the last frame if the source ends before the window (e.g. crossfade beyond the media).
      parts.push(`fps=${fpsStr}`, `tpad=stop_mode=clone:stop_duration=${n(winDur + 1)}`, `trim=duration=${n(winDur)}`);
      const sw = asset.meta.width ?? W;
      const sh = asset.meta.height ?? H;
      const base = fittedSize(sw, sh, W, H, 1);
      const sk = c.keyframes.scale;
      if (sk && sk.length) {
        const se = keyframeExpr(sk, c.transform.scale, fps.num, fps.den, `(t+${n(sec(localOffsetFrames))})`);
        parts.push(`scale=w='max(2,2*trunc(${base.w}*(${se})/2))':h='max(2,2*trunc(${base.h}*(${se})/2))':eval=frame`);
        w = base.w;
        h = base.h;
      } else {
        const s = fittedSize(sw, sh, W, H, c.transform.scale);
        parts.push(`scale=${s.w}:${s.h}`);
        w = s.w;
        h = s.h;
      }
      parts.push("setsar=1");
    } else if (c.kind === "color") {
      parts.push(`color=c=${hexAlpha(c.fillColor ?? "#000000", 1)}:s=${W}x${H}:r=${fpsStr}:d=${n(winDur)}`);
      isFullCanvasLayer = true;
    } else {
      // text
      if (!c.text) continue;
      if (!font) throw new Error("No font available for titles. Set MOTIF_FONT to a .ttf file.");
      const textFile = join(tempDir, `text_${k}.txt`);
      await writeFile(textFile, c.text.content, "utf8");
      const fs = Math.round(c.text.fontSize * (H / 1080) * c.transform.scale);
      const yExpr = c.text.align === "lower-third" ? "h*0.85-text_h/2" : c.text.align === "top" ? "h*0.08" : "(h-text_h)/2";
      const box = c.text.boxColor ? `:box=1:boxcolor=${hexAlpha(c.text.boxColor, c.text.boxOpacity)}:boxborderw=${Math.round(fs * 0.35)}` : "";
      parts.push(
        `color=c=black@0.0:s=${W}x${H}:r=${fpsStr}:d=${n(winDur)}`,
        "format=yuva420p",
        `drawtext=fontfile=${filterPath(font)}:textfile=${filterPath(textFile)}:fontsize=${fs}:fontcolor=${hexAlpha(c.text.color, 1)}:x=(w-text_w)/2:y=${yExpr}:line_spacing=${Math.round(fs * 0.2)}${box}:shadowcolor=black@0.45:shadowx=2:shadowy=2`,
      );
      isFullCanvasLayer = true;
    }

    // colour adjust
    const col = c.color;
    if (c.kind === "media" && (col.brightness !== 0 || col.contrast !== 1 || col.saturation !== 1))
      parts.push(`eq=brightness=${n(col.brightness)}:contrast=${n(col.contrast)}:saturation=${n(col.saturation)}`);
    parts.push("format=yuva420p");
    if (c.transform.rotation && !isFullCanvasLayer) {
      const a = (c.transform.rotation * Math.PI) / 180;
      parts.push(`rotate=${n(a)}:c=none:ow=rotw(${n(a)}):oh=roth(${n(a)})`);
      const cos = Math.abs(Math.cos(a));
      const sin = Math.abs(Math.sin(a));
      [w, h] = [w * cos + h * sin, w * sin + h * cos];
    }
    if (c.transform.opacity < 1) parts.push(`colorchannelmixer=aa=${n(c.transform.opacity)}`);
    if (c.transitionIn && localOffsetFrames < c.transitionIn.frames) {
      const fadeFrames = c.transitionIn.frames - localOffsetFrames;
      parts.push(`fade=t=in:st=0:d=${n(sec(fadeFrames + 1))}:alpha=1`);
    }
    parts.push(`setpts=PTS+${n(shift)}/TB`);
    chains.push(parts.join(",") + `[${label}]`);

    // overlay position: centred + keyframed offset. `t` in overlay is output time.
    const localT = `(t-${n(shift)}+${n(sec(localOffsetFrames))})`;
    const xe = keyframeExpr(c.keyframes.x, c.transform.x, fps.num, fps.den, localT);
    const ye = keyframeExpr(c.keyframes.y, c.transform.y, fps.num, fps.den, localT);
    const xPos = isFullCanvasLayer ? `${xe}` : `(main_w-overlay_w)/2+${xe}`;
    const yPos = isFullCanvasLayer ? `${ye}` : `(main_h-overlay_h)/2+${ye}`;
    const out = `ov${k}`;
    const endT = shift + winDur;
    chains.push(`[${last}][${label}]overlay=x='${xPos}':y='${yPos}':eval=frame:eof_action=pass:format=auto:enable='between(t,${n(shift)},${n(endT - 1e-4)})'[${out}]`);
    last = out;
    void w;
    void h;
  }

  const outW = preset.width;
  const outH = preset.height;
  const presetFps = `${preset.fps.num}/${preset.fps.den}`;
  const needsScale = outW !== W || outH !== H;
  chains.push(
    `[${last}]` +
      (needsScale ? `scale=${outW}:${outH}:force_original_aspect_ratio=decrease,pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2:color=${hexAlpha(project.profile.background, 1)},` : "") +
      `fps=${presetFps},format=yuv420p,trim=duration=${n(D)}[vout]`,
  );

  // ---------------------------------------------------------------- audio
  const SR = project.profile.sampleRate;
  const audioLabels: string[] = [];
  chains.push(`anullsrc=r=${SR}:cl=stereo,atrim=duration=${n(D)}[asil]`);
  audioLabels.push("asil");
  let ak = 0;
  for (const track of project.tracks) {
    if (track.kind === "text" || !isTrackAudible(project, track)) continue;
    for (const c of track.clips) {
      if (!c.enabled || c.audio.muted || c.kind !== "media") continue;
      const asset = project.assets.find((a) => a.id === c.assetId);
      if (!asset?.meta.hasAudio) continue;
      const t0 = Math.max(c.start, range.start);
      const t1 = Math.min(clipEnd(c), range.end);
      if (t1 <= t0) continue;
      const speed = c.speed.num / c.speed.den;
      const localOffset = t0 - c.start;
      const winDur = sec(t1 - t0);
      const srcStart = sec(c.sourceIn) + sec(localOffset) * speed;
      inputs.push("-ss", n(srcStart), "-t", n(winDur * speed + 0.1), "-i", asset.proxyPath ?? asset.path);
      const idx = inputIndex++;
      const gainDb = c.audio.gainDb + track.volumeDb;
      const L = Math.min(1, 1 - c.audio.pan);
      const R = Math.min(1, 1 + c.audio.pan);
      const parts = [
        `[${idx}:a]aresample=${SR}`,
        "aformat=sample_fmts=fltp:channel_layouts=stereo",
        "asetpts=PTS-STARTPTS",
        ...atempoChain(speed),
        `atrim=duration=${n(winDur)}`,
        `volume=${n(gainDb)}dB`,
      ];
      if (c.audio.pan !== 0) parts.push(`pan=stereo|c0=${n(L)}*c0|c1=${n(R)}*c1`);
      const fin = c.audio.fadeInFrames - localOffset;
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

  const filterGraph = chains.join(";\n");
  const codec: string[] = [];
  if (preset.videoCodec === "libx264")
    codec.push("-c:v", "libx264", "-preset", preset.preset, "-crf", String(preset.crf), "-pix_fmt", "yuv420p", "-movflags", "+faststart");
  else if (preset.videoCodec === "libvpx-vp9") codec.push("-c:v", "libvpx-vp9", "-crf", String(preset.crf), "-b:v", "0", "-row-mt", "1", "-deadline", "good", "-cpu-used", "4");
  else codec.push("-c:v", "prores_ks", "-profile:v", "2");
  if (preset.audioCodec === "pcm_s16le") codec.push("-c:a", "pcm_s16le");
  else codec.push("-c:a", preset.audioCodec, "-b:a", `${preset.audioBitrateK}k`);
  codec.push("-ar", String(preset.audioCodec === "libopus" ? 48000 : SR), "-ac", "2");

  // Long graphs go through a script file to stay under OS argv limits.
  let graphArgs: string[];
  if (filterGraph.length > 60_000) {
    const scriptPath = join(tempDir, "graph.txt");
    await writeFile(scriptPath, filterGraph, "utf8");
    graphArgs = ["-/filter_complex", scriptPath];
  } else graphArgs = ["-filter_complex", filterGraph];

  const args = [
    opts.overwrite === false ? "-n" : "-y",
    ...inputs,
    ...graphArgs,
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    ...codec,
    "-t",
    n(D),
    "-metadata",
    `title=${project.title}`,
    "-metadata",
    "encoder=MOTIF Studio",
    opts.outputPath,
  ];

  return {
    args,
    durationSec: D,
    tempDir,
    filterGraph,
    cleanup: () => rm(tempDir, { recursive: true, force: true }),
  };
}

export { interpolate };
