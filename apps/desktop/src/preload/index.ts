import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { MotifApi } from "../shared/api";

const inv = (ch: string, ...a: unknown[]) => ipcRenderer.invoke(ch, ...a);
function on<T>(ch: string, cb: (e: T) => void) {
  const l = (_: unknown, payload: T) => cb(payload);
  ipcRenderer.on(ch, l);
  return () => ipcRenderer.removeListener(ch, l);
}

const api: MotifApi = {
  appInfo: () => inv("app:info"),
  getSettings: () => inv("settings:get"),
  setSettings: (s) => inv("settings:set", s),
  listRecent: () => inv("project:recent"),
  createProject: (o) => inv("project:create", o),
  openProjectDialog: () => inv("project:openDialog"),
  openProject: (p, o) => inv("project:open", p, o),
  hasRecovery: (p) => inv("project:hasRecovery", p),
  saveProject: (p, proj) => inv("project:save", p, proj),
  autosave: (p, proj) => inv("project:autosave", p, proj),
  renameProject: (p, t) => inv("project:rename", p, t),
  duplicateProject: (p) => inv("project:duplicate", p),
  removeRecent: (p) => inv("project:removeRecent", p),
  createDemoProject: () => inv("project:demo"),
  importMediaDialog: () => inv("media:importDialog"),
  importMediaPaths: (paths) => inv("media:importPaths", paths),
  registerAssets: (a) => inv("media:register", a),
  relinkAsset: (id) => inv("media:relink", id),
  deriveMedia: (a) => inv("media:derive", a),
  detectSilences: (a, o) => inv("media:silences", a, o),
  mediaUrl: (id) => `motif-media://asset/${encodeURIComponent(id)}`,
  presets: () => inv("render:presets"),
  chooseExportPath: (n, c) => inv("render:chooseOutput", n, c),
  startRender: (p, preset, out, range) => inv("render:start", p, preset, out, range),
  cancelRender: (id) => inv("render:cancel", id),
  onRenderProgress: (cb) => on("render:progress", cb),
  onRenderDone: (cb) => on("render:done", cb),
  showInFolder: (p) => inv("shell:showInFolder", p),
  importSrtDialog: () => inv("captions:importDialog"),
  exportSrtDialog: (s, n) => inv("captions:exportDialog", s, n),
  aiStatus: () => inv("ai:status"),
  transcribe: (a, o) => inv("ai:transcribe", a, o),
  textToSpeech: (t, v) => inv("ai:tts", t, v),
  stabilize: (a) => inv("ai:stabilize", a),
  extractAudio: (a) => inv("ai:extractAudio", a),
  cancelJob: (id) => inv("job:cancel", id),
  onJobProgress: (cb) => on("job:progress", cb),
  onJobDone: (cb) => on("job:done", cb),
  voices: () => inv("ai:voices"),
  onMenu: (cb) => on("menu", cb),
  pathForFile: (f) => webUtils.getPathForFile(f),
};

contextBridge.exposeInMainWorld("motif", api);
