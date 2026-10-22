/**
 * Post-production for the tutorial video, done with MOTIF's own engine:
 * builds a MOTIF project (animated intro, chapter cards, framed screen
 * recording with spotlight zooms, lower-third captions, narration, music bed,
 * outro) and renders it with renderProject — the same path as an in-app export.
 *
 *   (from apps/desktop)  npx tsx scripts/demo-compose.ts <workdir> <out.mp4>
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createProject, newId, type Project, type Keyframe } from "@motif/project-schema";
import { insertMediaClip, insertTextClip, insertShapeClip, updateClip, findClip } from "@motif/editor-core";
import { importMedia, renderProject, runFfmpeg } from "@motif/render-engine";

const report = (e: any) => {
  const tail = String(e?.stderrTail ?? e?.stack ?? e).split("\n").filter((l) => !/No accelerated colorspace/.test(l)).slice(-15).join("%0A");
  console.error(`::error title=compose::${e?.message}%0A${tail}`);
  process.exit(1);
};
process.on("unhandledRejection", report);
process.on("uncaughtException", report);

const [dir, out] = [resolve(process.argv[2] ?? "demo-work"), resolve(process.argv[3] ?? "motif-tutorial.mp4")];
const FPS = 30;
const f = (sec: number) => Math.round(sec * FPS);
const script = JSON.parse(await readFile(new URL("../../../scripts/demo-video/script.json", import.meta.url), "utf8")) as { chapters: { id: string; title: string; narration: string }[]; outro: string };
const marks = JSON.parse(await readFile(join(dir, "chapters.json"), "utf8")) as { chapters: { id: string; start: number; end: number; spots: { t: number; rect: { x: number; y: number; w: number; h: number }; zoom: number }[] }[] };
const durs = JSON.parse(await readFile(join(dir, "narration", "durations.json"), "utf8")) as Record<string, number>;
const fontDir = new URL("../src/renderer/public/fonts", import.meta.url).pathname;

const INTRO = 6.5, CARD = 2.2, OUTRO = 7;
const segs = script.chapters.map((c) => ({ ...c, mark: marks.chapters.find((m) => m.id === c.id) })).filter((c) => c.mark && c.mark.end - c.mark.start > 1);
const total = INTRO + segs.reduce((n, s) => n + CARD + (s.mark!.end - s.mark!.start), 0) + OUTRO;

// ---------------------------------------------------------------- generated assets
const bg = join(dir, "bg.mp4");
const music = join(dir, "music.wav");
if (!existsSync(bg))
  await runFfmpeg(["-y", "-f", "lavfi", "-i", `gradients=s=1920x1080:r=30:c0=0x07060d:c1=0x24104f:c2=0x061e33:c3=0x0b0a14:n=4:speed=0.004:d=${Math.ceil(total) + 1}`, "-vf", "noise=alls=3:allf=t,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", bg]);
if (!existsSync(music)) {
  // Soft ambient pad: Am – F – C – G, 4 s per chord, with slow tremolo, low-pass and room echo.
  const chord = (a: number, b: number, c: number) => `(sin(2*PI*${a}*t)+0.8*sin(2*PI*${b}*t)+0.6*sin(2*PI*${c}*t)+0.3*sin(2*PI*${a / 2}*t))`;
  const m = "mod(t,16)";
  const expr = `0.07*(0.75+0.25*sin(2*PI*0.25*t))*if(lt(${m},4),${chord(220, 261.63, 329.63)},if(lt(${m},8),${chord(174.61, 220, 261.63)},if(lt(${m},12),${chord(196, 261.63, 329.63)},${chord(196, 246.94, 293.66)})))`;
  await runFfmpeg(["-y", "-f", "lavfi", "-i", `aevalsrc='${expr}':s=48000:d=${Math.ceil(total) + 1}`, "-af", "lowpass=f=1600,aecho=0.8:0.7:120|240:0.35|0.2,afade=t=in:d=3,volume=0.9", "-ac", "2", music]);
}

let p: Project = createProject({ title: "MOTIF Studio — the complete tutorial", fps: { num: FPS, den: 1 } });
p.tracks = [
  { id: "bg", kind: "video", name: "Background", hidden: false, muted: false, solo: false, locked: false, volumeDb: 0, clips: [] },
  ...["deco1", "deco2", "deco3", "bar"].map((id) => ({ id, kind: "video" as const, name: id, hidden: false, muted: false, solo: false, locked: false, volumeDb: 0, clips: [] })),
  { id: "screen", kind: "video", name: "Screen", hidden: false, muted: false, solo: false, locked: false, volumeDb: 0, clips: [] },
  { id: "titles", kind: "text", name: "Titles", hidden: false, muted: false, solo: false, locked: false, volumeDb: 0, clips: [] },
  { id: "titles2", kind: "text", name: "Subtitles", hidden: false, muted: false, solo: false, locked: false, volumeDb: 0, clips: [] },
  { id: "labels", kind: "text", name: "Labels", hidden: false, muted: false, solo: false, locked: false, volumeDb: 0, clips: [] },
  { id: "captions", kind: "text", name: "Captions", hidden: false, muted: false, solo: false, locked: false, volumeDb: 0, clips: [] },
  { id: "voice", kind: "audio", name: "Narration", hidden: false, muted: false, solo: false, locked: false, volumeDb: 0, clips: [] },
  { id: "music", kind: "audio", name: "Music", hidden: false, muted: false, solo: false, locked: false, volumeDb: -21, clips: [] },
];
const add = async (path: string) => {
  const a = await importMedia(path);
  p = { ...p, assets: [...p.assets, a] };
  return a;
};
const screenA = await add(join(dir, "screen.mp4"));
const bgA = await add(bg);
const musicA = await add(music);

const text = (track: string, start: number, dur: number, content: string, style: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
  try {
    const r = insertTextClip(p, { trackId: track, start, duration: dur, content, findFreeSlot: false });
    const c = findClip(r.project, r.clipId)!.clip;
    p = updateClip(r.project, r.clipId, { text: { ...c.text!, ...style }, ...extra } as any);
    return r.clipId;
  } catch (e: any) {
    console.warn(`::warning title=compose::skipped text "${content.slice(0, 40)}" on ${track} at ${start}: ${e.message}`);
    return null;
  }
};
const shape = (start: number, dur: number, type: "rect" | "ellipse", fill: string, w: number, h: number, extra: Record<string, unknown>, trackId = "bar") => {
  try {
    const r = insertShapeClip(p, { trackId, start, duration: dur, type, fill, w, h });
    p = updateClip(r.project, r.clipId, extra as any);
  } catch (e: any) {
    console.warn(`::warning title=compose::skipped shape on ${trackId} at ${start}: ${e.message}`);
  }
};

// background for the whole video, music bed underneath
p = insertMediaClip(p, { trackId: "bg", assetId: bgA.id, start: 0, duration: f(total) }).project;
{
  const r = insertMediaClip(p, { trackId: "music", assetId: musicA.id, start: 0, duration: f(total) });
  p = updateClip(r.project, r.clipId, { audio: { ...findClip(r.project, r.clipId)!.clip.audio, fadeInFrames: f(2), fadeOutFrames: f(4) } } as any);
}

// ---------------------------------------------------------------- intro
const orb = (track: string, start: number, dur: number, dx: number, dy: number, color: string, size = 230) =>
  shape(f(start), f(dur), "ellipse", color, size, size, { transform: { x: dx, y: dy, scale: 1, rotation: 0, opacity: 0.88 }, animIn: { kind: "zoom-in", frames: 18 }, animOut: { kind: "fade", frames: 12 } }, track);
// the MOTIF mark: three overlapping orbs popping in one after another
orb("deco1", 0.2, INTRO - 0.2, 0, -250, "#29c6ff");
orb("deco2", 0.45, INTRO - 0.45, -85, -120, "#ff7a3d");
orb("deco3", 0.7, INTRO - 0.7, 85, -120, "#ff4f6d");
text("titles", f(1.0), f(INTRO - 1.0), "MOTIF STUDIO", { font: "bebas", fontSize: 210, color: "#ffffff", strokeWidth: 0, shadow: true }, { transform: { x: 0, y: 150, scale: 1, rotation: 0, opacity: 1 }, animIn: { kind: "zoom-in", frames: 16 }, animOut: { kind: "fade", frames: 12 } });
text("titles2", f(1.7), f(INTRO - 1.7), "The complete tutorial  ·  every feature in one video", { font: "poppins", fontSize: 44, color: "#c4b5fd", shadow: false }, { transform: { x: 0, y: 300, scale: 1, rotation: 0, opacity: 1 }, animIn: { kind: "slide-up", frames: 14 }, animOut: { kind: "fade", frames: 12 } });
text("labels", f(2.4), f(INTRO - 2.4), "  v0.3  ·  open source  ·  local-first  ", { font: "poppins", fontSize: 28, color: "#ffffff", boxColor: "#7c3aed", boxOpacity: 0.85, shadow: false, align: "top" }, { transform: { x: 0, y: 60, scale: 1, rotation: 0, opacity: 1 }, animIn: { kind: "fade", frames: 12 }, animOut: { kind: "fade", frames: 10 } });

// ---------------------------------------------------------------- chapters
const BASE = 0.86;
let t = INTRO;
const sentences = (s: string) => s.match(/[^.!?]+[.!?]*/g)!.map((x) => x.trim()).filter(Boolean);
const wrap = (s: string, n = 58) => {
  const words = s.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > n && cur) {
      lines.push(cur);
      cur = w;
    } else cur = (cur + " " + w).trim();
  }
  if (cur) lines.push(cur);
  return lines;
};
for (const [i, s] of segs.entries()) {
  const num = String(i + 1).padStart(2, "0");
  // chapter card
  text("titles", f(t), f(CARD), num, { font: "bebas", fontSize: 190, color: "#a78bfa", shadow: true }, { transform: { x: 0, y: -70, scale: 1, rotation: 0, opacity: 1 }, animIn: { kind: "zoom-in", frames: 10 }, animOut: { kind: "fade", frames: 8 } });
  text("titles2", f(t + 0.25), f(CARD - 0.25), s.title, { font: "poppins", fontSize: 76, color: "#ffffff", shadow: true }, { transform: { x: 0, y: 90, scale: 1, rotation: 0, opacity: 1 }, animIn: { kind: "slide-up", frames: 12 }, animOut: { kind: "fade", frames: 8 } });
  shape(f(t), f(CARD), "rect", "#8b5cf6", 120, 8, { transform: { x: 0, y: 170, scale: 1, rotation: 0, opacity: 1 }, animIn: { kind: "slide-left", frames: 12 }, animOut: { kind: "fade", frames: 8 } });
  t += CARD;

  // framed screen recording with spotlight zooms
  const m = s.mark!;
  const len = m.end - m.start;
  const r = insertMediaClip(p, { trackId: "screen", assetId: screenA.id, start: f(t), duration: f(len), sourceIn: f(m.start) });
  const kf: Record<string, Keyframe[]> = { scale: [{ frame: 0, value: BASE, easing: "easeInOut" }], x: [{ frame: 0, value: 0, easing: "easeInOut" }], y: [{ frame: 0, value: 0, easing: "easeInOut" }] };
  const spots = m.spots.map((sp) => ({ ...sp, local: sp.t - m.start })).filter((sp) => sp.local > 0.2 && sp.local < len - 1);
  for (const [k, sp] of spots.entries()) {
    const z = Math.min(1.8, Math.max(1.15, sp.zoom));
    const cx = sp.rect.x + sp.rect.w / 2, cy = sp.rect.y + sp.rect.h / 2;
    const clamp = (v: number, lim: number) => Math.max(-lim, Math.min(lim, v));
    const x = clamp(-z * (cx - 960), (z - 1) * 960), y = clamp(-z * (cy - 540), (z - 1) * 540);
    const a = f(sp.local), next = spots[k + 1] ? f(spots[k + 1]!.local) : f(len);
    const holdEnd = Math.min(next - 2, a + 18 + f(3.2));
    const push = (frame: number, sc: number, xx: number, yy: number) => {
      if (frame <= (kf.scale!.at(-1)?.frame ?? -1)) return;
      kf.scale!.push({ frame, value: sc, easing: "easeInOut" });
      kf.x!.push({ frame, value: xx, easing: "easeInOut" });
      kf.y!.push({ frame, value: yy, easing: "easeInOut" });
    };
    push(a, kf.scale!.at(-1)!.value, kf.x!.at(-1)!.value, kf.y!.at(-1)!.value);
    push(a + 18, z, x, y);
    push(holdEnd, z, x, y);
    if (next - holdEnd > f(1.2)) push(holdEnd + 18, BASE, 0, 0);
  }
  p = updateClip(r.project, r.clipId, {
    keyframes: kf,
    mask: { shape: "rect", w: 1, h: 1, cx: 0, cy: 0, feather: 0.012, invert: false },
    animIn: { kind: "zoom-in", frames: 12 },
    animOut: { kind: "fade", frames: 10 },
    audio: { ...findClip(r.project, r.clipId)!.clip.audio, muted: true },
  } as any);

  // chapter label
  text("labels", f(t), f(len), `  ${num}  ${s.title}  `, { font: "poppins", fontSize: 26, color: "#ffffff", boxColor: "#14121e", boxOpacity: 0.78, shadow: false, align: "top" }, { transform: { x: -690, y: 18, scale: 1, rotation: 0, opacity: 1 }, animIn: { kind: "fade", frames: 10 }, animOut: { kind: "fade", frames: 8 } });

  // narration + word-paced lower-third captions
  const voice = join(dir, "narration", `${s.id}.wav`);
  if (existsSync(voice)) {
    const va = await add(voice);
    p = insertMediaClip(p, { trackId: "voice", assetId: va.id, start: f(t + 0.35), duration: Math.min(f(durs[s.id] ?? len), f(len - 0.4)) }).project;
    const ss = sentences(s.narration);
    const chars = ss.reduce((n, x) => n + x.length, 0);
    let ct = t + 0.35;
    const vd = Math.min(durs[s.id] ?? len, len - 0.4);
    for (const sentence of ss) {
      const d = (sentence.length / chars) * vd;
      const lines = wrap(sentence);
      const per = d / Math.ceil(lines.length / 2);
      for (let li = 0; li < lines.length; li += 2) {
        const chunk = lines.slice(li, li + 2).join("\n");
        const st = ct + (li / 2) * per;
        text("captions", f(st), Math.max(6, f(per) - 2), chunk, { font: "poppins", fontSize: 40, color: "#ffffff", boxColor: "#0b0a12", boxOpacity: 0.62, role: "caption", align: "lower-third", shadow: false }, { animIn: { kind: "fade", frames: 4 }, animOut: { kind: "fade", frames: 4 } });
      }
      ct += d;
    }
  }
  t += len;
}

