/**
 * Pure, transactional timeline operations. Every operation takes a Project and
 * returns a NEW Project (structural sharing) or throws a TimelineError, leaving
 * the input untouched. Results are validated against the semantic rules
 * (no overlaps on a track, no negative durations, valid source ranges).
 */
import {
  ClipSchema,
  semanticProblems,
  newId,
  type Clip,
  type MediaAsset,
  type Project,
  type Rational,
  type Track,
} from "@motif/project-schema";
import { secondsToFrames, sourceFramesConsumed, reduce } from "./time.js";

export class TimelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimelineError";
  }
}

export function clipEnd(c: Pick<Clip, "start" | "duration">): number {
  return c.start + c.duration;
}

export function projectDuration(p: Project): number {
  let end = 0;
  for (const t of p.tracks) for (const c of t.clips) end = Math.max(end, clipEnd(c));
  return end;
}

export function findClip(p: Project, clipId: string): { track: Track; clip: Clip; trackIndex: number } | null {
  for (let i = 0; i < p.tracks.length; i++) {
    const track = p.tracks[i]!;
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { track, clip, trackIndex: i };
  }
  return null;
}

export function assetOf(p: Project, clip: Clip): MediaAsset | undefined {
  return clip.assetId ? p.assets.find((a) => a.id === clip.assetId) : undefined;
}

/** Max source frames available for an asset at project rate (Infinity for images). */
export function assetFrames(p: Project, asset: MediaAsset): number {
  if (asset.kind === "image") return Number.POSITIVE_INFINITY;
  return secondsToFrames(asset.meta.durationSec, p.profile.fps, "floor");
}

function touch(p: Project): Project {
  return { ...p, updatedAt: new Date().toISOString() };
}

function commit(p: Project): Project {
  const problems = semanticProblems(p);
  if (problems.length) throw new TimelineError(problems[0]!);
  for (const t of p.tracks)
    for (const c of t.clips) {
      if (c.duration < 1) throw new TimelineError(`clip ${c.id} would have no duration`);
      const a = assetOf(p, c);
      if (a) {
        const avail = assetFrames(p, a);
        if (c.sourceIn + sourceFramesConsumed(c.duration, c.speed) > avail + 1)
          throw new TimelineError(`clip ${c.id} exceeds its source media`);
      }
    }
  return touch(p);
}

function mapTrack(p: Project, trackId: string, fn: (t: Track) => Track): Project {
  let found = false;
  const tracks = p.tracks.map((t) => {
    if (t.id !== trackId) return t;
    found = true;
    return fn(t);
  });
  if (!found) throw new TimelineError(`track ${trackId} not found`);
  return { ...p, tracks };
}

function sortClips(clips: Clip[]): Clip[] {
  return [...clips].sort((a, b) => a.start - b.start);
}

function assertUnlocked(t: Track) {
  if (t.locked) throw new TimelineError(`track "${t.name}" is locked`);
}

/** Whether [start, start+duration) is free on a track (ignoring `ignoreIds`). */
export function isRangeFree(t: Track, start: number, duration: number, ignoreIds: string[] = []): boolean {
  return t.clips.every((c) => ignoreIds.includes(c.id) || clipEnd(c) <= start || c.start >= start + duration);
}

/** First free start >= desired on a track for a given duration. */
export function firstFreeStart(t: Track, desired: number, duration: number, ignoreIds: string[] = []): number {
  let s = Math.max(0, desired);
  const others = sortClips(t.clips.filter((c) => !ignoreIds.includes(c.id)));
  for (const c of others) {
    if (clipEnd(c) <= s) continue;
    if (c.start >= s + duration) break;
    s = clipEnd(c);
  }
  return s;
}

// ------------------------------------------------------------- assets

export function addAsset(p: Project, asset: MediaAsset): Project {
  if (p.assets.some((a) => a.id === asset.id)) throw new TimelineError("asset already in project");
  return touch({ ...p, assets: [...p.assets, asset] });
}

export function removeAsset(p: Project, assetId: string): Project {
  const used = p.tracks.some((t) => t.clips.some((c) => c.assetId === assetId));
  if (used) throw new TimelineError("asset is used on the timeline; remove its clips first");
  return touch({ ...p, assets: p.assets.filter((a) => a.id !== assetId) });
}

