/**
 * MOTIF cloud sync client, shared by the desktop app and tests.
 * Talks to apps/api over HTTPS: device sign-in, project versions with
 * optimistic concurrency, and media transfer through signed URLs with
 * SHA-256 integrity checks on both upload and download.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseProject, type Project } from "@motif/project-schema";

export class CloudError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public detail?: unknown,
  ) {
    super(message);
  }
}
export class ConflictError extends CloudError {}

export interface CloudLink {
  server: string;
  workspaceId: string;
  projectId: string;
  version: number;
}

export interface Me {
  user: { id: string; email: string; name: string; isAdmin: boolean };
  workspaces: { id: string; name: string; plan: string; role: "owner" | "editor" | "viewer" }[];
}

export class CloudClient {
  constructor(
    public baseUrl: string,
    public token: string | null = null,
    private ua = "MOTIF-Desktop",
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async req<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    let r: Response;
    try {
      r = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          "user-agent": this.ua,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e: any) {
      throw new CloudError(0, "offline", `Can't reach ${this.baseUrl} (${e.cause?.code ?? e.message})`);
    }
    const data: any = await r.json().catch(() => null);
    if (!r.ok) {
      const E = r.status === 409 && data?.error === "conflict" ? ConflictError : CloudError;
      throw new E(r.status, data?.error ?? "error", data?.message ?? `HTTP ${r.status}`, data);
    }
    return data as T;
  }

  login(email: string, password: string) {
    return this.req<{ token: string }>("POST", "/v1/auth/login", { email, password, client: "desktop" }).then((r) => ((this.token = r.token), r));
  }
  deviceStart() {
    return this.req<{ deviceCode: string; userCode: string; verificationUrl: string; expiresIn: number; interval: number }>("POST", "/v1/auth/device/start", {});
  }
  /** Poll until approved; resolves with the session token. */
  async devicePoll(deviceCode: string, o: { interval?: number; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<string> {
    const until = Date.now() + (o.timeoutMs ?? 10 * 60e3);
    while (Date.now() < until) {
      if (o.signal?.aborted) throw new CloudError(0, "cancelled", "Sign-in cancelled");
      try {
        const r = await this.req<{ token: string }>("POST", "/v1/auth/device/poll", { deviceCode });
        this.token = r.token;
        return r.token;
      } catch (e) {
        if (!(e instanceof CloudError) || e.code !== "authorization_pending") throw e;
      }
      await new Promise((res) => setTimeout(res, (o.interval ?? 3) * 1000));
    }
    throw new CloudError(0, "expired_token", "Sign-in timed out");
  }
  logout() {
    return this.req("POST", "/v1/auth/logout", {}).finally(() => (this.token = null));
  }
  me() {
    return this.req<Me>("GET", "/v1/me");
  }
  listProjects(workspaceId: string) {
    return this.req<{ id: string; title: string; headVersion: number; updatedAt: string }[]>("GET", `/v1/workspaces/${workspaceId}/projects`);
  }
  versions(projectId: string) {
    return this.req<{ version: number; message: string; createdAt: string }[]>("GET", `/v1/projects/${projectId}/versions`);
  }
  entitlements(workspaceId: string) {
    return this.req("GET", `/v1/workspaces/${workspaceId}/entitlements`);
  }
}

export async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  await pipeline(createReadStream(path), async function* (src) {
    for await (const c of src) h.update(c as Buffer);
  });
  return h.digest("hex");
}

const MIME: Record<string, string> = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
const mimeOf = (p: string) => MIME[p.slice(p.lastIndexOf(".")).toLowerCase()] ?? "application/octet-stream";

export interface SyncProgress {
  stage: "hashing" | "uploading" | "downloading" | "saving";
  done: number;
  total: number;
  name?: string;
}

/** Cloud manifests never carry local absolute paths; assets reference cloud asset ids instead. */
export interface CloudManifest extends Record<string, unknown> {
  schemaVersion: number;
  tracks: unknown[];
  cloudAssets: Record<string, { cloudAssetId: string; sha256: string; name: string }>;
}

