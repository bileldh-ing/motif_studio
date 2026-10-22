/** Drizzle table definitions mirroring migrations/*.sql (the SQL files are the source of truth for DDL). */
import { pgTable, text, boolean, timestamp, integer, jsonb, bigint, bigserial, primaryKey } from "drizzle-orm/pg-core";

const ts = (n: string) => timestamp(n, { withTimezone: true, mode: "date" });

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull().default(""),
  passwordHash: text("password_hash").notNull(),
  isAdmin: boolean("is_admin").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  kind: text("kind").$type<"web" | "desktop">().notNull(),
  userAgent: text("user_agent").notNull().default(""),
  createdAt: ts("created_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
});

export const deviceCodes = pgTable("device_codes", {
  deviceCodeHash: text("device_code_hash").primaryKey(),
  userCode: text("user_code").notNull().unique(),
  userId: text("user_id"),
  createdAt: ts("created_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
  consumed: boolean("consumed").notNull().default(false),
});

export type Plan = "free" | "pro" | "team";
export type Role = "owner" | "editor" | "viewer";

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  ownerId: text("owner_id").notNull(),
  plan: text("plan").$type<Plan>().notNull().default("free"),
  stripeCustomerId: text("stripe_customer_id"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const memberships = pgTable(
  "memberships",
  {
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role").$type<Role>().notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  title: text("title").notNull(),
  headVersion: integer("head_version").notNull().default(0),
  createdBy: text("created_by").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  deletedAt: ts("deleted_at"),
});

export const projectVersions = pgTable(
  "project_versions",
  {
    projectId: text("project_id").notNull(),
    version: integer("version").notNull(),
    manifest: jsonb("manifest").notNull(),
    sha256: text("sha256").notNull(),
    message: text("message").notNull().default(""),
    createdBy: text("created_by").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.version] })],
);

export const assets = pgTable("assets", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  name: text("name").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  sha256: text("sha256").notNull(),
  mime: text("mime").notNull(),
  storageKey: text("storage_key").notNull().unique(),
  status: text("status").$type<"pending" | "ready">().notNull().default("pending"),
  createdBy: text("created_by").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const subscriptions = pgTable("subscriptions", {
  workspaceId: text("workspace_id").primaryKey(),
  stripeSubscriptionId: text("stripe_subscription_id"),
  status: text("status").notNull(),
  plan: text("plan").$type<Plan>().notNull(),
  currentPeriodEnd: ts("current_period_end"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const usageLedger = pgTable("usage_ledger", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  kind: text("kind").$type<"export_seconds" | "ai_seconds" | "storage_bytes">().notNull(),
  amount: bigint("amount", { mode: "number" }).notNull(),
  ref: text("ref").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const auditLog = pgTable("audit_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  workspaceId: text("workspace_id"),
  actorId: text("actor_id"),
  action: text("action").notNull(),
  target: text("target").notNull().default(""),
  meta: jsonb("meta").notNull().default({}),
  ip: text("ip").notNull().default(""),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const webhookEvents = pgTable("webhook_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  processedAt: ts("processed_at").notNull().defaultNow(),
});
