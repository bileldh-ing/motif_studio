/** Project files, recent list, settings, autosave/recovery. */
import { app } from "electron";
import { mkdir, readFile, writeFile, rename, copyFile, stat, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import {
  parseProject,
  serializeProject,
  createProject,
  newId,
  ASPECT_PROFILES,
  FRAME_RATES,
  type Project,
  type AspectKey,
} from "@motif/project-schema";
import type { OpenedProject, RecentProject, Settings } from "../shared/api";

export const PROJECT_EXT = ".motif";

export function userDir(...p: string[]) {
  return join(app.getPath("userData"), ...p);
}

export function projectsRoot() {
  return join(app.getPath("documents"), "MOTIF Studio");
}

async function atomicWrite(path: string, data: string) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, data, "utf8");
  await rename(tmp, path);
}

// ------------------------------------------------------------ settings
const DEFAULT_SETTINGS: Settings = { autosaveSeconds: 30, previewScale: 0.5, snapping: true };

export async function getSettings(): Promise<Settings> {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(await readFile(userDir("settings.json"), "utf8")) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  next.autosaveSeconds = Math.max(5, Math.min(600, Math.round(next.autosaveSeconds)));
  await atomicWrite(userDir("settings.json"), JSON.stringify(next, null, 2));
  return next;
}

// ------------------------------------------------------------ recent
async function readRecentPaths(): Promise<string[]> {
  try {
    const v = JSON.parse(await readFile(userDir("recent.json"), "utf8"));
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export async function touchRecent(path: string) {
  const list = (await readRecentPaths()).filter((p) => p !== path);
  list.unshift(path);
  await atomicWrite(userDir("recent.json"), JSON.stringify(list.slice(0, 50), null, 2));
}

export async function removeRecent(path: string) {
  const list = (await readRecentPaths()).filter((p) => p !== path);
  await atomicWrite(userDir("recent.json"), JSON.stringify(list, null, 2));
}

export async function listRecent(): Promise<RecentProject[]> {
  const out: RecentProject[] = [];
  for (const path of await readRecentPaths()) {
    if (!existsSync(path)) {
      out.push({ id: path, title: basename(path, PROJECT_EXT), path, updatedAt: "", width: 0, height: 0, fps: "", clipCount: 0, missingMedia: 0, exists: false });
      continue;
    }
    try {
      const p = parseProject(JSON.parse(await readFile(path, "utf8")));
      out.push({
        id: p.id,
        title: p.title,
        path,
        updatedAt: p.updatedAt,
        width: p.profile.width,
        height: p.profile.height,
        fps: (p.profile.fps.num / p.profile.fps.den).toFixed(p.profile.fps.den === 1 ? 0 : 3),
        clipCount: p.tracks.reduce((n, t) => n + t.clips.length, 0),
        missingMedia: p.assets.filter((a) => !existsSync(a.path)).length,
        exists: true,
      });
    } catch {
      out.push({ id: path, title: basename(path, PROJECT_EXT) + " (unreadable)", path, updatedAt: "", width: 0, height: 0, fps: "", clipCount: 0, missingMedia: 0, exists: true });
    }
  }
  return out;
}

// ------------------------------------------------------------ projects
function recoveryPath(projectPath: string) {
  return userDir("recovery", Buffer.from(projectPath).toString("base64url").slice(-120) + ".json");
}

function slug(s: string) {
  return s.replace(/[^\p{L}\p{N} _-]+/gu, "").trim().slice(0, 60) || "Untitled";
}

async function uniquePath(dir: string, name: string) {
  let p = join(dir, name + PROJECT_EXT);
  let i = 2;
  while (existsSync(p)) p = join(dir, `${name} ${i++}${PROJECT_EXT}`);
  return p;
}

export async function createNewProject(opts: { title: string; aspect: string; fps: string }): Promise<OpenedProject> {
  const aspect = (opts.aspect in ASPECT_PROFILES ? opts.aspect : "16:9") as AspectKey;
  const fps = FRAME_RATES[opts.fps] ?? FRAME_RATES["30"]!;
  const project = createProject({ title: opts.title.trim() || "Untitled project", aspect, fps });
  const path = await uniquePath(projectsRoot(), slug(project.title));
  await saveProject(path, project);
  return { project, path, recovered: false, missingAssetIds: [] };
}

export async function saveProject(path: string, project: Project): Promise<{ savedAt: string }> {
  const data = serializeProject(project);
  // keep one backup of the previous version
  if (existsSync(path)) await copyFile(path, path + ".bak").catch(() => {});
  await atomicWrite(path, data);
  await rm(recoveryPath(path), { force: true });
  await touchRecent(path);
  return { savedAt: new Date().toISOString() };
}

export async function autosave(path: string, project: Project) {
  await atomicWrite(recoveryPath(path), serializeProject(project));
}

export async function hasRecovery(path: string): Promise<{ recoveryNewer: boolean; recoveredAt?: string }> {
  const rp = recoveryPath(path);
  if (!existsSync(rp)) return { recoveryNewer: false };
  const r = await stat(rp);
  const p = existsSync(path) ? await stat(path) : null;
  return { recoveryNewer: !p || r.mtimeMs > p.mtimeMs, recoveredAt: r.mtime.toISOString() };
}

export async function openProject(path: string, preferRecovery = false): Promise<OpenedProject> {
  let recovered = false;
  let raw: string;
  const rec = await hasRecovery(path);
  if (preferRecovery && rec.recoveryNewer) {
    raw = await readFile(recoveryPath(path), "utf8");
    recovered = true;
  } else raw = await readFile(path, "utf8");
  let project: Project;
  try {
    project = parseProject(JSON.parse(raw));
  } catch (e: any) {
    // Corrupt main file: fall back to the backup rather than losing work.
    if (!recovered && existsSync(path + ".bak")) {
      project = parseProject(JSON.parse(await readFile(path + ".bak", "utf8")));
      recovered = true;
    } else throw new Error(`This project file could not be read: ${e.message}`);
  }
  await touchRecent(path);
  return { project, path, recovered, missingAssetIds: project.assets.filter((a) => !existsSync(a.path)).map((a) => a.id) };
}

export async function renameProject(path: string, title: string) {
  const o = await openProject(path);
  await saveProject(path, { ...o.project, title: title.trim() || o.project.title, updatedAt: new Date().toISOString() });
}

export async function duplicateProject(path: string): Promise<OpenedProject> {
  const o = await openProject(path);
  const copy: Project = { ...o.project, id: newId("prj"), title: o.project.title + " copy", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const np = await uniquePath(dirname(path), slug(copy.title));
  await saveProject(np, copy);
  return { project: copy, path: np, recovered: false, missingAssetIds: o.missingAssetIds };
}
