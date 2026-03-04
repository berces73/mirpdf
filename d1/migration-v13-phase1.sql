-- ============================================================
-- PDF Platform v13 (Phase 1) — Core Stabilization
-- Adds:
-- 1) refresh_tokens table (for httpOnly refresh token rotation)
-- 2) processed_events table (Stripe idempotency / replay safety)
-- 3) composite indexes for jobs + analytics
-- ============================================================

-- Refresh tokens
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

-- Stripe idempotency
CREATE TABLE IF NOT EXISTS processed_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT,
  received_at INTEGER NOT NULL,
  raw_sha256 TEXT
);

-- Composite index audit
CREATE INDEX IF NOT EXISTS idx_jobs_client_batch_created ON jobs(client_id, batch_id, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_client_status_updated ON jobs(client_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_analytics_client_event_created ON analytics_events(client_id, event, created_at);
