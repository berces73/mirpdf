-- Migration v15: SEO batch generator fields
-- Adds keyword + schema_json to seo_pages if missing.

-- keyword
ALTER TABLE seo_pages ADD COLUMN keyword TEXT;

-- schema_json
ALTER TABLE seo_pages ADD COLUMN schema_json TEXT;

-- indexes
CREATE INDEX IF NOT EXISTS idx_seo_pages_slug ON seo_pages(slug);
CREATE INDEX IF NOT EXISTS idx_seo_pages_tool ON seo_pages(tool_name);
