import { safeString } from "./util.js";

export function normalizeAttribution(input) {
  const a = input && typeof input === "object" ? input : {};
  const out = {
    attribution_id: safeString(a.attribution_id, 64) || null,
    landing_path: safeString(a.landing_path, 256) || null,
    seo_slug: safeString(a.seo_slug, 128) || null,
    keyword: safeString(a.keyword, 128) || null,
    tool_name: safeString(a.tool_name, 64) || null,
    utm_source: safeString(a.utm_source, 64) || null,
    utm_medium: safeString(a.utm_medium, 64) || null,
    utm_campaign: safeString(a.utm_campaign, 64) || null,
    utm_term: safeString(a.utm_term, 64) || null,
    utm_content: safeString(a.utm_content, 64) || null,
    referrer: safeString(a.referrer, 256) || null,
    gclid: safeString(a.gclid, 128) || null,
    fbclid: safeString(a.fbclid, 128) || null,
    msclkid: safeString(a.msclkid, 128) || null,
  };
  return out;
}

export async function upsertAttribution(env, attr) {
  const a = normalizeAttribution(attr);
  if (!a.attribution_id) return null;
  const now = Date.now();
  await env.DB.prepare(`
    INSERT INTO attribution_sessions (
      attribution_id, created_at, last_seen_at, landing_path, seo_slug, keyword, tool_name,
      utm_source, utm_medium, utm_campaign, utm_term, utm_content, referrer, gclid, fbclid, msclkid
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
    ON CONFLICT(attribution_id) DO UPDATE SET
      last_seen_at=excluded.last_seen_at,
      landing_path=COALESCE(excluded.landing_path, attribution_sessions.landing_path),
      seo_slug=COALESCE(excluded.seo_slug, attribution_sessions.seo_slug),
      keyword=COALESCE(excluded.keyword, attribution_sessions.keyword),
      tool_name=COALESCE(excluded.tool_name, attribution_sessions.tool_name),
      utm_source=COALESCE(excluded.utm_source, attribution_sessions.utm_source),
      utm_medium=COALESCE(excluded.utm_medium, attribution_sessions.utm_medium),
      utm_campaign=COALESCE(excluded.utm_campaign, attribution_sessions.utm_campaign),
      utm_term=COALESCE(excluded.utm_term, attribution_sessions.utm_term),
      utm_content=COALESCE(excluded.utm_content, attribution_sessions.utm_content),
      referrer=COALESCE(excluded.referrer, attribution_sessions.referrer),
      gclid=COALESCE(excluded.gclid, attribution_sessions.gclid),
      fbclid=COALESCE(excluded.fbclid, attribution_sessions.fbclid),
      msclkid=COALESCE(excluded.msclkid, attribution_sessions.msclkid)
  `).bind(
    a.attribution_id, now, now, a.landing_path, a.seo_slug, a.keyword, a.tool_name,
    a.utm_source, a.utm_medium, a.utm_campaign, a.utm_term, a.utm_content, a.referrer, a.gclid, a.fbclid, a.msclkid
  ).run();
  return a.attribution_id;
}
