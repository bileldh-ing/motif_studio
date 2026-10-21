/** Higher-level editing operations (CapCut-style tools) built on the core timeline commands. */
import { ClipSchema, LOOKS, newId, type Clip, type ColorAdjust, type Project, type Track, type TRANSITION_KINDS } from "@motif/project-schema";
import { clipEnd, findClip, updateClip, splitClip, TimelineError, isRangeFree, firstFreeStart, addTrack } from "./timeline.js";
import { clipSourceSeconds } from "./evaluate.js";
import { secondsToFrames } from "./time.js";

/** Default colour values, used to reset before applying a look. */
export const NEUTRAL_COLOR: ColorAdjust = { brightness: 0, contrast: 1, saturation: 1, hue: 0, grayscale: 0, sepia: 0, invert: false, blur: 0, vignette: 0, temperature: 0, look: "" };

export function applyLook(p: Project, clipId: string, lookId: string | null): Project {
  const look = lookId ? LOOKS.find((l) => l.id === lookId) : null;
  if (lookId && !look) throw new TimelineError("unknown look");
  return updateClip(p, clipId, { color: { ...NEUTRAL_COLOR, ...(look?.color ?? {}), look: look?.id ?? "" } });
}

/**
 * Freeze frame: holds the frame under the playhead for `holdFrames`, pushing
 * the rest of the track right (ripple insert), like CapCut's Freeze.
 */
export function freezeFrame(p: Project, clipId: string, frame: number, holdFrames: number): { project: Project; freezeId: string } {
  const hit = findClip(p, clipId);
  if (!hit) throw new TimelineError("clip not found");
  const c = hit.clip;
  if (c.kind !== "media") throw new TimelineError("freeze works on video clips");
  const asset = p.assets.find((a) => a.id === c.assetId);
  if (asset?.kind !== "video") throw new TimelineError("freeze works on video clips");
  if (frame < c.start || frame >= clipEnd(c)) throw new TimelineError("put the playhead inside the clip");
  if (hit.track.locked) throw new TimelineError(`track "${hit.track.name}" is locked`);
  const fps = p.profile.fps;
  const srcFrame = secondsToFrames(clipSourceSeconds(c, frame, fps), fps, "floor");
  // 1. ripple everything at/after `frame` on this track to the right
  let next: Project = {
    ...p,
    tracks: p.tracks.map((t) =>
      t.id !== hit.track.id
        ? t
        : {
            ...t,
            clips: t.clips.flatMap((x): Clip[] => {
              if (x.id === c.id && frame > x.start) {
                // split this clip at `frame`
                const left: Clip = { ...x, duration: frame - x.start };
                const speed = x.speed.num / x.speed.den;
                const right: Clip = { ...x, id: newId("clp"), start: frame + holdFrames, duration: clipEnd(x) - frame, sourceIn: x.reverse ? x.sourceIn : x.sourceIn + Math.round((frame - x.start) * speed), transitionIn: undefined, animIn: { kind: "none", frames: 15 } };
                return [left, right];
              }
              return x.start >= frame ? [{ ...x, start: x.start + holdFrames }] : [x];
            }),
          },
    ),
  };
  const freeze = ClipSchema.parse({
    ...c,
    id: newId("clp"),
    name: `${c.name} (freeze)`,
    start: frame,
    duration: holdFrames,
    sourceIn: srcFrame,
    speed: { num: 1, den: 1 },
    freeze: true,
    reverse: false,
    transitionIn: undefined,
    animIn: { kind: "none", frames: 15 },
    animOut: { kind: "none", frames: 15 },
    keyframes: {},
    audio: { ...c.audio, muted: true },
  });
  next = { ...next, tracks: next.tracks.map((t) => (t.id === hit.track.id ? { ...t, clips: [...t.clips, freeze].sort((a, b) => a.start - b.start) } : t)) };
  // validate via a no-op update (runs semantic checks)
  return { project: updateClip(next, freeze.id, {}), freezeId: freeze.id };
}

