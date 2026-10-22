/**
 * MOTIF cloud API (Fastify). Every data access is scoped by workspace
 * membership in SQL — never by UI state — so tenant isolation holds even for
 * guessed IDs (cross-tenant lookups return 404).
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import { and, desc, eq, isNull, sql, gt } from "drizzle-orm";
import Stripe from "stripe";
import type { DB } from "./db/index.ts";
import { schema } from "./db/index.ts";
import { hashPassword, verifyPassword, newToken, sha256, newId, userCode } from "./security.ts";
import { LocalStorage, keyFor, type Storage } from "./storage.ts";
import { PLANS, planFor } from "./plans.ts";
import type { Role, Plan } from "./db/schema.ts";

const { users, sessions, deviceCodes, workspaces, memberships, projects, projectVersions, assets, subscriptions, usageLedger, auditLog, webhookEvents } = schema;

export interface AppConfig {
  db: DB;
  storage: Storage;
  publicUrl: string;
  webUrl: string;
  stripe?: { secretKey?: string; webhookSecret?: string; prices: Partial<Record<Plan, string | undefined>> };
  sessionDays?: number;
  logger?: boolean;
  corsOrigins?: string[];
}

interface AuthUser {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
  sessionId: string;
}
declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
    rawBody?: Buffer;
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
const fail = (status: number, code: string, message: string): never => {
  throw new HttpError(status, code, message);
};

const ROLE_RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };

export async function buildApp(cfg: AppConfig): Promise<FastifyInstance> {
  const { db, storage } = cfg;
  const app = Fastify({ logger: cfg.logger ?? false, bodyLimit: 8 * 1024 * 1024, trustProxy: true });
  const stripe = cfg.stripe?.secretKey ? new Stripe(cfg.stripe.secretKey) : null;
  const webhookVerifier = new Stripe(cfg.stripe?.secretKey ?? "sk_test_placeholder");
  await app.register(cors, { origin: cfg.corsOrigins ?? [cfg.webUrl] });
  await app.register(rateLimit, { global: false });

  // JSON keeps its raw bytes (Stripe signature check); uploads stream as octet-stream.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    req.rawBody = body as Buffer;
    if (!(body as Buffer).length) return done(null, {});
    try {
      done(null, JSON.parse((body as Buffer).toString("utf8")));
    } catch {
      done(new HttpError(400, "bad_json", "Body is not valid JSON"), undefined);
    }
  });
  app.addContentTypeParser("*", (_req, payload, done) => done(null, payload));

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.code, message: err.message });
    if (err instanceof z.ZodError) return reply.status(400).send({ error: "invalid_request", message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    if (err.statusCode === 429) return reply.status(429).send({ error: "rate_limited", message: "Too many attempts, slow down." });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: "bad_request", message: err.message });
    req.log.error(err);
    return reply.status(500).send({ error: "internal", message: "Something went wrong" });
  });

  const audit = (req: FastifyRequest, action: string, o: { workspaceId?: string | null; target?: string; meta?: object } = {}) =>
    db.insert(auditLog).values({ action, workspaceId: o.workspaceId ?? null, actorId: req.user?.id ?? null, target: o.target ?? "", meta: o.meta ?? {}, ip: req.ip });

  // ---------------------------------------------------------------- auth helpers
  const issueSession = async (userId: string, kind: "web" | "desktop", ua: string) => {
    const token = newToken();
    const days = cfg.sessionDays ?? (kind === "desktop" ? 90 : 30);
    await db.insert(sessions).values({ id: newId("ses"), userId, tokenHash: sha256(token), kind, userAgent: ua.slice(0, 200), expiresAt: new Date(Date.now() + days * 864e5) });
    return token;
  };
  const requireUser = async (req: FastifyRequest) => {
    const h = req.headers.authorization ?? "";
    const tok = h.startsWith("Bearer ") ? h.slice(7) : "";
    if (!tok) fail(401, "unauthenticated", "Sign in required");
    const rows = await db
      .select({ id: users.id, email: users.email, name: users.name, isAdmin: users.isAdmin, sessionId: sessions.id })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.tokenHash, sha256(tok)), gt(sessions.expiresAt, new Date())))
      .limit(1);
    if (!rows[0]) fail(401, "unauthenticated", "Session expired, sign in again");
    req.user = rows[0];
    return rows[0]!;
  };
  const auth = { preHandler: async (req: FastifyRequest) => void (await requireUser(req)) };
  /** Membership check scoped in SQL. Non-members get 404 (no existence leak). */
  const requireRole = async (req: FastifyRequest, workspaceId: string, min: Role) => {
    const m = await db
      .select({ role: memberships.role, plan: workspaces.plan })
      .from(memberships)
      .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
      .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, req.user!.id)))
      .limit(1);
    if (!m[0]) fail(404, "not_found", "Workspace not found");
    if (ROLE_RANK[m[0]!.role] < ROLE_RANK[min]) fail(403, "forbidden", `Requires ${min} role`);
    return m[0]!;
  };
  const projectFor = async (req: FastifyRequest, projectId: string, min: Role) => {
    const p = await db.select().from(projects).where(and(eq(projects.id, projectId), isNull(projects.deletedAt))).limit(1);
    if (!p[0]) fail(404, "not_found", "Project not found");
    await requireRole(req, p[0]!.workspaceId, min);
    return p[0]!;
  };
  const createWorkspace = async (ownerId: string, name: string) => {
    const id = newId("ws");
    await db.insert(workspaces).values({ id, name, ownerId });
    await db.insert(memberships).values({ workspaceId: id, userId: ownerId, role: "owner" });
    return id;
  };

  // ---------------------------------------------------------------- health / meta
  app.get("/healthz", async () => ({ ok: true }));
  app.get("/readyz", async (_req, reply) => {
    try {
      await db.execute(sql`select 1`);
      return { ok: true, storage: storage.kind, billing: stripe ? "stripe" : "disabled" };
    } catch {
      return reply.status(503).send({ ok: false });
    }
  });
  app.get("/v1/plans", async () => PLANS);

  // ---------------------------------------------------------------- identity
  const Email = z.string().email().max(200).transform((s) => s.toLowerCase().trim());
  app.post("/v1/auth/signup", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const b = z.object({ email: Email, password: z.string().min(10).max(200), name: z.string().max(80).optional(), client: z.enum(["web", "desktop"]).default("web") }).parse(req.body);
    const exists = await db.select({ id: users.id }).from(users).where(eq(users.email, b.email)).limit(1);
    if (exists[0]) fail(409, "email_taken", "An account with this email already exists");
    const id = newId("usr");
    const name = b.name || b.email.split("@")[0]!;
    await db.insert(users).values({ id, email: b.email, name, passwordHash: await hashPassword(b.password) });
    const ws = await createWorkspace(id, `${name}'s workspace`);
    const token = await issueSession(id, b.client, String(req.headers["user-agent"] ?? ""));
    req.user = { id, email: b.email, name, isAdmin: false, sessionId: "" };
    await audit(req, "user.signup", { workspaceId: ws, target: id });
    return reply.status(201).send({ token, user: { id, email: b.email, name }, workspaceId: ws });
  });
  app.post("/v1/auth/login", { config: { rateLimit: { max: 8, timeWindow: "1 minute" } } }, async (req) => {
    const b = z.object({ email: Email, password: z.string().min(1).max(200), client: z.enum(["web", "desktop"]).default("web") }).parse(req.body);
    const u = (await db.select().from(users).where(eq(users.email, b.email)).limit(1))[0];
    // do comparable work when the user does not exist (timing)
    const ok = u ? await verifyPassword(b.password, u.passwordHash) : (await hashPassword(b.password), false);
    if (!u || !ok) fail(401, "invalid_credentials", "Email or password is incorrect");
    const token = await issueSession(u!.id, b.client, String(req.headers["user-agent"] ?? ""));
    req.user = { id: u!.id, email: u!.email, name: u!.name, isAdmin: u!.isAdmin, sessionId: "" };
    await audit(req, "user.login", { target: u!.id, meta: { client: b.client } });
    return { token, user: { id: u!.id, email: u!.email, name: u!.name } };
  });
  app.post("/v1/auth/logout", auth, async (req) => {
    await db.delete(sessions).where(eq(sessions.id, req.user!.sessionId));
    return { ok: true };
  });
  app.get("/v1/me", auth, async (req) => {
    const ws = await db.select({ id: workspaces.id, name: workspaces.name, plan: workspaces.plan, role: memberships.role }).from(memberships).innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId)).where(eq(memberships.userId, req.user!.id));
    return { user: { id: req.user!.id, email: req.user!.email, name: req.user!.name, isAdmin: req.user!.isAdmin }, workspaces: ws };
  });

  // Device authorization for the desktop app (RFC 8628 style)
  app.post("/v1/auth/device/start", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async () => {
    const deviceCode = newToken();
    const code = userCode();
    await db.insert(deviceCodes).values({ deviceCodeHash: sha256(deviceCode), userCode: code, expiresAt: new Date(Date.now() + 10 * 60e3) });
    return { deviceCode, userCode: code, verificationUrl: `${cfg.webUrl}/app/device/?code=${code}`, expiresIn: 600, interval: 3 };
  });
  app.post("/v1/auth/device/approve", auth, async (req) => {
    const { userCode: code } = z.object({ userCode: z.string().trim().toUpperCase().pipe(z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)) }).parse(req.body);
    const r = await db.update(deviceCodes).set({ userId: req.user!.id }).where(and(eq(deviceCodes.userCode, code), isNull(deviceCodes.userId), gt(deviceCodes.expiresAt, new Date()), eq(deviceCodes.consumed, false))).returning();
    if (!r[0]) fail(404, "invalid_code", "That code is invalid or expired");
    await audit(req, "device.approve", { target: code });
    return { ok: true };
  });
  app.post("/v1/auth/device/poll", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { deviceCode } = z.object({ deviceCode: z.string().min(20) }).parse(req.body);
    const row = (await db.select().from(deviceCodes).where(eq(deviceCodes.deviceCodeHash, sha256(deviceCode))).limit(1))[0];
    if (!row || row.consumed || row.expiresAt < new Date()) return reply.status(400).send({ error: "expired_token", message: "Code expired, start again" });
    if (!row.userId) return reply.status(428).send({ error: "authorization_pending", message: "Waiting for approval" });
    const claimed = await db.update(deviceCodes).set({ consumed: true }).where(and(eq(deviceCodes.deviceCodeHash, row.deviceCodeHash), eq(deviceCodes.consumed, false))).returning();
    if (!claimed[0]) return reply.status(400).send({ error: "expired_token", message: "Code already used" });
    const token = await issueSession(row.userId, "desktop", String(req.headers["user-agent"] ?? ""));
    return { token };
  });

  // ---------------------------------------------------------------- workspaces & members
  app.get("/v1/workspaces", auth, async (req) =>
    db.select({ id: workspaces.id, name: workspaces.name, plan: workspaces.plan, role: memberships.role }).from(memberships).innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId)).where(eq(memberships.userId, req.user!.id)),
  );
  app.post("/v1/workspaces", auth, async (req, reply) => {
    const { name } = z.object({ name: z.string().min(1).max(80) }).parse(req.body);
    const id = await createWorkspace(req.user!.id, name);
    await audit(req, "workspace.create", { workspaceId: id });
    return reply.status(201).send({ id, name });
  });
  app.get("/v1/workspaces/:ws/members", auth, async (req) => {
    const { ws } = req.params as { ws: string };
    await requireRole(req, ws, "viewer");
    return db.select({ userId: users.id, email: users.email, name: users.name, role: memberships.role }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(eq(memberships.workspaceId, ws));
  });
  app.post("/v1/workspaces/:ws/members", auth, async (req, reply) => {
    const { ws } = req.params as { ws: string };
    const w = await requireRole(req, ws, "owner");
    const b = z.object({ email: Email, role: z.enum(["editor", "viewer"]) }).parse(req.body);
    const u = (await db.select().from(users).where(eq(users.email, b.email)).limit(1))[0];
    if (!u) fail(404, "user_not_found", "That person needs a MOTIF account first");
    const count = await db.select({ n: sql<number>`count(*)::int` }).from(memberships).where(eq(memberships.workspaceId, ws));
    if ((count[0]?.n ?? 0) >= planFor(w.plan).seats) fail(402, "seat_limit", `Your ${w.plan} plan includes ${planFor(w.plan).seats} seat(s)`);
    await db.insert(memberships).values({ workspaceId: ws, userId: u!.id, role: b.role }).onConflictDoUpdate({ target: [memberships.workspaceId, memberships.userId], set: { role: b.role } });
    await audit(req, "member.add", { workspaceId: ws, target: u!.id, meta: { role: b.role } });
    return reply.status(201).send({ ok: true });
  });

  // ---------------------------------------------------------------- cloud projects (manifest + version history)
  const Manifest = z.record(z.string(), z.unknown()).refine((m) => typeof m.schemaVersion === "number" && Array.isArray(m.tracks), "not a MOTIF project");
  app.get("/v1/workspaces/:ws/projects", auth, async (req) => {
    const { ws } = req.params as { ws: string };
    await requireRole(req, ws, "viewer");
    return db.select({ id: projects.id, title: projects.title, headVersion: projects.headVersion, updatedAt: projects.updatedAt }).from(projects).where(and(eq(projects.workspaceId, ws), isNull(projects.deletedAt))).orderBy(desc(projects.updatedAt));
  });
  app.post("/v1/workspaces/:ws/projects", auth, async (req, reply) => {
    const { ws } = req.params as { ws: string };
    const w = await requireRole(req, ws, "editor");
    const b = z.object({ title: z.string().min(1).max(200), manifest: Manifest, message: z.string().max(200).default("Initial upload") }).parse(req.body);
    const n = await db.select({ n: sql<number>`count(*)::int` }).from(projects).where(and(eq(projects.workspaceId, ws), isNull(projects.deletedAt)));
    if ((n[0]?.n ?? 0) >= planFor(w.plan).cloudProjects) fail(402, "project_limit", `Your ${w.plan} plan allows ${planFor(w.plan).cloudProjects} cloud projects`);
    const id = newId("cpj");
    const body = JSON.stringify(b.manifest);
    await db.transaction(async (tx) => {
      await tx.insert(projects).values({ id, workspaceId: ws, title: b.title, headVersion: 1, createdBy: req.user!.id });
      await tx.insert(projectVersions).values({ projectId: id, version: 1, manifest: b.manifest, sha256: sha256(body), message: b.message, createdBy: req.user!.id });
    });
    await audit(req, "project.create", { workspaceId: ws, target: id });
    return reply.status(201).send({ id, version: 1 });
  });
  app.get("/v1/projects/:id", auth, async (req) => {
    const p = await projectFor(req, (req.params as { id: string }).id, "viewer");
    const v = (await db.select().from(projectVersions).where(and(eq(projectVersions.projectId, p.id), eq(projectVersions.version, p.headVersion))).limit(1))[0]!;
    return { id: p.id, workspaceId: p.workspaceId, title: p.title, version: p.headVersion, sha256: v.sha256, manifest: v.manifest, updatedAt: p.updatedAt };
  });
  app.get("/v1/projects/:id/versions", auth, async (req) => {
    const p = await projectFor(req, (req.params as { id: string }).id, "viewer");
    return db
      .select({ version: projectVersions.version, sha256: projectVersions.sha256, message: projectVersions.message, createdBy: projectVersions.createdBy, createdAt: projectVersions.createdAt })
      .from(projectVersions)
      .where(eq(projectVersions.projectId, p.id))
      .orderBy(desc(projectVersions.version));
  });
  app.get("/v1/projects/:id/versions/:v", auth, async (req) => {
    const { id, v } = req.params as { id: string; v: string };
    const p = await projectFor(req, id, "viewer");
    const row = (await db.select().from(projectVersions).where(and(eq(projectVersions.projectId, p.id), eq(projectVersions.version, Number(v)))).limit(1))[0];
    if (!row) fail(404, "not_found", "Version not found");
    return row;
  });
  /** Optimistic concurrency: the client says which version it edited; a stale base is a 409 conflict. */
  const commitVersion = async (req: FastifyRequest, projectId: string, baseVersion: number | null, manifest: unknown, message: string, title?: string) => {
    const body = JSON.stringify(manifest);
    return db.transaction(async (tx) => {
      const cur = (await tx.select().from(projects).where(eq(projects.id, projectId)).for("update"))[0]!;
      if (baseVersion !== null && cur.headVersion !== baseVersion) fail(409, "conflict", `The cloud copy changed (now v${cur.headVersion}, you edited v${baseVersion}). Pull, keep both, or overwrite.`);
      const next = cur.headVersion + 1;
      await tx.insert(projectVersions).values({ projectId, version: next, manifest: manifest as object, sha256: sha256(body), message, createdBy: req.user!.id });
      await tx.update(projects).set({ headVersion: next, updatedAt: new Date(), ...(title ? { title } : {}) }).where(eq(projects.id, projectId));
      return next;
    });
  };
  app.put("/v1/projects/:id/manifest", auth, async (req) => {
    const p = await projectFor(req, (req.params as { id: string }).id, "editor");
    const b = z.object({ baseVersion: z.number().int().min(1), manifest: Manifest, message: z.string().max(200).default(""), title: z.string().min(1).max(200).optional(), force: z.boolean().default(false) }).parse(req.body);
    const version = await commitVersion(req, p.id, b.force ? null : b.baseVersion, b.manifest, b.message || (b.force ? "Overwrite" : "Update"), b.title);
    await audit(req, "project.update", { workspaceId: p.workspaceId, target: p.id, meta: { version, force: b.force } });
    return { id: p.id, version };
  });
  app.post("/v1/projects/:id/restore", auth, async (req) => {
    const p = await projectFor(req, (req.params as { id: string }).id, "editor");
    const { version } = z.object({ version: z.number().int().min(1) }).parse(req.body);
    const row = (await db.select().from(projectVersions).where(and(eq(projectVersions.projectId, p.id), eq(projectVersions.version, version))).limit(1))[0];
    if (!row) fail(404, "not_found", "Version not found");
    const v = await commitVersion(req, p.id, null, row!.manifest, `Restored v${version}`);
    await audit(req, "project.restore", { workspaceId: p.workspaceId, target: p.id, meta: { from: version, to: v } });
    return { id: p.id, version: v };
  });
  app.delete("/v1/projects/:id", auth, async (req) => {
    const p = await projectFor(req, (req.params as { id: string }).id, "owner");
    await db.update(projects).set({ deletedAt: new Date() }).where(eq(projects.id, p.id));
    await audit(req, "project.delete", { workspaceId: p.workspaceId, target: p.id });
    return { ok: true };
  });

  // ---------------------------------------------------------------- media transfer (signed URLs)
  const storageUsed = async (ws: string) => Number((await db.select({ n: sql<string>`coalesce(sum(size_bytes),0)` }).from(assets).where(eq(assets.workspaceId, ws)))[0]?.n ?? 0);
  app.post("/v1/workspaces/:ws/assets", auth, async (req, reply) => {
    const { ws } = req.params as { ws: string };
    const w = await requireRole(req, ws, "editor");
    const b = z.object({ name: z.string().min(1).max(255), size: z.number().int().min(0).max(50 * 1024 ** 3), sha256: z.string().regex(/^[a-f0-9]{64}$/), mime: z.string().max(100).default("application/octet-stream") }).parse(req.body);
    // dedupe: the same bytes are already in this workspace
    const dup = (await db.select().from(assets).where(and(eq(assets.workspaceId, ws), eq(assets.sha256, b.sha256), eq(assets.status, "ready"))).limit(1))[0];
    if (dup) return { assetId: dup.id, alreadyUploaded: true };
    if ((await storageUsed(ws)) + b.size > planFor(w.plan).storageBytes) fail(413, "storage_quota", `Upload exceeds your ${w.plan} plan's ${Math.round(planFor(w.plan).storageBytes / 1024 ** 3)} GB storage`);
    const id = newId("ast");
    const key = keyFor(ws, id);
    await db.insert(assets).values({ id, workspaceId: ws, name: b.name, sizeBytes: b.size, sha256: b.sha256, mime: b.mime, storageKey: key, createdBy: req.user!.id });
    const upload = await storage.signPut(key, { contentType: b.mime, size: b.size, ttlSec: 15 * 60 });
    await audit(req, "asset.upload_url", { workspaceId: ws, target: id, meta: { size: b.size } });
    return reply.status(201).send({ assetId: id, upload });
  });
  app.post("/v1/assets/:id/complete", auth, async (req) => {
    const a = (await db.select().from(assets).where(eq(assets.id, (req.params as { id: string }).id)).limit(1))[0];
    if (!a) fail(404, "not_found", "Asset not found");
    await requireRole(req, a!.workspaceId, "editor");
    const obj = await storage.head(a!.storageKey);
    if (!obj) fail(409, "not_uploaded", "The file has not been uploaded yet");
    if (obj!.size !== a!.sizeBytes || (obj!.sha256 && obj!.sha256 !== a!.sha256)) {
      await storage.delete(a!.storageKey);
      fail(422, "integrity", "Uploaded bytes do not match the declared size/checksum");
    }
    await db.update(assets).set({ status: "ready" }).where(eq(assets.id, a!.id));
    return { assetId: a!.id, status: "ready" };
  });
  app.get("/v1/assets/:id/download", auth, async (req) => {
    const a = (await db.select().from(assets).where(eq(assets.id, (req.params as { id: string }).id)).limit(1))[0];
    if (!a) fail(404, "not_found", "Asset not found");
    await requireRole(req, a!.workspaceId, "viewer");
    if (a!.status !== "ready") fail(409, "not_ready", "Upload not finished");
    return { assetId: a!.id, name: a!.name, size: a!.sizeBytes, sha256: a!.sha256, download: await storage.signGet(a!.storageKey, { ttlSec: 15 * 60, filename: a!.name }) };
  });
  app.get("/v1/workspaces/:ws/assets", auth, async (req) => {
    const { ws } = req.params as { ws: string };
    await requireRole(req, ws, "viewer");
    return db.select({ id: assets.id, name: assets.name, size: assets.sizeBytes, sha256: assets.sha256, status: assets.status }).from(assets).where(eq(assets.workspaceId, ws)).orderBy(desc(assets.createdAt));
  });
  if (storage instanceof LocalStorage) {
    const local = storage;
    app.put("/v1/storage/*", { bodyLimit: 50 * 1024 ** 3 }, async (req: FastifyRequest, reply: FastifyReply) => {
      const key = (req.params as { "*": string })["*"];
      const q = req.query as { exp?: string; sig?: string; size?: string };
      const err = local.verify("PUT", key, q);
      if (err) return reply.status(403).send({ error: "forbidden", message: err });
      try {
        const r = await local.write(key, req.body as any, Number(q.size));
        return { ok: true, size: r.size };
      } catch (e: any) {
        return reply.status(413).send({ error: "too_large", message: e.message });
      }
    });
    app.get("/v1/storage/*", async (req: FastifyRequest, reply: FastifyReply) => {
      const key = (req.params as { "*": string })["*"];
      const err = local.verify("GET", key, req.query as { exp?: string; sig?: string });
      if (err) return reply.status(403).send({ error: "forbidden", message: err });
      const h = await local.head(key);
      if (!h) return reply.status(404).send({ error: "not_found", message: "No such object" });
      reply.header("content-length", h.size).header("content-type", "application/octet-stream");
      return reply.send(local.read(key));
    });
  }

  // ---------------------------------------------------------------- entitlements, usage & billing
  const entitlements = async (ws: string, plan: Plan) => {
    const since = new Date(Date.now() - 30 * 864e5);
    const usage = await db.select({ kind: usageLedger.kind, total: sql<string>`sum(amount)` }).from(usageLedger).where(and(eq(usageLedger.workspaceId, ws), gt(usageLedger.createdAt, since))).groupBy(usageLedger.kind);
    const u = Object.fromEntries(usage.map((r) => [r.kind, Number(r.total)]));
    const sub = (await db.select().from(subscriptions).where(eq(subscriptions.workspaceId, ws)).limit(1))[0];
    return {
      plan,
      limits: planFor(plan),
      usage: { exportSeconds30d: u.export_seconds ?? 0, aiSeconds30d: u.ai_seconds ?? 0, storageBytes: await storageUsed(ws) },
      subscription: sub ? { status: sub.status, currentPeriodEnd: sub.currentPeriodEnd } : null,
      billingEnabled: !!stripe,
    };
  };
  app.get("/v1/workspaces/:ws/entitlements", auth, async (req) => {
    const { ws } = req.params as { ws: string };
    const w = await requireRole(req, ws, "viewer");
    return entitlements(ws, w.plan);
  });
  app.post("/v1/workspaces/:ws/usage", auth, async (req) => {
    const { ws } = req.params as { ws: string };
    const w = await requireRole(req, ws, "editor");
    const b = z.object({ kind: z.enum(["export_seconds", "ai_seconds"]), amount: z.number().int().min(0).max(86400), ref: z.string().min(4).max(100) }).parse(req.body);
    const already = await db.select({ id: usageLedger.id }).from(usageLedger).where(and(eq(usageLedger.workspaceId, ws), eq(usageLedger.kind, b.kind), eq(usageLedger.ref, b.ref))).limit(1);
    if (already[0]) return { ok: true, duplicate: true };
    const e = await entitlements(ws, w.plan);
    const used = b.kind === "ai_seconds" ? e.usage.aiSeconds30d : e.usage.exportSeconds30d;
    const limit = b.kind === "ai_seconds" ? e.limits.aiSecondsPerMonth : e.limits.exportSecondsPerMonth;
    if (used + b.amount > limit) fail(402, "quota_exceeded", `This would exceed your monthly ${b.kind === "ai_seconds" ? "cloud AI" : "export"} allowance`);
    await db.insert(usageLedger).values({ workspaceId: ws, kind: b.kind, amount: b.amount, ref: b.ref }).onConflictDoNothing();
    return { ok: true };
  });
  app.post("/v1/workspaces/:ws/billing/checkout", auth, async (req) => {
    const { ws } = req.params as { ws: string };
    await requireRole(req, ws, "owner");
    const { plan } = z.object({ plan: z.enum(["pro", "team"]) }).parse(req.body);
    if (!stripe) fail(503, "billing_disabled", "Billing is not configured on this server (set STRIPE_SECRET_KEY)");
    const price = cfg.stripe?.prices[plan];
    if (!price) fail(503, "billing_disabled", `No Stripe price configured for ${plan}`);
    const s = await stripe!.checkout.sessions.create({ mode: "subscription", line_items: [{ price: price!, quantity: 1 }], client_reference_id: ws, metadata: { workspaceId: ws, plan }, success_url: `${cfg.webUrl}/app/billing/?ok=1`, cancel_url: `${cfg.webUrl}/app/billing/` });
    await audit(req, "billing.checkout", { workspaceId: ws, meta: { plan } });
    return { url: s.url };
  });
  app.post("/v1/workspaces/:ws/billing/portal", auth, async (req) => {
    const { ws } = req.params as { ws: string };
    await requireRole(req, ws, "owner");
    const w = (await db.select().from(workspaces).where(eq(workspaces.id, ws)))[0]!;
    if (!stripe) fail(503, "billing_disabled", "Billing is not configured on this server");
    if (!w.stripeCustomerId) fail(409, "no_customer", "No subscription yet");
    const s = await stripe!.billingPortal.sessions.create({ customer: w.stripeCustomerId!, return_url: `${cfg.webUrl}/app/billing/` });
    return { url: s.url };
  });
  /** Stripe webhook: signature-verified, idempotent (webhook_events), drives the workspace plan. */
  app.post("/v1/billing/webhook", async (req, reply) => {
    const secret = cfg.stripe?.webhookSecret;
    if (!secret) return reply.status(503).send({ error: "billing_disabled", message: "Webhook secret not configured" });
    let event: Stripe.Event;
    try {
      event = webhookVerifier.webhooks.constructEvent(req.rawBody ?? Buffer.alloc(0), String(req.headers["stripe-signature"] ?? ""), secret);
    } catch (e: any) {
      return reply.status(400).send({ error: "bad_signature", message: e.message });
    }
    const fresh = await db.insert(webhookEvents).values({ id: event.id, type: event.type }).onConflictDoNothing().returning();
    if (!fresh[0]) return { received: true, duplicate: true };
    const setPlan = async (ws: string, plan: Plan, status: string, subId: string | null, periodEnd: number | null, customer?: string | null) => {
      await db.update(workspaces).set({ plan, ...(customer ? { stripeCustomerId: customer } : {}) }).where(eq(workspaces.id, ws));
      const end = periodEnd ? new Date(periodEnd * 1000) : null;
      await db
        .insert(subscriptions)
        .values({ workspaceId: ws, stripeSubscriptionId: subId, status, plan, currentPeriodEnd: end })
        .onConflictDoUpdate({ target: subscriptions.workspaceId, set: { stripeSubscriptionId: subId, status, plan, currentPeriodEnd: end, updatedAt: new Date() } });
      await db.insert(auditLog).values({ workspaceId: ws, action: "billing.plan_changed", meta: { plan, status, event: event.id } });
    };
    const priceToPlan = (priceId?: string): Plan => (Object.entries(cfg.stripe?.prices ?? {}).find(([, p]) => p && p === priceId)?.[0] as Plan) ?? "pro";
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object as Stripe.Checkout.Session;
        const ws = s.client_reference_id ?? s.metadata?.workspaceId;
        if (ws) await setPlan(ws, ((s.metadata?.plan as Plan) ?? "pro"), "active", typeof s.subscription === "string" ? s.subscription : null, null, typeof s.customer === "string" ? s.customer : null);
        break;
      }
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const ws = (await db.select().from(workspaces).where(eq(workspaces.stripeCustomerId, String(sub.customer))).limit(1))[0];
        if (!ws) break;
        const active = event.type === "customer.subscription.updated" && ["active", "trialing", "past_due"].includes(sub.status);
        const periodEnd = (sub as any).current_period_end ?? (sub.items?.data?.[0] as any)?.current_period_end ?? null;
        await setPlan(ws.id, active ? priceToPlan(sub.items?.data?.[0]?.price?.id) : "free", sub.status, sub.id, periodEnd);
        break;
      }
    }
    return { received: true };
  });

  // ---------------------------------------------------------------- audit & admin
  app.get("/v1/workspaces/:ws/audit", auth, async (req) => {
    const { ws } = req.params as { ws: string };
    await requireRole(req, ws, "owner");
    return db.select().from(auditLog).where(eq(auditLog.workspaceId, ws)).orderBy(desc(auditLog.id)).limit(200);
  });
  const admin = {
    preHandler: async (req: FastifyRequest) => {
      const u = await requireUser(req);
      if (!u.isAdmin) fail(403, "forbidden", "Admins only");
    },
  };
  app.get("/v1/admin/stats", admin, async () => {
    const [u] = await db.select({ n: sql<number>`count(*)::int` }).from(users);
    const [w] = await db.select({ n: sql<number>`count(*)::int` }).from(workspaces);
    const [p] = await db.select({ n: sql<number>`count(*)::int` }).from(projects).where(isNull(projects.deletedAt));
    const plans = await db.select({ plan: workspaces.plan, n: sql<number>`count(*)::int` }).from(workspaces).groupBy(workspaces.plan);
    return { users: u!.n, workspaces: w!.n, projects: p!.n, plans };
  });
  app.get("/v1/admin/users", admin, async () => db.select({ id: users.id, email: users.email, name: users.name, isAdmin: users.isAdmin, createdAt: users.createdAt }).from(users).orderBy(desc(users.createdAt)).limit(500));
  app.post("/v1/admin/workspaces/:ws/plan", admin, async (req) => {
    const { ws } = req.params as { ws: string };
    const { plan } = z.object({ plan: z.enum(["free", "pro", "team"]) }).parse(req.body);
    const r = await db.update(workspaces).set({ plan }).where(eq(workspaces.id, ws)).returning();
    if (!r[0]) fail(404, "not_found", "Workspace not found");
    await audit(req, "admin.set_plan", { workspaceId: ws, meta: { plan } });
    return { ok: true };
  });
  app.get("/v1/admin/audit", admin, async () => db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(500));

  return app;
}
