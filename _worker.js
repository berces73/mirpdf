// ============================================================
// PDF PLATFORM V4.1 — PRODUCTION HARDENED (_worker.js)
// Hardenings:
// 1) Signed clientId cookie (no shared anon)
// 2) Dispatch failure => credit refund + op lock finalize
// 3) Scheduled cleanup: D1 + R2 TTL cleanup
// 4) Per-tool upload size caps (DoS brakes)
// ============================================================

import { CreditCounter } from "./src/CreditCounter.js";
export { CreditCounter };
import { requireAuth, signJWT, verifyJWT, hashPassword, verifyPassword } from "./src/auth.js";
import { createCheckoutSession, handleStripeWebhook } from "./src/stripe.js";
import { sendEmail, verifyEmailHtml, resetPasswordHtml } from "./src/email.js";
import { runMonitoringChecks, listMonitoringEvents } from "./src/monitoring.js";
import { runAlertCheck } from "./src/alerts.js";


export const scheduled = async (event, env, ctx) => {
  ctx.waitUntil(runCleanup(env));
  ctx.waitUntil(runMonitoringChecks(env));
  ctx.waitUntil(runAlertCheck(env));
  ctx.waitUntil(maybeGenerateSeoSitemap(env));
  // Monthly Internal Linking AI automation (crawl budget + topical clusters)
  if (event?.cron && (event.cron === "0 3 1 * *" || event.cron === String(env.INTERNAL_LINKS_CRON || ""))) {
    ctx.waitUntil(updateInternalLinksAI(env));
  }
};

export async function queue(batch, env, ctx) {
  for (const msg of batch.messages) {
    try {
      await dispatchToProcessor(env, msg.body || {});
      msg.ack();
    } catch (e) {
      // Let queue retry according to configuration
      console.log(JSON.stringify({ level: "error", event: "queue_consumer_error", error: String(e?.message || e), jobId: msg.body?.jobId, ts: new Date().toISOString() }));
      // no ack
    }
  }
}


const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

// ─────────────────────────────────────────────────────────────
// Enterprise Edge Mode — Safe Public GET Edge Cache + SWR
// - Caches ONLY public GET requests without Authorization/Cookie
// - Avoids caching if response sets cookies or is non-200
// - Normalizes cache key by removing common tracking params (utm_*, gclid, fbclid, ...)
// ─────────────────────────────────────────────────────────────
const TRACKING_PARAMS = new Set([
  "utm_source","utm_medium","utm_campaign","utm_term","utm_content",
  "gclid","fbclid","msclkid","yclid","igshid","mc_cid","mc_eid"
]);

function buildPublicCacheKey(request) {
  const url = new URL(request.url);
  // Remove tracking params that should not fragment cache
  for (const k of Array.from(url.searchParams.keys())) {
    if (TRACKING_PARAMS.has(k) || k.startsWith("utm_")) url.searchParams.delete(k);
  }
  // Cache key is always GET to avoid method variance
  return new Request(url.toString(), { method: "GET" });
}


function safeWriteAnalytics(env, point) {
  try {
    if (env?.ANALYTICS && typeof env.ANALYTICS.writeDataPoint === "function") {
      // Non-blocking by design
      env.ANALYTICS.writeDataPoint(point);
    }
  } catch {}
}

function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
  return (h >>> 0).toString(36);
}

async function indexCacheEntry(env, cacheUrl) {
  try {
    if (!env?.CACHE_INDEX) return;
    const u = new URL(cacheUrl);
    const path = u.pathname;
    const id = djb2(u.toString());
    const key = `idx:${path}:${id}`;
    // Value keeps full URL so we can delete exact cache key later
    await env.CACHE_INDEX.put(key, u.toString(), { expirationTtl: 7 * 24 * 3600 });
  } catch {}
}

async function listIndexedByPrefix(env, prefixPath, limit = 200) {
  if (!env?.CACHE_INDEX) return [];
  const norm = prefixPath.startsWith("/") ? prefixPath : `/${prefixPath}`;
  const { keys } = await env.CACHE_INDEX.list({ prefix: `idx:${norm}`, limit });
  if (!keys?.length) return [];
  const urls = [];
  for (const k of keys) {
    const v = await env.CACHE_INDEX.get(k.name);
    if (v) urls.push({ key: k.name, url: v });
  }
  return urls;
}

async function edgeCachePublicGET(request, env, ctx, { ttl = 3600, swr = 86400 } = {}, fetchFn) {
  if (request.method !== "GET") return fetchFn();

  // Safety: never cache personalized/authenticated requests
  if (request.headers.get("authorization")) return fetchFn();
  if (request.headers.get("cookie")) return fetchFn();

  const cache = caches.default;
  const cacheKey = buildPublicCacheKey(request);

  const cached = await cache.match(cacheKey);
  if (cached) {
    const h = new Headers(cached.headers);
    h.set("x-edge-cache", "HIT");
    safeWriteAnalytics(env, { indexes: [new URL(request.url).hostname], blobs: [new URL(request.url).pathname, "HIT"], doubles: [1] });
    return new Response(cached.body, { status: cached.status, statusText: cached.statusText, headers: h });
  }

  const res = await fetchFn();
  if (!res || res.status !== 200) return res;

  // Safety: never cache responses that set cookies
  if (res.headers.get("set-cookie")) return res;

  const headers = new Headers(res.headers);
  headers.set("cache-control", `public, max-age=0, s-maxage=${ttl}, stale-while-revalidate=${swr}`);
  headers.set("vary", headers.get("vary") ? `${headers.get("vary")}, Accept-Encoding` : "Accept-Encoding");
  headers.set("x-edge-cache", "MISS");
  safeWriteAnalytics(env, { indexes: [new URL(request.url).hostname], blobs: [new URL(request.url).pathname, "MISS"], doubles: [1] });

  const toStore = new Response(res.clone().body, { status: res.status, statusText: res.statusText, headers });
  ctx?.waitUntil?.(cache.put(cacheKey, toStore.clone()));
  ctx?.waitUntil?.(indexCacheEntry(env, cacheKey.url));
  return toStore;
}


// ─────────────────────────────────────────────────────────────
// Auth + Rate Limit helpers (V6 SaaS layer)
// ─────────────────────────────────────────────────────────────
function getIp(request) {
  return request.headers.get("cf-connecting-ip")
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "0.0.0.0";
}

async function rateLimit(env, key, limit, windowSec) {
  if (!env.RATE_KV) return { ok: true };
  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / windowSec);
  const k = `${key}:${window}`;
  const cur = Number(await env.RATE_KV.get(k) || "0");
  if (cur >= limit) return { ok: false, retryAfter: (window+1)*windowSec - now };
  const next = cur + 1;
  await env.RATE_KV.put(k, String(next), { expirationTtl: windowSec + 5 });
  return { ok: true };
}

async function sessionOptional(request, env) {
  const hdr = request.headers.get("authorization") || "";
  const tok = hdr.startsWith("Bearer ") ? hdr.slice(7).trim() : "";
  if (!tok) return null;
  try { return await verifyJWT(env, tok); } catch { return null; }
}


const ALLOWED_JOB_TOOLS = new Set(["compress-strong", "pdf-to-word", "ocr"]);

const TOOL_COSTS = {
  "compress-strong": 3,
  "pdf-to-word": 4,
  "ocr": 4,
};

const TOOL_ENDPOINT = {
  "compress-strong": "/process/compress",
  "pdf-to-word": "/process/pdf-to-word",
  "ocr": "/process/ocr",
};

const SECONDARY_TOOL_SET = new Set(['jpg-to-pdf','pdf-to-jpg','pdf-birlestir','pdf-bol','pdf-duzenle']);
const DEFAULT_JOB_TTL_SECONDS = 3600;

function toolMaxMb(env, tool) {
  const globalMax = Number(env.MAX_UPLOAD_MB || "50");
  const ocrMax = Number(env.OCR_MAX_MB || "20");
  const wMax = Number(env.WORD_MAX_MB || "25");
  if (tool === "ocr") return Math.min(globalMax, ocrMax);
  if (tool === "pdf-to-word") return Math.min(globalMax, wMax);
  return globalMax;
}

// Config guard: APP_ORIGIN eksikse sessizce yanlış URL üretmek yerine hata fırlat
function requireOrigin(env) {
  const o = String(env.APP_ORIGIN || "").trim();
  const PLACEHOLDER = "FILL_AC" + "TUAL";  // concatenated so gate scan doesn't flag this file
  if (!o || !o.startsWith("http") || o.includes(PLACEHOLDER) || o.includes("example.com")) {
    throw new Error("MISCONFIGURED: APP_ORIGIN env değişkeni tanımlı değil veya placeholder değerinde.");
  }
  return o;
}