/** Detach audio: place the clip's audio on an audio track and mute the video clip. */
export function detachAudio(p: Project, clipId: string, audioAssetId?: string): { project: Project; audioClipId: string } {
  const hit = findClip(p, clipId);
  if (!hit) throw new TimelineError("clip not found");
  const c = hit.clip;
  const asset = p.assets.find((a) => a.id === (audioAssetId ?? c.assetId));
  if (!asset?.meta.hasAudio) throw new TimelineError("this clip has no audio");
  let next = p;
  let track: Track | undefined = next.tracks.find((t) => t.kind === "audio" && !t.locked && isRangeFree(t, c.start, c.duration));
  if (!track) {
    const r = addTrack(next, "audio");
    next = r.project;
    track = next.tracks.find((t) => t.id === r.trackId)!;
  }
  const a = ClipSchema.parse({
    id: newId("clp"),
    kind: "media",
    assetId: asset.id,
    name: `${c.name} audio`,
    start: c.start,
    duration: c.duration,
    sourceIn: c.sourceIn,
    speed: c.speed,
    reverse: c.reverse,
    audio: { ...c.audio, muted: false },
  });
  next = { ...next, tracks: next.tracks.map((t) => (t.id === track!.id ? { ...t, clips: [...t.clips, a].sort((x, y) => x.start - y.start) } : t)) };
  next = updateClip(next, c.id, { audio: { ...c.audio, muted: true } });
  return { project: next, audioClipId: a.id };
}

export function insertShapeClip(p: Project, o: { trackId: string; start: number; duration: number; type: "rect" | "ellipse"; fill: string; w?: number; h?: number }): { project: Project; clipId: string } {
  const track = p.tracks.find((t) => t.id === o.trackId);
  if (!track || track.kind === "audio") throw new TimelineError("shapes go on a video or text track");
  if (track.locked) throw new TimelineError(`track "${track.name}" is locked`);
  const side = Math.round(Math.min(p.profile.width, p.profile.height) * 0.35);
  const start = isRangeFree(track, o.start, o.duration) ? o.start : firstFreeStart(track, o.start, o.duration);
  const clip = ClipSchema.parse({
    id: newId("clp"),
    kind: "shape",
    name: o.type === "rect" ? "Rectangle" : "Circle",
    start,
    duration: o.duration,
    shape: { type: o.type, w: o.w ?? side, h: o.h ?? side, fill: o.fill },
  });
  const next = { ...p, tracks: p.tracks.map((t) => (t.id === track.id ? { ...t, clips: [...t.clips, clip].sort((a, b) => a.start - b.start) } : t)) };
  return { project: updateClip(next, clip.id, {}), clipId: clip.id };
}

export function setTransition(p: Project, clipId: string, kind: (typeof TRANSITION_KINDS)[number] | null, frames: number): Project {
  const hit = findClip(p, clipId);
  if (!hit) throw new TimelineError("clip not found");
  if (!kind) return updateClip(p, clipId, { transitionIn: undefined });
  const prev = hit.track.clips.find((c) => clipEnd(c) === hit.clip.start);
  if (!prev) throw new TimelineError("a transition needs a clip directly before this one on the same track");
  const max = Math.min(hit.clip.duration, prev.duration);
  return updateClip(p, clipId, { transitionIn: { kind, frames: Math.max(1, Math.min(frames, max)) } });
}

/** Clipboard: copy clips (with their relative offsets). */
export interface ClipboardData {
  clips: { clip: Clip; trackKind: Track["kind"]; offset: number }[];
}
export function copyClips(p: Project, ids: string[]): ClipboardData {
  const hits = ids.map((id) => findClip(p, id)).filter(Boolean) as NonNullable<ReturnType<typeof findClip>>[];
  if (!hits.length) throw new TimelineError("nothing selected");
  const first = Math.min(...hits.map((h) => h.clip.start));
  return { clips: hits.map((h) => ({ clip: h.clip, trackKind: h.track.kind, offset: h.clip.start - first })) };
}

