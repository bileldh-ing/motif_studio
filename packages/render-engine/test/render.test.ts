/**
 * Render integration + regression tests. Fixtures are generated with FFmpeg's
 * lavfi sources (solid colours, sine tones), so they are license-clean and tiny.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createProject, serializeProject, parseProject, type Project, type RenderPreset } from "@motif/project-schema";
import { addAsset, insertMediaClip, insertTextClip, setKeyframe, setTransitionIn, updateClip } from "@motif/editor-core";
import { CancelledError, computePeaks, grabFrameRGB, importMedia, renderProject, runFfmpeg, makeFilmstrip } from "@motif/render-engine";

const OUT = join(process.cwd(), "tests", "output");
const FIX = join(OUT, "fixtures");

async function gen(args: string[]) {
  await runFfmpeg(["-y", ...args]);
}

const preset: RenderPreset = {
  id: "test",
  name: "test",
  container: "mp4",
  videoCodec: "libx264",
  audioCodec: "aac",
  width: 320,
  height: 180,
  fps: { num: 30, den: 1 },
  crf: 18,
  audioBitrateK: 128,
  preset: "ultrafast",
};

function px(buf: Buffer, x: number, y: number, w = 320): [number, number, number] {
  const i = (y * w + x) * 3;
  return [buf[i]!, buf[i + 1]!, buf[i + 2]!];
}

let project: Project;

beforeAll(async () => {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(FIX, { recursive: true });
  await gen(["-f", "lavfi", "-i", "color=c=red:s=320x180:r=30:d=3", "-f", "lavfi", "-i", "sine=f=440:d=3", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", join(FIX, "red.mp4")]);
  await gen(["-f", "lavfi", "-i", "color=c=blue:s=320x180:r=30:d=3", "-f", "lavfi", "-i", "sine=f=880:d=3", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", join(FIX, "blue.mp4")]);
  await gen(["-f", "lavfi", "-i", "color=c=0x00ff00:s=80x80", "-frames:v", "1", join(FIX, "green.png")]);
  await gen(["-f", "lavfi", "-i", "sine=f=220:d=5", join(FIX, "tone.wav")]);

  let p = createProject({ title: "Spike", id: "prj_spike" });
  p = { ...p, profile: { ...p.profile, width: 320, height: 180, fps: { num: 30, den: 1 } } };
  const red = await importMedia(join(FIX, "red.mp4"));
  const blue = await importMedia(join(FIX, "blue.mp4"));
  const green = await importMedia(join(FIX, "green.png"));
  const tone = await importMedia(join(FIX, "tone.wav"));
  for (const a of [red, blue, green, tone]) p = addAsset(p, a);
  const r = insertMediaClip(p, { trackId: "trk_v1", assetId: red.id, start: 0, duration: 60 });
  const b = insertMediaClip(r.project, { trackId: "trk_v1", assetId: blue.id, start: 60, duration: 60 });
  p = setTransitionIn(b.project, b.clipId, 10);
  const g = insertMediaClip(p, { trackId: "trk_v2", assetId: green.id, start: 30, duration: 60 });
  // green.png fitted to a 180-high canvas would be 180x180; scale it down to 80x80 and push right.
  p = updateClip(g.project, g.clipId, { transform: { x: 100, y: 0, scale: 80 / 180, rotation: 0, opacity: 1 } });
  const t = insertTextClip(p, { trackId: "trk_t1", start: 0, duration: 30, content: "MOTIF" });
  p = updateClip(t.project, t.clipId, { text: { content: "MOTIF", fontSize: 140, color: "#ffffff", boxOpacity: 0.5, align: "top", role: "title" } });
  const m = insertMediaClip(p, { trackId: "trk_a1", assetId: tone.id, start: 0, duration: 120 });
  p = updateClip(m.project, m.clipId, { audio: { gainDb: -6, pan: 0, fadeInFrames: 15, fadeOutFrames: 15, muted: false } });
  project = p;
});

describe("media probe", () => {
  it("detects kinds and metadata", async () => {
    const a = await importMedia(join(FIX, "red.mp4"));
    expect(a.kind).toBe("video");
    expect(a.meta.width).toBe(320);
    expect(a.meta.hasAudio).toBe(true);
    expect(a.meta.durationSec).toBeGreaterThan(2.9);
    expect((await importMedia(join(FIX, "green.png"))).kind).toBe("image");
    expect((await importMedia(join(FIX, "tone.wav"))).kind).toBe("audio");
  });
  it("reports corrupt files clearly", async () => {
    const { writeFile } = await import("node:fs/promises");
    const bad = join(FIX, "corrupt.mp4");
    await writeFile(bad, "not a video");
    await expect(importMedia(bad)).rejects.toThrow(/Could not read/);
  });
  it("computes waveform peaks and filmstrips", async () => {
    const peaks = await computePeaks(join(FIX, "tone.wav"));
    expect(peaks.length).toBeGreaterThan(240);
    expect(Math.max(...peaks)).toBeGreaterThan(0.05);
    await makeFilmstrip(join(FIX, "red.mp4"), 3, join(OUT, "strip.jpg"), 5, 40);
  });
});

describe("render engine (technical spike)", () => {
  it("exports a 2-layer composition with title, crossfade, image overlay and audio, matching the timeline", async () => {
    // round-trip the project through disk format first: export must work from the saved document
    const saved = parseProject(JSON.parse(serializeProject(project)));
    const out = join(OUT, "spike.mp4");
    const progress: number[] = [];
    const res = await renderProject(saved, preset, { outputPath: out }, { onProgress: (f) => progress.push(f) });
    expect(res.verification.problems).toEqual([]);
    expect(res.verification.ok).toBe(true);
    expect(res.durationSec).toBeCloseTo(4, 6);
    expect(progress.at(-1)).toBe(1);

    // t=0.5s: red base, title in top band (white pixels), no green yet
    const f1 = await grabFrameRGB(out, 0.5, 320, 180);
    const [r1, g1, b1] = px(f1, 40, 120);
    expect(r1).toBeGreaterThan(200);
    expect(g1).toBeLessThan(60);
    expect(b1).toBeLessThan(60);
    let maxTop = 0;
    for (let x = 100; x < 220; x++) for (let y = 10; y < 40; y++) maxTop = Math.max(maxTop, Math.min(...px(f1, x, y)));
    expect(maxTop).toBeGreaterThan(200); // white text drawn
    expect(px(f1, 260, 90)[1]).toBeLessThan(60); // overlay not visible yet

    // t=1.5s: green overlay at centre+100px, red base elsewhere
    const f2 = await grabFrameRGB(out, 1.5, 320, 180);
    const [r2, g2] = px(f2, 260, 90);
    expect(g2).toBeGreaterThan(200);
    expect(r2).toBeLessThan(60);
    expect(px(f2, 40, 90)[0]).toBeGreaterThan(200);

    // frame 65 (inside the 10-frame crossfade): red and blue mixed
    const f3 = await grabFrameRGB(out, 65 / 30 + 0.001, 320, 180);
    const [r3, , b3] = px(f3, 40, 120);
    expect(r3).toBeGreaterThan(50);
    expect(b3).toBeGreaterThan(50);

    // t=3.5s: blue only
    const f4 = await grabFrameRGB(out, 3.5, 320, 180);
    const [r4, , b4] = px(f4, 40, 120);
    expect(b4).toBeGreaterThan(200);
    expect(r4).toBeLessThan(60);

    // audio present and not silent
    const peaks = await computePeaks(out);
    expect(Math.max(...peaks.slice(50, 150))).toBeGreaterThan(0.2); // mid-timeline is loud
    expect(peaks[0]!).toBeLessThan(0.2); // fade-in starts near silence
  });

  it("animates position keyframes in the export", async () => {
    let p = project;
    const green = p.tracks.find((t) => t.id === "trk_v2")!.clips[0]!;
    p = setKeyframe(p, green.id, "x", 0, -100);
    p = setKeyframe(p, green.id, "x", 59, 100);
    const out = join(OUT, "kf.mp4");
    const res = await renderProject(p, preset, { outputPath: out });
    expect(res.verification.ok).toBe(true);
    const early = await grabFrameRGB(out, 31 / 30, 320, 180); // local frame ~1 -> x≈-97 => centre at ~63
    expect(px(early, 63, 90)[1]).toBeGreaterThan(200);
    expect(px(early, 260, 90)[1]).toBeLessThan(60);
    const late = await grabFrameRGB(out, 88 / 30, 320, 180); // local ~58 -> x≈97 => ~257
    expect(px(late, 257, 90)[1]).toBeGreaterThan(200);
  });

  it("exports a sub-range and a resized preset", async () => {
    const out = join(OUT, "range.mp4");
    const res = await renderProject(project, { ...preset, width: 640, height: 360 }, { outputPath: out, range: { start: 30, end: 90 } });
    expect(res.verification.ok).toBe(true);
    expect(res.verification.probed!.width).toBe(640);
    expect(res.durationSec).toBeCloseTo(2, 6);
  });

  it("cancels cleanly and leaves no partial output", async () => {
    // a long composition: loop the image for 10 minutes so the render takes a while
    let p = project;
    const green = p.assets.find((a) => a.kind === "image")!;
    p = insertMediaClip(p, { trackId: "trk_v1", assetId: green.id, start: 200, duration: 30 * 600 }).project;
    const ac = new AbortController();
    const out = join(OUT, "cancel.mp4");
    let aborted = false;
    const pr = renderProject(p, { ...preset, preset: "medium", crf: 10 }, { outputPath: out }, {
      signal: ac.signal,
      onProgress: (f, stage) => {
        if (stage === "encoding" && f > 0.005 && !aborted) {
          aborted = true;
          ac.abort();
        }
      },
    });
    await expect(pr).rejects.toBeInstanceOf(CancelledError);
    expect(aborted).toBe(true);
    const left = (await readdir(OUT)).filter((f) => f.includes("cancel"));
    expect(left).toEqual([]);
  });
});

describe("silence detection", () => {
  it("finds the silent gap in a tone-silence-tone file", async () => {
    const { detectSilences } = await import("@motif/render-engine");
    const f = join(FIX, "gap.wav");
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "sine=f=440:d=1", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=1.5", "-f", "lavfi", "-i", "sine=f=440:d=1", "-filter_complex", "[0][1][2]concat=n=3:v=0:a=1", f]);
    const r = await detectSilences(f, -40, 0.5);
    expect(r).toHaveLength(1);
    expect(r[0]!.startSec).toBeCloseTo(1, 1);
    expect(r[0]!.endSec).toBeCloseTo(2.5, 1);
  });
});