export async function uploadProject(
  client: CloudClient,
  o: { workspaceId: string; project: Project; link?: CloudLink | null; force?: boolean; message?: string; onProgress?: (p: SyncProgress) => void; signal?: AbortSignal },
): Promise<CloudLink> {
  const p = o.project;
  const cloudAssets: CloudManifest["cloudAssets"] = {};
  const total = p.assets.length;
  let i = 0;
  for (const a of p.assets) {
    if (o.signal?.aborted) throw new CloudError(0, "cancelled", "Upload cancelled");
    o.onProgress?.({ stage: "hashing", done: i, total, name: a.name });
    const st = await stat(a.path).catch(() => null);
    if (!st) throw new CloudError(0, "missing_media", `Media is offline: ${a.name}. Relink it before uploading.`);
    const sha = await sha256File(a.path);
    const r = await client.req<{ assetId: string; alreadyUploaded?: boolean; upload?: { url: string; headers: Record<string, string> } }>("POST", `/v1/workspaces/${o.workspaceId}/assets`, {
      name: basename(a.path),
      size: st.size,
      sha256: sha,
      mime: mimeOf(a.path),
    });
    if (!r.alreadyUploaded && r.upload) {
      o.onProgress?.({ stage: "uploading", done: i, total, name: a.name });
      const put = await fetch(r.upload.url, {
        method: "PUT",
        headers: { ...r.upload.headers, "content-length": String(st.size) },
        body: Readable.toWeb(createReadStream(a.path)) as any,
        duplex: "half",
        signal: o.signal,
      } as RequestInit);
      if (!put.ok) throw new CloudError(put.status, "upload_failed", `Upload of ${a.name} failed (${put.status})`);
      await client.req("POST", `/v1/assets/${r.assetId}/complete`, {});
    }
    cloudAssets[a.id] = { cloudAssetId: r.assetId, sha256: sha, name: basename(a.path) };
    i++;
  }
  const manifest: CloudManifest = {
    ...(p as unknown as Record<string, unknown>),
    assets: p.assets.map((a) => ({ ...a, path: `cloud://${cloudAssets[a.id]!.cloudAssetId}/${cloudAssets[a.id]!.name}` })),
    cloudAssets,
  } as unknown as CloudManifest;
  o.onProgress?.({ stage: "saving", done: total, total });
  if (o.link && o.link.workspaceId === o.workspaceId) {
    const r = await client.req<{ version: number }>("PUT", `/v1/projects/${o.link.projectId}/manifest`, { baseVersion: o.link.version, manifest, title: p.title, message: o.message ?? "", force: !!o.force });
    return { ...o.link, server: client.baseUrl, version: r.version };
  }
  const r = await client.req<{ id: string; version: number }>("POST", `/v1/workspaces/${o.workspaceId}/projects`, { title: p.title, manifest, message: o.message ?? "Uploaded from MOTIF Desktop" });
  return { server: client.baseUrl, workspaceId: o.workspaceId, projectId: r.id, version: r.version };
}

/** Download a cloud project (head or a specific version) and its media; verifies every file's SHA-256. */
export async function downloadProject(
  client: CloudClient,
  o: { projectId: string; mediaDir: string; version?: number; onProgress?: (p: SyncProgress) => void; signal?: AbortSignal },
): Promise<{ project: Project; link: CloudLink }> {
  const head = await client.req<{ workspaceId: string; version: number; manifest: CloudManifest }>("GET", `/v1/projects/${o.projectId}`);
  const manifest = o.version && o.version !== head.version ? (await client.req<{ manifest: CloudManifest }>("GET", `/v1/projects/${o.projectId}/versions/${o.version}`)).manifest : head.manifest;
  await mkdir(o.mediaDir, { recursive: true });
  const cloudAssets = manifest.cloudAssets ?? {};
  const assets = (manifest.assets as any[]) ?? [];
  let i = 0;
  for (const a of assets) {
    if (o.signal?.aborted) throw new CloudError(0, "cancelled", "Download cancelled");
    const ref = cloudAssets[a.id];
    if (!ref) throw new CloudError(0, "bad_manifest", `Asset ${a.name} has no cloud copy`);
    const dest = join(o.mediaDir, `${ref.sha256.slice(0, 12)}-${ref.name.replace(/[\\/:*?"<>|]/g, "_")}`);
    const have = await stat(dest).catch(() => null);
    if (!have || (await sha256File(dest)) !== ref.sha256) {
      o.onProgress?.({ stage: "downloading", done: i, total: assets.length, name: a.name });
      const d = await client.req<{ download: { url: string } }>("GET", `/v1/assets/${ref.cloudAssetId}/download`);
      const res = await fetch(d.download.url, { signal: o.signal });
      if (!res.ok || !res.body) throw new CloudError(res.status, "download_failed", `Download of ${a.name} failed (${res.status})`);
      const tmp = `${dest}.part`;
      await pipeline(Readable.fromWeb(res.body as any), createWriteStream(tmp));
      if ((await sha256File(tmp)) !== ref.sha256) {
        await rm(tmp, { force: true });
        throw new CloudError(0, "integrity", `${a.name} failed its checksum after download`);
      }
      await rename(tmp, dest);
    }
    a.path = dest;
    i++;
  }
  const { cloudAssets: _drop, ...rest } = manifest;
  const project = parseProject({ ...rest, assets });
  const version = o.version ?? head.version;
  return { project, link: { server: client.baseUrl, workspaceId: head.workspaceId, projectId: o.projectId, version } };
}