export function pasteClips(p: Project, data: ClipboardData, at: number): { project: Project; ids: string[] } {
  let next = p;
  const ids: string[] = [];
  for (const item of data.clips) {
    if (item.clip.assetId && !next.assets.some((a) => a.id === item.clip.assetId)) continue;
    const kind = item.clip.kind === "text" ? "text" : item.trackKind;
    const candidates = next.tracks.filter((t) => t.kind === kind && !t.locked);
    const want = at + item.offset;
    let track = candidates.find((t) => isRangeFree(t, want, item.clip.duration));
    if (!track) {
      const r = addTrack(next, kind);
      next = r.project;
      track = next.tracks.find((t) => t.id === r.trackId)!;
    }
    const clip: Clip = { ...item.clip, id: newId("clp"), start: want, transitionIn: undefined };
    next = { ...next, tracks: next.tracks.map((t) => (t.id === track!.id ? { ...t, clips: [...t.clips, clip].sort((a, b) => a.start - b.start) } : t)) };
    next = updateClip(next, clip.id, {});
    ids.push(clip.id);
  }
  if (!ids.length) throw new TimelineError("nothing to paste");
  return { project: next, ids };
}

/** Insert caption cues (timeline seconds) on a dedicated "Captions" text track. */
export function insertCaptionCues(p: Project, cues: { startSec: number; endSec: number; text: string }[]): { project: Project; trackId: string; count: number } {
  let next = p;
  let track = next.tracks.find((t) => t.kind === "text" && t.name === "Captions");
  if (!track) {
    const r = addTrack(next, "text", "Captions");
    next = r.project;
    track = next.tracks.find((t) => t.id === r.trackId)!;
  }
  const fps = p.profile.fps;
  const add: Clip[] = [];
  let lastEnd = 0;
  for (const cue of cues) {
    let s = secondsToFrames(cue.startSec, fps, "round");
    const e = secondsToFrames(cue.endSec, fps, "round");
    s = Math.max(s, lastEnd);
    if (e - s < 2 || !isRangeFree(track, s, e - s)) continue;
    add.push(
      ClipSchema.parse({
        id: newId("clp"),
        kind: "text",
        name: cue.text.slice(0, 32),
        start: s,
        duration: e - s,
        text: { content: cue.text, role: "caption", align: "lower-third", fontSize: 54, boxColor: "#000000", boxOpacity: 0.55, font: "poppins", bold: true },
      }),
    );
    lastEnd = e;
  }
  const tid = track.id;
  next = { ...next, tracks: next.tracks.map((t) => (t.id === tid ? { ...t, clips: [...t.clips, ...add].sort((a, b) => a.start - b.start) } : t)) };
  if (add[0]) next = updateClip(next, add[0].id, {});
  return { project: next, trackId: tid, count: add.length };
}

/** Group transcript words into caption-sized cues (max words / max seconds). */
export function wordsToCues(words: { start: number; end: number; word: string }[], maxWords = 6, maxSec = 3): { startSec: number; endSec: number; text: string }[] {
  const cues: { startSec: number; endSec: number; text: string }[] = [];
  let cur: typeof words = [];
  const flush = () => {
    if (!cur.length) return;
    cues.push({ startSec: cur[0]!.start, endSec: cur[cur.length - 1]!.end, text: cur.map((w) => w.word.trim()).join(" ").replace(/\s+([,.!?;:])/g, "$1") });
    cur = [];
  };
  for (const w of words) {
    if (cur.length && (cur.length >= maxWords || w.end - cur[0]!.start > maxSec || /[.!?]$/.test(cur[cur.length - 1]!.word.trim()))) flush();
    cur.push(w);
  }
  flush();
  return cues;
}

/** CSS-spec sepia matrix blended with identity, then a warm/cool channel gain. Shared with the preview. */
export function colorMatrix(sepia: number, temperature: number): number[][] {
  const s = sepia;
  const sep = [
    [0.393 + 0.607 * (1 - s), 0.769 - 0.769 * (1 - s), 0.189 - 0.189 * (1 - s)],
    [0.349 - 0.349 * (1 - s), 0.686 + 0.314 * (1 - s), 0.168 - 0.168 * (1 - s)],
    [0.272 - 0.272 * (1 - s), 0.534 - 0.534 * (1 - s), 0.131 + 0.869 * (1 - s)],
  ];
  const gain = [1 + 0.25 * temperature, 1 + 0.03 * temperature, 1 - 0.25 * temperature];
  return sep.map((row, i) => row.map((v) => v * gain[i]!));
}


export { splitClip };