export function updateAsset(p: Project, assetId: string, patch: Partial<MediaAsset>): Project {
  return touch({ ...p, assets: p.assets.map((a) => (a.id === assetId ? { ...a, ...patch, id: a.id } : a)) });
}

// ------------------------------------------------------------- clips

export interface InsertMediaOptions {
  trackId: string;
  assetId: string;
  start: number;
  /** Defaults to the whole source (or 5 s for images). */
  duration?: number;
  sourceIn?: number;
  /** When the target range is occupied, place at the first free slot instead of failing. */
  findFreeSlot?: boolean;
}

export function insertMediaClip(p: Project, o: InsertMediaOptions): { project: Project; clipId: string } {
  const asset = p.assets.find((a) => a.id === o.assetId);
  if (!asset) throw new TimelineError("asset not found");
  const track = p.tracks.find((t) => t.id === o.trackId);
  if (!track) throw new TimelineError("track not found");
  assertUnlocked(track);
  if (track.kind === "text") throw new TimelineError("media cannot go on a text track");
  if (track.kind === "audio" && !asset.meta.hasAudio) throw new TimelineError("this media has no audio");
  if (track.kind === "video" && asset.kind === "audio") throw new TimelineError("audio files go on an audio track");
  const sourceIn = o.sourceIn ?? 0;
  const avail = assetFrames(p, asset);
  const full = Number.isFinite(avail) ? avail - sourceIn : secondsToFrames(5, p.profile.fps);
  const duration = Math.max(1, Math.min(o.duration ?? full, full));
  let start = Math.max(0, o.start);
  if (!isRangeFree(track, start, duration)) {
    if (!o.findFreeSlot) throw new TimelineError("that spot is occupied");
    start = firstFreeStart(track, start, duration);
  }
  const clip = ClipSchema.parse({ id: newId("clp"), kind: "media", assetId: asset.id, name: asset.name, start, duration, sourceIn });
  const project = commit(mapTrack(p, track.id, (t) => ({ ...t, clips: sortClips([...t.clips, clip]) })));
  return { project, clipId: clip.id };
}

export function insertTextClip(
  p: Project,
  o: { trackId: string; start: number; duration: number; content: string; role?: "title" | "caption"; findFreeSlot?: boolean },
): { project: Project; clipId: string } {
  const track = p.tracks.find((t) => t.id === o.trackId);
  if (!track) throw new TimelineError("track not found");
  assertUnlocked(track);
  if (track.kind === "audio") throw new TimelineError("text cannot go on an audio track");
  let start = Math.max(0, o.start);
  if (!isRangeFree(track, start, o.duration)) {
    if (!o.findFreeSlot) throw new TimelineError("that spot is occupied");
    start = firstFreeStart(track, start, o.duration);
  }
  const role = o.role ?? "title";
  const clip = ClipSchema.parse({
    id: newId("clp"),
    kind: "text",
    name: o.content.slice(0, 32),
    start,
    duration: o.duration,
    text: { content: o.content, role, align: role === "caption" ? "lower-third" : "center", fontSize: role === "caption" ? 54 : 96, boxColor: role === "caption" ? "#000000" : undefined },
  });
  return { project: commit(mapTrack(p, track.id, (t) => ({ ...t, clips: sortClips([...t.clips, clip]) }))), clipId: clip.id };
}

export function updateClip(p: Project, clipId: string, patch: Partial<Omit<Clip, "id">>): Project {
  const hit = findClip(p, clipId);
  if (!hit) throw new TimelineError("clip not found");
  assertUnlocked(hit.track);
  const next = ClipSchema.parse({ ...hit.clip, ...patch, id: hit.clip.id });
  return commit(mapTrack(p, hit.track.id, (t) => ({ ...t, clips: sortClips(t.clips.map((c) => (c.id === clipId ? next : c))) })));
}

