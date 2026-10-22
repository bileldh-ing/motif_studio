-- MOTIF cloud schema v1. Media bytes live in object storage; rows hold metadata, hashes and keys.
CREATE TABLE users (
  id            text PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  name          text NOT NULL DEFAULT '',
  password_hash text NOT NULL,
  is_admin      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  kind        text NOT NULL CHECK (kind IN ('web', 'desktop')),
  user_agent  text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE device_codes (
  device_code_hash text PRIMARY KEY,
  user_code        text NOT NULL UNIQUE,
  user_id          text REFERENCES users(id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  consumed         boolean NOT NULL DEFAULT false
);

CREATE TABLE workspaces (
  id                 text PRIMARY KEY,
  name               text NOT NULL,
  owner_id           text NOT NULL REFERENCES users(id),
  plan               text NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'team')),
  stripe_customer_id text UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships(user_id);

CREATE TABLE projects (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title        text NOT NULL,
  head_version integer NOT NULL DEFAULT 0,
  created_by   text NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE INDEX projects_ws_idx ON projects(workspace_id) WHERE deleted_at IS NULL;

CREATE TABLE project_versions (
  project_id   text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version      integer NOT NULL,
  manifest     jsonb NOT NULL,
  sha256       text NOT NULL,
  message      text NOT NULL DEFAULT '',
  created_by   text NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, version)
);

CREATE TABLE assets (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL,
  size_bytes   bigint NOT NULL CHECK (size_bytes >= 0),
  sha256       text NOT NULL,
  mime         text NOT NULL,
  storage_key  text NOT NULL UNIQUE,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready')),
  created_by   text NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assets_ws_sha_idx ON assets(workspace_id, sha256);

CREATE TABLE subscriptions (
  workspace_id           text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  stripe_subscription_id text UNIQUE,
  status                 text NOT NULL,
  plan                   text NOT NULL,
  current_period_end     timestamptz,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE usage_ledger (
  id           bigserial PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('export_seconds', 'ai_seconds', 'storage_bytes')),
  amount       bigint NOT NULL,
  ref          text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, kind, ref)
);

CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  workspace_id text,
  actor_id     text,
  action       text NOT NULL,
  target       text NOT NULL DEFAULT '',
  meta         jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip           text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_ws_idx ON audit_log(workspace_id, created_at DESC);

CREATE TABLE webhook_events (
  id           text PRIMARY KEY,
  type         text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);
