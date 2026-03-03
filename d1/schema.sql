-- D1 schema (Hybrid SaaS + Jobs)
-- If you already deployed a previous schema, you must migrate with ALTER TABLE statements (see README).

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  pass_salt TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'free',
  email_verified INTEGER NOT NULL DEFAULT 0,
  stripe_customer_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS credits (
  user_id TEXT PRIMARY KEY,
  balance INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,           -- purchase | usage | refund
  amount INTEGER NOT NULL,
  stripe_session_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tx_user_created ON transactions(user_id, created_at DESC);

-- Jobs table (Worker expects these columns)
CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  batch_id TEXT,
  tool TEXT NOT NULL,
  status TEXT NOT NULL,         -- pending | running | done | failed
  input_key TEXT NOT NULL,
  output_key TEXT,
  output_bytes INTEGER,
  error_message TEXT,
  client_id TEXT,
  ttl_seconds INTEGER NOT NULL,
  cost INTEGER NOT NULL DEFAULT 1,
  op_id TEXT,
  credits_deducted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_client_created ON jobs(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_status_updated ON jobs(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_batch_id ON jobs(batch_id);
CREATE INDEX IF NOT EXISTS idx_jobs_client_batch ON jobs(client_id, batch_id);

-- Programmatic SEO pages
CREATE TABLE IF NOT EXISTS seo_pages (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  h1 TEXT,
  content TEXT NOT NULL,
  tool_name TEXT,
  keyword TEXT,
  schema_json TEXT,
  last_updated TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seo_pages_updated ON seo_pages(last_updated DESC);


-- Email verification tokens
CREATE TABLE IF NOT EXISTS email_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON email_tokens(user_id);

-- Password reset tokens
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pwreset_user ON password_resets(user_id);


-- ============================================================
-- Analytics events (Programmatic SEO + funnel + revenue)
-- ============================================================
CREATE TABLE IF NOT EXISTS analytics_events (
  event_id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  client_id TEXT,
  user_id TEXT,
  session_id TEXT,
  ip TEXT,
  user_agent TEXT,
  tool TEXT,
  job_id TEXT,
  batch_id TEXT,
  plan_type TEXT,
  revenue REAL,
  metadata TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_event ON analytics_events(event);
CREATE INDEX IF NOT EXISTS idx_events_client ON analytics_events(client_id);
CREATE INDEX IF NOT EXISTS idx_events_user ON analytics_events(user_id);
CREATE INDEX IF NOT EXISTS idx_events_tool ON analytics_events(tool);
CREATE INDEX IF NOT EXISTS idx_events_created ON analytics_events(created_at);
CREATE INDEX IF NOT EXISTS idx_events_event_created ON analytics_events(event, created_at);
CREATE INDEX IF NOT EXISTS idx_events_tool_created ON analytics_events(tool, created_at);

-- ============================================================
-- Monitoring & Alerting
-- ============================================================

CREATE TABLE IF NOT EXISTS webhook_failures (
  id TEXT PRIMARY KEY,
  event_id TEXT,
  event_type TEXT,
  status INTEGER,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_webhook_failures_created ON webhook_failures(created_at);
CREATE INDEX IF NOT EXISTS idx_webhook_failures_type ON webhook_failures(event_type);

CREATE TABLE IF NOT EXISTS monitoring_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_monitoring_events_created ON monitoring_events(created_at);
CREATE INDEX IF NOT EXISTS idx_monitoring_events_kind ON monitoring_events(kind);

-- ============================================================
-- KVKK/GDPR deletion logs (proof of deletion)
-- ============================================================
CREATE TABLE IF NOT EXISTS deletion_log (
  log_id TEXT PRIMARY KEY,
  job_id TEXT,
  file_key TEXT,
  bucket TEXT,
  reason TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deletion_log_job ON deletion_log(job_id);
CREATE INDEX IF NOT EXISTS idx_deletion_log_created ON deletion_log(created_at);

-- ============================================================
-- Phase 1 additions
-- ============================================================

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  ip TEXT,
  user_agent TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_exp ON refresh_tokens(expires_at);

CREATE TABLE IF NOT EXISTS processed_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT,
  received_at INTEGER NOT NULL,
  raw_sha256 TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_client_batch_created ON jobs(client_id, batch_id, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_client_status_updated ON jobs(client_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_analytics_client_event_created ON analytics_events(client_id, event, created_at);


-- Phase 5: Revenue Attribution + Dashboard
CREATE TABLE IF NOT EXISTS attribution_sessions (
  attribution_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  landing_path TEXT,
  seo_slug TEXT,
  keyword TEXT,
  tool_name TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_term TEXT,
  utm_content TEXT,
  referrer TEXT,
  gclid TEXT,
  fbclid TEXT,
  msclkid TEXT
);
CREATE INDEX IF NOT EXISTS idx_attr_seen ON attribution_sessions(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_attr_keyword ON attribution_sessions(keyword);

CREATE TABLE IF NOT EXISTS revenue_events (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  kind TEXT NOT NULL, -- payment | subscription_invoice
  user_id TEXT,
  stripe_object_id TEXT,
  attribution_id TEXT,
  plan TEXT,
  amount INTEGER NOT NULL,
  currency TEXT,
  keyword TEXT,
  seo_slug TEXT,
  tool_name TEXT,
  utm_source TEXT,
  utm_campaign TEXT,
  utm_term TEXT
);
CREATE INDEX IF NOT EXISTS idx_rev_created ON revenue_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rev_keyword ON revenue_events(keyword);
CREATE INDEX IF NOT EXISTS idx_rev_slug ON revenue_events(seo_slug);
CREATE INDEX IF NOT EXISTS idx_rev_tool ON revenue_events(tool_name);
