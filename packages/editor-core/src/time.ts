import type { Rational } from "@motif/project-schema";

/** Greatest common divisor for non-negative integers. */
export function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

export function reduce(r: Rational): Rational {
  const g = gcd(r.num, r.den);
  return { num: r.num / g, den: r.den / g };
}

export function rationalToNumber(r: Rational): number {
  return r.num / r.den;
}

export function mulRational(a: Rational, b: Rational): Rational {
  return reduce({ num: a.num * b.num, den: a.den * b.den });
}

/** Exact seconds of a frame index as a rational: frames * den / num. */
export function framesToSecondsRational(frames: number, fps: Rational): Rational {
  if (frames === 0) return { num: 0, den: 1 } as unknown as Rational;
  return reduce({ num: frames * fps.den, den: fps.num });
}

/** Seconds as a float, only for display, FFmpeg arguments and media elements. */
export function framesToSeconds(frames: number, fps: Rational): number {
  return (frames * fps.den) / fps.num;
}

/**
 * Convert seconds to the frame containing that instant.
 * A tiny epsilon absorbs float noise so 1.001 s at 29.97 maps to frame 30, not 29.
 */
export function secondsToFrames(sec: number, fps: Rational, mode: "floor" | "round" | "ceil" = "floor"): number {
  const raw = (sec * fps.num) / fps.den;
  const eps = 1e-6;
  if (mode === "round") return Math.round(raw);
  if (mode === "ceil") return Math.ceil(raw - eps);
  return Math.floor(raw + eps);
}

/** Non-drop-frame timecode HH:MM:SS:FF using the nominal (rounded) frame rate. */
export function formatTimecode(frames: number, fps: Rational): string {
  const nominal = Math.round(fps.num / fps.den);
  const ff = frames % nominal;
  const totalSec = Math.floor(frames / nominal);
  const ss = totalSec % 60;
  const mm = Math.floor(totalSec / 60) % 60;
  const hh = Math.floor(totalSec / 3600);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`;
}

/** Wall-clock style label (mm:ss.t) computed from exact time. */
export function formatClock(frames: number, fps: Rational): string {
  const s = framesToSeconds(frames, fps);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(1).padStart(4, "0")}`;
}

export function parseTimecode(tc: string, fps: Rational): number | null {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})[:;](\d{2})$/.exec(tc.trim());
  if (!m) return null;
  const nominal = Math.round(fps.num / fps.den);
  const [hh, mm, ss, ff] = m.slice(1).map(Number) as [number, number, number, number];
  if (mm > 59 || ss > 59 || ff >= nominal) return null;
  return ((hh * 60 + mm) * 60 + ss) * nominal + ff;
}

/**
 * Source time (seconds, float for FFmpeg/media) for a timeline frame inside a clip.
 * sourceSeconds = (sourceIn + (frame - start) * speed) / fps
 */
export function sourceSecondsAt(clip: { start: number; sourceIn: number; speed: Rational }, frame: number, fps: Rational): number {
  const local = frame - clip.start;
  return ((clip.sourceIn + (local * clip.speed.num) / clip.speed.den) * fps.den) / fps.num;
}

/** Number of source frames (project-rate) consumed by a clip of `duration` timeline frames. */
export function sourceFramesConsumed(duration: number, speed: Rational): number {
  return Math.ceil((duration * speed.num) / speed.den - 1e-9);
}
