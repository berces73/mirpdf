-- v14 Phase 3+4: Reliability + Programmatic SEO
ALTER TABLE jobs ADD COLUMN credits_deducted INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS seo_pages (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  h1 TEXT,
  content TEXT NOT NULL,
  tool_name TEXT,
  last_updated TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seo_pages_updated ON seo_pages(last_updated DESC);