/** Move a clip to a new start (and optionally another compatible track). */
export function moveClip(p: Project, clipId: string, newStart: number, toTrackId?: string): Project {
  const hit = findClip(p, clipId);
  if (!hit) throw new TimelineError("clip not found");
  assertUnlocked(hit.track);
  const target = toTrackId ? p.tracks.find((t) => t.id === toTrackId) : hit.track;
  if (!target) throw new TimelineError("target track not found");
  assertUnlocked(target);
  const compatible =
    target.kind === hit.track.kind ||
    (hit.clip.kind === "text" && target.kind === "video") ||
    (hit.clip.kind !== "text" && hit.track.kind === "video" && target.kind === "video");
  if (!compatible) throw new TimelineError(`cannot move a ${hit.track.kind} clip to a ${target.kind} track`);
  const start = Math.max(0, Math.round(newStart));
  if (!isRangeFree(target, start, hit.clip.duration, [clipId])) throw new TimelineError("that spot is occupied");
  const moved = { ...hit.clip, start };
  let next = mapTrack(p, hit.track.id, (t) => ({ ...t, clips: t.clips.filter((c) => c.id !== clipId) }));
  next = mapTrack(next, target.id, (t) => ({ ...t, clips: sortClips([...t.clips, moved]) }));
  return commit(next);
}

/** Trim the left edge so the clip starts at `newStart` (source in moves with it). */
export function trimStart(p: Project, clipId: string, newStart: number): Project {
  const hit = findClip(p, clipId);
  if (!hit) throw new TimelineError("clip not found");
  const c = hit.clip;
  const end = clipEnd(c);
  let start = Math.round(newStart);
  if (start >= end) throw new TimelineError("trim would remove the whole clip");
  const deltaTimeline = start - c.start;
  // Source frames move by delta * speed (exactly representable only for integer results).
  const deltaSource = Math.round((deltaTimeline * c.speed.num) / c.speed.den);
  let sourceIn = c.sourceIn + deltaSource;
  if (c.kind === "media" && sourceIn < 0) {
    // clamp to the beginning of the source
    start = c.start - Math.floor((c.sourceIn * c.speed.den) / c.speed.num);
    sourceIn = 0;
  }
  if (c.kind !== "media") sourceIn = 0;
  start = Math.max(0, start);
  return updateClip(p, clipId, { start, duration: end - start, sourceIn });
}

/** Trim the right edge so the clip ends at `newEnd`. */
export function trimEnd(p: Project, clipId: string, newEnd: number): Project {
  const hit = findClip(p, clipId);
  if (!hit) throw new TimelineError("clip not found");
  const c = hit.clip;
  let end = Math.round(newEnd);
  if (end <= c.start) throw new TimelineError("trim would remove the whole clip");
  const a = assetOf(p, c);
  if (a) {
    const avail = assetFrames(p, a);
    if (Number.isFinite(avail)) {
      const maxDur = Math.floor(((avail - c.sourceIn) * c.speed.den) / c.speed.num);
      end = Math.min(end, c.start + maxDur);
    }
  }
  return updateClip(p, clipId, { duration: end - c.start });
}

/** Split a clip at a timeline frame. Returns ids of both halves. */
export function splitClip(p: Project, clipId: string, frame: number): { project: Project; leftId: string; rightId: string } {
  const hit = findClip(p, clipId);
  if (!hit) throw new TimelineError("clip not found");
  assertUnlocked(hit.track);
  const c = hit.clip;
  if (frame <= c.start || frame >= clipEnd(c)) throw new TimelineError("playhead is not inside the clip");
  const leftDur = frame - c.start;
  const rightSourceIn = c.kind === "media" ? c.sourceIn + Math.round((leftDur * c.speed.num) / c.speed.den) : 0;
  const left: Clip = { ...c, duration: leftDur, audio: { ...c.audio, fadeOutFrames: 0 } };
  const right: Clip = {
    ...c,
    id: newId("clp"),
    start: frame,
    duration: clipEnd(c) - frame,
    sourceIn: rightSourceIn,
    transitionIn: undefined,
    audio: { ...c.audio, fadeInFrames: 0 },
    keyframes: shiftKeyframes(c.keyframes, -leftDur),
  };
  const next = mapTrack(p, hit.track.id, (t) => ({
    ...t,
    clips: sortClips(t.clips.flatMap((x) => (x.id === clipId ? [left, right] : [x]))),
  }));
  return { project: commit(next), leftId: left.id, rightId: right.id };
}

