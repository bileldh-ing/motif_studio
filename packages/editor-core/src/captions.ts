/** SRT import/export for caption clips. */
import type { Project } from "@motif/project-schema";
import { framesToSeconds, secondsToFrames } from "./time.js";
import { insertTextClip, TimelineError } from "./timeline.js";

export interface CaptionCue {
  startSec: number;
  endSec: number;
  text: string;
}

function srtTime(sec: number): string {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
}

export function parseSrt(src: string): CaptionCue[] {
  const cues: CaptionCue[] = [];
  const blocks = src.replace(/\r/g, "").replace(/^\uFEFF/, "").split(/\n{2,}/);
  const re = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;
  for (const b of blocks) {
    const lines = b.split("\n").filter((l) => l.trim() !== "");
    const idx = lines.findIndex((l) => re.test(l));
    if (idx < 0) continue;
    const m = re.exec(lines[idx]!)!;
    const n = m.slice(1).map(Number);
    const t = (h: number, mi: number, s: number, ms: number) => h * 3600 + mi * 60 + s + ms / 1000;
    const startSec = t(n[0]!, n[1]!, n[2]!, n[3]!);
    const endSec = t(n[4]!, n[5]!, n[6]!, n[7]!);
    const text = lines.slice(idx + 1).join("\n").trim();
    if (endSec > startSec && text) cues.push({ startSec, endSec, text });
  }
  return cues;
}

export function captionCues(p: Project): CaptionCue[] {
  const fps = p.profile.fps;
  const cues: CaptionCue[] = [];
  for (const t of p.tracks)
    for (const c of t.clips)
      if (c.kind === "text" && c.text?.role === "caption" && c.enabled)
        cues.push({ startSec: framesToSeconds(c.start, fps), endSec: framesToSeconds(c.start + c.duration, fps), text: c.text.content });
  return cues.sort((a, b) => a.startSec - b.startSec);
}

export function toSrt(cues: CaptionCue[]): string {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.startSec)} --> ${srtTime(c.endSec)}\n${c.text}\n`).join("\n");
}

/** Place cues as caption clips on a text track (creates no overlaps; overlapping cues are trimmed). */
export function importCaptions(p: Project, trackId: string, cues: CaptionCue[]): Project {
  const fps = p.profile.fps;
  let next = p;
  let lastEnd = 0;
  for (const cue of cues) {
    let start = secondsToFrames(cue.startSec, fps, "round");
    const end = secondsToFrames(cue.endSec, fps, "round");
    start = Math.max(start, lastEnd);
    if (end - start < 1) continue;
    try {
      next = insertTextClip(next, { trackId, start, duration: end - start, content: cue.text, role: "caption" }).project;
      lastEnd = end;
    } catch (e) {
      if (!(e instanceof TimelineError)) throw e;
    }
  }
  return next;
}