// ---------------------------------------------------------------- outro
text("titles", f(t + 0.2), f(OUTRO - 0.2), "Thanks for watching", { font: "bebas", fontSize: 150, color: "#ffffff", shadow: true }, { transform: { x: 0, y: -80, scale: 1, rotation: 0, opacity: 1 }, animIn: { kind: "slide-up", frames: 14 }, animOut: { kind: "fade", frames: 18 } });
text("titles2", f(t + 0.8), f(OUTRO - 0.8), "github.com/bileldh-ing/motif_studio", { font: "poppins", fontSize: 52, color: "#c4b5fd", boxColor: "#1b1430", boxOpacity: 0.7, shadow: false }, { transform: { x: 0, y: 80, scale: 1, rotation: 0, opacity: 1 }, animIn: { kind: "zoom-in", frames: 14 }, animOut: { kind: "fade", frames: 18 } });
text("labels", f(t + 1.4), f(OUTRO - 1.4), "Edited and rendered with MOTIF Studio itself", { font: "poppins", fontSize: 30, color: "#9a9cab", shadow: false }, { transform: { x: 0, y: 190, scale: 1, rotation: 0, opacity: 1 }, animIn: { kind: "fade", frames: 14 }, animOut: { kind: "fade", frames: 18 } });
const ov = join(dir, "narration", "outro.wav");
if (existsSync(ov)) {
  const oa = await add(ov);
  p = insertMediaClip(p, { trackId: "voice", assetId: oa.id, start: f(t + 0.6), duration: Math.min(f(durs.outro ?? 4), f(OUTRO - 0.8)) }).project;
}

