/** Local AI / processing tools. Everything runs on this machine. */
import { spawn } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { runFfmpeg, getToolPaths, CancelledError } from "./ffmpeg.js";

export const FLITE_VOICES = [
  { id: "slt", label: "Sky (female)" },
  { id: "kal", label: "Kai (male)" },
  { id: "rms", label: "Ryan (male, deep)" },
  { id: "awb", label: "Alba (Scottish)" },
] as const;

/** Text-to-speech with FFmpeg's built-in libflite (offline). Writes a 48 kHz WAV. */
export async function textToSpeech(text: string, voice: string, outWav: string, signal?: AbortSignal): Promise<string> {
  const clean = text.replace(/\s+/g, " ").trim().slice(0, 3000);
  if (!clean) throw new Error("Type some text to speak.");
  if (!FLITE_VOICES.some((v) => v.id === voice)) throw new Error("Unknown voice");
  await mkdir(dirname(outWav), { recursive: true });
  const tf = join(tmpdir(), `motif-tts-${process.pid}-${Date.now()}.txt`);
  await writeFile(tf, clean, "utf8");
  try {
    await runFfmpeg(["-y", "-f", "lavfi", "-i", `flite=textfile=${tf.replace(/\\/g, "/").replace(/:/g, "\\:")}:voice=${voice}`, "-ar", "48000", "-ac", "1", outWav], { signal });
  } finally {
    await rm(tf, { force: true });
  }
  return outWav;
}

/** Extract a clip's audio as a WAV file (non-destructive: writes a new file). */
export async function extractAudio(src: string, outWav: string, signal?: AbortSignal): Promise<string> {
  await mkdir(dirname(outWav), { recursive: true });
  await runFfmpeg(["-y", "-i", src, "-vn", "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", outWav], { signal });
  return outWav;
}

/** Two-pass vid.stab stabilization into a new H.264 file. */
export async function stabilize(src: string, outMp4: string, durationSec: number, opts: { shakiness?: number; smoothing?: number; signal?: AbortSignal; onProgress?: (f: number) => void } = {}): Promise<string> {
  await mkdir(dirname(outMp4), { recursive: true });
  const trf = join(tmpdir(), `motif-stab-${process.pid}-${Date.now()}.trf`);
  const t = trf.replace(/\\/g, "/").replace(/:/g, "\\:");
  try {
    await runFfmpeg(["-y", "-i", src, "-vf", `vidstabdetect=shakiness=${opts.shakiness ?? 6}:accuracy=12:result=${t}`, "-f", "null", "-"], {
      signal: opts.signal,
      durationSec,
      onProgress: (f) => opts.onProgress?.(f * 0.5),
    });
    await runFfmpeg(
      ["-y", "-i", src, "-vf", `vidstabtransform=input=${t}:smoothing=${opts.smoothing ?? 20}:zoom=0:optzoom=1,unsharp=5:5:0.6:3:3:0.3`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "copy", outMp4],
      { signal: opts.signal, durationSec, onProgress: (f) => opts.onProgress?.(0.5 + f * 0.5) },
    );
  } finally {
    await rm(trf, { force: true });
  }
  return outMp4;
}

export interface TranscriptWord {
  start: number;
  end: number;
  word: string;
}
export interface Transcript {
  language: string;
  duration: number;
  segments: { start: number; end: number; text: string; words: TranscriptWord[] }[];
}

export function defaultTranscribeScript(): string {
  return fileURLToPath(new URL("../ai/transcribe.py", import.meta.url));
}

/** Run the faster-whisper worker. Model weights are downloaded once (Hugging Face) and cached. */
export function transcribe(
  src: string,
  opts: { model?: "tiny" | "base" | "small"; language?: string; python?: string; script?: string; signal?: AbortSignal; onProgress?: (f: number) => void } = {},
): Promise<Transcript> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new CancelledError());
    const args = [opts.script ?? defaultTranscribeScript(), src, "--model", opts.model ?? "base", "--ffmpeg", getToolPaths().ffmpeg];
    if (opts.language) args.push("--language", opts.language);
    const child = spawn(opts.python ?? (process.env.MOTIF_PYTHON || (process.platform === "win32" ? "python" : "python3")), args, { windowsHide: true });
    const out: Transcript = { language: "", duration: 0, segments: [] };
    let buf = "";
    let err = "";
    let failed: string | null = null;
    let cancelled = false;
    const onAbort = () => {
      cancelled = true;
      child.kill("SIGTERM");
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) {
        if (!l.trim()) continue;
        try {
          const m = JSON.parse(l);
          if (m.type === "info") {
            out.language = m.language;
            out.duration = m.duration;
          } else if (m.type === "segment") {
            out.segments.push({ start: m.start, end: m.end, text: m.text, words: m.words ?? [] });
            if (out.duration) opts.onProgress?.(Math.min(0.99, m.end / out.duration));
          } else if (m.type === "error") failed = m.message;
        } catch {
          /* ignore non-JSON lines */
        }
      }
    });
    child.stderr.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-4000)));
    child.on("error", (e) => reject(new Error(`could not start Python (${e.message}). Install Python 3 and faster-whisper, or set MOTIF_PYTHON.`)));
    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (cancelled) return reject(new CancelledError());
      if (failed) return reject(new Error(failed));
      if (code !== 0) return reject(new Error(`transcription failed: ${err.trim().split("\n").slice(-2).join(" ")}`));
      opts.onProgress?.(1);
      resolve(out);
    });
  });
}
