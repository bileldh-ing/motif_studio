/**
 * Release operations: crash logging, diagnostic bundles and auto-update.
 * Nothing is ever sent anywhere automatically: MOTIF has no telemetry.
 * Diagnostics are written to a file the user chooses and can inspect.
 */
import { app, dialog, type BrowserWindow } from "electron";
import { appendFile, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import * as store from "./store";

const logDir = () => store.userDir("logs");

export async function logCrash(kind: string, detail: unknown) {
  try {
    await mkdir(logDir(), { recursive: true });
    const line = JSON.stringify({ at: new Date().toISOString(), version: app.getVersion(), kind, detail: detail instanceof Error ? { message: detail.message, stack: detail.stack } : detail });
    await appendFile(join(logDir(), "crash.jsonl"), line + "\n");
  } catch {
    /* never throw from the crash logger */
  }
}

export function installCrashHandlers(getWin: () => BrowserWindow | null) {
  process.on("uncaughtException", (e) => void logCrash("main.uncaughtException", e));
  process.on("unhandledRejection", (e) => void logCrash("main.unhandledRejection", e));
  app.on("render-process-gone", (_e, _wc, details) => {
    void logCrash("renderer.gone", details);
    const w = getWin();
    if (w && !w.isDestroyed() && details.reason !== "clean-exit") {
      // Autosave keeps the project safe; reload into Home where recovery is offered.
      dialog.showMessageBox(w, { type: "warning", message: "MOTIF's editor view stopped unexpectedly", detail: "Your work is autosaved. The window will reload and offer to restore it." }).then(() => w.reload());
    }
  });
  app.on("child-process-gone", (_e, details) => void logCrash("child.gone", details));
}

const tail = async (p: string, n = 200) => (await readFile(p, "utf8").catch(() => "")).split("\n").slice(-n).join("\n");

/** Writes a JSON diagnostic bundle (no media, no project contents, no tokens) to a user-chosen path. */
export async function diagnosticsBundle(win: BrowserWindow, extra: Record<string, unknown>) {
  const res = await dialog.showSaveDialog(win, { defaultPath: join(app.getPath("desktop"), `motif-diagnostics-${Date.now()}.json`), filters: [{ name: "JSON", extensions: ["json"] }] });
  if (res.canceled || !res.filePath) return null;
  const recent = await store.listRecent().catch(() => []);
  const bundle = {
    generatedAt: new Date().toISOString(),
    app: { version: app.getVersion(), packaged: app.isPackaged, electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    os: { platform: process.platform, arch: process.arch, release: os.release(), cpus: os.cpus().length, memoryGb: Math.round(os.totalmem() / 1024 ** 3) },
    ...extra,
    projects: { recentCount: recent.length, missingMedia: recent.reduce((n, r) => n + r.missingMedia, 0) },
    crashes: await tail(join(logDir(), "crash.jsonl")),
    renders: await tail(store.userDir("render-log.jsonl"), 50),
    logs: await readdir(logDir()).catch(() => []),
  };
  await writeFile(res.filePath, JSON.stringify(bundle, null, 2));
  return res.filePath;
}

export type UpdateState = { state: "disabled"; reason: string } | { state: "idle" | "checking" | "none" } | { state: "available" | "downloading"; version: string; percent?: number } | { state: "ready"; version: string } | { state: "error"; message: string };

let updateState: UpdateState = { state: "disabled", reason: "Updates are only available in installed release builds." };
let updater: any = null;

/** electron-updater against GitHub Releases; signatures are verified by electron-updater (code signature on Windows/macOS, sha512 manifest everywhere). */
export async function initUpdater(send: (s: UpdateState) => void) {
  if (!app.isPackaged || process.env.MOTIF_DISABLE_UPDATES) return;
  if (process.platform === "linux" && !process.env.APPIMAGE) {
    updateState = { state: "disabled", reason: "This package is updated by your package manager (deb/snap)." };
    return;
  }
  if (process.windowsStore || process.mas) {
    updateState = { state: "disabled", reason: "Store builds are updated by the store." };
    return;
  }
  try {
    const mod = await import("electron-updater");
    updater = mod.default?.autoUpdater ?? (mod as any).autoUpdater;
  } catch (e) {
    updateState = { state: "disabled", reason: `Updater unavailable: ${(e as Error).message}` };
    return;
  }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.allowDowngrade = false;
  const set = (s: UpdateState) => send((updateState = s));
  updater.on("checking-for-update", () => set({ state: "checking" }));
  updater.on("update-not-available", () => set({ state: "none" }));
  updater.on("update-available", (i: any) => set({ state: "available", version: i.version }));
  updater.on("download-progress", (p: any) => set({ state: "downloading", version: (updateState as any).version ?? "", percent: Math.round(p.percent) }));
  updater.on("update-downloaded", (i: any) => set({ state: "ready", version: i.version }));
  updater.on("error", (e: Error) => {
    void logCrash("updater.error", e);
    set({ state: "error", message: e.message });
  });
  updateState = { state: "idle" };
  setTimeout(() => updater.checkForUpdates().catch(() => {}), 15_000);
}
export const getUpdateState = () => updateState;
export async function checkForUpdates() {
  if (!updater) return updateState;
  await updater.checkForUpdates().catch((e: Error) => (updateState = { state: "error", message: e.message }));
  return updateState;
}
export function installUpdate() {
  if (updater && updateState.state === "ready") updater.quitAndInstall(false, true);
}
