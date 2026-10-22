/**
 * v0.2 feature tests: every effect/tool that the UI offers is exported and
 * checked on decoded output pixels (or stream metadata) here.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createProject, sizeForResolution, type Project, type RenderPreset, type MediaAsset } from "@motif/project-schema";
import { addAsset, insertMediaClip, insertTextClip, updateClip, findClip, freezeFrame, insertShapeClip, setTransition, applyLook, detachAudio, wordsToCues, insertCaptionCues } from "@motif/editor-core";
import { grabFrameRGB, importMedia, renderProject, runFfmpeg, probeMedia, textToSpeech, transcribe, stabilize, extractAudio, computePeaks } from "@motif/render-engine";

const OUT = join(process.cwd(), "tests", "output", "fx");
const FIX = join(OUT, "fixtures");
const FONT_DIR = fileURLToPath(new URL("../../../apps/desktop/src/renderer/public/fonts", import.meta.url));

const preset: RenderPreset = { id: "t", name: "t", kind: "video", container: "mp4", videoCodec: "libx264", audioCodec: "aac", width: 320, height: 180, fps: { num: 30, den: 1 }, crf: 16, audioBitrateK: 128, preset: "ultrafast" };

const px = (buf: Buffer, x: number, y: number, w = 320): [number, number, number] => {
  const i = (y * w + x) * 3;
  return [buf[i]!, buf[i + 1]!, buf[i + 2]!];
};
const gen = (args: string[]) => runFfmpeg(["-y", ...args]);

const A: Record<string, MediaAsset> = {};
function base(): Project {
  let p = createProject({ title: "fx", id: "prj_fx" });
  p = { ...p, profile: { ...p.profile, width: 320, height: 180 } };
  for (const a of Object.values(A)) p = addAsset(p, a);
  return p;
}
function clipOn(p: Project, track: string, asset: string, start = 0, duration = 60) {
  return insertMediaClip(p, { trackId: track, assetId: A[asset]!.id, start, duration });
}
async function render(p: Project, name: string, pr: Partial<RenderPreset> = {}, range?: { start: number; end: number }) {
  const out = join(OUT, name);
  const r = await renderProject(p, { ...preset, ...pr }, { outputPath: out, fontDir: FONT_DIR, ...(range ? { range } : {}) });
  expect(r.verification.problems).toEqual([]);
  return out;
}
const frame = (f: string, t: number, w = 320, h = 180) => grabFrameRGB(f, t, w, h);

beforeAll(async () => {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(FIX, { recursive: true });
  const v = (name: string, src: string, d = 2) => gen(["-f", "lavfi", "-i", `${src}:s=320x180:r=30:d=${d}`, "-f", "lavfi", "-i", `sine=f=440:d=${d}`, "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", join(FIX, name)]);
  await v("red.mp4", "color=c=red");
  await v("blue.mp4", "color=c=blue");
  await v("gray.mp4", "color=c=0x808080");
  // left half red, right half blue
  await gen(["-f", "lavfi", "-i", "color=c=red:s=160x180:r=30:d=2", "-f", "lavfi", "-i", "color=c=blue:s=160x180:r=30:d=2", "-f", "lavfi", "-i", "sine=d=2", "-filter_complex", "[0][1]hstack", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-shortest", "-c:a", "aac", join(FIX, "split.mp4")]);
  // green screen with a red square in the middle
  await gen(["-f", "lavfi", "-i", "color=c=0x00ff00:s=320x180:r=30:d=2", "-f", "lavfi", "-i", "sine=d=2", "-vf", "drawbox=x=130:y=60:w=60:h=60:c=red:t=fill", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv444p", "-crf", "0", "-c:a", "aac", join(FIX, "greenscreen.mp4")]);
  // 1 s red then 1 s blue
  await gen(["-f", "lavfi", "-i", "color=c=red:s=320x180:r=30:d=1", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=30:d=1", "-f", "lavfi", "-i", "sine=d=2", "-filter_complex", "[0][1]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-map", "2:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-shortest", "-c:a", "aac", join(FIX, "redblue.mp4")]);
  // tall (portrait) white clip for background-fill
  await gen(["-f", "lavfi", "-i", "color=c=white:s=90x160:r=30:d=2", "-f", "lavfi", "-i", "sine=d=2", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", join(FIX, "tall.mp4")]);
  // shaky clip for stabilization
  await gen(["-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=2", "-vf", "crop=280:160:20+15*sin(n):10+10*cos(n*1.3),scale=320:180", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(FIX, "shaky.mp4")]);
  for (const f of ["red.mp4", "blue.mp4", "gray.mp4", "split.mp4", "greenscreen.mp4", "redblue.mp4", "tall.mp4", "shaky.mp4"]) A[f.replace(".mp4", "")] = await importMedia(join(FIX, f));
});

describe("clip tools", () => {
  it("crop and horizontal flip", async () => {
    const c = clipOn(base(), "trk_v1", "split");
    const p = updateClip(c.project, c.clipId, { flipH: true });
    const f = await frame(await render(p, "flip.mp4"), 0.5);
    expect(px(f, 40, 90)[2]).toBeGreaterThan(200); // blue now on the left
    expect(px(f, 280, 90)[0]).toBeGreaterThan(200); // red on the right
    const p2 = updateClip(c.project, c.clipId, { crop: { l: 0.5, t: 0, r: 0, b: 0 } });
    const f2 = await frame(await render(p2, "crop.mp4"), 0.5);
    expect(px(f2, 160, 90)[2]).toBeGreaterThan(200); // only the blue half, fitted
    expect(px(f2, 160, 90)[0]).toBeLessThan(60);
  });

  it("reverse plays the source backwards", async () => {
    const c = clipOn(base(), "trk_v1", "redblue");
    const p = updateClip(c.project, c.clipId, { reverse: true });
    const out = await render(p, "reverse.mp4");
    expect(px(await frame(out, 0.3), 160, 90)[2]).toBeGreaterThan(200); // starts blue
    expect(px(await frame(out, 1.6), 160, 90)[0]).toBeGreaterThan(200); // ends red
  });

  it("freeze frame holds the frame and ripples the rest", async () => {
    const c = clipOn(base(), "trk_v1", "redblue");
    const fz = freezeFrame(c.project, c.clipId, 15, 45);
    const track = fz.project.tracks.find((t) => t.id === "trk_v1")!;
    expect(track.clips.map((x) => [x.start, x.duration, x.freeze])).toEqual([[0, 15, false], [15, 45, true], [60, 45, false]]);
    const out = await render(fz.project, "freeze.mp4");
    expect(px(await frame(out, 1.0), 160, 90)[0]).toBeGreaterThan(200); // frozen red frame (source was red at 0.5 s)
    expect(px(await frame(out, 3.2), 160, 90)[2]).toBeGreaterThan(200); // resumed into the blue part
  });

  it("chroma key removes the green screen", async () => {
    let p = clipOn(base(), "trk_v1", "blue").project;
    const g = clipOn(p, "trk_v2", "greenscreen");
    p = updateClip(g.project, g.clipId, { chroma: { enabled: true, color: "#00ff00", similarity: 0.2, blend: 0.05 } });
    const f = await frame(await render(p, "chroma.mp4"), 0.5);
    const [r, gg, b] = px(f, 20, 20);
    expect(b).toBeGreaterThan(180);
    expect(gg).toBeLessThan(80);
    expect(r).toBeLessThan(80);
    expect(px(f, 160, 90)[0]).toBeGreaterThan(180); // red square kept
  });

  it("ellipse mask cuts corners", async () => {
    let p = clipOn(base(), "trk_v1", "blue").project;
    const r = clipOn(p, "trk_v2", "red");
    p = updateClip(r.project, r.clipId, { mask: { shape: "ellipse", w: 0.8, h: 0.8, cx: 0, cy: 0, feather: 0, invert: false } });
    const f = await frame(await render(p, "mask.mp4"), 0.5);
    expect(px(f, 160, 90)[0]).toBeGreaterThan(200);
    expect(px(f, 5, 5)[2]).toBeGreaterThan(200);
  });

  it("background blur fill covers the empty sides", async () => {
    const c = clipOn(base(), "trk_v1", "tall");
    const off = await frame(await render(c.project, "nofill.mp4"), 0.5);
    expect(px(off, 10, 90)[0]).toBeLessThan(30); // black bars without fill
    const p = updateClip(c.project, c.clipId, { bgFill: "blur" });
    const on = await frame(await render(p, "fill.mp4"), 0.5);
    expect(px(on, 10, 90)[0]).toBeGreaterThan(150);
  });
});

describe("colour & filters", () => {
  it("grayscale, invert, sepia, warm, blur and vignette change pixels as expected", async () => {
    const red = clipOn(base(), "trk_v1", "red");
    const inv = await frame(await render(updateClip(red.project, red.clipId, { color: { ...findClip(red.project, red.clipId)!.clip.color, invert: true } }), "invert.mp4"), 0.5);
    expect(px(inv, 160, 90)[0]).toBeLessThan(60);
    expect(px(inv, 160, 90)[2]).toBeGreaterThan(200);
    const mono = await frame(await render(applyLook(red.project, red.clipId, "mono"), "mono.mp4"), 0.5);
    const [mr, mg, mb] = px(mono, 160, 90);
    expect(Math.abs(mr - mg)).toBeLessThan(20);
    expect(Math.abs(mg - mb)).toBeLessThan(20);
    const gray = clipOn(base(), "trk_v1", "gray");
    const warm = await frame(await render(applyLook(gray.project, gray.clipId, "warm"), "warm.mp4"), 0.5);
    expect(px(warm, 160, 90)[0] - px(warm, 160, 90)[2]).toBeGreaterThan(30);
    const sep = await frame(await render(updateClip(gray.project, gray.clipId, { color: { ...findClip(gray.project, gray.clipId)!.clip.color, sepia: 1 } }), "sepia.mp4"), 0.5);
    expect(px(sep, 160, 90)[0]).toBeGreaterThan(px(sep, 160, 90)[2] + 20);
    const vig = await frame(await render(updateClip(gray.project, gray.clipId, { color: { ...findClip(gray.project, gray.clipId)!.clip.color, vignette: 1 } }), "vignette.mp4"), 0.5);
    expect(px(vig, 2, 2)[0]).toBeLessThan(px(vig, 160, 90)[0] - 20);
    const split = clipOn(base(), "trk_v1", "split");
    const bl = await frame(await render(updateClip(split.project, split.clipId, { color: { ...findClip(split.project, split.clipId)!.clip.color, blur: 12 } }), "blur.mp4"), 0.5);
    const edge = px(bl, 160, 90);
    expect(edge[0]).toBeGreaterThan(60); // red and blue mixed at the seam
    expect(edge[2]).toBeGreaterThan(60);
  });
});

describe("motion", () => {
  it("slide-left transition pushes the incoming clip from the right", async () => {
    const a = clipOn(base(), "trk_v1", "red", 0, 60);
    const b = clipOn(a.project, "trk_v1", "blue", 60, 60);
    const p = setTransition(b.project, b.clipId, "slide-left", 20);
    const f = await frame(await render(p, "slide.mp4"), 70 / 30);
    expect(px(f, 20, 90)[0]).toBeGreaterThan(200); // outgoing red still on the left
    expect(px(f, 310, 90)[2]).toBeGreaterThan(200); // incoming blue on the right
  });

  it("fade-in animation and zoom-out-in animation", async () => {
    const r = clipOn(base(), "trk_v1", "red");
    const p = updateClip(r.project, r.clipId, { animIn: { kind: "fade", frames: 30 } });
    const out = await render(p, "fadein.mp4");
    const early = px(await frame(out, 0.15), 160, 90)[0];
    const late = px(await frame(out, 1.5), 160, 90)[0];
    expect(early).toBeLessThan(late - 80);
    const z = updateClip(r.project, r.clipId, { animIn: { kind: "zoom-in", frames: 30 } });
    const zout = await render(z, "zoomin.mp4");
    const zf = await frame(zout, 0.1);
    const dbg = JSON.stringify({ c: px(zf, 160, 90), e: px(zf, 5, 90), q: px(zf, 80, 45), t3: px(await frame(zout, 0.3), 160, 90), t1: px(await frame(zout, 1.2), 160, 90) });
    expect(px(zf, 5, 90)[0], dbg).toBeLessThan(60); // still small: edges show background
    expect(px(zf, 160, 90)[0], dbg).toBeGreaterThan(10); // the layer is already visible at the centre
    expect(px(await frame(zout, 0.3), 160, 90)[0], dbg).toBeGreaterThan(px(zf, 160, 90)[0]); // growing in
    expect(px(await frame(zout, 1.2), 160, 90)[0], dbg).toBeGreaterThan(200); // fully in
  });

  it("rotation keyframes animate", async () => {
    let p = clipOn(base(), "trk_v1", "blue").project;
    const r = clipOn(p, "trk_v2", "red");
    p = updateClip(r.project, r.clipId, { transform: { x: 0, y: 0, scale: 0.4, rotation: 0, opacity: 1 }, keyframes: { rotation: [{ frame: 0, value: 0, easing: "linear" }, { frame: 59, value: 45, easing: "linear" }] } });
    const out = await render(p, "rot.mp4");
    // at 45° the rotated square reaches higher than the unrotated one did
    const f0 = await frame(out, 0.02);
    const f1 = await frame(out, 1.95);
    expect(px(f0, 160, 50)[0]).toBeLessThan(80);
    expect(px(f1, 160, 50)[0]).toBeGreaterThan(150);
  });
});

describe("shapes & text", () => {
  it("draws an ellipse shape and a stroked Poppins title", async () => {
    let p = base();
    p = insertShapeClip(p, { trackId: "trk_v2", start: 0, duration: 60, type: "ellipse", fill: "#ff0000", w: 120, h: 120 }).project;
    const t = insertTextClip(p, { trackId: "trk_t1", start: 0, duration: 60, content: "MOTIF" });
    p = updateClip(t.project, t.clipId, { text: { ...findClip(t.project, t.clipId)!.clip.text!, font: "poppins", fontSize: 200, align: "top", strokeWidth: 8, strokeColor: "#00ff00", color: "#ffffff" } });
    const f = await frame(await render(p, "shape-text.mp4"), 0.5);
    expect(px(f, 160, 95)[0]).toBeGreaterThan(200); // ellipse centre
    expect(px(f, 112, 44)[0]).toBeLessThan(50); // corner of the bounding box, outside the circle
    expect(px(f, 104, 92)[0]).toBeGreaterThan(200); // left edge of the circle is inside
    let white = 0;
    let green = 0;
    for (let x = 60; x < 260; x++)
      for (let y = 10; y < 60; y++) {
        const [r, g, b] = px(f, x, y);
        if (r > 200 && g > 200 && b > 200) white++;
        if (g > 180 && r < 90 && b < 90) green++;
      }
    expect(white).toBeGreaterThan(50);
    expect(green).toBeGreaterThan(50); // stroke drawn
  });
});

describe("export formats", () => {
  it("resolution helper keeps aspect", () => {
    expect(sizeForResolution(1920, 1080, 2160)).toEqual({ width: 3840, height: 2160 });
    expect(sizeForResolution(1080, 1920, 2160)).toEqual({ width: 2160, height: 3840 });
    expect(sizeForResolution(1080, 1080, 720)).toEqual({ width: 720, height: 720 });
  });

  it("exports true 4K (3840x2160)", async () => {
    const p = clipOn(base(), "trk_v1", "split").project;
    const out = await render(p, "uhd.mp4", { width: 3840, height: 2160, preset: "ultrafast", crf: 28 });
    const m = (await probeMedia(out)).meta;
    expect([m.width, m.height, m.videoCodec]).toEqual([3840, 2160, "h264"]);
  });

  it("exports HEVC, AV1, ProRes, bitrate mode and 60 fps", async () => {
    const p = clipOn(base(), "trk_v1", "red", 0, 30).project;
    expect((await probeMedia(await render(p, "hevc.mp4", { videoCodec: "libx265", preset: "ultrafast" }))).meta.videoCodec).toBe("hevc");
    expect((await probeMedia(await render(p, "av1.mp4", { videoCodec: "libsvtav1", preset: "ultrafast" }))).meta.videoCodec).toBe("av1");
    expect((await probeMedia(await render(p, "prores.mov", { container: "mov", videoCodec: "prores_ks", audioCodec: "pcm_s16le" }))).meta.videoCodec).toBe("prores");
    const br = await render(p, "bitrate.mp4", { bitrateMbps: 2 });
    expect((await stat(br)).size).toBeGreaterThan(1000);
    const m60 = (await probeMedia(await render(p, "60.mp4", { fps: { num: 60, den: 1 } }))).meta;
    expect(m60.fps!.num / m60.fps!.den).toBeCloseTo(60, 0);
  });

  it("exports GIF, audio-only MP3/WAV and a PNG frame", async () => {
    const p = clipOn(base(), "trk_v1", "red", 0, 30).project;
    const gif = (await probeMedia(await render(p, "anim.gif", { kind: "gif", container: "gif", videoCodec: "gif", audioCodec: "none", fps: { num: 15, den: 1 } }))).meta;
    expect(gif.videoCodec).toBe("gif");
    const mp3 = (await probeMedia(await render(p, "sound.mp3", { kind: "audio", container: "mp3", videoCodec: "none", audioCodec: "libmp3lame" }))).meta;
    expect([mp3.hasVideo, mp3.hasAudio, mp3.audioCodec]).toEqual([false, true, "mp3"]);
    const wav = (await probeMedia(await render(p, "sound.wav", { kind: "audio", container: "wav", videoCodec: "none", audioCodec: "pcm_s16le" }))).meta;
    expect(wav.audioCodec).toBe("pcm_s16le");
    const png = await render(p, "still.png", { kind: "frame", container: "png", videoCodec: "png", audioCodec: "none", width: 640, height: 360 }, { start: 10, end: 11 });
    const pm = (await probeMedia(png)).meta;
    expect([pm.width, pm.height]).toEqual([640, 360]);
  });

  it("applies denoise and voice pitch on export", async () => {
    const c = clipOn(base(), "trk_a1", "red", 0, 60);
    const p = updateClip(c.project, c.clipId, { audio: { ...findClip(c.project, c.clipId)!.clip.audio, denoise: true, pitch: 5 } });
    const out = await render(p, "voice.mp3", { kind: "audio", container: "mp3", videoCodec: "none", audioCodec: "libmp3lame" });
    const peaks = await computePeaks(out);
    expect(Math.max(...peaks)).toBeGreaterThan(0.02);
  });
});

describe("AI & processing tools", () => {
  it("text-to-speech, then auto captions transcribe it", async () => {
    const wav = await textToSpeech("Welcome to motif studio. Captions are generated locally.", "slt", join(FIX, "tts.wav"));
    const m = (await probeMedia(wav)).meta;
    expect(m.durationSec).toBeGreaterThan(2);
    const tr = await transcribe(wav, { model: "tiny" });
    const text = tr.segments.map((s) => s.text).join(" ").toLowerCase();
    expect(text).toContain("welcome");
    expect(text).toMatch(/caption/);
    const words = tr.segments.flatMap((s) => s.words);
    expect(words.length).toBeGreaterThan(4);
    const cues = wordsToCues(words, 4, 2.5);
    expect(cues.length).toBeGreaterThanOrEqual(2);
    const ins = insertCaptionCues(base(), cues);
    expect(ins.count).toBe(cues.length);
    expect(ins.project.tracks.find((t) => t.name === "Captions")!.clips.length).toBe(cues.length);
  }, 170_000);

  it("stabilizes shaky footage into a new file", async () => {
    const out = await stabilize(A.shaky!.path, join(OUT, "stable.mp4"), 2);
    const m = (await probeMedia(out)).meta;
    expect(m.durationSec).toBeCloseTo(2, 0);
    expect(m.width).toBe(320);
  });

  it("extracts and detaches audio", async () => {
    const wav = await extractAudio(A.red!.path, join(OUT, "red.wav"));
    expect((await probeMedia(wav)).meta.hasVideo).toBe(false);
    const c = clipOn(base(), "trk_v1", "red");
    const d = detachAudio(c.project, c.clipId);
    expect(findClip(d.project, c.clipId)!.clip.audio.muted).toBe(true);
    expect(findClip(d.project, d.audioClipId)!.track.kind).toBe("audio");
  });
});
