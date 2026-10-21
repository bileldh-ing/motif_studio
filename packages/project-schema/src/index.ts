/**
 * MOTIF Studio canonical project schema.
 *
 * Time model (see docs/PROJECT_FORMAT.md):
 *  - Every timeline position/duration is an INTEGER number of frames at the
 *    project frame rate, which is itself a rational (e.g. 30000/1001).
 *  - Source positions (`sourceIn`) are also integer frames at the project rate,
 *    measured from the start of the source media. Speed is a rational, so the
 *    mapping timeline-frame -> source-time is exact and deterministic.
 *  - No editing position is ever stored as floating-point seconds.
 */
import { z } from "zod";

export const SCHEMA_VERSION = 1 as const;

const int = () => z.number().int();
const nonNegInt = () => z.number().int().min(0);
const posInt = () => z.number().int().min(1);

export const RationalSchema = z.object({ num: posInt(), den: posInt() }).strict();
export type Rational = z.infer<typeof RationalSchema>;

export const ProfileSchema = z
  .object({
    width: z.number().int().min(16).max(8192),
    height: z.number().int().min(16).max(8192),
    fps: RationalSchema,
    sampleRate: z.union([z.literal(44100), z.literal(48000)]),
    background: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  })
  .strict();
export type Profile = z.infer<typeof ProfileSchema>;

export const MediaMetaSchema = z
  .object({
    durationSec: z.number().min(0), // as reported by ffprobe (informational)
    hasVideo: z.boolean(),
    hasAudio: z.boolean(),
    width: z.number().int().optional(),
    height: z.number().int().optional(),
    fps: RationalSchema.optional(),
    videoCodec: z.string().optional(),
    audioCodec: z.string().optional(),
    sampleRate: z.number().int().optional(),
    channels: z.number().int().optional(),
    rotation: z.number().optional(),
    variableFrameRate: z.boolean().optional(),
    container: z.string().optional(),
  })
  .strict();
export type MediaMeta = z.infer<typeof MediaMetaSchema>;

export const MediaAssetSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["video", "audio", "image"]),
    name: z.string(),
    path: z.string().min(1),
    fingerprint: z.string().optional(), // size+mtime+partial hash
    meta: MediaMetaSchema,
    proxyPath: z.string().optional(),
    thumbnailPath: z.string().optional(),
    waveformPath: z.string().optional(),
    favorite: z.boolean().default(false),
    tags: z.array(z.string()).default([]),
    bin: z.string().default(""),
    provenance: z.enum(["imported", "generated", "sample"]).default("imported"),
  })
  .strict();
export type MediaAsset = z.infer<typeof MediaAssetSchema>;

export const EasingSchema = z.enum(["linear", "easeIn", "easeOut", "easeInOut", "hold"]);
export type Easing = z.infer<typeof EasingSchema>;

export const KeyframeSchema = z
  .object({ frame: nonNegInt(), value: z.number(), easing: EasingSchema.default("linear") })
  .strict();
export type Keyframe = z.infer<typeof KeyframeSchema>;

export const ANIMATABLE = ["x", "y", "scale", "opacity", "rotation", "volume"] as const;
export type AnimatableProperty = (typeof ANIMATABLE)[number];

export const TransformSchema = z
  .object({
    /** Offset of the clip centre from the canvas centre, in canvas pixels. */
    x: z.number().default(0),
    y: z.number().default(0),
    /** 1 = fit inside canvas (contain). */
    scale: z.number().min(0.01).max(20).default(1),
    rotation: z.number().default(0),
    opacity: z.number().min(0).max(1).default(1),
  })
  .strict();
export type Transform = z.infer<typeof TransformSchema>;

export const AudioSettingsSchema = z
  .object({
    gainDb: z.number().min(-60).max(24).default(0),
    pan: z.number().min(-1).max(1).default(0),
    fadeInFrames: nonNegInt().default(0),
    fadeOutFrames: nonNegInt().default(0),
    muted: z.boolean().default(false),
  })
  .strict();
export type AudioSettings = z.infer<typeof AudioSettingsSchema>;

export const TextStyleSchema = z
  .object({
    content: z.string().max(2000),
    fontSize: z.number().int().min(8).max(400).default(72),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#ffffff"),
    boxColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    boxOpacity: z.number().min(0).max(1).default(0.5),
    align: z.enum(["center", "lower-third", "top"]).default("center"),
    role: z.enum(["title", "caption"]).default("title"),
  })
  .strict();
export type TextStyle = z.infer<typeof TextStyleSchema>;

export const ColorAdjustSchema = z
  .object({
    brightness: z.number().min(-1).max(1).default(0),
    contrast: z.number().min(0).max(3).default(1),
    saturation: z.number().min(0).max(3).default(1),
  })
  .strict();
export type ColorAdjust = z.infer<typeof ColorAdjustSchema>;

export const TransitionSchema = z
  .object({ kind: z.literal("crossfade"), frames: posInt() })
  .strict();
