import { stat, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import type { MediaAsset, MediaMeta, Rational } from "@motif/project-schema";
import { newId } from "@motif/project-schema";
import { runProbe } from "./ffmpeg.js";

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"]);

export class ProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeError";
  }
}

function parseRate(s: string | undefined): Rational | undefined {
  if (!s) return undefined;
  const [n, d] = s.split("/").map(Number);
  if (!n || !d) return undefined;
  return { num: n, den: d };
}

export interface ProbeResult {
  kind: MediaAsset["kind"];
  meta: MediaMeta;
}

export async function probeMedia(path: string): Promise<ProbeResult> {
  let raw: string;
  try {
    raw = await runProbe(["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path]);
  } catch (e: any) {
    const msg = String(e?.stderr || e?.message || e).split("\n")[0];
    throw new ProbeError(`Could not read this file: ${msg}`);
  }
  const j = JSON.parse(raw) as { streams?: any[]; format?: any };
  const streams = j.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video" && !(s.disposition?.attached_pic === 1));
  const a = streams.find((s) => s.codec_type === "audio");
  if (!v && !a) throw new ProbeError("This file has no video or audio streams.");
  const ext = extname(path).toLowerCase();
  const formatName: string = j.format?.format_name ?? "";
  const isImage = !!v && !a && (IMAGE_EXT.has(ext) || /image2|png_pipe|jpeg_pipe|webp_pipe|bmp_pipe|tiff_pipe/.test(formatName)) && ext !== ".gif";
  const durationSec = Number(j.format?.duration ?? v?.duration ?? a?.duration ?? 0) || 0;
  let rotation: number | undefined;
  const sideRot = v?.side_data_list?.find((s: any) => typeof s.rotation === "number")?.rotation;
  if (typeof sideRot === "number") rotation = sideRot;
  else if (v?.tags?.rotate) rotation = Number(v.tags.rotate);
  let width = v ? Number(v.width) : undefined;
  let height = v ? Number(v.height) : undefined;
  if (rotation && Math.abs(rotation) % 180 === 90 && width && height) [width, height] = [height, width];
  const r = parseRate(v?.r_frame_rate);
  const avg = parseRate(v?.avg_frame_rate);
  const vfr = !!(r && avg && Math.abs(r.num / r.den - avg.num / avg.den) > 0.01);
  const meta: MediaMeta = {
    durationSec: isImage ? 0 : durationSec,
    hasVideo: !!v,
    hasAudio: !!a,
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...(avg && !isImage ? { fps: avg } : r && !isImage ? { fps: r } : {}),
    ...(v?.codec_name ? { videoCodec: v.codec_name } : {}),
    ...(a?.codec_name ? { audioCodec: a.codec_name } : {}),
    ...(a?.sample_rate ? { sampleRate: Number(a.sample_rate) } : {}),
    ...(a?.channels ? { channels: Number(a.channels) } : {}),
    ...(rotation !== undefined ? { rotation } : {}),
    ...(vfr ? { variableFrameRate: true } : {}),
    ...(formatName ? { container: formatName } : {}),
  };
  if (!isImage && durationSec <= 0) throw new ProbeError("Could not determine this file's duration.");
  return { kind: isImage ? "image" : v ? "video" : "audio", meta };
}

/** Cheap stable fingerprint: size + mtime + sha1 of first/last 64 KiB. */
export async function fingerprint(path: string): Promise<string> {
  const st = await stat(path);
  const fh = await open(path, "r");
  try {
    const n = 64 * 1024;
    const h = createHash("sha1");
    const head = Buffer.alloc(Math.min(n, st.size));
    await fh.read(head, 0, head.length, 0);
    h.update(head);
    if (st.size > n) {
      const tail = Buffer.alloc(Math.min(n, st.size - n));
      await fh.read(tail, 0, tail.length, st.size - tail.length);
      h.update(tail);
    }
    h.update(String(st.size));
    return h.digest("hex").slice(0, 24);
  } finally {
    await fh.close();
  }
}

export async function importMedia(path: string): Promise<MediaAsset> {
  const { kind, meta } = await probeMedia(path);
  return {
    id: newId("ast"),
    kind,
    name: basename(path),
    path,
    fingerprint: await fingerprint(path),
    meta,
    favorite: false,
    tags: [],
    bin: "",
    provenance: "imported",
  };
}
