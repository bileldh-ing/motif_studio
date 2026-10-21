import { statfs, rm, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import type { Project, RenderPreset } from "@motif/project-schema";
import { buildRenderJob, type BuildOptions } from "./graph.js";
import { runFfmpeg, CancelledError, FfmpegError } from "./ffmpeg.js";
import { probeMedia } from "./probe.js";

export interface RenderResult {
  outputPath: string;
  durationSec: number;
  elapsedMs: number;
  verification: VerificationResult;
}

export interface VerificationResult {
  ok: boolean;
  problems: string[];
  probed?: { durationSec: number; width?: number; height?: number; hasAudio: boolean; videoCodec?: string };
}

export interface RenderCallbacks {
  signal?: AbortSignal;
  onProgress?: (fraction: number, stage: "preparing" | "encoding" | "verifying") => void;
  onLog?: (line: string) => void;
}

export async function verifyOutput(
  path: string,
  expect: { durationSec: number; width: number; height: number; fpsApprox: number; kind?: RenderPreset["kind"]; audio?: boolean },
): Promise<VerificationResult> {
  const problems: string[] = [];
  const kind = expect.kind ?? "video";
  try {
    const { meta } = await probeMedia(path);
    const frameTol = kind === "gif" ? 0.25 : 2 / expect.fpsApprox + 0.06;
    if (kind !== "audio" && !meta.hasVideo) problems.push("output has no video stream");
    if ((kind === "audio" || (kind === "video" && expect.audio !== false)) && !meta.hasAudio) problems.push("output has no audio stream");
    if (kind !== "audio" && (meta.width !== expect.width || meta.height !== expect.height)) problems.push(`output is ${meta.width}x${meta.height}, expected ${expect.width}x${expect.height}`);
    if (kind !== "frame" && Math.abs(meta.durationSec - expect.durationSec) > frameTol) problems.push(`output lasts ${meta.durationSec.toFixed(3)} s, expected ${expect.durationSec.toFixed(3)} s`);
    return {
      ok: problems.length === 0,
      problems,
      probed: { durationSec: meta.durationSec, width: meta.width, height: meta.height, hasAudio: meta.hasAudio, videoCodec: meta.videoCodec },
    };
  } catch (e: any) {
    return { ok: false, problems: [`could not read output: ${e.message}`] };
  }
}

/** Render a project to a file: disk check, temp output, progress, cancellation, verification. */
export async function renderProject(project: Project, preset: RenderPreset, opts: BuildOptions, cb: RenderCallbacks = {}): Promise<RenderResult> {
  const t0 = Date.now();
  cb.onProgress?.(0, "preparing");
  const outDir = dirname(opts.outputPath);
  await mkdir(outDir, { recursive: true });
  if (opts.overwrite === false && existsSync(opts.outputPath)) throw new Error("A file with that name already exists.");
  try {
    const st = await statfs(outDir);
    const free = Number(st.bavail) * Number(st.bsize);
    if (free < 200 * 1024 * 1024) throw new Error(`Not enough free disk space in ${outDir} (need at least 200 MB).`);
  } catch (e: any) {
    if (e?.message?.startsWith("Not enough")) throw e;
  }
  // Render to a temp name, then atomically move into place so a cancelled
  // or failed render never leaves a half-written file under the final name.
  const tmpOut = join(outDir, `.${basename(opts.outputPath)}.part${opts.outputPath.slice(opts.outputPath.lastIndexOf("."))}`);
  const job = await buildRenderJob(project, preset, { ...opts, outputPath: tmpOut, overwrite: true });
  cb.onLog?.(`ffmpeg ${job.args.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ").slice(0, 2000)}`);
  try {
    await runFfmpeg(job.args, {
      signal: cb.signal,
      durationSec: job.durationSec,
      onProgress: (f) => cb.onProgress?.(f * 0.97, "encoding"),
    });
    cb.onProgress?.(0.98, "verifying");
    const verification = await verifyOutput(tmpOut, {
      durationSec: job.durationSec,
      width: preset.width,
      height: preset.height,
      fpsApprox: preset.fps.num / preset.fps.den,
      kind: preset.kind,
      audio: preset.audioCodec !== "none",
    });
    await rename(tmpOut, opts.outputPath);
    cb.onProgress?.(1, "verifying");
    return { outputPath: opts.outputPath, durationSec: job.durationSec, elapsedMs: Date.now() - t0, verification };
  } catch (e) {
    await rm(tmpOut, { force: true });
    if (e instanceof CancelledError) throw e;
    if (e instanceof FfmpegError) cb.onLog?.(e.stderrTail);
    throw e;
  } finally {
    await job.cleanup();
  }
}