export type Transition = z.infer<typeof TransitionSchema>;

export const ClipSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["media", "text", "color"]),
    assetId: z.string().optional(),
    name: z.string().default(""),
    /** Timeline placement, integer frames at the project rate. */
    start: nonNegInt(),
    duration: posInt(),
    /** Source offset, integer frames at the project rate. */
    sourceIn: nonNegInt().default(0),
    /** Playback speed as a rational; 1/1 = normal. Reverse not yet supported. */
    speed: RationalSchema.default({ num: 1, den: 1 }),
    enabled: z.boolean().default(true),
    transform: TransformSchema.default({}),
    keyframes: z.record(z.enum(ANIMATABLE), z.array(KeyframeSchema)).default({}),
    audio: AudioSettingsSchema.default({}),
    color: ColorAdjustSchema.default({}),
    text: TextStyleSchema.optional(),
    fillColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    /** Crossfade from the previous adjacent clip on the same track. */
    transitionIn: TransitionSchema.optional(),
    linkGroup: z.string().optional(),
  })
  .strict();
export type Clip = z.infer<typeof ClipSchema>;

export const TrackSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["video", "audio", "text"]),
    name: z.string(),
    hidden: z.boolean().default(false),
    muted: z.boolean().default(false),
    solo: z.boolean().default(false),
    locked: z.boolean().default(false),
    volumeDb: z.number().min(-60).max(12).default(0),
    clips: z.array(ClipSchema),
  })
  .strict();
export type Track = z.infer<typeof TrackSchema>;

export const MarkerSchema = z
  .object({ id: z.string(), frame: nonNegInt(), label: z.string().default(""), color: z.string().default("#f5b942") })
  .strict();
export type Marker = z.infer<typeof MarkerSchema>;

export const RenderPresetSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    container: z.enum(["mp4", "mov", "webm"]),
    videoCodec: z.enum(["libx264", "libvpx-vp9", "prores_ks"]),
    audioCodec: z.enum(["aac", "libopus", "pcm_s16le"]),
    width: z.number().int().min(16),
    height: z.number().int().min(16),
    fps: RationalSchema,
    crf: z.number().int().min(0).max(51).default(20),
    audioBitrateK: z.number().int().min(32).max(512).default(192),
    preset: z.enum(["ultrafast", "veryfast", "fast", "medium", "slow"]).default("medium"),
  })
  .strict();
export type RenderPreset = z.infer<typeof RenderPresetSchema>;

export const ProjectSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    id: z.string().min(1),
    title: z.string().min(1).max(200),
    profile: ProfileSchema,
    assets: z.array(MediaAssetSchema),
    /** Index 0 is the bottom-most layer for compositing. */
    tracks: z.array(TrackSchema),
    markers: z.array(MarkerSchema).default([]),
    inPoint: nonNegInt().optional(),
    outPoint: nonNegInt().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
    /** UI state, kept out of the exported composition. */
    ui: z
      .object({ zoom: z.number().default(1), scrollX: z.number().default(0), playhead: nonNegInt().default(0) })
      .strict()
      .default({}),
  })
  .strict();
export type Project = z.infer<typeof ProjectSchema>;

// ---------------------------------------------------------------- helpers

