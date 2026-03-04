-- ============================================================
-- PDF Platform — D1 Schema
-- Uygula: wrangler d1 execute mirpdf-db --file=schema.sql --remote --config wrangler.worker.toml
-- ============================================================

-- ── Jobs tablosu ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS jobs (
  job_id        TEXT PRIMARY KEY,
  batch_id      TEXT,
  client_id     TEXT NOT NULL,
  tool          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  input_key     TEXT,
  output_key    TEXT,
  ttl_seconds   INTEGER DEFAULT 3600,
  cost          INTEGER DEFAULT 0,
  op_id         TEXT UNIQUE,
  error_message TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_client       ON jobs (client_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status       ON jobs (status);
CREATE INDEX IF NOT EXISTS idx_jobs_expires      ON jobs (expires_at);
CREATE INDEX IF NOT EXISTS idx_jobs_batch_id     ON jobs (batch_id);
CREATE INDEX IF NOT EXISTS idx_jobs_client_batch ON jobs (client_id, batch_id);

-- ── Pro planlar (Stripe webhook buraya yazar) ─────────────────
CREATE TABLE IF NOT EXISTS pro_plans (
  client_id       TEXT PRIMARY KEY,
  stripe_customer TEXT,
  stripe_sub      TEXT,
  active          INTEGER NOT NULL DEFAULT 0,  -- 1 = aktif
  activated_at    INTEGER,
  renewed_at      INTEGER,
  cancelled_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_pro_customer ON pro_plans (stripe_customer);

-- ── Stripe event idempotency ──────────────────────────────────
CREATE TABLE IF NOT EXISTS stripe_events (
  event_id    TEXT PRIMARY KEY,
  processed   INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);

-- ── KVKK cleanup log ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cleanup_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     TEXT    NOT NULL,
  deleted_at INTEGER NOT NULL,
  reason     TEXT    NOT NULL DEFAULT 'expired'  -- expired | manual
);

-- ── Users / Auth (SaaS) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                 TEXT PRIMARY KEY,        -- uuid
  email              TEXT UNIQUE NOT NULL,
  pass_salt          TEXT NOT NULL,
  pass_hash          TEXT NOT NULL,
  role               TEXT NOT NULL DEFAULT 'free', -- free | pro | admin
  email_verified     INTEGER NOT NULL DEFAULT 0,
  stripe_customer_id TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS credits (
  user_id     TEXT PRIMARY KEY,
  balance     INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS transactions (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  kind              TEXT NOT NULL,            -- purchase | grant | consume | refund | subscription
  amount            INTEGER NOT NULL,
  stripe_session_id TEXT,
  created_at        INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_time ON transactions(created_at);

CREATE TABLE IF NOT EXISTS email_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  token_hash  TEXT NOT NULL,
  purpose     TEXT NOT NULL DEFAULT 'verify',
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON email_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_email_tokens_hash ON email_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_email_tokens_exp  ON email_tokens(expires_at);

CREATE TABLE IF NOT EXISTS password_resets (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  token_hash  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);
CREATE INDEX IF NOT EXISTS idx_password_resets_hash ON password_resets(token_hash);
CREATE INDEX IF NOT EXISTS idx_password_resets_exp  ON password_resets(expires_at);

-- ── Refresh Tokens (JWT refresh / rotation) ───────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id               TEXT PRIMARY KEY,          -- uuid
  user_id          TEXT NOT NULL,
  token_hash       TEXT NOT NULL,             -- sha256(token)
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  revoked_at       INTEGER,                   -- null = active
  ip               TEXT,
  user_agent       TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_exp  ON refresh_tokens(expires_at);