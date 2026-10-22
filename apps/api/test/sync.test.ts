/**
 * Desktop ⇄ cloud round trip over real HTTP: the cloud-client used by the
 * desktop app uploads a project with real media, a second "device" downloads
 * it, edits conflict, and an older version is restored and pulled.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { createProject, newId, type Project } from "@motif/project-schema";
import { CloudClient, ConflictError, CloudError, downloadProject, uploadProject, sha256File } from "@motif/cloud-client";
import { buildApp } from "../src/app.ts";
import { connect, migrate } from "../src/db/index.ts";
import { LocalStorage } from "../src/storage.ts";

let app: FastifyInstance;
let base = "";
let pool: any;
let tmp: string;
let stopDb: () => Promise<void> = async () => {};

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "motif-sync-"));
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    const { default: EmbeddedPostgres } = await import("embedded-postgres");
    const port = 55329 + Math.floor(Math.random() * 500);
    const pg = new EmbeddedPostgres({ databaseDir: join(tmp, "pg"), user: "motif", password: "motif", port, persistent: false, onLog: () => {}, onError: () => {} });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("motif_sync");
    stopDb = async () => pg.stop();
    url = `postgres://motif:motif@localhost:${port}/motif_sync`;
  }
  const c = connect(url);
  pool = c.pool;
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(pool);
  // listen first so the signed URLs point at the real port
  const holder: { url: string } = { url: "http://127.0.0.1:0" };
  const storage = new LocalStorage(join(tmp, "objects"), "http://placeholder", "sync-secret");
  app = await buildApp({ db: c.db, storage, publicUrl: holder.url, webUrl: "http://web.test" });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
  (storage as any).publicBaseUrl = base;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await stopDb();
  await rm(tmp, { recursive: true, force: true });
});

async function makeProject(): Promise<Project> {
  const media = join(tmp, "laptop-media");
  await (await import("node:fs/promises")).mkdir(media, { recursive: true });
  const v = join(media, "intro.mp4");
  const w = join(media, "voice.wav");
  await writeFile(v, Buffer.from("fake-mp4-bytes-".repeat(5000)));
  await writeFile(w, Buffer.from("RIFF-fake-wav-".repeat(3000)));
  const p = createProject({ title: "Cloud vlog" });
  const asset = (id: string, path: string, kind: "video" | "audio") => ({ id, kind, name: path.split("/").pop()!, path, meta: { durationSec: 5, hasVideo: kind === "video", hasAudio: true }, favorite: false, tags: [], bin: "", provenance: "imported" as const });
  return { ...p, assets: [asset(newId("ast"), v, "video"), asset(newId("ast"), w, "audio")] } as Project;
}

describe("desktop cloud sync", () => {
  it("uploads with media, downloads on a second device, handles conflicts and restores", async () => {
    const laptop = new CloudClient(base);
    const s = await laptop.req<{ token: string; workspaceId: string }>("POST", "/v1/auth/signup", { email: "sync@example.com", password: "sync sync sync sync" });
    laptop.token = s.token;
    const ws = s.workspaceId;

    // desktop device sign-in flow
    const desk = new CloudClient(base);
    const start = await desk.deviceStart();
    await laptop.req("POST", "/v1/auth/device/approve", { userCode: start.userCode });
    await desk.devicePoll(start.deviceCode, { interval: 0.05 });
    expect((await desk.me()).user.email).toBe("sync@example.com");

    const project = await makeProject();
    const stages: string[] = [];
    const link = await uploadProject(laptop, { workspaceId: ws, project, onProgress: (p) => stages.push(p.stage) });
    expect(link.version).toBe(1);
    expect(stages).toContain("uploading");

    // the cloud manifest never stores local absolute paths
    const head = await laptop.req("GET", `/v1/projects/${link.projectId}`);
    expect(JSON.stringify(head.manifest)).not.toContain(tmp);

    // second device downloads into its own media folder, checksums verified
    const pulled = await downloadProject(desk, { projectId: link.projectId, mediaDir: join(tmp, "desktop-media") });
    expect(pulled.project.title).toBe("Cloud vlog");
    for (const a of pulled.project.assets) {
      expect(a.path.startsWith(join(tmp, "desktop-media"))).toBe(true);
      const original = project.assets.find((x) => x.id === a.id)!;
      expect(await sha256File(a.path)).toBe(await sha256File(original.path));
    }

    // re-upload from the laptop dedupes media (no new assets)
    const before = (await pool.query("select count(*)::int n from assets")).rows[0].n;
    const v2 = await uploadProject(laptop, { workspaceId: ws, project: { ...project, title: "Cloud vlog v2" }, link, message: "retitle" });
    expect(v2.version).toBe(2);
    expect((await pool.query("select count(*)::int n from assets")).rows[0].n).toBe(before);

    // desktop still on v1 -> conflict, then explicit overwrite
    await expect(uploadProject(desk, { workspaceId: ws, project: pulled.project, link: pulled.link })).rejects.toBeInstanceOf(ConflictError);
    const v3 = await uploadProject(desk, { workspaceId: ws, project: { ...pulled.project, title: "Desk wins" }, link: pulled.link, force: true });
    expect(v3.version).toBe(3);

    // pull a specific older version
    const old = await downloadProject(desk, { projectId: link.projectId, mediaDir: join(tmp, "desktop-media"), version: 2 });
    expect(old.project.title).toBe("Cloud vlog v2");
    const vs = await desk.versions(link.projectId);
    expect(vs.map((v) => v.version)).toEqual([3, 2, 1]);
  });

  it("detects tampered media on download", async () => {
    const c = new CloudClient(base);
    const s = await c.req<{ token: string; workspaceId: string }>("POST", "/v1/auth/signup", { email: "tamper@example.com", password: "tamper tamper tamper" });
    c.token = s.token;
    const project = await makeProject();
    const link = await uploadProject(c, { workspaceId: s.workspaceId, project });
    // corrupt the stored object behind the API's back
    const row = (await pool.query("select storage_key from assets where workspace_id=$1 limit 1", [s.workspaceId])).rows[0];
    const file = join(tmp, "objects", row.storage_key);
    await writeFile(file, Buffer.concat([await readFile(file), Buffer.from("evil")]));
    await expect(downloadProject(c, { projectId: link.projectId, mediaDir: join(tmp, "tamper-dl") })).rejects.toThrow(/checksum/);
  });

  it("reports offline media and offline servers clearly", async () => {
    const c = new CloudClient("http://127.0.0.1:1");
    await expect(c.me()).rejects.toMatchObject({ code: "offline" });
    const ok = new CloudClient(base);
    const s = await ok.req<{ token: string; workspaceId: string }>("POST", "/v1/auth/signup", { email: "offline@example.com", password: "offline offline off" });
    ok.token = s.token;
    const p = await makeProject();
    p.assets[0]!.path = join(tmp, "nope.mp4");
    await expect(uploadProject(ok, { workspaceId: s.workspaceId, project: p })).rejects.toBeInstanceOf(CloudError);
  });
});
