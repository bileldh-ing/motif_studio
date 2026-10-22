/**
 * End-to-end API tests against a real PostgreSQL (embedded locally, or the
 * TEST_DATABASE_URL service in CI), real migrations, real signed storage and
 * Stripe-signed webhook payloads.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import Stripe from "stripe";
import { buildApp } from "../src/app.ts";
import { connect, migrate } from "../src/db/index.ts";
import { LocalStorage } from "../src/storage.ts";

let app: FastifyInstance;
let stopDb: () => Promise<void> = async () => {};
let pool: any;
let tmp: string;
const WEBHOOK_SECRET = "whsec_test_motif_secret";
const stripe = new Stripe("sk_test_placeholder");

async function startDb(): Promise<string> {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const port = 54329 + Math.floor(Math.random() * 500);
  const pg = new EmbeddedPostgres({ databaseDir: join(tmp, "pg"), user: "motif", password: "motif", port, persistent: false, onLog: () => {}, onError: () => {} });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("motif_test");
  stopDb = async () => pg.stop();
  return `postgres://motif:motif@localhost:${port}/motif_test`;
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "motif-api-"));
  const url = await startDb();
  const c = connect(url);
  pool = c.pool;
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  const applied = await migrate(pool);
  expect(applied).toContain("0001_init.sql");
  expect(await migrate(pool)).toEqual([]); // idempotent
  app = await buildApp({
    db: c.db,
    storage: new LocalStorage(join(tmp, "objects"), "http://api.test", "storage-secret"),
    publicUrl: "http://api.test",
    webUrl: "http://web.test",
    stripe: { webhookSecret: WEBHOOK_SECRET, prices: { pro: "price_pro_test", team: "price_team_test" } },
  });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await stopDb();
  await rm(tmp, { recursive: true, force: true });
});

const call = async (method: string, url: string, o: { token?: string; body?: unknown; headers?: Record<string, string>; raw?: string | Buffer } = {}) => {
  const r = await app.inject({
    method: method as any,
    url,
    headers: { ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.body !== undefined ? { "content-type": "application/json" } : {}), ...(o.headers ?? {}) },
    payload: o.raw ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined),
  });
  let body: any = null;
  try {
    body = r.body ? JSON.parse(r.body) : null;
  } catch {
    body = r.body;
  }
  return { status: r.statusCode, body, raw: r.rawPayload };
};
const manifest = (title: string, n = 1) => ({ schemaVersion: 2, id: "prj_x", title, tracks: [{ id: "trk_v1", clips: Array.from({ length: n }, (_, i) => ({ id: `c${i}` })) }] });
const octet = { "content-type": "application/octet-stream" };

let alice: { token: string; ws: string };
let bob: { token: string; ws: string };

describe("identity", () => {
  it("signs up, logs in, rejects bad passwords and duplicate emails", async () => {
    const s = await call("POST", "/v1/auth/signup", { body: { email: "Alice@Example.com", password: "correct horse battery", name: "Alice" } });
    expect(s.status).toBe(201);
    alice = { token: s.body.token, ws: s.body.workspaceId };
    expect((await call("POST", "/v1/auth/signup", { body: { email: "alice@example.com", password: "another long password" } })).status).toBe(409);
    expect((await call("POST", "/v1/auth/signup", { body: { email: "short@example.com", password: "short" } })).status).toBe(400);
    expect((await call("POST", "/v1/auth/login", { body: { email: "alice@example.com", password: "wrong password!!" } })).status).toBe(401);
    const l = await call("POST", "/v1/auth/login", { body: { email: "alice@example.com", password: "correct horse battery" } });
    expect(l.status).toBe(200);
    const me = await call("GET", "/v1/me", { token: l.body.token });
    expect(me.body.user.email).toBe("alice@example.com");
    expect(me.body.workspaces[0].role).toBe("owner");
    expect((await call("POST", "/v1/auth/logout", { token: l.body.token, body: {} })).status).toBe(200);
    expect((await call("GET", "/v1/me", { token: l.body.token })).status).toBe(401);
    expect((await call("GET", "/v1/me")).status).toBe(401);
    const b = await call("POST", "/v1/auth/signup", { body: { email: "bob@example.com", password: "bob has a long password" } });
    bob = { token: b.body.token, ws: b.body.workspaceId };
  });

  it("stores scrypt password hashes and only token hashes for sessions", async () => {
    const u = await pool.query("select password_hash from users where email='alice@example.com'");
    expect(u.rows[0].password_hash).toMatch(/^scrypt\$/);
    const s = await pool.query("select token_hash from sessions");
    expect(s.rows.every((r: any) => /^[a-f0-9]{64}$/.test(r.token_hash))).toBe(true);
    expect(s.rows.some((r: any) => r.token_hash === alice.token)).toBe(false);
  });

  it("device authorization flow signs in the desktop app", async () => {
    const st = await call("POST", "/v1/auth/device/start", { body: {} });
    expect(st.body.verificationUrl).toContain(st.body.userCode);
    expect((await call("POST", "/v1/auth/device/poll", { body: { deviceCode: st.body.deviceCode } })).status).toBe(428);
    expect((await call("POST", "/v1/auth/device/approve", { token: alice.token, body: { userCode: "ZZZZ-ZZZZ" } })).status).toBe(404);
    expect((await call("POST", "/v1/auth/device/approve", { token: alice.token, body: { userCode: st.body.userCode.toLowerCase() } })).status).toBe(200);
    const p = await call("POST", "/v1/auth/device/poll", { body: { deviceCode: st.body.deviceCode } });
    expect(p.status).toBe(200);
    expect((await call("GET", "/v1/me", { token: p.body.token })).body.user.email).toBe("alice@example.com");
    expect((await call("POST", "/v1/auth/device/poll", { body: { deviceCode: st.body.deviceCode } })).status).toBe(400); // single use
  });
});

describe("cloud projects", () => {
  let pid = "";
  it("creates, versions, detects conflicts and restores", async () => {
    const c = await call("POST", `/v1/workspaces/${alice.ws}/projects`, { token: alice.token, body: { title: "Vlog", manifest: manifest("Vlog") } });
    expect(c.status).toBe(201);
    pid = c.body.id;
    const u2 = await call("PUT", `/v1/projects/${pid}/manifest`, { token: alice.token, body: { baseVersion: 1, manifest: manifest("Vlog", 2), message: "added clip" } });
    expect(u2.body.version).toBe(2);
    const stale = await call("PUT", `/v1/projects/${pid}/manifest`, { token: alice.token, body: { baseVersion: 1, manifest: manifest("Vlog", 5) } });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("conflict");
    const forced = await call("PUT", `/v1/projects/${pid}/manifest`, { token: alice.token, body: { baseVersion: 1, manifest: manifest("Vlog", 5), force: true } });
    expect(forced.body.version).toBe(3);
    const r = await call("POST", `/v1/projects/${pid}/restore`, { token: alice.token, body: { version: 1 } });
    expect(r.body.version).toBe(4);
    const head = await call("GET", `/v1/projects/${pid}`, { token: alice.token });
    expect(head.body.manifest.tracks[0].clips).toHaveLength(1);
    const versions = await call("GET", `/v1/projects/${pid}/versions`, { token: alice.token });
    expect(versions.body.map((v: any) => v.version)).toEqual([4, 3, 2, 1]);
    expect(versions.body[0].message).toBe("Restored v1");
    expect((await call("PUT", `/v1/projects/${pid}/manifest`, { token: alice.token, body: { baseVersion: 4, manifest: { nope: true } } })).status).toBe(400);
  });

  it("isolates tenants: other users cannot see or touch the project", async () => {
    expect((await call("GET", `/v1/projects/${pid}`, { token: bob.token })).status).toBe(404);
    expect((await call("PUT", `/v1/projects/${pid}/manifest`, { token: bob.token, body: { baseVersion: 4, manifest: manifest("x") } })).status).toBe(404);
    expect((await call("GET", `/v1/workspaces/${alice.ws}/projects`, { token: bob.token })).status).toBe(404);
    expect((await call("DELETE", `/v1/projects/${pid}`, { token: bob.token })).status).toBe(404);
    expect((await call("GET", `/v1/workspaces/${bob.ws}/projects`, { token: bob.token })).body).toEqual([]);
  });

  it("enforces roles and seats: viewers read but cannot write", async () => {
    expect((await call("POST", `/v1/workspaces/${alice.ws}/members`, { token: alice.token, body: { email: "bob@example.com", role: "viewer" } })).status).toBe(402);
    await pool.query("update workspaces set plan='team' where id=$1", [alice.ws]);
    expect((await call("POST", `/v1/workspaces/${alice.ws}/members`, { token: alice.token, body: { email: "bob@example.com", role: "viewer" } })).status).toBe(201);
    expect((await call("GET", `/v1/projects/${pid}`, { token: bob.token })).status).toBe(200);
    expect((await call("PUT", `/v1/projects/${pid}/manifest`, { token: bob.token, body: { baseVersion: 4, manifest: manifest("x") } })).status).toBe(403);
    expect((await call("POST", `/v1/workspaces/${alice.ws}/members`, { token: bob.token, body: { email: "bob@example.com", role: "editor" } })).status).toBe(403);
    await pool.query("update workspaces set plan='free' where id=$1", [alice.ws]);
  });

  it("free plan limits cloud projects", async () => {
    for (let i = 0; i < 2; i++) expect((await call("POST", `/v1/workspaces/${alice.ws}/projects`, { token: alice.token, body: { title: `P${i}`, manifest: manifest("p") } })).status).toBe(201);
    expect((await call("POST", `/v1/workspaces/${alice.ws}/projects`, { token: alice.token, body: { title: "P4", manifest: manifest("p") } })).status).toBe(402);
  });
});

describe("signed media transfer", () => {
  const bytes = Buffer.from("MOTIF test media ".repeat(2000));
  const sha = createHash("sha256").update(bytes).digest("hex");
  it("uploads through a signed URL, verifies integrity, downloads through a signed URL", async () => {
    const a = await call("POST", `/v1/workspaces/${alice.ws}/assets`, { token: alice.token, body: { name: "clip.mp4", size: bytes.length, sha256: sha, mime: "video/mp4" } });
    expect(a.status).toBe(201);
    const assetId = a.body.assetId;
    const u = new URL(a.body.upload.url);
    const path = u.pathname + u.search;
    expect((await call("POST", `/v1/assets/${assetId}/complete`, { token: alice.token, body: {} })).status).toBe(409);
    expect((await call("PUT", path.replace(/sig=[^&]+/, "sig=AAAA"), { raw: bytes, headers: octet })).status).toBe(403);
    expect((await call("PUT", path, { raw: Buffer.concat([bytes, Buffer.alloc(100)]), headers: octet })).status).toBe(413);
    expect((await call("PUT", path, { raw: bytes, headers: octet })).status).toBe(200);
    expect((await call("POST", `/v1/assets/${assetId}/complete`, { token: alice.token, body: {} })).body.status).toBe("ready");
    const d = await call("GET", `/v1/assets/${assetId}/download`, { token: alice.token });
    const du = new URL(d.body.download.url);
    const got = await call("GET", du.pathname + du.search);
    expect(got.status).toBe(200);
    expect(createHash("sha256").update(got.raw).digest("hex")).toBe(sha);
    expect((await call("GET", du.pathname + du.search.replace(/exp=\d+/, "exp=100"))).status).toBe(403);
    expect((await call("GET", `/v1/assets/${assetId}/download`, { token: bob.token })).status).toBe(200); // viewer of alice's workspace
    const eve = await call("POST", "/v1/auth/signup", { body: { email: "eve@example.com", password: "eve wants your media" } });
    expect((await call("GET", `/v1/assets/${assetId}/download`, { token: eve.body.token })).status).toBe(404);
  });

  it("dedupes identical uploads and rejects checksum mismatches", async () => {
    const again = await call("POST", `/v1/workspaces/${alice.ws}/assets`, { token: alice.token, body: { name: "copy.mp4", size: bytes.length, sha256: sha, mime: "video/mp4" } });
    expect(again.body.alreadyUploaded).toBe(true);
    const bad = await call("POST", `/v1/workspaces/${alice.ws}/assets`, { token: alice.token, body: { name: "lie.mp4", size: 10, sha256: "0".repeat(64) } });
    const u = new URL(bad.body.upload.url);
    await call("PUT", u.pathname + u.search, { raw: Buffer.from("0123456789"), headers: octet });
    expect((await call("POST", `/v1/assets/${bad.body.assetId}/complete`, { token: alice.token, body: {} })).status).toBe(422);
  });

  it("enforces the storage quota", async () => {
    expect((await call("POST", `/v1/workspaces/${bob.ws}/assets`, { token: bob.token, body: { name: "huge.mov", size: 3 * 1024 ** 3, sha256: "a".repeat(64) } })).status).toBe(413);
  });
});

describe("billing & entitlements", () => {
  const signed = (event: object) => {
    const payload = JSON.stringify(event);
    return { raw: payload, headers: { "content-type": "application/json", "stripe-signature": stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }) } };
  };
  it("rejects unsigned or wrongly signed webhooks", async () => {
    const payload = JSON.stringify({ id: "evt_x", type: "checkout.session.completed", data: { object: {} } });
    expect((await call("POST", "/v1/billing/webhook", { raw: payload, headers: { "content-type": "application/json" } })).status).toBe(400);
    const wrong = stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_wrong" });
    expect((await call("POST", "/v1/billing/webhook", { raw: payload, headers: { "content-type": "application/json", "stripe-signature": wrong } })).status).toBe(400);
  });
  it("checkout.session.completed upgrades; duplicates are idempotent; cancellation downgrades", async () => {
    const ev = { id: "evt_checkout_1", object: "event", type: "checkout.session.completed", data: { object: { object: "checkout.session", client_reference_id: bob.ws, customer: "cus_bob", subscription: "sub_bob", metadata: { workspaceId: bob.ws, plan: "pro" } } } };
    expect((await call("POST", "/v1/billing/webhook", signed(ev))).body).toEqual({ received: true });
    expect((await call("POST", "/v1/billing/webhook", signed(ev))).body.duplicate).toBe(true);
    let e = await call("GET", `/v1/workspaces/${bob.ws}/entitlements`, { token: bob.token });
    expect(e.body.plan).toBe("pro");
    expect(e.body.limits.cloudProjects).toBe(100);
    const del = { id: "evt_sub_del", object: "event", type: "customer.subscription.deleted", data: { object: { object: "subscription", id: "sub_bob", customer: "cus_bob", status: "canceled", items: { data: [] } } } };
    await call("POST", "/v1/billing/webhook", signed(del));
    e = await call("GET", `/v1/workspaces/${bob.ws}/entitlements`, { token: bob.token });
    expect(e.body.plan).toBe("free");
    expect(e.body.subscription.status).toBe("canceled");
  });
  it("meters usage with idempotent refs and quotas", async () => {
    expect((await call("POST", `/v1/workspaces/${bob.ws}/usage`, { token: bob.token, body: { kind: "ai_seconds", amount: 600, ref: "job_1" } })).status).toBe(200);
    expect((await call("POST", `/v1/workspaces/${bob.ws}/usage`, { token: bob.token, body: { kind: "ai_seconds", amount: 600, ref: "job_1" } })).body.duplicate).toBe(true);
    expect((await call("GET", `/v1/workspaces/${bob.ws}/entitlements`, { token: bob.token })).body.usage.aiSeconds30d).toBe(600);
    expect((await call("POST", `/v1/workspaces/${bob.ws}/usage`, { token: bob.token, body: { kind: "ai_seconds", amount: 1500, ref: "job_2" } })).status).toBe(402);
  });
  it("checkout reports honestly when Stripe is not configured", async () => {
    const r = await call("POST", `/v1/workspaces/${bob.ws}/billing/checkout`, { token: bob.token, body: { plan: "pro" } });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("billing_disabled");
  });
});

describe("audit & admin", () => {
  it("records audit events and restricts admin endpoints", async () => {
    const a = await call("GET", `/v1/workspaces/${alice.ws}/audit`, { token: alice.token });
    expect(a.body.map((x: any) => x.action)).toEqual(expect.arrayContaining(["user.signup", "project.create", "project.update", "project.restore", "member.add", "asset.upload_url"]));
    expect((await call("GET", `/v1/workspaces/${alice.ws}/audit`, { token: bob.token })).status).toBe(403);
    expect((await call("GET", "/v1/admin/stats", { token: alice.token })).status).toBe(403);
    await pool.query("update users set is_admin=true where email='alice@example.com'");
    const s = await call("GET", "/v1/admin/stats", { token: alice.token });
    expect(s.body.users).toBe(3);
    expect((await call("POST", `/v1/admin/workspaces/${bob.ws}/plan`, { token: alice.token, body: { plan: "team" } })).status).toBe(200);
  });
  it("health and readiness", async () => {
    expect((await call("GET", "/healthz")).body.ok).toBe(true);
    expect((await call("GET", "/readyz")).body.storage).toBe("local");
  });
  it("rate-limits login attempts", async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await call("POST", "/v1/auth/login", { body: { email: "nobody@example.com", password: "whatever-pass" } })).status;
    expect(last).toBe(429);
  });
});
