/** Thumbnails, waveform peaks, proxies and single-frame extraction. */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { runFfmpeg } from "./ffmpeg.js";

export async function makeThumbnail(src: string, atSec: number, outPng: string, width = 320, signal?: AbortSignal): Promise<string> {
  await mkdir(dirname(outPng), { recursive: true });
  await runFfmpeg(["-y", "-ss", String(Math.max(0, atSec)), "-i", src, "-frames:v", "1", "-vf", `scale=${width}:-2`, outPng], { signal });
  return outPng;
}

/** Filmstrip: `count` thumbnails tiled horizontally into one image. */
export async function makeFilmstrip(src: string, durationSec: number, outJpg: string, count = 10, height = 64, signal?: AbortSignal): Promise<string> {
  await mkdir(dirname(outJpg), { recursive: true });
  const step = Math.max(0.04, durationSec / count);
  await runFfmpeg(["-y", "-i", src, "-vf", `fps=1/${step.toFixed(4)},scale=-2:${height},tile=${count}x1`, "-frames:v", "1", "-q:v", "5", outJpg], { signal });
  return outJpg;
}

/**
 * Waveform peaks: decode to mono 8 kHz float, take max |sample| per bucket.
 * Streams through ffmpeg; never loads the source file itself into memory.
 */
export async function computePeaks(src: string, peaksPerSecond = 50, signal?: AbortSignal): Promise<number[]> {
  const rate = 8000;
  const pcm = await runFfmpeg(["-i", src, "-vn", "-ac", "1", "-ar", String(rate), "-f", "f32le", "pipe:1"], { signal, captureStdout: true });
  const samples = new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 4));
  const bucket = Math.max(1, Math.floor(rate / peaksPerSecond));
  const peaks: number[] = [];
  for (let i = 0; i < samples.length; i += bucket) {
    let m = 0;
    const end = Math.min(samples.length, i + bucket);
    for (let j = i; j < end; j++) {
      const v = Math.abs(samples[j]!);
      if (v > m) m = v;
    }
    peaks.push(Math.round(Math.min(1, m) * 1000) / 1000);
  }
  return peaks;
}

export async function cachePeaks(src: string, outJson: string, signal?: AbortSignal): Promise<number[]> {
  try {
    return JSON.parse(await readFile(outJson, "utf8")) as number[];
  } catch {
    const peaks = await computePeaks(src, 50, signal);
    await mkdir(dirname(outJson), { recursive: true });
    await writeFile(outJson, JSON.stringify(peaks));
    return peaks;
  }
}

/** Low-res editing proxy (H.264 540p, all-intra-ish GOP for fast seeking). */
export async function makeProxy(
  src: string,
  outMp4: string,
  durationSec: number,
  onProgress?: (f: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  await mkdir(dirname(outMp4), { recursive: true });
  await runFfmpeg(
    ["-y", "-i", src, "-vf", "scale=-2:540", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-g", "12", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", outMp4],
    { signal, durationSec, onProgress: onProgress ? (f) => onProgress(f) : undefined },
  );
  return outMp4;
}

/** Decode one frame of a file to raw RGB24 (used by render regression tests). */
export async function grabFrameRGB(src: string, atSec: number, w: number, h: number): Promise<Buffer> {
  return runFfmpeg(["-ss", atSec.toFixed(4), "-i", src, "-frames:v", "1", "-vf", `scale=${w}:${h}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { captureStdout: true });
}

/**
 * Silence detection (local, no ML): FFmpeg's silencedetect filter.
 * Returns ranges in source seconds; used for "remove silences" suggestions.
 */
export async function detectSilences(src: string, thresholdDb = -35, minSec = 0.5): Promise<{ startSec: number; endSec: number }[]> {
  const { spawn } = await import("node:child_process");
  const { getToolPaths } = await import("./ffmpeg.js");
  return new Promise((resolve, reject) => {
    const child = spawn(getToolPaths().ffmpeg, ["-hide_banner", "-nostdin", "-i", src, "-vn", "-af", `silencedetect=noise=${thresholdDb}dB:d=${minSec}`, "-f", "null", "-"], { windowsHide: true });
    let err = "";
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error("silence detection failed"));
      const ranges: { startSec: number; endSec: number }[] = [];
      let start: number | null = null;
      for (const line of err.split("\n")) {
        const s = /silence_start: (-?[\d.]+)/.exec(line);
        const e = /silence_end: ([\d.]+)/.exec(line);
        if (s) start = Math.max(0, Number(s[1]));
        if (e && start !== null) {
          ranges.push({ startSec: start, endSec: Number(e[1]) });
          start = null;
        }
      }
      resolve(ranges);
    });
  });
}
