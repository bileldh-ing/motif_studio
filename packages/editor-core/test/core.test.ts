import { describe, expect, it } from "vitest";
import { createProject, parseProject, serializeProject, type MediaAsset, type Project } from "@motif/project-schema";
import {
  History,
  addAsset,
  captionCues,
  formatTimecode,
  framesToSeconds,
  importCaptions,
  insertMediaClip,
  insertTextClip,
  interpolate,
  liftClips,
  moveClip,
  parseSrt,
  parseTimecode,
  rippleDelete,
  secondsToFrames,
  setClipSpeed,
  setKeyframe,
  setTransitionIn,
  snap,
  snapPoints,
  sourceSecondsAt,
  splitClip,
  toSrt,
  trimEnd,
  trimStart,
  visualLayersAt,
  findClip,
  TimelineError,
  duplicateClip,
} from "@motif/editor-core";

const ntsc = { num: 30000, den: 1001 };

function asset(id: string, durationSec: number, kind: MediaAsset["kind"] = "video", hasAudio = true): MediaAsset {
  return {
    id,
    kind,
    name: id,
    path: `/media/${id}.mp4`,
    meta: { durationSec, hasVideo: kind !== "audio", hasAudio, width: 1920, height: 1080 },
    favorite: false,
    tags: [],
    bin: "",
    provenance: "imported",
  };
}

function base(fps = { num: 30, den: 1 }): Project {
  let p = createProject({ title: "Test", fps, id: "prj_test", now: "2026-10-21T00:00:00.000Z" });
  p = addAsset(p, asset("a", 10));
  p = addAsset(p, asset("b", 4));
  p = addAsset(p, asset("music", 30, "audio"));
  return p;
}

describe("timebase", () => {
  it("round-trips frames and seconds at fractional rates without drift", () => {
    for (let f = 0; f < 200_000; f += 997) {
      expect(secondsToFrames(framesToSeconds(f, ntsc), ntsc)).toBe(f);
    }
  });
  it("1 hour at 29.97 is 107892 frames (rounded down)", () => {
    expect(secondsToFrames(3600, ntsc)).toBe(107892);
  });
  it("formats and parses timecode", () => {
    expect(formatTimecode(30 * 61 + 5, { num: 30, den: 1 })).toBe("00:01:01:05");
    expect(parseTimecode("00:01:01:05", { num: 30, den: 1 })).toBe(1835);
    expect(parseTimecode("00:00:00:30", { num: 30, den: 1 })).toBeNull();
  });
  it("maps timeline to source time with rational speed", () => {
    const c = { start: 100, sourceIn: 60, speed: { num: 2, den: 1 } };
    expect(sourceSecondsAt(c, 130, { num: 30, den: 1 })).toBeCloseTo((60 + 60) / 30, 9);
  });
});