function shiftKeyframes(k: Clip["keyframes"], delta: number): Clip["keyframes"] {
  const out: Clip["keyframes"] = {};
  for (const [prop, kfs] of Object.entries(k)) {
    const shifted = (kfs ?? []).map((f) => ({ ...f, frame: f.frame + delta })).filter((f) => f.frame >= 0);
    if (shifted.length) (out as any)[prop] = shifted;
  }
  return out;
}

/** Remove clips leaving a gap. */
export function liftClips(p: Project, clipIds: string[]): Project {
  let next = p;
  for (const id of clipIds) {
    const hit = findClip(next, id);
    if (!hit) continue;
    assertUnlocked(hit.track);
    next = mapTrack(next, hit.track.id, (t) => ({ ...t, clips: t.clips.filter((c) => c.id !== id) }));
  }
  return commit(next);
}

/** Remove a clip and close the gap on its track by shifting later clips left. */
export function rippleDelete(p: Project, clipId: string): Project {
  const hit = findClip(p, clipId);
  if (!hit) throw new TimelineError("clip not found");
  assertUnlocked(hit.track);
  const { start, duration } = hit.clip;
  return commit(
    mapTrack(p, hit.track.id, (t) => ({
      ...t,
      clips: t.clips.filter((c) => c.id !== clipId).map((c) => (c.start >= start + duration ? { ...c, start: c.start - duration } : c)),
    })),
  );
}

export function duplicateClip(p: Project, clipId: string): { project: Project; clipId: string } {
  const hit = findClip(p, clipId);
  if (!hit) throw new TimelineError("clip not found");
  assertUnlocked(hit.track);
  const start = firstFreeStart(hit.track, clipEnd(hit.clip), hit.clip.duration);
  const copy: Clip = { ...hit.clip, id: newId("clp"), start, transitionIn: undefined };
  return { project: commit(mapTrack(p, hit.track.id, (t) => ({ ...t, clips: sortClips([...t.clips, copy]) }))), clipId: copy.id };
}

/** Change speed keeping the same source range (duration scales). */
export function setClipSpeed(p: Project, clipId: string, speed: Rational): Project {
  const hit = findClip(p, clipId);
  if (!hit) throw new TimelineError("clip not found");
  const s = reduce(speed);
  const ratio = s.num / s.den;
  if (ratio < 0.25 || ratio > 4) throw new TimelineError("speed must be between 0.25× and 4×");
  const c = hit.clip;
  const sourceFrames = (c.duration * c.speed.num) / c.speed.den;
  const duration = Math.max(1, Math.floor((sourceFrames * s.den) / s.num + 1e-9));
  const track = hit.track;
  if (!isRangeFree(track, c.start, duration, [c.id])) throw new TimelineError("not enough room after this clip for the slower speed");
  return updateClip(p, clipId, { speed: s, duration });
}

/** Freeze frame: split at frame and insert a still of `holdFrames` using an image-like hold. */
export function setTransitionIn(p: Project, clipId: string, frames: number | null): Project {
  const hit = findClip(p, clipId);
  if (!hit) throw new TimelineError("clip not found");
  if (frames === null || frames <= 0) return updateClip(p, clipId, { transitionIn: undefined });
  const prev = hit.track.clips.find((c) => clipEnd(c) === hit.clip.start);
  if (!prev) throw new TimelineError("a crossfade needs a clip directly before this one on the same track");
  const max = Math.min(hit.clip.duration, prev.duration);
  return updateClip(p, clipId, { transitionIn: { kind: "crossfade", frames: Math.min(frames, max) } });
}

// ------------------------------------------------------------- keyframes

export function setKeyframe(p: Project, clipId: string, prop: keyof Clip["keyframes"], localFrame: number, value: number, easing: "linear" | "easeIn" | "easeOut" | "easeInOut" | "hold" = "linear"): Project {
  const hit = findClip(p, clipId);
  if (!hit) throw new TimelineError("clip not found");
  if (localFrame < 0 || localFrame >= hit.clip.duration) throw new TimelineError("keyframe must be inside the clip");
  const list = (hit.clip.keyframes[prop] ?? []).filter((k) => k.frame !== localFrame);
  list.push({ frame: localFrame, value, easing });
  list.sort((a, b) => a.frame - b.frame);
  return updateClip(p, clipId, { keyframes: { ...hit.clip.keyframes, [prop]: list } });
}

