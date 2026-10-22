/**
 * Desktop side of MOTIF Cloud. The session token is encrypted with the OS
 * keychain (Electron safeStorage) and never reaches the renderer. Everything
 * works without an account: signed out means honest local-only mode.
 */
import { app, safeStorage, shell } from "electron";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { CloudClient, CloudError, ConflictError, downloadProject, uploadProject, type CloudLink, type SyncProgress } from "@motif/cloud-client";
import { serializeProject, type Project } from "@motif/project-schema";
import * as store from "./store";

const DEFAULT_SERVER = process.env.MOTIF_CLOUD_URL ?? "http://localhost:8787";
const file = () => store.userDir("cloud.json");

interface CloudState {
  server: string;
  token?: string; // encrypted, base64
  plain?: boolean; // true when the OS has no keychain (token stored base64 only)
}

async function readState(): Promise<CloudState> {
  try {
    return { server: DEFAULT_SERVER, ...JSON.parse(await readFile(file(), "utf8")) };
  } catch {
    return { server: DEFAULT_SERVER };
  }
}
async function writeState(s: CloudState) {
  await mkdir(store.userDir(), { recursive: true });
  await writeFile(file(), JSON.stringify(s, null, 2), { mode: 0o600 });
}
function seal(token: string): Pick<CloudState, "token" | "plain"> {
  if (safeStorage.isEncryptionAvailable()) return { token: safeStorage.encryptString(token).toString("base64") };
  return { token: Buffer.from(token).toString("base64"), plain: true };
}
function unseal(s: CloudState): string | null {
  if (!s.token) return null;
  try {
    return s.plain ? Buffer.from(s.token, "base64").toString() : safeStorage.decryptString(Buffer.from(s.token, "base64"));
  } catch {
    return null;
  }
}
async function client(): Promise<CloudClient> {
  const s = await readState();
  return new CloudClient(s.server, unseal(s), `MOTIF-Desktop/${app.getVersion()} (${process.platform})`);
}

export async function status() {
  const s = await readState();
  const c = await client();
  const base = { server: s.server, keychain: safeStorage.isEncryptionAvailable() };
  if (!c.token) return { ...base, signedIn: false as const };
  try {
    const me = await c.me();
    return { ...base, signedIn: true as const, user: me.user, workspaces: me.workspaces };
  } catch (e) {
    if (e instanceof CloudError && e.status === 401) {
      await writeState({ server: s.server });
      return { ...base, signedIn: false as const, error: "Your session expired. Sign in again." };
    }
    return { ...base, signedIn: false as const, offline: true, error: (e as Error).message };
  }
}

export async function setServer(url: string) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error("Server must be an http(s) URL");
  if (u.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) throw new Error("Use https:// for remote servers");
  await writeState({ server: u.toString().replace(/\/$/, "") }); // changing server signs out
  return status();
}

export async function login(email: string, password: string) {
  const c = await client();
  const r = await c.login(email, password);
  await writeState({ ...(await readState()), ...seal(r.token) });
  return status();
}

let deviceAbort: AbortController | null = null;
/** Starts device sign-in, opens the approval page in the browser, and resolves once approved. */
export async function deviceStart(onSignedIn: (ok: boolean, error?: string) => void) {
  const c = await client();
  const d = await c.deviceStart();
  deviceAbort?.abort();
  const ac = (deviceAbort = new AbortController());
  shell.openExternal(d.verificationUrl).catch(() => {});
  c.devicePoll(d.deviceCode, { interval: d.interval, signal: ac.signal, timeoutMs: d.expiresIn * 1000 })
    .then(async (tok) => {
      await writeState({ ...(await readState()), ...seal(tok) });
      onSignedIn(true);
    })
    .catch((e) => onSignedIn(false, e.message));
  return { userCode: d.userCode, verificationUrl: d.verificationUrl };
}
export function deviceCancel() {
  deviceAbort?.abort();
}

export async function logout() {
  const c = await client();
  if (c.token) await c.logout().catch(() => {});
  const s = await readState();
  await writeState({ server: s.server });
  return status();
}

export async function listProjects(workspaceId: string) {
  return (await client()).listProjects(workspaceId);
}
export async function versions(projectId: string) {
  return (await client()).versions(projectId);
}

// The cloud link for a local project lives beside it (<file>.cloud.json), so the project format stays clean.
const linkPath = (projectPath: string) => `${projectPath}.cloud.json`;
export async function getLink(projectPath: string): Promise<CloudLink | null> {
  try {
    return JSON.parse(await readFile(linkPath(projectPath), "utf8"));
  } catch {
    return null;
  }
}
async function setLink(projectPath: string, link: CloudLink | null) {
  if (!link) return rm(linkPath(projectPath), { force: true });
  await writeFile(linkPath(projectPath), JSON.stringify(link, null, 2));
}

export async function upload(projectPath: string, project: Project, o: { workspaceId: string; message?: string; force?: boolean; asNew?: boolean }, progress: (p: SyncProgress) => void) {
  const c = await client();
  if (!c.token) throw new Error("Sign in to MOTIF Cloud first");
  const link = o.asNew ? null : await getLink(projectPath);
  try {
    const next = await uploadProject(c, { workspaceId: o.workspaceId, project, link: link && link.server === c.baseUrl ? link : null, force: o.force, message: o.message, onProgress: progress });
    await setLink(projectPath, next);
    return { ok: true as const, link: next };
  } catch (e) {
    if (e instanceof ConflictError) return { ok: false as const, conflict: true, message: e.message };
    throw e;
  }
}

export async function download(projectId: string, version: number | undefined, progress: (p: SyncProgress) => void) {
  const c = await client();
  const mediaDir = store.userDir("cloud-media");
  const r = await downloadProject(c, { projectId, mediaDir, version, onProgress: progress });
  const dir = join(store.projectsRoot(), "Cloud");
  await mkdir(dir, { recursive: true });
  const safe = r.project.title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80) || "Cloud project";
  let path = join(dir, `${safe}.motif`);
  for (let i = 2; existsSync(path) && !(await getLink(path))?.projectId?.startsWith(projectId); i++) path = join(dir, `${safe} (${i}).motif`);
  await writeFile(path, serializeProject(r.project), "utf8");
  await setLink(path, r.link);
  return { path, link: r.link };
}
