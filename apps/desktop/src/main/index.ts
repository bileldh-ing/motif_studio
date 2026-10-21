import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, shell, type IpcMainInvokeEvent } from "electron";
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { z } from "zod";
import { DEFAULT_PRESETS, ProjectSchema, RenderPresetSchema, MediaAssetSchema, newId, type MediaAsset, type Project } from "@motif/project-schema";
import { addAsset, insertMediaClip, insertTextClip, setTransitionIn, updateClip, secondsToFrames } from "@motif/editor-core";
import {
  importMedia,
  renderProject,
  makeThumbnail,
  makeFilmstrip,
  cachePeaks,
  runFfmpeg,
  ffmpegVersion,
  detectEncoders,
  findDefaultFont,
  detectSilences,
  CancelledError,
} from "@motif/render-engine";
import * as store from "./store";
import { runSmoke } from "./smoke";
import type { RenderDoneEvent } from "../shared/api";

const here = fileURLToPath(new URL(".", import.meta.url));
const MEDIA_SCHEME = "motif-media";

protocol.registerSchemesAsPrivileged([
  { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, bypassCSP: false } },
]);

let win: BrowserWindow | null = null;
/** Only files the user imported (or that belong to an opened project) can be served to the renderer. */
const allowedMedia = new Map<string, string>(); // assetId -> absolute path
const derivedDir = () => store.userDir("cache");
const renderJobs = new Map<string, AbortController>();

const MIME: Record<string, string> = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac", ".ogg": "audio/ogg", ".flac": "audio/flac",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp",
};

function serveFile(path: string, request: Request): Response {
  if (!existsSync(path)) return new Response("not found", { status: 404 });
  const size = statSync(path).size;
  const type = MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
  const range = request.headers.get("range");
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? Number(m[1]) : 0;
    let end = m && m[2] ? Number(m[2]) : size - 1;
    if (m && !m[1] && m[2]) {
      start = size - Number(m[2]);
      end = size - 1;
    }
    end = Math.min(end, size - 1);
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    const stream = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream;
    return new Response(stream, {
      status: 206,
      headers: { "Content-Type": type, "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes" },
    });
  }
  return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
    status: 200,
    headers: { "Content-Type": type, "Content-Length": String(size), "Accept-Ranges": "bytes" },
  });
}

function registerMediaProtocol() {
  protocol.handle(MEDIA_SCHEME, (request) => {
    const url = new URL(request.url);
    const id = decodeURIComponent(url.pathname.replace(/^\//, ""));
    if (url.host === "asset") {
      const p = allowedMedia.get(id);
      return p ? serveFile(p, request) : new Response("forbidden", { status: 403 });
    }
    if (url.host === "derived") {
      if (!/^[\w.-]+$/.test(id)) return new Response("bad name", { status: 400 });
      return serveFile(join(derivedDir(), id), request);
    }
    return new Response("not found", { status: 404 });
  });
}

// ------------------------------------------------------------ IPC plumbing
function trustedSender(e: IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url ?? "";
  if (process.env.ELECTRON_RENDERER_URL) return url.startsWith(process.env.ELECTRON_RENDERER_URL);
  return url.startsWith("file://");
}

function handle<A extends z.ZodTypeAny[]>(channel: string, schemas: [...A], fn: (...args: { [K in keyof A]: z.infer<A[K]> }) => unknown) {
  ipcMain.handle(channel, async (e, ...raw) => {
    if (!trustedSender(e)) throw new Error("untrusted sender");
    const args = schemas.map((s, i) => s.parse(raw[i])) as { [K in keyof A]: z.infer<A[K]> };
    return fn(...args);
  });
}

function registerProjectAssets(p: Project) {
  for (const a of p.assets) allowedMedia.set(a.id, a.path);
}

function derivedName(asset: MediaAsset, suffix: string) {
  const h = createHash("sha1").update(asset.path + (asset.fingerprint ?? "")).digest("hex").slice(0, 16);
  return `${h}-${suffix}`;
}

async function importPaths(paths: string[]) {
  const assets: MediaAsset[] = [];
  const errors: { file: string; error: string }[] = [];
  // bounded parallelism: probes run in ffprobe child processes, never on the UI thread
  const queue = [...paths];
  await Promise.all(
    Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) {
        const p = queue.shift()!;
        try {
          const a = await importMedia(p);
          allowedMedia.set(a.id, a.path);
          assets.push(a);
        } catch (e: any) {
          errors.push({ file: basename(p), error: e.message });
        }
      }
    }),
  );
  return { assets: paths.map((p) => assets.find((a) => a.path === p)).filter(Boolean) as MediaAsset[], errors };
}

