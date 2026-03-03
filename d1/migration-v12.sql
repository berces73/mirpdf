-- ============================================================
-- D1 Migration v12: Performance indexes + Monitoring table
-- Run with: wrangler d1 execute pdf-platform-db --file=./d1/migration-v12.sql
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- COMPOSITE INDEXES for analytics_events
-- These dramatically speed up admin dashboard + funnel queries
-- ─────────────────────────────────────────────────────────────

-- Event + time (most common admin query pattern)
CREATE INDEX IF NOT EXISTS idx_events_event_created
  ON analytics_events(event, created_at DESC);

-- Tool funnel: filter by tool + event in date range
CREATE INDEX IF NOT EXISTS idx_events_tool_event_created
  ON analytics_events(tool, event, created_at DESC);

-- User journey: all events for a user in time order
CREATE INDEX IF NOT EXISTS idx_events_user_created
  ON analytics_events(user_id, created_at DESC);

-- Session analysis
CREATE INDEX IF NOT EXISTS idx_events_session_created
  ON analytics_events(session_id, created_at DESC);

-- Revenue queries (purchases only)
CREATE INDEX IF NOT EXISTS idx_events_revenue_created
  ON analytics_events(plan_type, created_at DESC)
  WHERE revenue IS NOT NULL;

-- ─────────────────────────────────────────────────────────────
-- COMPOSITE INDEXES for jobs
-- ─────────────────────────────────────────────────────────────

-- Tool performance dashboard: filter by tool + status + time
CREATE INDEX IF NOT EXISTS idx_jobs_tool_status_created
  ON jobs(tool, status, created_at DESC);

-- Batch status check: all jobs for a batch sorted by time
-- (replaces separate idx_jobs_batch_id — adds status for filter pushdown)
CREATE INDEX IF NOT EXISTS idx_jobs_batch_status
  ON jobs(batch_id, status)
  WHERE batch_id IS NOT NULL;

-- Cleanup cron: find expired jobs efficiently
CREATE INDEX IF NOT EXISTS idx_jobs_ttl_cleanup
  ON jobs(created_at, ttl_seconds)
  WHERE input_key IS NOT NULL OR output_key IS NOT NULL;

-- ─────────────────────────────────────────────────────────────
-- MONITORING TABLE
-- Stores alert history so admin can audit past alerts
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS monitoring_alerts (
  alert_id   TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,   -- queue_backlog | batch_failure | error_rate | stripe_webhook
  severity   TEXT NOT NULL,   -- warning | error | critical
  value      REAL,            -- the metric value that triggered the alert
  threshold  REAL,            -- the configured threshold
  detail     TEXT,            -- JSON metadata
  resolved   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_alerts_kind_created
  ON monitoring_alerts(kind, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_alerts_resolved_created
  ON monitoring_alerts(resolved, created_at DESC);

-- ─────────────────────────────────────────────────────────────
-- SUBSCRIPTIONS TABLE (referenced in adminHealth but missing)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subscriptions (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,
  stripe_sub_id       TEXT UNIQUE,
  stripe_customer_id  TEXT,
  plan                TEXT NOT NULL,   -- basic | pro
  status              TEXT NOT NULL,   -- active | canceled | past_due
  current_period_end  INTEGER,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subs_stripe_sub ON subscriptions(stripe_sub_id);
CREATE INDEX IF NOT EXISTS idx_subs_status ON subscriptions(status, updated_at DESC);