describe("timeline operations", () => {
  it("inserts, splits and preserves exact source ranges", () => {
    let p = base();
    const ins = insertMediaClip(p, { trackId: "trk_v1", assetId: "a", start: 0 });
    p = ins.project;
    expect(findClip(p, ins.clipId)!.clip.duration).toBe(300);
    const s = splitClip(p, ins.clipId, 120);
    p = s.project;
    const left = findClip(p, s.leftId)!.clip;
    const right = findClip(p, s.rightId)!.clip;
    expect(left.duration).toBe(120);
    expect(right.start).toBe(120);
    expect(right.sourceIn).toBe(120);
    expect(right.duration).toBe(180);
  });

  it("rejects overlaps and leaves input untouched", () => {
    let p = insertMediaClip(base(), { trackId: "trk_v1", assetId: "a", start: 0 }).project;
    const before = JSON.stringify(p);
    expect(() => insertMediaClip(p, { trackId: "trk_v1", assetId: "b", start: 100 })).toThrow(TimelineError);
    expect(JSON.stringify(p)).toBe(before);
    const placed = insertMediaClip(p, { trackId: "trk_v1", assetId: "b", start: 100, findFreeSlot: true });
    expect(findClip(placed.project, placed.clipId)!.clip.start).toBe(300);
  });

  it("trims within source bounds", () => {
    let p = base();
    const { project, clipId } = insertMediaClip(p, { trackId: "trk_v1", assetId: "b", start: 30, sourceIn: 30, duration: 60 });
    p = trimStart(project, clipId, 0); // wants 30 frames earlier; source has exactly 30 frames of handle
    let c = findClip(p, clipId)!.clip;
    expect(c.start).toBe(0);
    expect(c.sourceIn).toBe(0);
    expect(c.duration).toBe(90);
    p = trimEnd(p, clipId, 10_000); // clamps at source end (4 s = 120 frames)
    c = findClip(p, clipId)!.clip;
    expect(c.duration).toBe(120);
  });

  it("ripple delete closes the gap, lift leaves it", () => {
    let p = base();
    const a = insertMediaClip(p, { trackId: "trk_v1", assetId: "b", start: 0 });
    const b = insertMediaClip(a.project, { trackId: "trk_v1", assetId: "b", start: 120 });
    const c = insertMediaClip(b.project, { trackId: "trk_v1", assetId: "b", start: 240 });
    p = c.project;
    const rip = rippleDelete(p, b.clipId);
    expect(findClip(rip, c.clipId)!.clip.start).toBe(120);
    const lift = liftClips(p, [b.clipId]);
    expect(findClip(lift, c.clipId)!.clip.start).toBe(240);
  });

  it("move respects track compatibility and occupancy", () => {
    let p = base();
    const v = insertMediaClip(p, { trackId: "trk_v1", assetId: "b", start: 0 });
    const m = insertMediaClip(v.project, { trackId: "trk_a1", assetId: "music", start: 0, duration: 90 });
    p = m.project;
    expect(() => moveClip(p, m.clipId, 0, "trk_v1")).toThrow(/cannot move/);
    p = moveClip(p, v.clipId, 50, "trk_v2");
    expect(findClip(p, v.clipId)!.track.id).toBe("trk_v2");
  });

  it("speed change scales duration and keeps source range", () => {
    let p = base();
    const { project, clipId } = insertMediaClip(p, { trackId: "trk_v1", assetId: "b", start: 0 });
    p = setClipSpeed(project, clipId, { num: 2, den: 1 });
    expect(findClip(p, clipId)!.clip.duration).toBe(60);
    p = setClipSpeed(p, clipId, { num: 1, den: 2 });
    expect(findClip(p, clipId)!.clip.duration).toBe(240);
  });

  it("image clips default to 5 s but accept any duration", () => {
    let p = addAsset(base(), asset("img", 0, "image", false));
    const a = insertMediaClip(p, { trackId: "trk_v2", assetId: "img", start: 0 });
    expect(findClip(a.project, a.clipId)!.clip.duration).toBe(150);
    const b = insertMediaClip(a.project, { trackId: "trk_v1", assetId: "img", start: 0, duration: 30 * 600 });
    expect(findClip(b.project, b.clipId)!.clip.duration).toBe(18000);
  });

  it("duplicate places copy after the original", () => {
    const { project, clipId } = insertMediaClip(base(), { trackId: "trk_v1", assetId: "b", start: 0 });
    const d = duplicateClip(project, clipId);
    expect(findClip(d.project, d.clipId)!.clip.start).toBe(120);
  });

  it("crossfade keeps the outgoing clip visible during the transition", () => {
    let p = base();
    const a = insertMediaClip(p, { trackId: "trk_v1", assetId: "a", start: 0, duration: 90 });
    const b = insertMediaClip(a.project, { trackId: "trk_v1", assetId: "b", start: 90 });
    p = setTransitionIn(b.project, b.clipId, 15);
    const layers = visualLayersAt(p, 95);
    expect(layers.map((l) => l.clip.id)).toEqual([a.clipId, b.clipId]);
    expect(layers[1]!.opacity).toBeGreaterThan(0);
    expect(layers[1]!.opacity).toBeLessThan(1);
    expect(visualLayersAt(p, 110).map((l) => l.clip.id)).toEqual([b.clipId]);
  });

  it("keyframes interpolate with easing", () => {
    let p = base();
    const { project, clipId } = insertMediaClip(p, { trackId: "trk_v1", assetId: "a", start: 0 });
    p = setKeyframe(project, clipId, "x", 0, -100);
    p = setKeyframe(p, clipId, "x", 30, 100);
    const kfs = findClip(p, clipId)!.clip.keyframes.x;
    expect(interpolate(kfs, 15, 0)).toBeCloseTo(0, 6);
    expect(interpolate(kfs, 60, 0)).toBe(100);
    expect(visualLayersAt(p, 15)[0]!.x).toBeCloseTo(0, 6);
  });

  it("undo/redo restores exact states and failed commands record nothing", () => {
    const h = new History(base());
    const s0 = h.state;
    let id = "";
    h.apply("Insert", (p) => {
      const r = insertMediaClip(p, { trackId: "trk_v1", assetId: "a", start: 0 });
      id = r.clipId;
      return r.project;
    });
    const s1 = h.state;
    h.apply("Split", (p) => splitClip(p, id, 60).project);
    expect(() => h.apply("Bad", (p) => splitClip(p, "nope", 1).project)).toThrow();
    expect(h.undoLabel).toBe("Split");
    h.undo();
    expect(h.state).toBe(s1);
    h.undo();
    expect(h.state).toBe(s0);
    h.redo();
    expect(h.state).toBe(s1);
  });

  it("snaps to nearby edges and the playhead", () => {
    const { project } = insertMediaClip(base(), { trackId: "trk_v1", assetId: "b", start: 0 });
    const pts = snapPoints(project, 200);
    expect(snap(118, pts, 4).frame).toBe(120);
    expect(snap(197, pts, 4).frame).toBe(200);
    expect(snap(160, pts, 4).snappedTo).toBeNull();
  });
});