export function removeKeyframe(p: Project, clipId: string, prop: keyof Clip["keyframes"], localFrame: number): Project {
  const hit = findClip(p, clipId);
  if (!hit) throw new TimelineError("clip not found");
  const list = (hit.clip.keyframes[prop] ?? []).filter((k) => k.frame !== localFrame);
  const kf = { ...hit.clip.keyframes } as Clip["keyframes"];
  if (list.length) (kf as any)[prop] = list;
  else delete (kf as any)[prop];
  return updateClip(p, clipId, { keyframes: kf });
}

// ------------------------------------------------------------- tracks

export function addTrack(p: Project, kind: Track["kind"], name?: string): { project: Project; trackId: string } {
  const count = p.tracks.filter((t) => t.kind === kind).length + 1;
  const track: Track = {
    id: newId("trk"),
    kind,
    name: name ?? `${kind === "video" ? "Video" : kind === "audio" ? "Audio" : "Text"} ${count}`,
    hidden: false,
    muted: false,
    solo: false,
    locked: false,
    volumeDb: 0,
    clips: [],
  };
  // Audio tracks go at the end; visual tracks are inserted above the top-most visual track.
  const tracks = [...p.tracks];
  if (kind === "audio") tracks.push(track);
  else {
    let idx = -1;
    tracks.forEach((t, i) => t.kind !== "audio" && (idx = i));
    tracks.splice(idx + 1, 0, track);
  }
  return { project: touch({ ...p, tracks }), trackId: track.id };
}

export function removeTrack(p: Project, trackId: string): Project {
  const t = p.tracks.find((x) => x.id === trackId);
  if (!t) throw new TimelineError("track not found");
  if (t.clips.length) throw new TimelineError("track still has clips");
  return touch({ ...p, tracks: p.tracks.filter((x) => x.id !== trackId) });
}

export function updateTrack(p: Project, trackId: string, patch: Partial<Omit<Track, "id" | "clips" | "kind">>): Project {
  return touch(mapTrack(p, trackId, (t) => ({ ...t, ...patch })));
}

export function reorderTrack(p: Project, trackId: string, newIndex: number): Project {
  const idx = p.tracks.findIndex((t) => t.id === trackId);
  if (idx < 0) throw new TimelineError("track not found");
  const tracks = [...p.tracks];
  const [t] = tracks.splice(idx, 1);
  tracks.splice(Math.max(0, Math.min(newIndex, tracks.length)), 0, t!);
  return touch({ ...p, tracks });
}

// ------------------------------------------------------------- markers

export function addMarker(p: Project, frame: number, label = ""): Project {
  return touch({ ...p, markers: [...p.markers, { id: newId("mkr"), frame, label, color: "#f5b942" }].sort((a, b) => a.frame - b.frame) });
}

export function removeMarker(p: Project, markerId: string): Project {
  return touch({ ...p, markers: p.markers.filter((m) => m.id !== markerId) });
}

// ------------------------------------------------------------- snapping

/** Collect snap points: clip edges, playhead, markers, 0. */
export function snapPoints(p: Project, playhead: number, ignoreClipIds: string[] = []): number[] {
  const pts = new Set<number>([0, playhead]);
  for (const t of p.tracks)
    for (const c of t.clips) {
      if (ignoreClipIds.includes(c.id)) continue;
      pts.add(c.start);
      pts.add(clipEnd(c));
    }
  for (const m of p.markers) pts.add(m.frame);
  return [...pts].sort((a, b) => a - b);
}

/** Snap `frame` to the nearest point within `threshold` frames. */
export function snap(frame: number, points: number[], threshold: number): { frame: number; snappedTo: number | null } {
  let best: number | null = null;
  let bestDist = threshold + 1;
  for (const pt of points) {
    const d = Math.abs(pt - frame);
    if (d <= threshold && d < bestDist) {
      best = pt;
      bestDist = d;
    }
  }
  return best === null ? { frame, snappedTo: null } : { frame: best, snappedTo: best };
}