const MEDIA_FILTERS = [
  { name: "Media", extensions: ["mp4", "mov", "m4v", "mkv", "webm", "avi", "mp3", "wav", "m4a", "aac", "flac", "ogg", "png", "jpg", "jpeg", "webp", "bmp", "gif"] },
  { name: "All files", extensions: ["*"] },
];

async function createDemo() {
  const dir = store.userDir("demo-media");
  await mkdir(dir, { recursive: true });
  const f = (n: string) => join(dir, n);
  const gen = async (out: string, args: string[]) => {
    if (!existsSync(out)) await runFfmpeg(["-y", ...args, out]);
  };
  await gen(f("demo-bars.mp4"), ["-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=6", "-f", "lavfi", "-i", "sine=f=440:d=6", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"]);
  await gen(f("demo-fractal.mp4"), ["-f", "lavfi", "-i", "mandelbrot=s=1280x720:r=30", "-f", "lavfi", "-i", "sine=f=660:d=6", "-t", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"]);
  await gen(f("demo-gradient.png"), ["-f", "lavfi", "-i", "gradients=s=640x640:c0=0x7c5cff:c1=0x00d4b4:x0=0:y0=0:x1=640:y1=640", "-frames:v", "1"]);
  await gen(f("demo-music.wav"), ["-f", "lavfi", "-i", "sine=f=196:d=12,volume=0.4", "-ar", "48000"]);
  const o = await store.createNewProject({ title: "MOTIF demo", aspect: "16:9", fps: "30" });
  let p = o.project;
  const assets = (await importPaths([f("demo-bars.mp4"), f("demo-fractal.mp4"), f("demo-gradient.png"), f("demo-music.wav")])).assets;
  for (const a of assets) p = { ...p, assets: [...p.assets, { ...a, provenance: "sample" as const }] };
  const [bars, fractal, grad, music] = assets as [MediaAsset, MediaAsset, MediaAsset, MediaAsset];
  const fps = p.profile.fps;
  const s = (sec: number) => secondsToFrames(sec, fps);
  const c1 = insertMediaClip(p, { trackId: "trk_v1", assetId: bars.id, start: 0, duration: s(5) });
  const c2 = insertMediaClip(c1.project, { trackId: "trk_v1", assetId: fractal.id, start: s(5), duration: s(5) });
  p = setTransitionIn(c2.project, c2.clipId, 15);
  const g = insertMediaClip(p, { trackId: "trk_v2", assetId: grad.id, start: s(2), duration: s(3) });
  p = updateClip(g.project, g.clipId, { transform: { x: 620, y: -280, scale: 0.3, rotation: 0, opacity: 0.9 } });
  p = insertTextClip(p, { trackId: "trk_t1", start: 0, duration: s(2.5), content: "Made with MOTIF Studio" }).project;
  p = insertTextClip(p, { trackId: "trk_t1", start: s(6), duration: s(3), content: "Edit, caption, export.", role: "caption" }).project;
  const m = insertMediaClip(p, { trackId: "trk_a1", assetId: music.id, start: 0, duration: s(10) });
  p = updateClip(m.project, m.clipId, { audio: { gainDb: -8, pan: 0, fadeInFrames: s(1), fadeOutFrames: s(1.5), muted: false } });
  for (const a of p.assets) allowedMedia.set(a.id, a.path);
  await store.saveProject(o.path, p);
  return { project: p, path: o.path, recovered: false, missingAssetIds: [] };
}

function registerIpc() {
  handle("app:info", [], async () => ({
    version: app.getVersion(),
    ffmpeg: await ffmpegVersion(),
    platform: `${process.platform} ${process.arch}`,
    userData: app.getPath("userData"),
    font: findDefaultFont() ?? null,
    encoders: [...(await detectEncoders())].filter((e) => ["libx264", "libvpx-vp9", "prores_ks", "aac", "libopus", "h264_nvenc", "h264_videotoolbox", "h264_qsv"].includes(e)),
  }));
  handle("settings:get", [], () => store.getSettings());
  handle("settings:set", [z.object({}).passthrough()], (s) => store.setSettings(s as any));

  handle("project:recent", [], () => store.listRecent());
  handle("project:create", [z.object({ title: z.string().max(200), aspect: z.string(), fps: z.string() })], async (o) => {
    const r = await store.createNewProject(o);
    registerProjectAssets(r.project);
    return r;
  });
  handle("project:openDialog", [], async () => {
    const res = await dialog.showOpenDialog(win!, { properties: ["openFile"], filters: [{ name: "MOTIF project", extensions: ["motif"] }], defaultPath: store.projectsRoot() });
    if (res.canceled || !res.filePaths[0]) return null;
    const r = await store.openProject(res.filePaths[0]);
    registerProjectAssets(r.project);
    return r;
  });
  handle("project:open", [z.string(), z.object({ preferRecovery: z.boolean().optional() }).optional()], async (path, o) => {
    const r = await store.openProject(path, o?.preferRecovery);
    registerProjectAssets(r.project);
    return r;
  });
  handle("project:hasRecovery", [z.string()], (p) => store.hasRecovery(p));
  handle("project:save", [z.string(), ProjectSchema], (path, p) => store.saveProject(path, p));
  handle("project:autosave", [z.string(), ProjectSchema], (path, p) => store.autosave(path, p));
  handle("project:rename", [z.string(), z.string()], (path, t) => store.renameProject(path, t));
  handle("project:duplicate", [z.string()], (path) => store.duplicateProject(path));
  handle("project:removeRecent", [z.string()], (path) => store.removeRecent(path));
  handle("project:demo", [], () => createDemo());

  handle("media:importDialog", [], async () => {
    const res = await dialog.showOpenDialog(win!, { properties: ["openFile", "multiSelections"], filters: MEDIA_FILTERS });
    if (res.canceled) return { assets: [], errors: [] };
    return importPaths(res.filePaths);
  });
  handle("media:importPaths", [z.array(z.string()).max(500)], (paths) => importPaths(paths.filter((p) => existsSync(p))));
  handle("media:register", [z.array(z.object({ id: z.string(), path: z.string() }))], (list) => {
    for (const a of list) allowedMedia.set(a.id, a.path);
  });
  handle("media:relink", [z.string()], async (assetId) => {
    const res = await dialog.showOpenDialog(win!, { title: "Locate missing media", properties: ["openFile"], filters: MEDIA_FILTERS });
    if (res.canceled || !res.filePaths[0]) return null;
    const a = await importMedia(res.filePaths[0]);
    const relinked = { ...a, id: assetId };
    allowedMedia.set(assetId, relinked.path);
    return relinked;
  });
  handle("media:derive", [MediaAssetSchema], async (asset) => {
    const out: { assetId: string; thumbnailUrl?: string; filmstripUrl?: string; peaks?: number[]; error?: string } = { assetId: asset.id };
    try {
      if (asset.meta.hasVideo) {
        const thumb = derivedName(asset, "thumb.png");
        const tp = join(derivedDir(), thumb);
        if (!existsSync(tp)) await makeThumbnail(asset.path, Math.min(1, asset.meta.durationSec / 3), tp, 320);
        out.thumbnailUrl = `${MEDIA_SCHEME}://derived/${thumb}`;
        if (asset.kind === "video") {
          const strip = derivedName(asset, "strip.jpg");
          const sp = join(derivedDir(), strip);
          if (!existsSync(sp)) await makeFilmstrip(asset.path, asset.meta.durationSec, sp, 12, 54);
          out.filmstripUrl = `${MEDIA_SCHEME}://derived/${strip}`;
        }
      }
      if (asset.meta.hasAudio) out.peaks = await cachePeaks(asset.path, join(derivedDir(), derivedName(asset, "peaks.json")));
    } catch (e: any) {
      out.error = e.message;
    }
    return out;
  });
  handle("media:silences", [MediaAssetSchema, z.object({ thresholdDb: z.number().min(-90).max(0), minSec: z.number().min(0.1).max(10) })], (asset, o) =>
    detectSilences(asset.path, o.thresholdDb, o.minSec),
  );

  handle("render:presets", [], () => DEFAULT_PRESETS);
  handle("render:chooseOutput", [z.string(), z.string()], async (name, container) => {
    const res = await dialog.showSaveDialog(win!, {
      defaultPath: join(app.getPath("videos"), `${name.replace(/[\\/:*?"<>|]/g, "")}.${container}`),
      filters: [{ name: container.toUpperCase(), extensions: [container] }],
    });
    return res.canceled ? null : res.filePath;
  });
  handle(
    "render:start",
    [ProjectSchema, RenderPresetSchema, z.string(), z.object({ start: z.number().int(), end: z.number().int() }).optional()],
    async (project, preset, outputPath, range) => {
      const jobId = newId("job");
      const ac = new AbortController();
      renderJobs.set(jobId, ac);
      const send = (ch: string, payload: unknown) => win?.webContents.send(ch, payload);
      renderProject(project, preset, { outputPath, ...(range ? { range } : {}) }, {
        signal: ac.signal,
        onProgress: (fraction, stage) => send("render:progress", { jobId, fraction, stage }),
        onLog: (l) => console.log("[render]", l.slice(0, 500)),
      })
        .then((r) => {
          const done: RenderDoneEvent = { jobId, ok: r.verification.ok, outputPath: r.outputPath, elapsedMs: r.elapsedMs, problems: r.verification.problems };
          send("render:done", done);
          appendRenderLog({ ...done, title: project.title, preset: preset.id, at: new Date().toISOString() });
        })
        .catch((e) => send("render:done", { jobId, ok: false, cancelled: e instanceof CancelledError, error: e instanceof CancelledError ? undefined : e.message }))
        .finally(() => renderJobs.delete(jobId));
      return { jobId };
    },
  );
  handle("render:cancel", [z.string()], (jobId) => renderJobs.get(jobId)?.abort());
  handle("shell:showInFolder", [z.string()], (p) => {
    if (existsSync(p)) shell.showItemInFolder(p);
  });

  handle("captions:importDialog", [], async () => {
    const res = await dialog.showOpenDialog(win!, { properties: ["openFile"], filters: [{ name: "Subtitles", extensions: ["srt"] }] });
    if (res.canceled || !res.filePaths[0]) return null;
    return readFile(res.filePaths[0], "utf8");
  });
  handle("captions:exportDialog", [z.string(), z.string()], async (srt, name) => {
    const res = await dialog.showSaveDialog(win!, { defaultPath: join(app.getPath("documents"), `${name}.srt`), filters: [{ name: "SubRip", extensions: ["srt"] }] });
    if (res.canceled || !res.filePath) return null;
    await writeFile(res.filePath, srt, "utf8");
    return res.filePath;
  });
}

async function appendRenderLog(entry: unknown) {
  const p = store.userDir("render-log.jsonl");
  await mkdir(store.userDir(), { recursive: true });
  await writeFile(p, JSON.stringify(entry) + "\n", { flag: "a" });
}

function buildMenu() {
  const send = (cmd: string) => () => win?.webContents.send("menu", cmd);
  const isMac = process.platform === "darwin";
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [
        { label: "Home", accelerator: "CmdOrCtrl+Shift+H", click: send("home") },
        { label: "Import Media…", accelerator: "CmdOrCtrl+I", click: send("import") },
        { label: "Save", accelerator: "CmdOrCtrl+S", click: send("save") },
        { label: "Export…", accelerator: "CmdOrCtrl+E", click: send("export") },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { label: "Undo", accelerator: "CmdOrCtrl+Z", click: send("undo") },
        { label: "Redo", accelerator: "CmdOrCtrl+Shift+Z", click: send("redo") },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    { label: "View", submenu: [{ role: "togglefullscreen" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, ...(app.isPackaged ? [] : [{ role: "toggleDevTools" as const }])] },
    { label: "Help", submenu: [{ label: "Keyboard Shortcuts", accelerator: "CmdOrCtrl+/", click: send("shortcuts") }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1100,
    minHeight: 680,
    backgroundColor: "#0e0f12",
    title: "MOTIF Studio",
    show: false,
    webPreferences: {
      preload: join(here, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  win.once("ready-to-show", () => win?.show());
  if (process.env.MOTIF_SMOKE_DIR) win.webContents.once("did-finish-load", () => runSmoke(win!, process.env.MOTIF_SMOKE_DIR!));
  // Never navigate the privileged window to remote content; open links in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    const dev = process.env.ELECTRON_RENDERER_URL;
    if (!(dev && url.startsWith(dev)) && !url.startsWith("file://")) e.preventDefault();
  });
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(join(here, "../renderer/index.html"));
}

app.whenReady().then(() => {
  registerMediaProtocol();
  registerIpc();
  buildMenu();
  createWindow();
  app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on("window-all-closed", () => {
  for (const ac of renderJobs.values()) ac.abort();
  if (process.platform !== "darwin") app.quit();
});
