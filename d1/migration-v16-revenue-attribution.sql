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
