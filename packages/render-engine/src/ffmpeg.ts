/**
 * FFmpeg/FFprobe process helpers. Arguments are always passed as arrays to
 * execFile/spawn (never through a shell), so media paths and user text cannot
 * inject commands.
 */
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface ToolPaths {
  ffmpeg: string;
  ffprobe: string;
}

let tools: ToolPaths = {
  ffmpeg: process.env.MOTIF_FFMPEG || "ffmpeg",
  ffprobe: process.env.MOTIF_FFPROBE || "ffprobe",
};

export function setToolPaths(p: Partial<ToolPaths>) {
  tools = { ...tools, ...p };
}
export function getToolPaths(): ToolPaths {
  return tools;
}

export class FfmpegError extends Error {
  constructor(message: string, public readonly stderrTail: string, public readonly code: number | null) {
    super(message);
    this.name = "FfmpegError";
  }
}

export class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}

export async function runProbe(args: string[]): Promise<string> {
  const { stdout } = await execFileP(tools.ffprobe, args, { maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  return stdout;
}

export interface RunOptions {
  signal?: AbortSignal;
  /** total output duration in seconds, used to compute progress 0..1 */
  durationSec?: number;
  onProgress?: (fraction: number, info: { outTimeSec: number; speed?: string }) => void;
  /** capture stdout as a Buffer (for raw PCM/frames) */
  captureStdout?: boolean;
}

/** Run ffmpeg with structured args. Resolves with stdout buffer when requested. */
export function runFfmpeg(args: string[], opts: RunOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new CancelledError());
    const withProgress = !!opts.onProgress && !opts.captureStdout;
    const full = ["-hide_banner", "-nostdin", ...(withProgress ? ["-progress", "pipe:1", "-nostats"] : []), ...args];
    const child = spawn(tools.ffmpeg, full, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    const chunks: Buffer[] = [];
    let progressBuf = "";
    let killTimer: NodeJS.Timeout | undefined;
    let cancelled = false;

    const onAbort = () => {
      cancelled = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
    });
    child.stdout.on("data", (d: Buffer) => {
      if (opts.captureStdout) {
        chunks.push(d);
        return;
      }
      if (!withProgress) return;
      progressBuf += d.toString();
      const lines = progressBuf.split("\n");
      progressBuf = lines.pop() ?? "";
      let outUs: number | null = null;
      let speed: string | undefined;
      for (const l of lines) {
        const [k, v] = l.split("=");
        if (k === "out_time_us" || k === "out_time_ms") {
          const n = Number(v);
          if (Number.isFinite(n)) outUs = n;
        } else if (k === "speed") speed = v?.trim();
      }
      if (outUs !== null && opts.durationSec) {
        const sec = outUs / 1e6;
        opts.onProgress!(Math.max(0, Math.min(1, sec / opts.durationSec)), { outTimeSec: sec, speed });
      }
    });
    child.on("error", (err) => {
      opts.signal?.removeEventListener("abort", onAbort);
      reject(new FfmpegError(`could not start ffmpeg (${err.message})`, "", null));
    });
    child.on("close", (code) => {
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (cancelled) return reject(new CancelledError());
      if (code !== 0) {
        const tail = stderr.trim().split("\n").slice(-12).join("\n");
        return reject(new FfmpegError(`ffmpeg exited with code ${code}`, tail, code));
      }
      opts.onProgress?.(1, { outTimeSec: opts.durationSec ?? 0 });
      resolve(Buffer.concat(chunks));
    });
  });
}

/** Escape a value for use inside a single-quoted filtergraph option. */
export function filterQuote(v: string): string {
  // Inside '...' only the quote itself needs handling: close, escaped quote, reopen.
  // A second level of escaping is needed because the filtergraph parser unescapes once more.
  return "'" + v.replace(/\\/g, "\\\\\\\\").replace(/'/g, "'\\\\\\''").replace(/:/g, "\\\\:") + "'";
}

/** Escape a filesystem path for filter options like fontfile/textfile. */
export function filterPath(p: string): string {
  const norm = p.replace(/\\/g, "/");
  return "'" + norm.replace(/'/g, "'\\''").replace(/:/g, "\\:") + "'";
}

export async function detectEncoders(): Promise<Set<string>> {
  const out = await new Promise<string>((res) => {
    execFile(tools.ffmpeg, ["-hide_banner", "-encoders"], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => res(err ? "" : stdout));
  });
  const set = new Set<string>();
  for (const line of out.split("\n")) {
    const m = /^\s[VAS][.A-Z]{5}\s+(\S+)/.exec(line);
    if (m) set.add(m[1]!);
  }
  return set;
}

export async function ffmpegVersion(): Promise<string | null> {
  try {
    const { stdout } = await execFileP(tools.ffmpeg, ["-version"], { windowsHide: true });
    return stdout.split("\n")[0] ?? null;
  } catch {
    return null;
  }
}