describe("project format", () => {
  it("serializes deterministically and round-trips exactly", () => {
    let p = base(ntsc);
    p = insertMediaClip(p, { trackId: "trk_v1", assetId: "a", start: 0 }).project;
    p = insertTextClip(p, { trackId: "trk_t1", start: 10, duration: 50, content: "Hello" }).project;
    const s1 = serializeProject(p);
    const back = parseProject(JSON.parse(s1));
    expect(serializeProject(back)).toBe(s1);
    expect(back.profile.fps).toEqual(ntsc);
  });
  it("migrates schema 0 float fps to rational", () => {
    const p = base();
    const legacy: any = JSON.parse(serializeProject(p));
    delete legacy.schemaVersion;
    legacy.profile.fps = 29.97;
    delete legacy.ui;
    expect(parseProject(legacy).profile.fps).toEqual(ntsc);
  });
  it("rejects corrupt documents with a clear error", () => {
    const p: any = JSON.parse(serializeProject(base()));
    p.tracks[0].clips.push({ id: "x", kind: "media", assetId: "missing", start: 0, duration: 10 });
    expect(() => parseProject(p)).toThrow(/missing asset/);
    expect(() => parseProject({ schemaVersion: 99 })).toThrow(/newer MOTIF/);
  });
});

describe("captions", () => {
  it("imports and exports SRT", () => {
    const srt = "1\n00:00:01,000 --> 00:00:02,500\nHello world\n\n2\n00:00:03,000 --> 00:00:04,000\nSecond line\n";
    const cues = parseSrt(srt);
    expect(cues).toHaveLength(2);
    const p = importCaptions(base(), "trk_t1", cues);
    const out = captionCues(p);
    expect(out[0]!.startSec).toBeCloseTo(1, 3);
    expect(out[0]!.endSec).toBeCloseTo(2.5, 3);
    expect(toSrt(out)).toContain("00:00:01,000 --> 00:00:02,500");
  });
});