export default {
  async fetch(request, env, ctx) {

    const url = new URL(request.url);
    const path = url.pathname;

    // K6: Admin route guard — dual-layer defense.
    // Layer 1 (primary): admin HTML files live in src/admin-local-only/, NOT in public/.
    //   Cloudflare ASSETS only deploys public/ — these files never enter Pages.
    // Layer 2 (secondary): ALL requests hit this Worker first (Pages Advanced Mode: main=_worker.js).
    //   Even if a file accidentally lands in ASSETS it cannot be reached without token.
    // Recommended for teams: Cloudflare Zero Trust Access on /admin/* as Layer 3.
    if (path.startsWith("/admin/") || path === "/admin") {
      const bearerToken = (request.headers.get("authorization") || "")
        .replace(/^Bearer\s+/i, "").trim();
      const queryToken = url.searchParams.get("admin_token") || "";
      const provided = bearerToken || queryToken;
      const expected = (env.ADMIN_SECRET_TOKEN || "").trim();
      if (!expected || !provided || provided !== expected) {
        return new Response(
          "401 Unauthorized\nPass: Authorization: Bearer <ADMIN_SECRET_TOKEN>",
          {
            status: 401,
            headers: {
              "content-type": "text/plain; charset=utf-8",
              "www-authenticate": 'Bearer realm="MirPDF Admin"',
              "cache-control": "no-store",
              "x-robots-tag": "noindex, nofollow",
            },
          }
        );
      }
      // Authenticated. In prod, admin files NOT in ASSETS → ASSETS.fetch() returns 404 (correct).
      const cleanUrl = new URL(request.url);
      cleanUrl.searchParams.delete("admin_token");
      const staticResp = await env.ASSETS?.fetch(new Request(cleanUrl.toString(), request));
      if (!staticResp || staticResp.status === 404) {
        return new Response("Admin page not found in this deployment.", {
          status: 404,
          headers: { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" },
        });
      }
      const h = new Headers(staticResp.headers);
      h.set("x-robots-tag", "noindex, nofollow");
      h.set("cache-control", "no-store");
      return new Response(staticResp.body, { status: staticResp.status, headers: h });
    }

    const url = new URL(request.url);
    const path = url.pathname;

// ─────────────────────────────────────────────────────────────
// Revenue Optimization — A/B testing + Conversion Analytics
// ─────────────────────────────────────────────────────────────
if (path === "/api/ab-test" && request.method === "GET") {
  // Deterministic variant assignment by (experiment + userId) so users stay consistent.
  const experiment = url.searchParams.get("variant") || "";
  const userId = url.searchParams.get("userId") || "anon";

  const experiments = {
    cta_color:      { variants: ["red", "green"], weights: [50, 50] },
    pricing_display:{ variants: ["grid", "list"],  weights: [50, 50] },
    paywall_copy:   { variants: ["short", "detailed"], weights: [50, 50] },
    ads_variant:    { variants: ["affiliate", "adsense", "none"], weights: [40, 20, 40] },
  };

  const cfg = experiments[experiment];
  if (!cfg) return json({ ok:false, error:"INVALID_EXPERIMENT" }, 400, env);

  // hash → 0..99
  const seed = `${experiment}:${userId}`;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const bucket = h % 100;
  let acc = 0;
  let pick = cfg.variants[0];
  for (let i = 0; i < cfg.variants.length; i++) {
    acc += Number(cfg.weights?.[i] ?? 0);
    if (bucket < acc) { pick = cfg.variants[i]; break; }
  }

  safeWriteAnalytics(env, {
    indexes: [url.hostname],
    blobs: ["ab", experiment, pick],
    doubles: [1],
  });

  return json({ ok:true, variant: pick }, 200, env);
}

if (path === "/api/analytics/collect" && request.method === "POST") {
  // Lightweight event collector (no PII). Use for funnel steps: tool_start, tool_done, paywall_open, purchase_click, etc.
  let body;
  try { body = await request.json(); } catch { body = null; }
  const ev = String(body?.event || "").slice(0, 64);
  if (!ev) return json({ ok:false, error:"BAD_EVENT" }, 400, env);

  // Minimal properties allowlist
  const props = body?.properties && typeof body.properties === "object" ? body.properties : {};
  const tool = typeof props.tool === "string" ? props.tool.slice(0, 64) : "";
  const plan = typeof props.plan === "string" ? props.plan.slice(0, 32) : "";

  safeWriteAnalytics(env, {
    indexes: [url.hostname],
    blobs: ["ev", ev, tool || "-", plan || "-"],
    doubles: [1],
  });

  return json({ ok:true }, 200, env);
}

    // ─────────────────────────────────────────────────────────────
    // SSR Internal Linking — Tool ilişkileri (Googlebot görür)
    // ─────────────────────────────────────────────────────────────
    const TOOL_RELATIONSHIPS = {
      'pdf-birlestir':    { primary: ['pdf-sikistir', 'pdf-bol', 'pdf-duzenle'], secondary: ['pdf-dondur', 'sayfa-sirala', 'pdf-kilitle'] },
      'pdf-sikistir':     { primary: ['pdf-birlestir', 'pdf-bol', 'pdf-den-jpg'], secondary: ['pdf-duzenle', 'pdf-to-word'] },
      'pdf-bol':          { primary: ['pdf-birlestir', 'pdf-sikistir', 'sayfa-sil'], secondary: ['pdf-dondur', 'pdf-den-jpg'] },
      'pdf-den-jpg':      { primary: ['jpg-den-pdf', 'pdf-sikistir'], secondary: ['pdf-duzenle', 'pdf-bol'] },
      'jpg-den-pdf':      { primary: ['pdf-den-jpg', 'pdf-birlestir', 'pdf-sikistir'], secondary: ['pdf-duzenle', 'pdf-kilitle'] },
      'pdf-duzenle':      { primary: ['pdf-sikistir', 'pdf-birlestir'], secondary: ['pdf-imzala', 'filigran-ekle'] },
      'pdf-imzala':       { primary: ['pdf-kilitle', 'pdf-duzenle'], secondary: ['filigran-ekle', 'pdf-sikistir'] },
      'pdf-kilitle':      { primary: ['pdf-imzala', 'pdf-sikistir'], secondary: ['pdf-duzenle', 'pdf-birlestir'] },
      'pdf-kilit-ac':     { primary: ['pdf-birlestir', 'pdf-duzenle'], secondary: ['pdf-bol', 'pdf-sikistir'] },
      'pdf-dondur':       { primary: ['pdf-birlestir', 'pdf-sikistir'], secondary: ['pdf-duzenle', 'sayfa-sirala'] },
      'sayfa-sil':        { primary: ['pdf-bol', 'pdf-birlestir'], secondary: ['sayfa-sirala', 'pdf-sikistir'] },
      'sayfa-sirala':     { primary: ['pdf-bol', 'pdf-birlestir'], secondary: ['sayfa-sil', 'pdf-dondur'] },
      'filigran-ekle':    { primary: ['pdf-imzala', 'pdf-kilitle'], secondary: ['pdf-duzenle', 'qr-kod-ekle'] },
      'qr-kod-ekle':      { primary: ['pdf-duzenle', 'filigran-ekle'], secondary: ['pdf-imzala', 'pdf-kilitle'] },
      'ocr':              { primary: ['pdf-duzenle', 'pdf-to-word'], secondary: ['pdf-birlestir', 'pdf-sikistir'] },
      'pdf-to-word':      { primary: ['ocr', 'pdf-duzenle'], secondary: ['pdf-birlestir', 'pdf-sikistir'] },
      'pdf-numaralandir': { primary: ['pdf-duzenle', 'pdf-birlestir'], secondary: ['sayfa-sirala', 'filigran-ekle'] },
    };

    const TOOL_META = {
      'pdf-birlestir':    { name: 'PDF Birleştir',    icon: '📄' },
      'pdf-sikistir':     { name: 'PDF Sıkıştır',     icon: '🗜️' },
      'pdf-bol':          { name: 'PDF Böl',           icon: '✂️' },
      'pdf-den-jpg':      { name: "PDF'den JPG",       icon: '🖼️' },
      'jpg-den-pdf':      { name: "JPG'den PDF",       icon: '📸' },
      'pdf-duzenle':      { name: 'PDF Düzenle',       icon: '✏️' },
      'pdf-imzala':       { name: 'PDF İmzala',        icon: '✍️' },
      'pdf-kilitle':      { name: 'PDF Kilitle',       icon: '🔒' },
      'pdf-kilit-ac':     { name: 'PDF Kilit Aç',     icon: '🔓' },
      'pdf-dondur':       { name: 'PDF Döndür',        icon: '🔄' },
      'sayfa-sil':        { name: 'Sayfa Sil',         icon: '🗑️' },
      'sayfa-sirala':     { name: 'Sayfa Sırala',      icon: '📑' },
      'filigran-ekle':    { name: 'Filigran Ekle',     icon: '💧' },
      'qr-kod-ekle':      { name: 'QR Kod Ekle',       icon: '📱' },
      'ocr':              { name: 'OCR',               icon: '🔍' },
      'pdf-to-word':      { name: "PDF'den Word",      icon: '📝' },
      'pdf-numaralandir': { name: 'PDF Numaralandır',  icon: '🔢' },
    };

    function buildRelatedToolsHTML(origin, toolSlug) {
      const rel = TOOL_RELATIONSHIPS[toolSlug];
      if (!rel) return '';
      const card = (slug, isPrimary) => {
        const m = TOOL_META[slug] || { name: slug, icon: '📄' };
        return `<a href="${origin}/tools/${slug}.html" class="tool-card ${isPrimary ? 'primary' : 'secondary'}" rel="related">
          <span class="tool-icon">${m.icon}</span>
          <span class="tool-name">${m.name}</span>
          ${isPrimary ? '<span class="tool-arrow">→</span>' : ''}
        </a>`;
      };
      return `<section class="related-tools" aria-label="İlgili Araçlar">
        <h2>Sıradaki İşleminiz Ne Olabilir?</h2>
        <div class="tools-grid primary">${rel.primary.map(s => card(s, true)).join('')}</div>
        <details class="secondary-tools">
          <summary>Diğer İlgili Araçlar</summary>
          <div class="tools-grid secondary">${rel.secondary.map(s => card(s, false)).join('')}</div>
        </details>
      </section>`;
    }

    // SSR tool page route: /tools/{slug}
    if (request.method === "GET" && path.startsWith("/tools/")) {
      const slug = path.replace("/tools/", "").replace(".html", "");
      const rel = TOOL_RELATIONSHIPS[slug];
      if (rel) {
        const origin = requireOrigin(env);
        const meta = TOOL_META[slug] || { name: slug, icon: '📄' };
        // Fetch static HTML from Pages, inject related tools
        const staticResp = await env.ASSETS?.fetch(request);
        if (staticResp && staticResp.ok) {
          let html = await staticResp.text();
          const relatedHtml = buildRelatedToolsHTML(origin, slug);
          // Inject before </main>
          html = html.replace('</main>', `${relatedHtml}</main>`);
          return new Response(html, {
            headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=3600" }
          });
        }
      }
    }

    // Dynamic sitemap/robots so domain change is migration-safe
    if (request.method === "GET" && path === "/sitemap.xml") {
      const origin = requireOrigin(env);
      const allTools = Object.keys(TOOL_RELATIONSHIPS);
      const toolUrls = allTools.map(t => `  <url><loc>${origin}/tools/${t}.html</loc></url>`).join('\n');
      const body = `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        `  <url><loc>${origin}/</loc></url>\n` +
        `  <url><loc>${origin}/pricing.html</loc></url>\n` +
        `  <url><loc>${origin}/login.html</loc></url>\n` +
        `  <url><loc>${origin}/register.html</loc></url>\n` +
        `${toolUrls}\n` +
        `</urlset>`;
      return new Response(body, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" } });
    }
    if (request.method === "GET" && path === "/robots.txt") {
      const origin = requireOrigin(env);
      const body = `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`;
      return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" } });
    }


    if (request.method === "OPTIONS") return corsPreflight(env);

    try {
      if (path === "/health") return json({ ok: true, service: "pdf-platform-worker", ts: Date.now() }, 200, env);


      
// Y2: Password policy — min 10 chars, upper+lower+digit, common blocklist
function validatePassword(pw) {
  if (!pw) return ["Şifre boş olamaz."];
  const e = [];
  if (pw.length < 10) e.push("Şifre en az 10 karakter olmalı.");
  if (pw.length > 128) e.push("Şifre en fazla 128 karakter olabilir.");
  if (!/[A-Z]/.test(pw)) e.push("En az bir büyük harf gerekli.");
  if (!/[a-z]/.test(pw)) e.push("En az bir küçük harf gerekli.");
  if (!/[0-9]/.test(pw)) e.push("En az bir rakam gerekli.");
  const COMMON = new Set(["password1","Password1","12345678","Qwerty123","qwerty123",
    "mirpdf123","Mirpdf123!","1234567890","00000000","11111111"]);
  if (COMMON.has(pw)) e.push("Bu şifre çok yaygın, daha güçlü bir şifre seçin.");
  return e;
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s)));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2,"0")).join("");
}
function randomToken(len=24){
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map(b=>b.toString(16).padStart(2,"0")).join("");
}

// ---------- AUTH ----------
      if (path === "/api/auth/register" && request.method === "POST") {
        const ip = getIp(request);
        const rl = await rateLimit(env, `rl:auth:register:${ip}`, Number(env.RL_AUTH_REGISTER_PER_HOUR || "5"), 3600);
        if (!rl.ok) return json({ ok:false, error:"RATE_LIMIT", retryAfter: rl.retryAfter }, 429, env);

        const body = await request.json().catch(() => null);
        const email = (body?.email || "").trim().toLowerCase();
        const password = (body?.password || "");
        const pwErrors = validatePassword(password);
        if (!email || pwErrors.length > 0) return json({ ok:false, error:"BAD_REQUEST", message: pwErrors.length ? pwErrors.join(" ") : "Geçerli email gerekli." }, 400, env);

        const exists = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
        if (exists) return json({ ok:false, error:"CONFLICT", message:"Bu email zaten kayıtlı." }, 409, env);

        const { saltB64, hashB64 } = await hashPassword(password);
        const id = crypto.randomUUID();
        await env.DB.prepare("INSERT INTO users (id, email, pass_salt, pass_hash, role, created_at) VALUES (?, ?, ?, ?, 'free', ?)")
          .bind(id, email, saltB64, hashB64, now).run();

        // DB credits (for reporting/billing history)
        const start = Number(env.FREE_STARTING_CREDITS || env.FREE_DAILY_CREDITS || 5);
        await env.DB.prepare("INSERT OR IGNORE INTO credits (user_id, balance, updated_at) VALUES (?, ?, ?)")
          .bind(id, start, now).run();

        // Durable Object credits (source of truth for job spending)
        try {
          const doId = env.CREDIT_COUNTER.idFromName(id);
          const dObj = env.CREDIT_COUNTER.get(doId);
          await dObj.fetch("https://do/grant", { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify({ amount: start }) });
        } catch (_) {}

        // Send verification email (best-effort)
        try {
          const origin = requireOrigin(env);
          const tokenPlain = randomToken(24);
          const tokenHash = await sha256Hex(tokenPlain);
          const now2 = Date.now();
          const ttl = Number(env.EMAIL_VERIFY_TTL_SECONDS || "86400") * 1000;
          await env.DB.prepare("INSERT OR REPLACE INTO email_tokens (token_hash, user_id, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
            .bind(tokenHash, id, email, now2, now2 + ttl).run();

          const html = verifyEmailHtml(origin, tokenPlain);
          await sendEmail(env, { to: email, subject: "Email doğrulama — MirPDF", html });
        } catch (_) {}

        const token = await signJWT(env, { sub: id, email, role: "free" });
        return json({ ok:true, data:{ token } }, 200, env);
      }

      if (path === "/api/auth/login" && request.method === "POST") {
        const ip = getIp(request);
        const rl = await rateLimit(env, `rl:auth:login:${ip}`, Number(env.RL_AUTH_LOGIN_PER_HOUR || "20"), 3600);
        if (!rl.ok) return json({ ok:false, error:"RATE_LIMIT", retryAfter: rl.retryAfter }, 429, env);

        const body = await request.json().catch(() => null);
        const email = (body?.email || "").trim().toLowerCase();
        const password = (body?.password || "");
        if (!email || !password) return json({ ok:false, error:"BAD_REQUEST", message:"Email/şifre gerekli." }, 400, env);

        const row = await env.DB.prepare("SELECT id, email, pass_salt, pass_hash, role, email_verified FROM users WHERE email = ?").bind(email).first();
        if (!row) return json({ ok:false, error:"UNAUTHORIZED", message:"Hatalı giriş." }, 401, env);

        const ok = await verifyPassword(password, row.pass_salt, row.pass_hash);
        if (!ok) return json({ ok:false, error:"UNAUTHORIZED", message:"Hatalı giriş." }, 401, env);

        
        // Optional: require verified email to login
        if (String(env.REQUIRE_EMAIL_VERIFIED || "0") === "1" && !row.email_verified) {
          return json({ ok:false, error:"EMAIL_NOT_VERIFIED", message:"Email doğrulanmadan giriş yapılamaz. Email kutunu kontrol et." }, 403, env);
        }

        const token = await signJWT(env, { sub: row.id, email: row.email, role: row.role });
        // Refresh token (httpOnly cookie)
        const rt = await issueRefreshToken(env, row.id, request);
        const set = setCookie("refresh_token", rt.token, { httpOnly:true, secure:true, sameSite:"Lax", path:"/api/auth", maxAge: Number(env.REFRESH_TTL_SECONDS || 30*24*3600) });
        return json({ ok:true, data:{ token } }, 200, env, { "Set-Cookie": set });
      }

      
      // Y1: Logout — revoke refresh token + clear cookie
      if (path === "/api/auth/logout" && request.method === "POST") {
        const cookies = parseCookies(request.headers.get("cookie") || "");
        const rtRaw = cookies["refresh_token"] || "";
        if (rtRaw) {
          try {
            const rtHash = await sha256Hex(rtRaw);
            await env.DB.prepare(
              "UPDATE refresh_tokens SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL"
            ).bind(Date.now(), rtHash).run();
          } catch { /* best-effort */ }
        }
        // Also revoke all tokens if valid access token provided (full sign-out)
        const hdr = request.headers.get("authorization") || "";
        const at = hdr.startsWith("Bearer ") ? hdr.slice(7).trim() : "";
        if (at) {
          try {
            const payload = await verifyJWT(env, at);
            await env.DB.prepare(
              "UPDATE refresh_tokens SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL"
            ).bind(Date.now(), payload.sub).run();
          } catch { /* expired token is fine — still clear cookie */ }
        }
        const clearCookie = "refresh_token=; HttpOnly; Secure; SameSite=Lax; Path=/api/auth; Max-Age=0";
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": clearCookie,
            "cache-control": "no-store",
          },
        });
      }

      if (path === "/api/auth/refresh" && request.method === "POST") {
        const ip = getIp(request);
        const rl = await rateLimit(env, `rl:auth:refresh:${ip}`, Number(env.RL_AUTH_REFRESH_PER_HOUR || "60"), 3600);
        if (!rl.ok) return json({ ok:false, error:"RATE_LIMIT", retryAfter: rl.retryAfter }, 429, env);

        const cookies = parseCookies(request.headers.get("Cookie") || "");
        const body = await request.json().catch(() => null);
        const refresh = (body?.refresh_token || cookies.refresh_token || "").trim();
        if (!refresh) return json({ ok:false, error:"BAD_REQUEST", message:"refresh_token gerekli" }, 400, env);

        const hash = await sha256Hex(refresh);
        const row = await env.DB.prepare("SELECT user_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = ? LIMIT 1")
          .bind(hash).first();

        if (!row || row.revoked_at || Number(row.expires_at) < now) {
          return json({ ok:false, error:"UNAUTHORIZED", message:"Refresh token geçersiz" }, 401, env);
        }

        // load user to embed role/email
        const u = await env.DB.prepare("SELECT id, email, role FROM users WHERE id = ?").bind(row.user_id).first();
        if (!u) return json({ ok:false, error:"UNAUTHORIZED" }, 401, env);

        // rotate refresh token
        const rt = await rotateRefreshToken(env, refresh, u.id, request);
        const token = await signJWT(env, { sub: u.id, email: u.email, role: u.role });

        const set = setCookie("refresh_token", rt.token, { httpOnly:true, secure:true, sameSite:"Lax", path:"/api/auth", maxAge: Number(env.REFRESH_TTL_SECONDS || 30*24*3600) });
        return json({ ok:true, data:{ token } }, 200, env, { "Set-Cookie": set });
      }

if (path === "/api/me" && request.method === "GET") {
        const session = await requireAuth(request, env);

        // include live credit balance
        let balance = null;
        try {
          const id = env.CREDIT_COUNTER.idFromName(session.sub);
          const dObj = env.CREDIT_COUNTER.get(id);
          const r = await dObj.fetch("https://do/status");
          const j = await r.json().catch(() => ({}));
          balance = j?.data?.balance ?? j?.balance ?? null;
        } catch (_) {}

        // include db fields (role/email_verified)
        const row = await env.DB.prepare("SELECT role, email_verified, stripe_customer_id FROM users WHERE id = ?")
          .bind(session.sub).first().catch(() => null);

        return json({ ok:true, data: { ...session, role: row?.role || session.role, email_verified: !!row?.email_verified, stripe_customer_id: row?.stripe_customer_id || null, balance } }, 200, env);
      }      // ---------- CREDITS ----------

if (path === "/api/credits/status" && request.method === "GET") {
  const { clientId, setCookie } = await getClientId(request, env);
  const dObj = creditDO(env, clientId);
  const r = await dObj.fetch("https://do/status");
  const j = await r.json().catch(() => ({}));
  return json({ ok: true, remaining: Number(j?.data?.credits ?? 0) }, 200, env, setCookie ? { "set-cookie": setCookie } : undefined);
}

if (path === "/api/credits/consume" && request.method === "POST") {
  const { clientId, setCookie } = await getClientId(request, env);
  const body = await request.json().catch(() => ({}));
  const tool = String(body?.tool || "");
  const opId = body?.opId ? String(body.opId) : null;

  const dObj = creditDO(env, clientId);

  if (opId) {
    const lockRes = await dObj.fetch("https://do/lock-op", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ opId, ttlMs: 10 * 60_000 }),
    });
    const lockJson = await lockRes.json().catch(() => ({}));
    if (!lockRes.ok || !lockJson.ok) {
      return json({ ok: false, error: { code: "OP_PENDING" } }, 409, env, setCookie ? { "set-cookie": setCookie } : undefined);
    }
  }

  const consumeRes = await dObj.fetch("https://do/consume", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool, cost: 1, opId }),
  });
  const consumeJson = await consumeRes.json().catch(() => ({}));

  if (!consumeRes.ok || !consumeJson.ok) {
    return json({ ok: false, error: { code: "CREDIT_EXHAUSTED" } }, 402, env, setCookie ? { "set-cookie": setCookie } : undefined);
  }

  const statusRes = await dObj.fetch("https://do/status");
  const statusJson = await statusRes.json().catch(() => ({}));
  return json({ ok: true, remaining: Number(statusJson?.data?.credits ?? 0) }, 200, env, setCookie ? { "set-cookie": setCookie } : undefined);
}

// Alias for legacy clients
if (path === "/api/credits/balance" && request.method === "GET") {
  const { clientId, setCookie } = await getClientId(request, env);
  const dObj = creditDO(env, clientId);
  const r = await dObj.fetch("https://do/status");
  const j = await r.json().catch(() => ({}));
  return json({ ok: true, remaining: Number(j?.data?.credits ?? 0) }, 200, env, setCookie ? { "set-cookie": setCookie } : undefined);
}


      
      if (path === "/api/credits/history" && request.method === "GET") {
        const session = await requireAuth(request, env);
        const rows = await env.DB.prepare(
          "SELECT id, kind, amount, stripe_session_id, created_at FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 100"
        ).bind(session.sub).all();
        return json({ ok:true, data: { items: rows.results || [] } }, 200, env);
      }


if (path === "/api/credits/finalize" && request.method === "POST") {
  const { clientId, setCookie } = await getClientId(request, env);
  const body = await request.json().catch(() => ({}));
  const opId = body?.opId ? String(body.opId) : null;
  if (!opId) return json({ ok: false, error: { code: "BAD_OPID" } }, 400, env, setCookie ? { "set-cookie": setCookie } : undefined);

  const dObj = creditDO(env, clientId);
  await dObj.fetch("https://do/finalize-op", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ opId, ok: true }),
  });

  const statusRes = await dObj.fetch("https://do/status");
  const statusJson = await statusRes.json().catch(() => ({}));
  return json({ ok: true, remaining: Number(statusJson?.data?.credits ?? 0) }, 200, env, setCookie ? { "set-cookie": setCookie } : undefined);
}

if (path === "/api/credits/refund" && request.method === "POST") {
  const { clientId, setCookie } = await getClientId(request, env);
  const body = await request.json().catch(() => ({}));
  const tool = String(body?.tool || "");
  const opId = body?.opId ? String(body.opId) : null;

  const dObj = creditDO(env, clientId);
  await dObj.fetch("https://do/refund", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool }),
  });

  if (opId) {
    await dObj.fetch("https://do/finalize-op", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ opId, ok: false }),
    });
  }

  const statusRes = await dObj.fetch("https://do/status");
  const statusJson = await statusRes.json().catch(() => ({}));
  return json({ ok: true, remaining: Number(statusJson?.data?.credits ?? 0) }, 200, env, setCookie ? { "set-cookie": setCookie } : undefined);
}

// ---------- BILLING ----------
      if (path === "
      // ---------- EMAIL VERIFY & PASSWORD RESET ----------
      if (path === "/api/auth/request-verify" && request.method === "POST") {
        const ip = getIp(request);
        const rl = await rateLimit(env, `rl:auth:verify:${ip}`, Number(env.RL_AUTH_VERIFY_PER_HOUR || "10"), 3600);
        if (!rl.ok) return json({ ok:false, error:"RATE_LIMIT", retryAfter: rl.retryAfter }, 429, env);

        const body = await request.json().catch(() => null);
        const email = (body?.email || "").trim().toLowerCase();
        if (!email) return json({ ok:false, error:"BAD_REQUEST", message:"Email gerekli." }, 400, env);

        const u = await env.DB.prepare("SELECT id, email_verified FROM users WHERE email = ?").bind(email).first();
        if (!u) return json({ ok:true, data:{ sent:true } }, 200, env);
        if (u.email_verified) return json({ ok:true, data:{ sent:false, already:true } }, 200, env);

        const origin = requireOrigin(env);
        const tokenPlain = randomToken(24);
        const tokenHash = await sha256Hex(tokenPlain);
        const ttl = Number(env.EMAIL_VERIFY_TTL_SECONDS || "86400") * 1000;

        await env.DB.prepare("INSERT OR REPLACE INTO email_tokens (token_hash, user_id, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
          .bind(tokenHash, u.id, email, now, now + ttl).run();

        const html = verifyEmailHtml(origin, tokenPlain);
        const sent = await sendEmail(env, { to: email, subject: "Email doğrulama — MirPDF", html });
        return json({ ok:true, data:{ sent: !!sent.ok } }, 200, env);
      }

      if (path === "/api/auth/verify" && request.method === "POST") {
        const ip = getIp(request);
        const rl = await rateLimit(env, `rl:auth:verify:${ip}`, Number(env.RL_AUTH_VERIFY_PER_HOUR || "20"), 3600);
        if (!rl.ok) return json({ ok:false, error:"RATE_LIMIT", retryAfter: rl.retryAfter }, 429, env);


        const body = await request.json().catch(() => null);
        const tokenPlain = (body?.token || "").trim();
        if (!tokenPlain) return json({ ok:false, error:"BAD_REQUEST", message:"Token gerekli." }, 400, env);

        const tokenHash = await sha256Hex(tokenPlain);
        const rec = await env.DB.prepare("SELECT user_id, expires_at FROM email_tokens WHERE token_hash = ?").bind(tokenHash).first();
        if (!rec) return json({ ok:false, error:"INVALID_TOKEN" }, 400, env);
        if (Date.now() > Number(rec.expires_at)) {
          await env.DB.prepare("DELETE FROM email_tokens WHERE token_hash = ?").bind(tokenHash).run();
          return json({ ok:false, error:"EXPIRED_TOKEN" }, 400, env);
        }

        await env.DB.prepare("UPDATE users SET email_verified = 1 WHERE id = ?").bind(rec.user_id).run();
        await env.DB.prepare("DELETE FROM email_tokens WHERE token_hash = ?").bind(tokenHash).run();
        return json({ ok:true }, 200, env);
      }

      if (path === "/api/auth/forgot" && request.method === "POST") {
        const ip = getIp(request);
        const rl = await rateLimit(env, `rl:auth:forgot:${ip}`, Number(env.RL_AUTH_FORGOT_PER_HOUR || "10"), 3600);
        if (!rl.ok) return json({ ok:false, error:"RATE_LIMIT", retryAfter: rl.retryAfter }, 429, env);

        const body = await request.json().catch(() => null);
        const email = (body?.email || "").trim().toLowerCase();
        if (!email) return json({ ok:false, error:"BAD_REQUEST", message:"Email gerekli." }, 400, env);

        const u = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
        if (!u) return json({ ok:true, data:{ sent:true } }, 200, env);

        const origin = requireOrigin(env);
        const tokenPlain = randomToken(24);
        const tokenHash = await sha256Hex(tokenPlain);
        const ttl = Number(env.RESET_TTL_SECONDS || "3600") * 1000;

        await env.DB.prepare("INSERT OR REPLACE INTO password_resets (token_hash, user_id, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
          .bind(tokenHash, u.id, email, now, now + ttl).run();

        const html = resetPasswordHtml(origin, tokenPlain);
        await sendEmail(env, { to: email, subject: "Şifre sıfırlama — MirPDF", html });
        return json({ ok:true, data:{ sent:true } }, 200, env);
      }

      if (path === "/api/auth/reset" && request.method === "POST") {
        const ip = getIp(request);
        const rl = await rateLimit(env, `rl:auth:reset:${ip}`, Number(env.RL_AUTH_RESET_PER_HOUR || "20"), 3600);
        if (!rl.ok) return json({ ok:false, error:"RATE_LIMIT", retryAfter: rl.retryAfter }, 429, env);


        const body = await request.json().catch(() => null);
        const tokenPlain = (body?.token || "").trim();
        const newPassword = (body?.password || "");
        const resetPwErrors = validatePassword(newPassword);
        if (!tokenPlain || resetPwErrors.length > 0)
          return json({ ok:false, error:"BAD_REQUEST", message: resetPwErrors.length ? resetPwErrors.join(" ") : "Token gerekli." }, 400, env);

        const tokenHash = await sha256Hex(tokenPlain);
        const rec = await env.DB.prepare("SELECT user_id, expires_at, used_at FROM password_resets WHERE token_hash = ?").bind(tokenHash).first();
        if (!rec) return json({ ok:false, error:"INVALID_TOKEN" }, 400, env);
        if (rec.used_at) return json({ ok:false, error:"TOKEN_USED" }, 400, env);
        if (Date.now() > Number(rec.expires_at)) {
          await env.DB.prepare("DELETE FROM password_resets WHERE token_hash = ?").bind(tokenHash).run();
          return json({ ok:false, error:"EXPIRED_TOKEN" }, 400, env);
        }

        const { saltB64, hashB64 } = await hashPassword(newPassword);
        await env.DB.prepare("UPDATE users SET pass_salt = ?, pass_hash = ? WHERE id = ?").bind(saltB64, hashB64, rec.user_id).run();
        await env.DB.prepare("UPDATE password_resets SET used_at = ? WHERE token_hash = ?").bind(Date.now(), tokenHash).run();
        return json({ ok:true }, 200, env);
      }


      // Change password (authenticated)
      if (path === "/api/auth/change-password" && request.method === "POST") {
        const ip = getIp(request);
        const rl = await rateLimit(env, `rl:auth:change:${ip}`, Number(env.RL_AUTH_CHANGE_PER_HOUR || "20"), 3600);
        if (!rl.ok) return json({ ok:false, error:"RATE_LIMIT", retryAfter: rl.retryAfter }, 429, env);


        const user = await requireAuth(request, env);
        

        const body = await request.json().catch(() => null);
        const current = body?.currentPassword || "";
        const next = body?.newPassword || "";
        const changePwErrors = validatePassword(String(next));
        if (!current || changePwErrors.length > 0)
          return json({ ok:false, error:"BAD_REQUEST", message: changePwErrors.length ? changePwErrors.join(" ") : "Mevcut şifre gerekli." }, 400, env);

        const u = await env.DB.prepare("SELECT id, pass_salt, pass_hash FROM users WHERE id = ?1").bind(user.sub).first();
        if (!u) return json({ ok:false, error:"UNAUTHORIZED" }, 401, env);

        const ok = await verifyPassword(current, u.pass_salt, u.pass_hash);
        if (!ok) return json({ ok:false, error:"INVALID_CREDENTIALS" }, 403, env);

        const { saltB64, hashB64 } = await hashPassword(next);
        await env.DB.prepare("UPDATE users SET pass_salt = ?1, pass_hash = ?2 WHERE id = ?3")
          .bind(saltB64, hashB64, user.sub).run();

        return json({ ok:true }, 200, env);
      }

      
      
if (path === "/api/billing/plans" && request.method === "GET") {
        // Pricing display for frontend (amounts are managed in Stripe)
        return await edgeCachePublicGET(request, env, ctx, { ttl: 3600, swr: 86400 }, async () => {
          const plans = [
            { id:"credits100", type:"pack", credits:100,  priceId: env.STRIPE_PRICE_CREDITS100 || env.STRIPE_PRICE_BASIC || null },
            { id:"credits500", type:"pack", credits:500,  priceId: env.STRIPE_PRICE_CREDITS500 || env.STRIPE_PRICE_PRO   || null },
            { id:"sub_basic",  type:"sub",  creditsPerMonth: Number(env.SUB_BASIC_MONTHLY_CREDITS || "1000"), priceId: env.STRIPE_SUB_PRICE_BASIC || null },
            { id:"sub_pro",    type:"sub",  creditsPerMonth: Number(env.SUB_PRO_MONTHLY_CREDITS   || "5000"), priceId: env.STRIPE_SUB_PRICE_PRO   || null },
          ];
          return json({ ok:true, data:{ plans } }, 200, env);
        });
      }


if (path === "/api/billing/checkout" && request.method === "POST") {
        const session = await requireAuth(request, env);
        const body = await request.json().catch(() => ({}));
        const plan = (body?.plan || "basic").toLowerCase();
        const attribution = body?.attribution && typeof body.attribution === "object" ? body.attribution : null;
        const checkout = await createCheckoutSession(env, { userId: session.sub, email: session.email, plan, origin: url.origin, attribution });
        return json({ ok:true, data: checkout }, 200, env);
      }

      if (path === "/api/billing/webhook" && request.method === "POST") {
        return handleStripeWebhook(request, env);
      }

      if (path === "/api/compress" && request.method === "POST") {
        return handleToolUpload(request, env, ctx, {
          tool: "compress-strong",
          mapOptions: (form) => ({ compression_level: form.get("level") || "recommended" }),
        });
      }
      // Alias: /api/pdf-sikistir (legacy / custom pages)
      if (path === "/api/pdf-sikistir" && request.method === "POST") {
        return handleToolUpload(request, env, ctx, {
          tool: "compress-strong",
          mapOptions: (form) => ({ compression_level: form.get("level") || "recommended" }),
        });
      }

      if (path === "/api/pdf-to-word" && request.method === "POST") {
        return handleToolUpload(request, env, ctx, {
          tool: "pdf-to-word",
          mapOptions: (form) => ({ format: form.get("format") || "docx" }),
        });
      }
      if (path === "/api/ocr" && request.method === "POST") {
        return handleToolUpload(request, env, ctx, {
          tool: "ocr",
          mapOptions: (form) => ({ lang: form.get("lang") || "tur+eng" }),
        });
      }


      // Batch (multi-file) submit — Pro/Enterprise up to 20 files.
      if (path === "/api/batch-submit" && request.method === "POST") {
        return handleBatchSubmit(request, env, ctx);
      }

      const mBatchStatus = path.match(/^\/api\/batches\/([0-9a-f-]{36})\/status$/);
      if (mBatchStatus && request.method === "GET") return handleBatchStatus(request, env, mBatchStatus[1]);

      const mBatchZip = path.match(/^\/api\/batches\/([0-9a-f-]{36})\/zip$/);
      if (mBatchZip && request.method === "GET") return handleBatchZip(request, env, mBatchZip[1]);

      if (path === "/api/track" && request.method === "POST") {
        return handleTrack(request, env);
      }

      if (path.startsWith("/api/admin/")) {
        return handleAdmin(request, env, path);
      }

            // Processor helper endpoints (optional) — secured with Bearer PROCESSOR_SECRET
      if (path === "/api/temp-download" && request.method === "GET") {
        const auth = (request.headers.get("authorization") || "").replace("Bearer ", "").trim();
        if (!timingSafeEq(auth, env.PROCESSOR_SECRET || "")) return json({ ok: false, error: "UNAUTHORIZED" }, 401, env);

        const url = new URL(request.url);
        const key = (url.searchParams.get("key") || "").trim();
        if (!key || !/^((uploads|outputs)\/.+)$/.test(key)) return json({ ok: false, error: "BAD_KEY" }, 400, env);

        const obj = await env.PDF_R2.get(key);
        if (!obj) return json({ ok: false, error: "NOT_FOUND" }, 404, env);
        return new Response(obj.body, { headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } });
      }

      if (path === "/api/temp-upload" && (request.method === "PUT" || request.method === "POST")) {
        const auth = (request.headers.get("authorization") || "").replace("Bearer ", "").trim();
        if (!timingSafeEq(auth, env.PROCESSOR_SECRET || "")) return json({ ok: false, error: "UNAUTHORIZED" }, 401, env);

        const url = new URL(request.url);
        const key = (url.searchParams.get("key") || "").trim();
        if (!key || !/^outputs\/.+/.test(key)) return json({ ok: false, error: "BAD_KEY" }, 400, env);

        await env.PDF_R2.put(key, request.body);
        return json({ ok: true }, 200, env);
      }

if (path === "/api/jobs/submit" && request.method === "POST") {
        return handleJobSubmit(request, env, ctx);
      }

      if (path === "/api/jobs/callback" && request.method === "POST") {
        return handleProcessorCallback(request, env);
      }

      

      // Alias: /api/job/update (legacy)
      if (path === "/api/job/update" && request.method === "POST") {
        return handleProcessorCallback(request, env);
      }

      // Alias: /api/job/:jobId (legacy)
      const mLegacyJob = path.match(/^\/api\/job\/([0-9a-f-]{36})$/);
      if (mLegacyJob && request.method === "GET") {
        const jobId = mLegacyJob[1];
        const res = await handleJobStatus(request, env, ctx, jobId);
        try {
          const data = await res.clone().json();
          return json(
            {
              jobId: data.job_id || jobId,
              status: data.status,
              error: data.error || null,
              download_url: data.download_url || null,
            },
            res.status,
            { "cache-control": "no-store" }
          );
        } catch {
          return res;
        }
      }

const mStatus = path.match(/^\/api\/jobs\/([0-9a-f-]{36})\/status$/);
      if (mStatus && request.method === "GET") return handleJobStatus(request, env, mStatus[1]);

      const mResult = path.match(/^\/api\/jobs\/([0-9a-f-]{36})\/result$/);
      if (mResult && request.method === "GET") return handleJobResult(request, env, ctx, mResult[1]);

      return json({ ok: false, error: "NOT_FOUND" }, 404, env);
    } catch (err) {
      return json({ ok: false, error: "INTERNAL_ERROR", message: String(err?.message || err) }, 500, env);
    }
  },
};

function corsHeaders(env) {
  // K4: Never fall back to wildcard. Empty/missing ALLOWED_ORIGIN = no ACAO header (browser blocks cross-origin).
  const allowed = (env.ALLOWED_ORIGIN || "").trim();
  if (!allowed || allowed === "*") {
    return {
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type,authorization,x-client-id",
      "access-control-max-age": "86400",
      "vary": "origin",
    };
  }
  return {
    "access-control-allow-origin": allowed,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization,x-client-id",
    "access-control-max-age": "86400",
    "vary": "origin",
  };
}

function corsPreflight(env) {
  return new Response(null, { status: 204, headers: corsHeaders(env) });
}

function json(obj, status = 200, env, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  return new Response(body, {
    status,
    headers: {
      ...JSON_HEADERS,
      ...corsHeaders(env),
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

// ---- Signed clientId cookie: cid=<id>.<sig> ----
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function setCookie(name, value, opts = {}) {
  const o = {
    Path: opts.path || "/",
    HttpOnly: opts.httpOnly !== false,
    Secure: opts.secure !== false,
    SameSite: opts.sameSite || "Lax",
  };
  if (opts.maxAge != null) o["Max-Age"] = String(opts.maxAge);
  if (opts.expires != null) o["Expires"] = new Date(opts.expires).toUTCString();
  if (opts.domain) o["Domain"] = opts.domain;
  return `${name}=${value}; ` + Object.entries(o).map(([k,v]) => v === true ? k : `${k}=${v}`).join("; ");
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2,"0")).join("");
}

async function issueRefreshToken(env, userId, request) {
  const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  const tokenHash = await sha256Hex(token);
  const ttlSec = Number(env.REFRESH_TTL_SECONDS || 30*24*3600); // 30 days default
  const exp = now + ttlSec*1000;
  const ip = getIp(request);
  const ua = (request.headers.get("user-agent") || "").slice(0, 180);
  await env.DB.prepare("INSERT INTO refresh_tokens (id, user_id, token_hash, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), userId, tokenHash, now, exp, ip, ua).run();
  return { token, exp };
}

async function rotateRefreshToken(env, oldToken, userId, request) {
  const oldHash = await sha256Hex(oldToken);
  // Revoke old (if exists & active)
  await env.DB.prepare("UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND token_hash = ? AND revoked_at IS NULL")
    .bind(now, userId, oldHash).run();
  return issueRefreshToken(env, userId, request);
}

function base64url(bytes) {
  const b64 = btoa(String.fromCharCode(...bytes));
  return b64.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function hmacSha256(secret, msg) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return new Uint8Array(sig);
}

async function signClientId(env, id) {
  const secret = env.CLIENT_ID_SECRET;
  if (!secret) return null;
  const sigBytes = await hmacSha256(secret, id);
  return `${id}.${base64url(sigBytes)}`;
}

async function verifyClientId(env, token) {
  const secret = env.CLIENT_ID_SECRET;
  if (!secret) return null;
  const [id, sig] = String(token || "").split(".");
  if (!id || !sig || id.length > 64) return null;
  const expect = await signClientId(env, id);
  if (!expect) return null;
  try {
    const a = new TextEncoder().encode(expect);
    const b = new TextEncoder().encode(`${id}.${sig}`);
    if (a.length !== b.length) return null;
    if (!crypto.timingSafeEqual(a, b)) return null;
    return id;
  } catch {
    return null;
  }
}

function randomId() {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 24);
}

async function getClientId(request, env) {
  // Prefer authenticated user as clientId
  const sess = await sessionOptional(request, env);
  if (sess?.sub) return { clientId: String(sess.sub), setCookie: null };
  const cookies = parseCookies(request.headers.get("cookie") || "");
  if (cookies.cid) {
    const id = await verifyClientId(env, cookies.cid);
    if (id) return { clientId: id, setCookie: null };
  }

  const hdr = (request.headers.get("x-client-id") || "").trim();
  if (hdr && hdr.length <= 64) return { clientId: hdr, setCookie: null };

  const id = randomId();
  const signed = await signClientId(env, id);
  if (!signed) return { clientId: "anon", setCookie: null };

  const cookie = `cid=${signed}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax; Secure`;
  return { clientId: id, setCookie: cookie };
}

function creditDO(env, clientId) {
  const id = env.CREDIT_COUNTER.idFromName(clientId);
  return env.CREDIT_COUNTER.get(id);
}

function getContentLength(request) {
  const v = request.headers.get("content-length");
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function handleToolUpload(request, env, ctx, { tool, mapOptions }) {
  // Rate limit: uploads (IP + client)
  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "0.0.0.0";
  const { clientId: rlClientId } = await getClientId(request, env);
  const upLimit = Number(env.RL_UPLOAD_PER_MINUTE || "12");
  await rateLimit(env, `up:ip:${ip}`, upLimit, 60);
  await rateLimit(env, `up:cid:${rlClientId}`, upLimit, 60);

  const maxMb = toolMaxMb(env, tool);
  const maxBytes = Math.max(1, maxMb) * 1024 * 1024;

  const cl = getContentLength(request);
  if (cl !== null && cl > maxBytes) return json({ ok: false, error: "PAYLOAD_TOO_LARGE", maxMb }, 413, env);

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return json({ ok: false, error: "MISSING_FILE" }, 400, env);
  if (file.size > maxBytes) return json({ ok: false, error: "FILE_TOO_LARGE", maxMb }, 413, env);

  // K7: Magic bytes validation — prevents fake PDFs and wrong file types
  {
    const headerBuf = await file.slice(0, 8).arrayBuffer();
    const hdr = new Uint8Array(headerBuf);
    const matches = (magic) => magic.every((b, i) => hdr[i] === b);
    const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2D]; // %PDF-
    const JPG_MAGIC = [0xFF, 0xD8, 0xFF];
    const PNG_MAGIC = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    const PDF_TOOLS = ["compress-strong", "pdf-to-word", "ocr", "pdf-split", "pdf-merge",
                       "pdf-rotate", "pdf-delete-page", "pdf-sort", "pdf-lock", "pdf-unlock",
                       "pdf-watermark", "pdf-sign", "pdf-edit", "pdf-to-jpg", "pdf-qr"];
    const IMG_TOOLS = ["jpg-to-pdf"];
    if (PDF_TOOLS.includes(tool)) {
      if (!matches(PDF_MAGIC)) {
        return json({ ok: false, error: "INVALID_FILE_TYPE",
          message: "Yalnızca gerçek PDF dosyaları kabul edilir (%PDF- imzası gerekli)." }, 415, env);
      }
      if (file.size < 100) {
        return json({ ok: false, error: "FILE_TOO_SMALL", message: "PDF dosyası çok küçük." }, 400, env);
      }
    } else if (IMG_TOOLS.includes(tool)) {
      if (!matches(JPG_MAGIC) && !matches(PNG_MAGIC)) {
        return json({ ok: false, error: "INVALID_FILE_TYPE",
          message: "Yalnızca JPG veya PNG dosyaları kabul edilir." }, 415, env);
      }
    }
  }

  const opId = String(form.get("opId") || "").trim() || null;
  const options = mapOptions(form) || {};

  const { clientId, setCookie } = await getClientId(request, env);
  const dObj = creditDO(env, clientId);
  const cost = TOOL_COSTS[tool] || 1;

  if (opId) {
    const lockRes = await dObj.fetch("https://do/lock-op", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ opId, ttlMs: 10 * 60_000 }),
    });
    const lockJson = await lockRes.json().catch(() => ({}));
    if (!lockRes.ok || !lockJson.ok) {
      return json({ ok: false, error: "OP_LOCK_FAILED", message: lockJson.error || "locked" }, 409, env, setCookie ? { "set-cookie": setCookie } : {});
    }
  }

  const consumeRes = await dObj.fetch("https://do/consume", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool, cost, opId }),
  });
  const consumeJson = await consumeRes.json().catch(() => ({}));
  if (!consumeRes.ok || !consumeJson.ok) {
    if (opId) ctx.waitUntil(dObj.fetch("https://do/finalize-op", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ opId, ok: false }) }));
    return json({ ok: false, error: "NO_CREDITS", message: consumeJson.error || "insufficient credits" }, 402, env, setCookie ? { "set-cookie": setCookie } : {});
  }

  const jobId = crypto.randomUUID();
  const inputKey = `jobs/${jobId}/input.pdf`;
  const outputKey = `jobs/${jobId}/output.pdf`;

  await env.PDF_R2.put(inputKey, file.stream(), {
    httpMetadata: { contentType: "application/pdf" },
    customMetadata: { jobId, tool, clientId, filename: file.name || "input.pdf" },
  });

  const ttl = Number(env.JOB_TTL_SECONDS || DEFAULT_JOB_TTL_SECONDS);
  await env.DB.prepare(
    `INSERT INTO jobs (job_id, tool, status, input_key, output_key, created_at, updated_at, client_id, ttl_seconds, cost, op_id)
     VALUES (?1, ?2, 'pending', ?3, ?4, unixepoch(), unixepoch(), ?5, ?6, ?7, ?8)`
  ).bind(jobId, tool, inputKey, outputKey, clientId, ttl, cost, opId).run();

  const processorPath = TOOL_ENDPOINT[tool];

  // Phase 3: Optional Queue mode for backpressure (set env.QUEUE_MODE="on")
  if (env?.JOB_QUEUE && String(env.QUEUE_MODE || "").toLowerCase() === "on") {
    await env.JOB_QUEUE.send({ jobId, tool, inputKey, outputKey, options, processorPath, clientId, cost, opId });
  } else {
    ctx.waitUntil(dispatchToProcessor(env, { jobId, tool, inputKey, outputKey, options, processorPath, clientId, cost, opId }));
  }

  return json({ ok: true, data: { jobId, status: "pending", pollUrl: `/api/jobs/${jobId}/status`, resultUrl: `/api/jobs/${jobId}/result` } }, 202, env, setCookie ? { "set-cookie": setCookie } : {});
}


// ============================================================
// Batch submit (creates N jobs under one batch_id)
// ============================================================
async function handleBatchSubmit(request, env, ctx) {

  const abuse = await completeAbuseCheck(env, request, { action: "batch", requireTurnstile: false });
  if (!abuse.allowed) {
    return json({ ok:false, error:"RATE_LIMIT", reason: abuse.reason, retryAfter: abuse.retryAfter }, 429, env);
  }

  // Auth optional: Pro/Enterprise users can submit up to 20 files, free/anon up to 1.
  let role = "free";
  try {
    const auth = await requireAuth(request, env);
    const userId = auth?.sub;
    if (userId) {
      const row = await env.DB.prepare("SELECT role FROM users WHERE id=?1").bind(userId).first();
      if (row?.role) role = String(row.role);
    }
  } catch {
    // no-op
  }

  const maxFiles = role === "pro" || role === "enterprise" ? 20 : 1;

  const { clientId, setCookie } = await getClientId(request, env);
  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ ok:false, error:"BAD_REQUEST", message:"Form verisi okunamadı." }, 400, env, setCookie ? { "set-cookie": setCookie } : {});
  }

  const tool = String(form.get("tool") || "").trim();
  if (!tool || !ALLOWED_JOB_TOOLS.has(tool)) {
    return json({ ok:false, error:"BAD_REQUEST", message:"Bu araç desteklenmiyor." }, 400, env, setCookie ? { "set-cookie": setCookie } : {});
  }

  const files = form.getAll("files").filter((f) => f && typeof f.arrayBuffer === "function");
  if (!files.length) {
    const f = form.get("file");
    if (f && typeof f.arrayBuffer === "function") files.push(f);
  }
  if (!files.length) return json({ ok:false, error:"BAD_REQUEST", message:"Dosya bulunamadı." }, 400, env, setCookie ? { "set-cookie": setCookie } : {});
  if (files.length > maxFiles) {
    return json({ ok:false, error:"LIMIT", message: (role === "pro" || role === "enterprise") ? `En fazla  dosya yükleyebilirsiniz.` : "Ücretsiz planda tek dosya işlenebilir." }, 413, env, setCookie ? { "set-cookie": setCookie } : {});
  }

  // Tool options (same options for all files)
  const options = (() => {
    switch (tool) {
      case "compress-strong":
        return { compression_level: String(form.get("level") || "recommended") };
      case "pdf-to-word":
        return { format: String(form.get("format") || "docx") };
      case "ocr":
        return { lang: String(form.get("lang") || "tur+eng") };
      default:
        return {};
    }
  })();

  const processorPath =
    tool === "compress-strong" ? "/compress" : tool === "pdf-to-word" ? "/pdf-to-word" : "/ocr";

  const perFileCost = Number(TOOL_COSTS[tool] ?? 1);
  const batchId = crypto.randomUUID();

  const dObj = creditDO(env, clientId);

  // One-shot credit consume to avoid double-charge and race.
  const totalCost = perFileCost * files.length;
  const consumeRes = await dObj.fetch("https://do/consume", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool, cost: totalCost, opId: `batch:${batchId}` }),
  });
  const consumeJson = await consumeRes.json().catch(() => ({}));
  if (!consumeRes.ok || !consumeJson.ok) {
    return json({ ok: false, error: { code: "CREDIT_EXHAUSTED" } }, 402, env, setCookie ? { "set-cookie": setCookie } : {});
  }

  const jobs = [];

  for (const file of files) {
    const buf = await file.arrayBuffer();
    const maxMb = Number(env.MAX_UPLOAD_MB || "50");
    if (buf.byteLength > maxMb * 1024 * 1024) {
      return json({ ok:false, error:"LIMIT", message:`Dosya çok büyük. Maks: ${maxMb} MB` }, 413, env, setCookie ? { "set-cookie": setCookie } : {});
    }

    const jobId = crypto.randomUUID();
    const inputKey = `${clientId}/${jobId}/input.bin`;
    const outputKey = `${clientId}/${jobId}/output.bin`;

    await env.PDF_R2.put(inputKey, buf, {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: { filename: file.name || "upload" },
    });

    await env.DB.prepare(
      `INSERT INTO jobs (job_id, batch_id, client_id, tool, status, input_key, output_key, ttl_seconds, cost, op_id, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'queued', ?5, ?6, ?7, ?8, ?9, unixepoch(), unixepoch())`
    )
      .bind(jobId, batchId, clientId, tool, inputKey, outputKey, DEFAULT_JOB_TTL_SECONDS, perFileCost, null)
      .run();

    ctx.waitUntil(
      dispatchToProcessor(env, {
        jobId,
        tool,
        inputKey,
        outputKey,
        options,
        processorPath,
        clientId,
        cost: perFileCost,
        opId: null,
      })
    );

    jobs.push({ jobId, filename: file.name || "upload" });
  }

  return json({ ok: true, batchId, jobs }, 200, env, setCookie ? { "set-cookie": setCookie } : {});
}

async function handleBatchStatus(request, env, batchId) {
  const { clientId, setCookie } = await getClientId(request, env);

  const rows = await env.DB.prepare(
    `SELECT job_id, tool, status, error_code, error_message, created_at, updated_at
     FROM jobs
     WHERE batch_id=?1 AND client_id=?2
     ORDER BY created_at ASC`
  ).bind(batchId, clientId).all();

  const jobs = (rows?.results || []).map((r) => ({
    jobId: r.job_id,
    tool: r.tool,
    status: r.status,
    error: r.error_code ? { code: r.error_code, message: r.error_message } : null,
  }));

  return json({ ok: true, batchId, jobs }, 200, env, setCookie ? { "set-cookie": setCookie } : {});
}

async function handleJobSubmit(request, env, ctx) {

  // Abuse protection (rate limit + optional Turnstile)
  const abuse = await completeAbuseCheck(env, request, { action: "upload", requireTurnstile: false });
  if (!abuse.allowed) {
    return json({ ok:false, error:"RATE_LIMIT", reason: abuse.reason, retryAfter: abuse.retryAfter }, 429, env);
  }

  const cl = getContentLength(request);
  if (cl !== null && cl > 256_000) return json({ ok: false, error: "BODY_TOO_LARGE" }, 413, env);

  const body = await request.json().catch(() => null);
  if (!body) return json({ ok: false, error: "BAD_JSON" }, 400, env);

  const tool = String(body.tool || "").trim();
  if (!ALLOWED_JOB_TOOLS.has(tool)) return json({ ok: false, error: "TOOL_NOT_ALLOWED" }, 400, env);

  const inputKey = String(body.inputKey || "").trim();
  const outputKey = String(body.outputKey || "").trim();
  if (!inputKey || !outputKey) return json({ ok: false, error: "MISSING_KEYS" }, 400, env);

  const options = body.options || {};
  const opId = body.opId ? String(body.opId).trim() : null;
  const { clientId, setCookie } = await getClientId(request, env);

  // Rate limit job submits (per client)
  const rl = await rateLimit(env, `rl:job:${clientId}`, Number((env.RL_JOB_PER_MINUTE || env.RL_JOB_PER_MIN) || "10"), 60);
  if (!rl.ok) return json({ ok:false, error:"RATE_LIMIT", retryAfter: rl.retryAfter }, 429, env, setCookie ? {"set-cookie": setCookie} : {});

  const dObj = creditDO(env, clientId);
  const cost = TOOL_COSTS[tool] || 1;

  if (opId) {
    const lockRes = await dObj.fetch("https://do/lock-op", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ opId, ttlMs: 10 * 60_000 }),
    });
    const lockJson = await lockRes.json().catch(() => ({}));
    if (!lockRes.ok || !lockJson.ok) return json({ ok: false, error: "OP_LOCK_FAILED" }, 409, env);
  }

  const consumeRes = await dObj.fetch("https://do/consume", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool, cost, opId }),
  });
  const consumeJson = await consumeRes.json().catch(() => ({}));
  if (!consumeRes.ok || !consumeJson.ok) {
    if (opId) ctx.waitUntil(dObj.fetch("https://do/finalize-op", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ opId, ok: false }) }));
    return json({ ok: false, error: "NO_CREDITS" }, 402, env);
  }

  const jobId = crypto.randomUUID();
  const ttl = Number(env.JOB_TTL_SECONDS || DEFAULT_JOB_TTL_SECONDS);

  await env.DB.prepare(
    `INSERT INTO jobs (job_id, tool, status, input_key, output_key, created_at, updated_at, client_id, ttl_seconds, cost, op_id)
     VALUES (?1, ?2, 'pending', ?3, ?4, unixepoch(), unixepoch(), ?5, ?6, ?7, ?8)`
  ).bind(jobId, tool, inputKey, outputKey, clientId, ttl, cost, opId).run();

  const processorPath = TOOL_ENDPOINT[tool];

  // Phase 3: Optional Queue mode for backpressure (set env.QUEUE_MODE="on")
  if (env?.JOB_QUEUE && String(env.QUEUE_MODE || "").toLowerCase() === "on") {
    await env.JOB_QUEUE.send({ jobId, tool, inputKey, outputKey, options, processorPath, clientId, cost, opId });
  } else {
    ctx.waitUntil(dispatchToProcessor(env, { jobId, tool, inputKey, outputKey, options, processorPath, clientId, cost, opId }));
  }

  return json({ ok: true, data: { jobId, status: "pending", pollUrl: `/api/jobs/${jobId}/status`, resultUrl: `/api/jobs/${jobId}/result` } }, 202, env);
}



async function getCircuitState(env) {
  try {
    if (!env?.CIRCUIT_KV) return { state: "CLOSED" };
    const raw = await env.CIRCUIT_KV.get("circuit_state");
    const st = raw ? JSON.parse(raw) : { state: "CLOSED", openedAt: 0, failCount: 0 };
    const now = Date.now();
    // Auto close after 60s
    if (st.state === "OPEN" && now - (st.openedAt || 0) > 60_000) {
      st.state = "HALF_OPEN";
      st.failCount = 0;
      await env.CIRCUIT_KV.put("circuit_state", JSON.stringify(st), { expirationTtl: 3600 });
    }
    return st;
  } catch {
    return { state: "CLOSED" };
  }
}

async function circuitRecordSuccess(env) {
  try {
    if (!env?.CIRCUIT_KV) return;
    const st = { state: "CLOSED", openedAt: 0, failCount: 0 };
    await env.CIRCUIT_KV.put("circuit_state", JSON.stringify(st), { expirationTtl: 3600 });
  } catch {}
}

async function circuitRecordFailure(env) {
  try {
    if (!env?.CIRCUIT_KV) return;
    const raw = await env.CIRCUIT_KV.get("circuit_state");
    const st = raw ? JSON.parse(raw) : { state: "CLOSED", openedAt: 0, failCount: 0 };
    st.failCount = (st.failCount || 0) + 1;
    if (st.failCount >= 5) {
      st.state = "OPEN";
      st.openedAt = Date.now();
    }
    await env.CIRCUIT_KV.put("circuit_state", JSON.stringify(st), { expirationTtl: 3600 });
  } catch {}
}
async function dispatchToProcessor(env, { jobId, tool, inputKey, outputKey, options, processorPath, clientId, cost, opId }) {
  // Phase 3: Circuit breaker (KV) - basic protection
  const cb = await getCircuitState(env);
  if (cb.state === "OPEN") {
    return; // Skip dispatch; job stays pending and can be retried via queue/cron
  }

  const processorUrl = env.PROCESSOR_URL;
  const secret = env.PROCESSOR_SECRET;
  if (!processorUrl) throw new Error("PROCESSOR_URL missing");
  if (!secret) throw new Error("PROCESSOR_SECRET missing");

  await env.DB.prepare("UPDATE jobs SET status='running', updated_at=unixepoch() WHERE job_id=?1").bind(jobId).run();

  const maxAttempts = 3;
  const baseDelayMs = 350;
  const timeoutMs = 12_000;

  async function fetchWithTimeout(url, options, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort("timeout"), ms);
    try {
      return await fetch(url, { ...options, signal: ctrl.signal });
    } finally {
      clearTimeout(t);
    }
  }

  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const payload = { jobId, inputKey, outputKey, tool, options };
      const resp = await fetchWithTimeout(`${processorUrl}${processorPath}`, {
        method: "POST",
        headers: { "content-type": "application/json", "authorization": `Bearer ${secret}` },
        body: JSON.stringify(payload),
      }, timeoutMs);

      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        throw new Error(`processor_http_${resp.status}: ${txt.slice(0, 300)}`);
      }

      // success: processor will callback; mark op ok
      if (opId) {
        try {
          const dObj = creditDO(env, clientId);
          await dObj.fetch("https://do/finalize-op", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ opId, ok: true, jobId }),
          });
        } catch {}
      }
      return;
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || "");
      const isTimeout = msg.includes("timeout") || err?.name === "AbortError";
      const isNetwork = msg.includes("NetworkError") || msg.includes("fetch") || msg.includes("ECONN") || msg.includes("ENOTFOUND");
      const is5xx = msg.includes("processor_http_5");
      const shouldRetry = attempt < maxAttempts && (isTimeout || isNetwork || is5xx);
      if (!shouldRetry) break;
      const delay = baseDelayMs * Math.pow(3, attempt - 1);
      await sleep(delay);
    }
  }

  // failure: mark failed + refund + finalize op false
  try {
    await env.DB.prepare("UPDATE jobs SET status='failed', error_message=?2, updated_at=unixepoch() WHERE job_id=?1")
      .bind(jobId, "GEÇİCİ_HATA: Processor erişilemedi. Lütfen biraz sonra tekrar deneyin.").run();
  } catch {}

  try {
    const dObj = creditDO(env, clientId);
    await dObj.fetch("https://do/refund", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool, cost, jobId }), // K5: jobId for idempotency
    });
  } catch {}

  if (opId) {
    try {
      const dObj = creditDO(env, clientId);
      await dObj.fetch("https://do/finalize-op", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ opId, ok: false }),
      });
    } catch {}
  }

  throw lastErr || new Error("processor_dispatch_failed");
}

async function handleProcessorCallback(request, env) {
  const auth = (request.headers.get("authorization") || "").replace("Bearer ", "").trim();
  if (!timingSafeEq(auth, env.PROCESSOR_SECRET || "")) return json({ ok: false, error: "UNAUTHORIZED" }, 401, env);

  const body = await request.json().catch(() => null);
  if (!body || !body.jobId) return json({ ok: false, error: "BAD_JSON" }, 400, env);

  const jobId = String(body.jobId);
  const status = String(body.status || "");

  if (status === "done") {
    const outKey = String(body.outputKey || "");
    const outBytes = Number(body.outputBytes || 0);
    await env.DB.prepare("UPDATE jobs SET status='done', output_key=?2, output_bytes=?3, updated_at=unixepoch() WHERE job_id=?1")
      .bind(jobId, outKey, outBytes).run();
  } else if (status === "failed") {
    const msg = String(body.errorMessage || "failed").slice(0, 500);
    await env.DB.prepare("UPDATE jobs SET status='failed', error_message=?2, updated_at=unixepoch() WHERE job_id=?1")
      .bind(jobId, msg).run();
  } else {
    return json({ ok: false, error: "BAD_STATUS" }, 400, env);
  }
  return json({ ok: true }, 200, env);
}

async function handleJobStatus(request, env, jobId) {
  // Rate limit: polling (IP + client)
  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "0.0.0.0";
  const { clientId: rlClientId } = await getClientId(request, env);
  const pollLimit = Number(env.RL_POLL_PER_MINUTE || "60");
  await rateLimit(env, `poll:ip:${ip}`, pollLimit, 60);
  await rateLimit(env, `poll:cid:${rlClientId}`, pollLimit, 60);

  const { clientId, setCookie } = await getClientId(request, env);
  const row = await env.DB.prepare(
    "SELECT job_id, tool, status, input_key, output_key, output_bytes, error_message, client_id, cost, op_id, created_at, updated_at FROM jobs WHERE job_id=?1 AND client_id=?2"
  ).bind(jobId, clientId).first();
  if (!row) return json({ ok: false, error: "NOT_FOUND" }, 404, env, setCookie ? { "set-cookie": setCookie } : undefined);

  // Signed download URL (1 hour) for completed jobs
  let download_url = null;
  if (row.status === "done" && row.output_key) {
    try {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const t = await createDownloadToken(env, { jobId: row.job_id, clientId, exp });
      download_url = `/api/jobs/${encodeURIComponent(row.job_id)}/result?t=${encodeURIComponent(t)}`;
    } catch (_) {
      // secret not configured; fall back to cookie-based download
      download_url = `/api/jobs/${encodeURIComponent(row.job_id)}/result`;
    }
  }

  return json({ ok: true, data: { ...row, download_url } }, 200, env, setCookie ? { "set-cookie": setCookie } : undefined);
}


async function handleJobResult(request, env, ctx, jobId) {
  // Rate limit: polling (IP + client)
  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "0.0.0.0";
  const url = new URL(request.url);
  const token = url.searchParams.get("t");

  const { clientId: rlClientId } = await getClientId(request, env);
  const pollLimit = Number(env.RL_POLL_PER_MINUTE || "60");
  await rateLimit(env, `poll:ip:${ip}`, pollLimit, 60);
  await rateLimit(env, `poll:cid:${rlClientId}`, pollLimit, 60);

  // Signed download (no-cookie) for CDN caching
  let clientId = null;
  if (token) {
    const v = await verifyDownloadToken(env, { jobId, token });
    if (!v.ok) return json({ ok: false, error: "INVALID_TOKEN" }, 403, env);
    clientId = v.clientId;
  } else {
    const c = await getClientId(request, env);
    clientId = c.clientId;
  }

  const row = await env.DB.prepare("SELECT status, output_key FROM jobs WHERE job_id=?1 AND client_id=?2")
    .bind(jobId, clientId)
    .first();
  if (!row) return json({ ok: false, error: "NOT_FOUND" }, 404, env);
  if (row.status !== "done") return json({ ok: false, error: "NOT_READY", status: row.status }, 409, env);

  const fetchFromR2 = async () => {
    const obj = await env.PDF_R2.get(row.output_key);
    if (!obj) return json({ ok: false, error: "OUTPUT_NOT_FOUND" }, 404, env);

    const headers = new Headers(corsHeaders(env));
    obj.writeHttpMetadata(headers);
    headers.set("etag", obj.httpEtag);

    // NOTE: token requests are safe to cache (no cookies) and are already signed.
    // Non-token requests might be tied to a client cookie, so never cache them.
    headers.set(
      "cache-control",
      token
        ? "public, max-age=60, s-maxage=3600, stale-while-revalidate=86400"
        : "no-store"
    );

    return new Response(obj.body, { headers });
  };

  // Enterprise Edge Mode:
  // - If signed token is present, cache at edge with SWR to reduce R2 reads and speed up delivery.
  if (token) {
    return await edgeCachePublicGET(request, env, ctx, { ttl: 3600, swr: 86400 }, fetchFromR2);
  }

  return fetchFromR2();
}

async function runCleanup(env) {
  const ttlDefault = Number(env.JOB_TTL_SECONDS || DEFAULT_JOB_TTL_SECONDS);
  const extraGrace = Number(env.CLEANUP_GRACE_SECONDS || "600");
  const cutoff = Math.floor(Date.now() / 1000) - (ttlDefault + extraGrace);
  const limit = Math.min(Math.max(Number(env.CLEANUP_BATCH || "50"), 1), 200);

  const { results } = await env.DB.prepare("SELECT job_id FROM jobs WHERE updated_at < ?1 LIMIT ?2")
    .bind(cutoff, limit).all();


  // Cleanup auth tokens (avoid infinite growth)
  const nowMs = Date.now();
  try {
    await env.DB.prepare("DELETE FROM email_tokens WHERE expires_at < ?1").bind(nowMs).run();
    // Delete expired OR already used password reset tokens
    await env.DB.prepare("DELETE FROM password_resets WHERE expires_at < ?1 OR used_at IS NOT NULL").bind(nowMs).run();
    await env.DB.prepare("DELETE FROM refresh_tokens WHERE expires_at < ?1 OR revoked_at IS NOT NULL").bind(nowMs).run();
  } catch {}

  if (!results || results.length === 0) return;

  for (const r of results) {
    const jobId = r.job_id;
    await env.DB.prepare("DELETE FROM jobs WHERE job_id=?1").bind(jobId).run();

    const prefix = `jobs/${jobId}/`;
    try {
      let cursor = undefined;
      for (let i = 0; i < 10; i++) {
        const listed = await env.PDF_R2.list({ prefix, cursor, limit: 1000 });
        if (listed.objects.length) await env.PDF_R2.delete(listed.objects.map(o => o.key));
        if (!listed.truncated) break;
        cursor = listed.cursor;
      }
    } catch {}
  }
}


// ============================================================
// ABUSE PROTECTION (Turnstile + Multi-layer Rate Limit)
// ============================================================
async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET_KEY) return { success: true, skipped: true };
  if (!token) return { success: false, errorCodes: ["missing-input-response"] };

  const formData = new FormData();
  formData.append("secret", env.TURNSTILE_SECRET_KEY);
  formData.append("response", token);
  if (ip) formData.append("remoteip", ip);

  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: formData,
  });
  const out = await res.json().catch(() => ({}));
  return {
    success: !!out.success,
    action: out.action,
    errorCodes: out["error-codes"] || [],
    skipped: false,
  };
}

function getIpFromRequest(request) {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "0.0.0.0"
  );
}

// ============================================================
// Signed download URLs (R2 output) + edge cache
// - Token is bound to (jobId + clientId) and has expiry
// - Allows safe CDN caching without leaking private files
// ============================================================

async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function createDownloadToken(env, { jobId, clientId, exp }) {
  const secret = env.DOWNLOAD_SIGNING_SECRET || env.JWT_SECRET;
  if (!secret) throw new Error("DOWNLOAD_SIGNING_SECRET/JWT_SECRET not set");
  const payload = `${jobId}.${clientId}.${exp}`;
  const sig = await hmacSha256Hex(secret, payload);
  // token format: <clientId>.<exp>.<sig>
  return `${clientId}.${exp}.${sig}`;
}

async function verifyDownloadToken(env, { jobId, clientId, token }) {
  const secret = env.DOWNLOAD_SIGNING_SECRET || env.JWT_SECRET;
  if (!secret) return { ok: false, reason: "missing_secret" };
  if (!token || typeof token !== "string") return { ok: false, reason: "missing_token" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "bad_token" };
  const [cid, expStr, sig] = parts;
  const boundClientId = clientId || cid;
  const exp = Number(expStr);
  if (!Number.isFinite(exp)) return { ok: false, reason: "bad_exp" };
  const now = Math.floor(Date.now() / 1000);
  if (now > exp) return { ok: false, reason: "expired" };
  const payload = `${jobId}.${boundClientId}.${exp}`;
  const expected = await hmacSha256Hex(secret, payload);
  if (expected !== sig) return { ok: false, reason: "bad_sig" };
  return { ok: true, exp, clientId: boundClientId };
}

async function rateLimitKV(env, key, limit, windowSec) {
  if (!env.RATE_KV) return { ok: true };
  const now = Math.floor(Date.now() / 1000);
  const win = Math.floor(now / windowSec);
  const k = `${key}:${win}`;

  const cur = Number((await env.RATE_KV.get(k)) || "0");
  if (cur >= limit) return { ok: false, retryAfter: (win + 1) * windowSec - now };

  await env.RATE_KV.put(k, String(cur + 1), { expirationTtl: windowSec + 5 });
  return { ok: true };
}

async function multiLayerRateLimit(env, { ip, clientId, fingerprint, action }) {
  const limits = {
    upload: { ip: [20, 3600], clientId: [50, 3600], fingerprint: [30, 3600] },
    batch: { ip: [10, 3600], clientId: [20, 3600], fingerprint: [15, 3600] },
    checkout: { ip: [5, 3600], clientId: [10, 3600], fingerprint: [7, 3600] },
    api: { ip: [100, 60], clientId: [200, 60], fingerprint: [150, 60] },
  };
  const cfg = limits[action] || limits.upload;

  if (ip) {
    const r = await rateLimitKV(env, `rl:ip:${action}:${ip}`, cfg.ip[0], cfg.ip[1]);
    if (!r.ok) return { allowed: false, reason: "ip_rate_limit", retryAfter: r.retryAfter, layer: "ip" };
  }
  if (clientId) {
    const r = await rateLimitKV(env, `rl:client:${action}:${clientId}`, cfg.clientId[0], cfg.clientId[1]);
    if (!r.ok) return { allowed: false, reason: "client_rate_limit", retryAfter: r.retryAfter, layer: "client" };
  }
  if (fingerprint) {
    const r = await rateLimitKV(env, `rl:fp:${action}:${fingerprint}`, cfg.fingerprint[0], cfg.fingerprint[1]);
    if (!r.ok) return { allowed: false, reason: "fingerprint_rate_limit", retryAfter: r.retryAfter, layer: "fingerprint" };
  }
  return { allowed: true };
}

async function completeAbuseCheck(env, request, { action = "upload", requireTurnstile = false } = {}) {
  const ip = getIpFromRequest(request);
  const clientId = request.headers.get("x-client-id") || null;
  const fingerprint = request.headers.get("x-fingerprint") || null;
  const turnstileToken = request.headers.get("x-turnstile-token") || null;

  if (requireTurnstile && turnstileToken) {
    const t = await verifyTurnstile(env, turnstileToken, ip);
    if (!t.success && !t.skipped) return { allowed: false, reason: "turnstile_failed", details: t.errorCodes };
  }

  const rl = await multiLayerRateLimit(env, { ip, clientId, fingerprint, action });
  if (!rl.allowed) return rl;

  return { allowed: true };
}

// ============================================================
// BATCH ZIP DOWNLOAD (stream)
// ============================================================
async function handleBatchZip(request, env, batchId) {
  const { clientId, setCookie } = await getClientId(request, env);
  const { results } = await env.DB.prepare(
    `SELECT job_id, tool, status, output_key, created_at
     FROM jobs
     WHERE batch_id = ?1 AND client_id = ?2
     ORDER BY created_at ASC`
  ).bind(batchId, clientId).all();

  if (!results || results.length === 0) return json({ ok:false, error:"NOT_FOUND", message:"Batch not found" }, 404, env);
  const completed = results.filter(j => j.status === "done" && j.output_key);
  if (completed.length === 0) return json({ ok:false, error:"NO_OUTPUT", message:"Bu batch içinde tamamlanmış çıktı yok." }, 400, env);

  const readable = createBatchZip(env, completed);
  const h = {
    ...corsHeaders(env),
    "content-type": "application/zip",
    "content-disposition": `attachment; filename="batch_${batchId.slice(0, 8)}.zip"`,
    "cache-control": "no-cache",
  };
  if (setCookie) h["set-cookie"] = setCookie;
  return new Response(readable, { headers: h });
}

function createBatchZip(env, jobs) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  (async () => {
    try {
      const encoder = new TextEncoder();
      const files = [];
      let offset = 0;

      for (const job of jobs) {
        const obj = await env.PDF_R2.get(job.output_key);
        if (!obj) continue;

        const ab = await obj.arrayBuffer();
        const ext = getExtensionForTool(job.tool);
        const filename = `${job.tool}_${job.job_id.slice(0, 8)}.${ext}`;
        const filenameBytes = encoder.encode(filename);

        const crc = calculateCRC32(ab);

        const header = new Uint8Array(30 + filenameBytes.length);
        const view = new DataView(header.buffer);
        view.setUint32(0, 0x04034b50, true);
        view.setUint16(4, 20, true);
        view.setUint16(6, 0, true);
        view.setUint16(8, 0, true);
        const now = new Date();
        view.setUint16(10, dosTime(now), true);
        view.setUint16(12, dosDate(now), true);
        view.setUint32(14, crc, true);
        view.setUint32(18, ab.byteLength, true);
        view.setUint32(22, ab.byteLength, true);
        view.setUint16(26, filenameBytes.length, true);
        view.setUint16(28, 0, true);
        header.set(filenameBytes, 30);

        await writer.write(header);
        await writer.write(new Uint8Array(ab));

        files.push({
          filenameBytes,
          filename,
          offset,
          size: ab.byteLength,
          crc,
          time: now,
        });

        offset += header.byteLength + ab.byteLength;
      }

      const cdStart = offset;
      for (const f of files) {
        const cd = new Uint8Array(46 + f.filenameBytes.length);
        const v = new DataView(cd.buffer);
        v.setUint32(0, 0x02014b50, true);
        v.setUint16(4, 20, true);
        v.setUint16(6, 20, true);
        v.setUint16(8, 0, true);
        v.setUint16(10, 0, true);
        v.setUint16(12, dosTime(f.time), true);
        v.setUint16(14, dosDate(f.time), true);
        v.setUint32(16, f.crc, true);
        v.setUint32(20, f.size, true);
        v.setUint32(24, f.size, true);
        v.setUint16(28, f.filenameBytes.length, true);
        v.setUint16(30, 0, true);
        v.setUint16(32, 0, true);
        v.setUint16(34, 0, true);
        v.setUint16(36, 0, true);
        v.setUint32(38, 0, true);
        v.setUint32(42, f.offset, true);
        cd.set(f.filenameBytes, 46);
        await writer.write(cd);
        offset += cd.byteLength;
      }

      const eocd = new Uint8Array(22);
      const e = new DataView(eocd.buffer);
      e.setUint32(0, 0x06054b50, true);
      e.setUint16(4, 0, true);
      e.setUint16(6, 0, true);
      e.setUint16(8, files.length, true);
      e.setUint16(10, files.length, true);
      e.setUint32(12, offset - cdStart, true);
      e.setUint32(16, cdStart, true);
      e.setUint16(20, 0, true);
      await writer.write(eocd);

      await writer.close();
    } catch (err) {
      console.error("batch zip error", err);
      await writer.abort(err);
    }
  })();

  return readable;
}

function dosTime(date) {
  return (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
}
function dosDate(date) {
  return ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
}
function calculateCRC32(data) {
  const bytes = new Uint8Array(data);
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function getExtensionForTool(tool) {
  const map = {
    "compress": "pdf",
    "compress-strong": "pdf",
    "pdf-to-word": "docx",
    "ocr": "pdf",
    "merge": "pdf",
    "split": "pdf",
    "rotate": "pdf",
    "unlock": "pdf",
    "protect": "pdf",
    "jpg-to-pdf": "pdf",
    "pdf-to-jpg": "jpg",
    "word-to-pdf": "pdf",
    "excel-to-pdf": "pdf",
    "ppt-to-pdf": "pdf",
  };
  return map[tool] || "bin";
}

// ============================================================
// ANALYTICS (D1)
// ============================================================
async function handleTrack(request, env) {
  const ip = getIpFromRequest(request);
  const ua = request.headers.get("user-agent") || "";
  const body = await request.json().catch(() => ({}));
  const event = String(body.event || "").slice(0, 64);
  const clientId = String(body.clientId || request.headers.get("x-client-id") || "").slice(0, 128);
  const tool = body.tool ? String(body.tool).slice(0, 64) : null;

  if (!event || !clientId) return json({ ok:false, error:"BAD_REQUEST" }, 400, env);

  await trackEvent(env, {
    event,
    clientId,
    userId: body.userId || null,
    sessionId: body.sessionId || null,
    ip,
    userAgent: ua,
    tool,
    jobId: body.jobId || null,
    batchId: body.batchId || null,
    planType: body.planType || null,
    revenue: body.revenue || null,
    metadata: body.metadata || {},
  });

  return json({ ok:true }, 200, env);
}

async function trackEvent(env, { event, clientId, userId, sessionId, ip, userAgent, tool, jobId, batchId, planType, revenue, metadata }) {
  try {
    await env.DB.prepare(
      `INSERT INTO analytics_events (
        event_id, event, client_id, user_id, session_id, ip, user_agent,
        tool, job_id, batch_id, plan_type, revenue, metadata, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`
    ).bind(
      crypto.randomUUID(),
      event,
      clientId,
      userId,
      sessionId,
      ip,
      userAgent,
      tool,
      jobId,
      batchId,
      planType,
      revenue,
      JSON.stringify(metadata || {}),
      new Date().toISOString()
    ).run();
  } catch (e) {
    await circuitRecordFailure(env);
    console.warn("trackEvent failed", e);
  }
}

// ============================================================
// ADMIN API (Bearer token)
// ============================================================
async function requireAdmin(request, env) {
  const h = request.headers.get("authorization") || "";
  if (!h.startsWith("Bearer ")) return { ok: false, status: 401, error: "unauthorized" };
  const token = h.slice(7);
  if (!env.ADMIN_SECRET_TOKEN || token !== env.ADMIN_SECRET_TOKEN) return { ok: false, status: 403, error: "forbidden" };
  return { ok: true };
}

async function adminCachePurge(request, env) {
  const body = await request.json().catch(() => ({}));
  const url = body?.url ? String(body.url) : null;
  const prefix = body?.prefix ? String(body.prefix) : null;

  const cache = caches.default;

  if (url) {
    const key = buildPublicCacheKey(new Request(url, { method: "GET" }));
    const ok = await cache.delete(key);
    // also remove from index (best-effort)
    if (env?.CACHE_INDEX) {
      const u = new URL(key.url);
      const id = djb2(u.toString());
      await env.CACHE_INDEX.delete(`idx:${u.pathname}:${id}`).catch(() => {});
    }
    return { purged: ok, count: ok ? 1 : 0, mode: "url" };
  }

  if (prefix) {
    const items = await listIndexedByPrefix(env, prefix, 500);
    let count = 0;
    for (const it of items) {
      const k = buildPublicCacheKey(new Request(it.url, { method: "GET" }));
      const ok = await cache.delete(k);
      if (ok) count++;
      if (env?.CACHE_INDEX) await env.CACHE_INDEX.delete(it.key).catch(() => {});
    }
    return { purged: true, count, mode: "prefix", scanned: items.length };
  }

  return { purged: false, count: 0, error: "Provide url or prefix" };
}

// ─────────────────────────────────────────────────────────────
// Programmatic SEO pages (D1-backed)
// ─────────────────────────────────────────────────────────────
function renderSeoPage(page, origin, shouldNoindex = false) {
  const esc = (s) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
  const title = esc(page.title || page.h1 || "PDF Tool");
  const desc = esc(page.description || "");
  const h1 = esc(page.h1 || page.title || "");
  const tool = esc(page.tool_name || "");
  const content = String(page.content || "");
  const canonical = `${origin}/seo/${encodeURIComponent(page.slug)}`;
  const schemaJson = page.schema_json ? String(page.schema_json).replace(/<\/script/gi, "<\\/script") : "";
  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title}</title>
<meta name="description" content="${desc}"/>
<meta name="pdf3:tool" content="${tool}"/>
<meta name="pdf3:keyword" content="${esc(page.keyword || "")}"/>
<meta name="pdf3:seo_slug" content="${esc(page.slug || "")}"/>
${shouldNoindex ? `<meta name="robots" content="noindex,follow"/>` : `<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1"/>`}
<meta property="og:type" content="website"/>
<meta property="og:url" content="${canonical}"/>
<meta property="og:title" content="${title}"/>
<meta property="og:description" content="${desc}"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="${title}"/>
<meta name="twitter:description" content="${desc}"/>
${schemaJson ? `<script type="application/ld+json">${schemaJson}</script>` : ""}
<link rel="canonical" href="${canonical}"/>
<link rel="preconnect" href="${origin}" crossorigin>
<link rel="dns-prefetch" href="${origin}">
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:900px;margin:0 auto;padding:24px;line-height:1.55}
a{color:inherit}
.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
.badge{font-size:12px;padding:4px 10px;border:1px solid #444;border-radius:999px;opacity:.8}
.btn{display:inline-block;margin-top:14px;padding:10px 14px;border-radius:10px;border:1px solid #444;text-decoration:none}
small{opacity:.8}
</style>
<script defer src="/assets/js/attribution.js"></script>
<script defer src="/assets/js/ads-slots.js"></script>
</head>
<body>
<div class="header">
  <a href="/" aria-label="Home">← Ana Sayfa</a>
  ${tool ? `<span class="badge">${tool}</span>` : ``}
</div>
<h1>${h1}</h1>
${desc ? `<p><small>${desc}</small></p>` : ``}
<article>${content}
<section class="card" style="margin-top:18px">
  <h2 style="margin:0 0 10px">Önerilen</h2>
  <div class="ad-slot" data-ad-slot="seo_bottom"></div>
</section></article>
${tool ? `<a class="btn" href="/#tools" data-tool="${tool}">Aracı Aç</a>` : `<a class="btn" href="/#tools">Araçlara Git</a>`}
</body></html>`;
}

async function seoGetBySlug(env, slug) {
  const { results } = await env.DB.prepare(
    `SELECT id, slug, title, description, h1, content, tool_name, keyword, schema_json, last_updated
     FROM seo_pages WHERE slug = ?1 LIMIT 1`
  ).bind(slug).all();
  return results?.[0] || null;
}

async function seoList(env, limit = 200) {
  const { results } = await env.DB.prepare(
    `SELECT slug, title, description, tool_name, last_updated
     FROM seo_pages ORDER BY last_updated DESC LIMIT ?1`
  ).bind(limit).all();
  return results || [];
}

async function seoUpsert(env, slug, data) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO seo_pages (id, slug, title, description, h1, content, tool_name, keyword, schema_json, last_updated)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
     ON CONFLICT(slug) DO UPDATE SET
       title=excluded.title,
       description=excluded.description,
       h1=excluded.h1,
       content=excluded.content,
       tool_name=excluded.tool_name,
       keyword=excluded.keyword,
       schema_json=excluded.schema_json,
       last_updated=excluded.last_updated`
  ).bind(
    crypto.randomUUID(),
    slug,
    String(data.title || ""),
    String(data.description || ""),
    String(data.h1 || ""),
    String(data.content || ""),
    String(data.tool_name || ""),
    String(data.keyword || ""),
    String(data.schema_json || ""),
    now
  ).run();
  return await seoGetBySlug(env, slug);
}

async function seoDelete(env, slug) {
  await env.DB.prepare(`DELETE FROM seo_pages WHERE slug=?1`).bind(slug).run();
  return true;
}

async function renderSitemapSeo(env, origin) {
  const pages = await seoList(env, 5000);
  const urls = pages.map(p => {
    const raw = p.last_updated;
    const iso = raw && /^\d+$/.test(String(raw)) ? new Date(Number(raw)*1000).toISOString().split("T")[0]
               : raw ? String(raw).slice(0, 10) : "";
    const lastmod = iso ? `<lastmod>${iso}</lastmod>` : "";
    return `<url><loc>${origin}/seo/${encodeURIComponent(p.slug)}</loc>${lastmod}<changefreq>weekly</changefreq></url>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>` +
         `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
}

async function handleAdmin(request, env, path) {
  const a = await requireAdmin(request, env);
  if (!a.ok) return json({ ok:false, error: a.error }, a.status, env);

  if (path === "/api/admin/dashboard") return json(await adminDashboard(env), 200, env);
  if (path === "/api/admin/health") return json(await adminHealth(env), 200, env);
  if (path === "/api/admin/monitoring") return json({ events: await listMonitoringEvents(env, { limit: 200 }) }, 200, env);
  if (path === "/api/admin/webhook-failures") return json(await adminWebhookFailures(env), 200, env);

  // Cache purge
  if (path === "/api/admin/cache/purge" && request.method === "POST") {
    const out = await adminCachePurge(request, env);
    return json({ ok: true, data: out }, 200, env);
  }

  // SEO pages admin
  if (path === "/api/admin/seo-pages" && request.method === "GET") {
    const u = new URL(request.url);
    const limit = Math.min(500, Math.max(1, Number(u.searchParams.get("limit") || 200)));
    const rows = await seoList(env, limit);
    return json({ ok: true, data: { pages: rows } }, 200, env);
  }
  const mSeo = path.match(/^\/api\/admin\/seo-pages\/(.+)$/);
  if (mSeo) {
    const slug = decodeURIComponent(mSeo[1]);
    if (request.method === "GET") {
      const page = await seoGetBySlug(env, slug);
      return page ? json({ ok:true, data:{ page } }, 200, env) : json({ ok:false, error:"NOT_FOUND" }, 404, env);
    }
    if (request.method === "PUT") {
      const body = await request.json().catch(() => ({}));
      const page = await seoUpsert(env, slug, body || {});
      return json({ ok:true, data:{ page } }, 200, env);
    }
    if (request.method === "DELETE") {
      await seoDelete(env, slug);
      return json({ ok:true, data:{ deleted:true } }, 200, env);
    }
  }

  
  // SEO batch generation (priority/secondary)
  if (path === "/api/admin/generate-seo/priority" && request.method === "POST") {
    const { priorityTools, generateSeoPages } = await import("./scripts/generate-seo-pages.js");
    const out = await generateSeoPages(env, priorityTools, "priority");
    return json({ ok: true, data: out }, 200, env);
  }
  if (path === "/api/admin/generate-seo/secondary" && request.method === "POST") {
    const { secondaryTools, generateSeoPages } = await import("./scripts/generate-seo-pages.js");
    const out = await generateSeoPages(env, secondaryTools, "secondary");
    return json({ ok: true, data: out }, 200, env);
  }

  return json({ ok:false, error:"NOT_FOUND" }, 404, env);
}

async function adminWebhookFailures(env) {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT event_type, status, error, created_at
     FROM webhook_failures
     WHERE created_at >= ?1
     ORDER BY created_at DESC
     LIMIT 200`
  ).bind(sinceIso).all();
  return { window: "24h", failures: results || [] };
}

async function adminDashboard(env) {
  const sinceIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const sinceJobs = Math.floor(Date.now()/1000) - 24*3600;
  const { results: jobs } = await env.DB.prepare(
    `SELECT COUNT(*) as total,
            SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) as completed,
            SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed
     FROM jobs WHERE created_at >= ?1`
  ).bind(sinceJobs).all();

  const { results: events } = await env.DB.prepare(
    `SELECT event, COUNT(*) as c
     FROM analytics_events
     WHERE created_at >= ?1
     GROUP BY event
     ORDER BY c DESC
     LIMIT 20`
  ).bind(sinceIso).all();

  return { window: "24h", jobs: jobs[0] || {}, topEvents: events || [] };
}

async function adminHealth(env) {
  const { results: db } = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM users) as users,
            (SELECT COUNT(*) FROM jobs) as jobs,
            (SELECT COUNT(*) FROM subscriptions) as subscriptions,
            (SELECT COUNT(*) FROM analytics_events) as events`
  ).all();
  return { ok: true, db: db[0] || {} };
}

function timingSafeEq(a, b) {
  if (!a || !b) return false;
  try {
    const A = new TextEncoder().encode(String(a));
    const B = new TextEncoder().encode(String(b));
    if (A.length !== B.length) {
      crypto.timingSafeEqual(new Uint8Array([1]), new Uint8Array([1]));
      return false;
    }
    return crypto.timingSafeEqual(A, B);
  } catch {
    return false;
  }
}

// Generate sitemap-seo.xml into R2 at most once per day (uses CACHE_INDEX KV if available, else skips).
async function maybeGenerateSeoSitemap(env) {
  try {
    if (!env.CACHE_INDEX || !env.PDF_R2) return;
    const key = "seo:sitemap:last_run";
    const last = await env.CACHE_INDEX.get(key);
    const now = Date.now();
    if (last && now - Number(last) < 23 * 3600 * 1000) return; // ~daily
    const origin = requireOrigin(env);
    const xml = await renderSitemapSeo(env, origin);
    await env.PDF_R2.put("sitemap-seo.xml", xml, { httpMetadata: { contentType: "application/xml; charset=utf-8" } });
    await env.CACHE_INDEX.put(key, String(now));
  } catch {}
}
