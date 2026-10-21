/**
 * Composition evaluation shared by the interactive preview and the exporter.
 * Given a project and a timeline frame, it answers "what is visible/audible
 * and with which resolved parameters". The FFmpeg graph builder uses the same
 * keyframe functions so preview and export agree.
 */
import type { Clip, Easing, Keyframe, Project, Track, AnimatableProperty } from "@motif/project-schema";
import { clipEnd } from "./timeline.js";
import { framesToSeconds, sourceSecondsAt } from "./time.js";

export function ease(t: number, e: Easing): number {
  switch (e) {
    case "easeIn":
      return t * t;
    case "easeOut":
      return 1 - (1 - t) * (1 - t);
    case "easeInOut":
      return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    case "hold":
      return 0;
    default:
      return t;
  }
}

/** Value of a keyframed property at a clip-local frame; the easing of the left key shapes the segment. */
export function interpolate(kfs: Keyframe[] | undefined, localFrame: number, fallback: number): number {
  if (!kfs || kfs.length === 0) return fallback;
  if (localFrame <= kfs[0]!.frame) return kfs[0]!.value;
  const last = kfs[kfs.length - 1]!;
  if (localFrame >= last.frame) return last.value;
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i]!;
    const b = kfs[i + 1]!;
    if (localFrame >= a.frame && localFrame < b.frame) {
      const t = (localFrame - a.frame) / (b.frame - a.frame);
      return a.value + (b.value - a.value) * ease(t, a.easing);
    }
  }
  return last.value;
}

const BASE: Record<AnimatableProperty, (c: Clip) => number> = {
  x: (c) => c.transform.x,
  y: (c) => c.transform.y,
  scale: (c) => c.transform.scale,
  opacity: (c) => c.transform.opacity,
  rotation: (c) => c.transform.rotation,
  volume: (c) => c.audio.gainDb,
};

export function propertyAt(c: Clip, prop: AnimatableProperty, localFrame: number): number {
  return interpolate(c.keyframes[prop], localFrame, BASE[prop](c));
}

export interface VisualLayer {
  clip: Clip;
  track: Track;
  /** compositing order, 0 = bottom */
  z: number;
  localFrame: number;
  sourceSeconds: number;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  /** final opacity including transition alpha */
  opacity: number;
}

export function isTrackAudible(p: Project, t: Track): boolean {
  if (t.muted) return false;
  const anySolo = p.tracks.some((x) => x.solo);
  return anySolo ? t.solo : true;
}

/**
 * Visual layers at a frame, bottom to top. A clip with a crossfade transition
 * keeps the previous clip on its track visible (playing into its handle)
 * during the transition window while the incoming clip fades in on top.
 */
export function visualLayersAt(p: Project, frame: number): VisualLayer[] {
  const out: VisualLayer[] = [];
  const fps = p.profile.fps;
  p.tracks.forEach((track, ti) => {
    if (track.kind === "audio" || track.hidden) return;
    const sorted = [...track.clips].sort((a, b) => a.start - b.start);
    for (let i = 0; i < sorted.length; i++) {
      const c = sorted[i]!;
      if (!c.enabled) continue;
      const next = sorted[i + 1];
      const tailFrames = next && next.transitionIn && next.start === clipEnd(c) ? next.transitionIn.frames : 0;
      const end = clipEnd(c) + tailFrames;
      if (frame < c.start || frame >= end) continue;
      const local = frame - c.start;
      const kfLocal = Math.min(local, c.duration - 1);
      let alpha = 1;
      if (c.transitionIn && local < c.transitionIn.frames) alpha = (local + 1) / (c.transitionIn.frames + 1);
      out.push({
        clip: c,
        track,
        z: ti * 2 + (frame >= clipEnd(c) ? 0 : 1),
        localFrame: local,
        sourceSeconds: c.kind === "media" ? sourceSecondsAt(c, frame, fps) : framesToSeconds(local, fps),
        x: propertyAt(c, "x", kfLocal),
        y: propertyAt(c, "y", kfLocal),
        scale: propertyAt(c, "scale", kfLocal),
        rotation: propertyAt(c, "rotation", kfLocal),
        opacity: Math.max(0, Math.min(1, propertyAt(c, "opacity", kfLocal))) * alpha,
      });
    }
  });
  return out.sort((a, b) => a.z - b.z);
}

export interface AudioSource {
  clip: Clip;
  track: Track;
}

/** Clips that contribute audio (audio tracks + video clips whose asset has audio). */
export function audioSources(p: Project): AudioSource[] {
  const out: AudioSource[] = [];
  for (const track of p.tracks) {
    if (track.kind === "text" || !isTrackAudible(p, track)) continue;
    for (const clip of track.clips) {
      if (!clip.enabled || clip.audio.muted || clip.kind !== "media") continue;
      const asset = p.assets.find((a) => a.id === clip.assetId);
      if (!asset?.meta.hasAudio) continue;
      out.push({ clip, track });
    }
  }
  return out;
}

/** Fit `src` (w,h) inside canvas (contain) then apply scale. */
export function fittedSize(srcW: number, srcH: number, canvasW: number, canvasH: number, scale: number): { w: number; h: number } {
  const k = Math.min(canvasW / srcW, canvasH / srcH) * scale;
  return { w: Math.max(2, Math.round((srcW * k) / 2) * 2), h: Math.max(2, Math.round((srcH * k) / 2) * 2) };
}
