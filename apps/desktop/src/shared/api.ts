/**
 * The typed contract between the renderer and the main process. The preload
 * script exposes exactly these functions on `window.motif`; nothing else
 * (no fs, no shell, no raw ipcRenderer) is reachable from the UI.
 */
import type { MediaAsset, Project, RenderPreset } from "@motif/project-schema";

export interface RecentProject {
  id: string;
  title: string;
  path: string;
  updatedAt: string;
  width: number;
  height: number;
  fps: string;
  clipCount: number;
  missingMedia: number;
  exists: boolean;
}

export interface AppInfo {
  version: string;
  ffmpeg: string | null;
  platform: string;
  userData: string;
  font: string | null;
  encoders: string[];
}

export interface DerivedMedia {
  assetId: string;
  thumbnailUrl?: string;
  filmstripUrl?: string;
  peaks?: number[];
  error?: string;
}

export interface OpenedProject {
  project: Project;
  path: string;
  recovered: boolean;
  missingAssetIds: string[];
}

export interface RenderProgressEvent {
  jobId: string;
  fraction: number;
  stage: "preparing" | "encoding" | "verifying";
}

export interface RenderDoneEvent {
  jobId: string;
  ok: boolean;
  cancelled?: boolean;
  outputPath?: string;
  elapsedMs?: number;
  problems?: string[];
  error?: string;
}

export interface Settings {
  autosaveSeconds: number;
  previewScale: 0.25 | 0.5 | 1;
  snapping: boolean;
}

export interface SilenceRange {
  startSec: number;
  endSec: number;
}

export interface MotifApi {
  appInfo(): Promise<AppInfo>;
  getSettings(): Promise<Settings>;
  setSettings(s: Partial<Settings>): Promise<Settings>;

  listRecent(): Promise<RecentProject[]>;
  createProject(opts: { title: string; aspect: string; fps: string }): Promise<OpenedProject>;
  openProjectDialog(): Promise<OpenedProject | null>;
  openProject(path: string, opts?: { preferRecovery?: boolean }): Promise<OpenedProject>;
  hasRecovery(path: string): Promise<{ recoveryNewer: boolean; recoveredAt?: string }>;
  saveProject(path: string, project: Project): Promise<{ savedAt: string }>;
  autosave(path: string, project: Project): Promise<void>;
  renameProject(path: string, title: string): Promise<void>;
  duplicateProject(path: string): Promise<OpenedProject>;
  removeRecent(path: string): Promise<void>;
  createDemoProject(): Promise<OpenedProject>;

  importMediaDialog(): Promise<{ assets: MediaAsset[]; errors: { file: string; error: string }[] }>;
  importMediaPaths(paths: string[]): Promise<{ assets: MediaAsset[]; errors: { file: string; error: string }[] }>;
  registerAssets(assets: { id: string; path: string }[]): Promise<void>;
  relinkAsset(assetId: string): Promise<MediaAsset | null>;
  deriveMedia(asset: MediaAsset): Promise<DerivedMedia>;
  detectSilences(asset: MediaAsset, opts: { thresholdDb: number; minSec: number }): Promise<SilenceRange[]>;
  mediaUrl(assetId: string): string;

  presets(): Promise<RenderPreset[]>;
  chooseExportPath(defaultName: string, container: string): Promise<string | null>;
  startRender(project: Project, preset: RenderPreset, outputPath: string, range?: { start: number; end: number }): Promise<{ jobId: string }>;
  cancelRender(jobId: string): Promise<void>;
  onRenderProgress(cb: (e: RenderProgressEvent) => void): () => void;
  onRenderDone(cb: (e: RenderDoneEvent) => void): () => void;
  showInFolder(path: string): Promise<void>;

  importSrtDialog(): Promise<string | null>;
  exportSrtDialog(srt: string, defaultName: string): Promise<string | null>;

  // local AI & processing tools (all run on this machine)
  aiStatus(): Promise<{ whisper: boolean; python: string | null; flite: boolean; vidstab: boolean; message?: string }>;
  transcribe(asset: MediaAsset, opts: { model: "tiny" | "base" | "small"; language?: string }): Promise<{ jobId: string }>;
  textToSpeech(text: string, voice: string): Promise<MediaAsset>;
  stabilize(asset: MediaAsset): Promise<{ jobId: string }>;
  extractAudio(asset: MediaAsset): Promise<MediaAsset>;
  cancelJob(jobId: string): Promise<void>;
  onJobProgress(cb: (e: { jobId: string; fraction: number }) => void): () => void;
  onJobDone(cb: (e: { jobId: string; ok: boolean; cancelled?: boolean; error?: string; result?: any }) => void): () => void;
  voices(): Promise<{ id: string; label: string }[]>;

  onMenu(cb: (command: string) => void): () => void;
  pathForFile(file: File): string;
}

declare global {
  interface Window {
    motif: MotifApi;
  }
}
