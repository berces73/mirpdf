/**
 * PDF3 Attribution (client-side)
 * - Captures UTM/GCLID parameters + referrer + page context
 * - Persists to localStorage + cookie
 * - Exposes: window.PDF3_ATTR.get()
 */
(function(){
  const KEY = "pdf3_attr_v1";
  const COOKIE = "pdf3_attr";
  const MAX_AGE_DAYS = 30;

  function now(){ return Date.now(); }
  function safeGetLS(){
    try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch(_) { return null; }
  }
  function safeSetLS(v){
    try { localStorage.setItem(KEY, JSON.stringify(v)); } catch(_) {}
  }
  function setCookie(name, value, days){
    try{
      const d = new Date();
      d.setTime(d.getTime() + days*24*60*60*1000);
      document.cookie = `${name}=${encodeURIComponent(value)}; expires=${d.toUTCString()}; path=/; SameSite=Lax`;
    }catch(_){}
  }
  function readCookie(name){
    try{
      const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([.$?*|{}()[\]\\/+^])/g,'\\$1') + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : null;
    }catch(_){ return null; }
  }
  function uuid(){
    try { return crypto.randomUUID(); } catch(_) { return (now().toString(36)+Math.random().toString(36).slice(2)); }
  }

  function pickMeta(name){
    const el = document.querySelector(`meta[name="${name}"]`);
    return el ? (el.getAttribute("content") || "") : "";
  }

  function parse(){
    const u = new URL(location.href);
    const p = u.searchParams;

    const tool_name = pickMeta("pdf3:tool") || "";
    const keyword = pickMeta("pdf3:keyword") || "";
    const seo_slug = pickMeta("pdf3:seo_slug") || (location.pathname.startsWith("/seo/") ? location.pathname.slice(5).replace(/^\/+|\/+$/g,"") : "");
    const landing_path = location.pathname + location.search;

    return {
      attribution_id: null,
      created_at: now(),
      last_seen_at: now(),
      landing_path,
      seo_slug: seo_slug || null,
      keyword: keyword || null,
      tool_name: tool_name || null,
      utm_source: p.get("utm_source") || null,
      utm_medium: p.get("utm_medium") || null,
      utm_campaign: p.get("utm_campaign") || null,
      utm_term: p.get("utm_term") || null,
      utm_content: p.get("utm_content") || null,
      gclid: p.get("gclid") || null,
      fbclid: p.get("fbclid") || null,
      msclkid: p.get("msclkid") || null,
      referrer: document.referrer || null,
    };
  }

  function merge(base, inc){
    const out = { ...(base||{}) };
    for (const k of Object.keys(inc||{})){
      const v = inc[k];
      if (v !== null && v !== "" && v !== undefined) out[k]=v;
    }
    out.last_seen_at = now();
    if (!out.attribution_id) out.attribution_id = uuid();
    if (!out.created_at) out.created_at = now();
    return out;
  }

  function init(){
    const existing = safeGetLS() || (()=>{ 
      const c = readCookie(COOKIE);
      if (!c) return null;
      try { return JSON.parse(c); } catch(_) { return null; }
    })();

    const inc = parse();
    const merged = merge(existing, inc);
    safeSetLS(merged);
    setCookie(COOKIE, JSON.stringify(merged), MAX_AGE_DAYS);
    return merged;
  }

  const state = init();

  window.PDF3_ATTR = {
    get(){ return safeGetLS() || state; },
    clear(){
      try{ localStorage.removeItem(KEY);}catch(_){}
      setCookie(COOKIE, "", -1);
    }
  };
})();