export class ProjectValidationError extends Error {
  constructor(public readonly issues: z.ZodIssue[]) {
    super("Invalid project: " + issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    this.name = "ProjectValidationError";
  }
}

/** Semantic validation beyond the structural schema. Returns problems (empty = valid). */
export function semanticProblems(p: Project): string[] {
  const problems: string[] = [];
  const assetIds = new Set(p.assets.map((a) => a.id));
  const clipIds = new Set<string>();
  const trackIds = new Set<string>();
  for (const t of p.tracks) {
    if (trackIds.has(t.id)) problems.push(`duplicate track id ${t.id}`);
    trackIds.add(t.id);
    const sorted = [...t.clips].sort((a, b) => a.start - b.start);
    for (let i = 0; i < sorted.length; i++) {
      const c = sorted[i]!;
      if (clipIds.has(c.id)) problems.push(`duplicate clip id ${c.id}`);
      clipIds.add(c.id);
      if (c.kind === "media" && (!c.assetId || !assetIds.has(c.assetId)))
        problems.push(`clip ${c.id} references missing asset ${c.assetId ?? "(none)"}`);
      if (c.kind === "text" && !c.text) problems.push(`text clip ${c.id} has no text`);
      const next = sorted[i + 1];
      if (next && c.start + c.duration > next.start)
        problems.push(`clips ${c.id} and ${next.id} overlap on track ${t.id}`);
      if (c.transitionIn && c.transitionIn.frames > c.duration)
        problems.push(`clip ${c.id} transition longer than clip`);
    }
  }
  return problems;
}

export function parseProject(input: unknown): Project {
  const migrated = migrate(input);
  const res = ProjectSchema.safeParse(migrated);
  if (!res.success) throw new ProjectValidationError(res.error.issues);
  const problems = semanticProblems(res.data);
  if (problems.length)
    throw new ProjectValidationError(problems.map((m) => ({ code: "custom", path: [], message: m }) as z.ZodIssue));
  return res.data;
}

/** Schema migrations. Each step upgrades version N -> N+1. */
export const MIGRATIONS: Record<number, (doc: any) => any> = {
  // 0 -> 1: pre-release documents stored fps as a number and had no `ui` block.
  0: (doc) => {
    const out = { ...doc, schemaVersion: 1 };
    if (typeof out.profile?.fps === "number") {
      const f = out.profile.fps as number;
      const known: Record<string, [number, number]> = { "23.976": [24000, 1001], "29.97": [30000, 1001], "59.94": [60000, 1001] };
      const k = known[f.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")] ?? known[f.toFixed(2)];
      out.profile = { ...out.profile, fps: k ? { num: k[0], den: k[1] } : { num: Math.round(f), den: 1 } };
    }
    return out;
  },
};

export function migrate(input: unknown): unknown {
  if (!input || typeof input !== "object") throw new ProjectValidationError([{ code: "custom", path: [], message: "not an object" } as z.ZodIssue]);
  let doc: any = input;
  let v: number = typeof doc.schemaVersion === "number" ? doc.schemaVersion : 0;
  if (v > SCHEMA_VERSION)
    throw new ProjectValidationError([{ code: "custom", path: ["schemaVersion"], message: `project was made by a newer MOTIF (schema ${v})` } as z.ZodIssue]);
  while (v < SCHEMA_VERSION) {
    const step = MIGRATIONS[v];
    if (!step) throw new Error(`no migration from schema ${v}`);
    doc = step(doc);
    v++;
  }
  return doc;
}

/** Deterministic serialization: sorted keys, 2-space indent, trailing newline. */
export function serializeProject(p: Project): string {
  const validated = ProjectSchema.parse(p);
  return JSON.stringify(sortKeys(validated), null, 2) + "\n";
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val !== undefined) o[k] = sortKeys(val);
    }
    return o;
  }
  return v;
}

export const DEFAULT_PRESETS: RenderPreset[] = [
  { id: "mp4-1080p", name: "MP4 · 1080p H.264", container: "mp4", videoCodec: "libx264", audioCodec: "aac", width: 1920, height: 1080, fps: { num: 30, den: 1 }, crf: 20, audioBitrateK: 192, preset: "medium" },
  { id: "mp4-vertical", name: "MP4 · 1080×1920 vertical", container: "mp4", videoCodec: "libx264", audioCodec: "aac", width: 1080, height: 1920, fps: { num: 30, den: 1 }, crf: 20, audioBitrateK: 192, preset: "medium" },
  { id: "mp4-720p-draft", name: "MP4 · 720p draft", container: "mp4", videoCodec: "libx264", audioCodec: "aac", width: 1280, height: 720, fps: { num: 30, den: 1 }, crf: 26, audioBitrateK: 128, preset: "veryfast" },
  { id: "webm-1080p", name: "WebM · 1080p VP9", container: "webm", videoCodec: "libvpx-vp9", audioCodec: "libopus", width: 1920, height: 1080, fps: { num: 30, den: 1 }, crf: 32, audioBitrateK: 160, preset: "medium" },
];

export const ASPECT_PROFILES = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
  "21:9": { width: 2560, height: 1080 },
} as const;
export type AspectKey = keyof typeof ASPECT_PROFILES;

export const FRAME_RATES: Record<string, Rational> = {
  "23.976": { num: 24000, den: 1001 },
  "24": { num: 24, den: 1 },
  "25": { num: 25, den: 1 },
  "29.97": { num: 30000, den: 1001 },
  "30": { num: 30, den: 1 },
  "50": { num: 50, den: 1 },
  "59.94": { num: 60000, den: 1001 },
  "60": { num: 60, den: 1 },
};

let idCounter = 0;
export function newId(prefix: string): string {
  idCounter = (idCounter + 1) % 1_000_000;
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${rnd}`;
}

export function createProject(opts: { title: string; aspect?: AspectKey; fps?: Rational; id?: string; now?: string }): Project {
  const size = ASPECT_PROFILES[opts.aspect ?? "16:9"];
  const now = opts.now ?? new Date().toISOString();
  return ProjectSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    id: opts.id ?? newId("prj"),
    title: opts.title,
    profile: { ...size, fps: opts.fps ?? { num: 30, den: 1 }, sampleRate: 48000, background: "#000000" },
    assets: [],
    tracks: [
      { id: "trk_v1", kind: "video", name: "Video 1", clips: [] },
      { id: "trk_v2", kind: "video", name: "Overlay", clips: [] },
      { id: "trk_t1", kind: "text", name: "Titles", clips: [] },
      { id: "trk_a1", kind: "audio", name: "Music", clips: [] },
    ],
    markers: [],
    createdAt: now,
    updatedAt: now,
  });
}