await writeFile(join(dir, "tutorial.motif"), JSON.stringify(p, null, 2));
if (process.env.MOTIF_COMPOSE_DRY) { console.log("dry run ok", p.tracks.map((t) => `${t.id}:${t.clips.length}`).join(" ")); process.exit(0); }
const preset = { id: "tutorial", name: "Tutorial 1080p30", kind: "video", container: "mp4", videoCodec: "libx264", audioCodec: "aac", width: 1920, height: 1080, fps: { num: FPS, den: 1 }, crf: 19, audioBitrateK: 192, preset: process.env.MOTIF_COMPOSE_PRESET ?? "medium" } as any;
let last = -1;
const r = await renderProject(p, preset, { outputPath: out, fontDir }, {
  onLog: (l) => /error|invalid|failed/i.test(l) && console.error("[ffmpeg]", l.slice(0, 400)),
  onProgress: (fr) => {
    const pc = Math.floor(fr * 100);
    if (pc !== last && pc % 5 === 0) console.log(`render ${pc}%`), (last = pc);
  },
});
console.log(JSON.stringify({ out: r.outputPath, ok: r.verification.ok, problems: r.verification.problems, seconds: total, chapters: segs.length, elapsedMs: r.elapsedMs }));
if (!r.verification.ok) {
  console.error(`::error title=verify::${r.verification.problems.join("; ")}`);
  process.exit(1);
}
void newId;
