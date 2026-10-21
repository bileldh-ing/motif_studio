/**
 * Clip motion model: transitions (in) and in/out animations, expressed as a
 * small spec that is evaluated in JS for the preview and compiled to FFmpeg
 * expressions for export. Both sides use the same formulas:
 *   in-ramp  u = clamp(local / N, 0, 1)
 *   out-ramp u = clamp((dur - local) / N, 0, 1)
 *   position/scale use easeOut e(u) = 1 - (1-u)^2, alpha is linear (FFmpeg fade).
 */
import type { Clip } from "@motif/project-schema";

export interface Ramp {
  dir: "in" | "out";
  /** first local frame of the ramp window (in: 0, out: dur - N) */
  N: number;
}
export interface OffsetTerm extends Ramp {
  axis: "x" | "y";
  /** offset (canvas px) when the ramp is at 0; eases to 0 */
  amp: number;
}
export interface ScaleTerm extends Ramp {
  /** scale multiplier when the ramp is at 0; eases to 1 */
  from: number;
}
export interface MotionSpec {
  dur: number;
  alpha: Ramp[];
  offsets: OffsetTerm[];
  scales: ScaleTerm[];
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const easeOut = (u: number) => 1 - (1 - u) * (1 - u);

export function rampU(r: Ramp, local: number, dur: number): number {
  return r.dir === "in" ? clamp01(local / r.N) : clamp01((dur - local) / r.N);
}

export function motionSpec(c: Clip, W: number, H: number): MotionSpec {
  const dur = c.duration;
  const spec: MotionSpec = { dur, alpha: [], offsets: [], scales: [] };
  const t = c.transitionIn;
  if (t) {
    const N = Math.min(t.frames, dur);
    if (t.kind === "crossfade") spec.alpha.push({ dir: "in", N });
    else if (t.kind === "slide-left") spec.offsets.push({ dir: "in", N, axis: "x", amp: W });
    else if (t.kind === "slide-right") spec.offsets.push({ dir: "in", N, axis: "x", amp: -W });
    else if (t.kind === "slide-up") spec.offsets.push({ dir: "in", N, axis: "y", amp: H });
    else if (t.kind === "slide-down") spec.offsets.push({ dir: "in", N, axis: "y", amp: -H });
    else if (t.kind === "zoom-in") {
      spec.scales.push({ dir: "in", N, from: 0.6 });
      spec.alpha.push({ dir: "in", N });
    } else if (t.kind === "zoom-out") {
      spec.scales.push({ dir: "in", N, from: 1.4 });
      spec.alpha.push({ dir: "in", N });
    }
  }
  const add = (dir: "in" | "out", a: Clip["animIn"]) => {
    if (!a || a.kind === "none") return;
    const N = Math.max(1, Math.min(a.frames, dur));
    spec.alpha.push({ dir, N });
    const dx = W * 0.2;
    const dy = H * 0.2;
    switch (a.kind) {
      case "zoom-in":
        spec.scales.push({ dir, N, from: dir === "in" ? 0.5 : 1.5 });
        break;
      case "zoom-out":
        spec.scales.push({ dir, N, from: dir === "in" ? 1.5 : 0.5 });
        break;
      case "slide-up":
        spec.offsets.push({ dir, N, axis: "y", amp: dir === "in" ? dy : -dy });
        break;
      case "slide-down":
        spec.offsets.push({ dir, N, axis: "y", amp: dir === "in" ? -dy : dy });
        break;
      case "slide-left":
        spec.offsets.push({ dir, N, axis: "x", amp: dir === "in" ? dx : -dx });
        break;
      case "slide-right":
        spec.offsets.push({ dir, N, axis: "x", amp: dir === "in" ? -dx : dx });
        break;
    }
  };
  add("in", c.animIn);
  add("out", c.animOut);
  return spec;
}

export function evalMotion(spec: MotionSpec, local: number): { dx: number; dy: number; scaleMul: number; alpha: number } {
  let dx = 0;
  let dy = 0;
  let scaleMul = 1;
  let alpha = 1;
  for (const r of spec.alpha) alpha *= rampU(r, local, spec.dur);
  for (const o of spec.offsets) {
    const v = o.amp * (1 - easeOut(rampU(o, local, spec.dur)));
    if (o.axis === "x") dx += v;
    else dy += v;
  }
  for (const s of spec.scales) scaleMul *= s.from + (1 - s.from) * easeOut(rampU(s, local, spec.dur));
  return { dx, dy, scaleMul, alpha };
}

const n = (v: number) => (Math.round(v * 1e6) / 1e6).toString();

function uExpr(r: Ramp, L: string, dur: number): string {
  return r.dir === "in" ? `clip((${L})/${r.N},0,1)` : `clip((${dur}-(${L}))/${r.N},0,1)`;
}

/** FFmpeg expressions for offsets and scale; `L` is an expression for the clip-local frame number. */
export function motionExprs(spec: MotionSpec, L: string): { dx: string; dy: string; scale: string; animated: boolean } {
  const parts = { x: [] as string[], y: [] as string[] };
  for (const o of spec.offsets) {
    const u = uExpr(o, L, spec.dur);
    parts[o.axis].push(`${n(o.amp)}*pow(1-(${u}),2)`);
  }
  const sc = spec.scales.map((s) => {
    const u = uExpr(s, L, spec.dur);
    return `(${n(s.from)}+${n(1 - s.from)}*(1-pow(1-(${u}),2)))`;
  });
  return {
    dx: parts.x.length ? parts.x.join("+") : "0",
    dy: parts.y.length ? parts.y.join("+") : "0",
    scale: sc.length ? sc.join("*") : "1",
    animated: spec.offsets.length + spec.scales.length > 0,
  };
}
