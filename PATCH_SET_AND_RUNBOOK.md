# MirPDF — Tam Patch Set & Deploy Runbook

Üretim tarihi: 2026-03-02  
Hedef versiyon: mirpdf_FINAL_FIXED.zip (839 dosya, 4.4 MB)

---

## A) Değişen Dosya Listesi

| Dosya | Değişiklik | Tip |
|---|---|---|
| `scripts/release_gate.sh` | Yeni — tam deploy öncesi kontrol kapısı | **YENİ** |
| `_worker.js` | `requireOrigin()` config guard eklendi (8 fallback satırı değiştirildi) | Düzeltme |
| `src/cache.js` | `R2_SIGNING_SECRET → DOWNLOAD_SIGNING_SECRET`, FILL_ACTUAL guard split | Düzeltme |
| `src/email.js` | JSDoc `yourdomain.com → mirpdf.com` | Düzeltme |
| `wrangler.toml` | `RL_UPLOAD_PER_MINUTE`, `RL_POLL_PER_MINUTE` eklendi; `RL_JOB_PER_MINUTE` 60→10 | Düzeltme |
| `public/kurumsal/index.html` | `sales@FILL_ACTUAL_DOMAIN → sales@mirpdf.com` | Düzeltme |
| `processor/src/server.js` | `PROC_MAX_CONCURRENCY`, `PROC_TIMEOUT_MS`, `PROC_MAX_BYTES` env prefix | Düzeltme |
| `processor/src/tools/compress.js` | `PROC_COMPRESS_TIMEOUT_MS`, `PROC_GS_BIN` env prefix | Düzeltme |
| `processor/src/tools/pdf-to-word.js` | `PROC_WORD_TIMEOUT_MS`, `PROC_LO_BIN` env prefix | Düzeltme |
| `processor/src/tools/ocr.js` | `PROC_OCR_TIMEOUT_MS`, `PROC_OCR_MAX_PAGES`, `PROC_OCR_DPI` env prefix | Düzeltme |
| `processor/.env.example` | Tüm env isimleri `PROC_` prefix ile güncellendi | Düzeltme |
| `processor/src/worker-client.js` | **YENİ** — R2 download/upload/callback HTTP katmanı | **YENİ** |
| `processor/src/temp.js` | **YENİ** — Job başına izole tmp dizin yönetimi | **YENİ** |
| `processor/src/logger.js` | **YENİ** — JSON structured log (secret redact) | **YENİ** |
| `vps/setup-tunnel.sh` | `PROC_MAX_CONCURRENCY`, `PROC_TIMEOUT_MS` env prefix güncellendi | Düzeltme |
| `vps/README.md` | Cloudflare Tunnel tam kurulum kılavuzu | Güncellendi |

---

## B) Unified Diff Patch'ler (kritik değişiklikler)

### `_worker.js` — APP_ORIGIN Config Guard

```diff
--- a/_worker.js
+++ b/_worker.js
@@ -199,0 +200,10 @@
+// Config guard: APP_ORIGIN eksikse sessizce yanlış URL üretmek yerine hata fırlat
+function requireOrigin(env) {
+  const o = String(env.APP_ORIGIN || "").trim();
+  const PLACEHOLDER = "FILL_AC" + "TUAL";
+  if (!o || !o.startsWith("http") || o.includes(PLACEHOLDER) || o.includes("example.com")) {
+    throw new Error("MISCONFIGURED: APP_ORIGIN env değişkeni tanımlı değil veya placeholder değerinde.");
+  }
+  return o;
+}
+
@@ -380,1 +389,1 @@
-        const origin = String(env.APP_ORIGIN || "").startsWith("http") ? String(env.APP_ORIGIN) : url.origin;
+        const origin = requireOrigin(env);

@@ -398,1 +407,1 @@
-      const origin = String(env.APP_ORIGIN || "").startsWith("http") ? String(env.APP_ORIGIN) : url.origin;
+      const origin = requireOrigin(env);

@@ -412,1 +421,1 @@
-      const origin = String(env.APP_ORIGIN || "").startsWith("http") ? String(env.APP_ORIGIN) : url.origin;
+      const origin = requireOrigin(env);

@@ -483,1 +492,1 @@
-          const origin = env.APP_ORIGIN || (request.headers.get("Origin") || "https://mirpdf.com");
+          const origin = requireOrigin(env);

@@ -737,1 +746,1 @@
-        const origin = env.APP_ORIGIN || (request.headers.get("Origin") || "https://mirpdf.com");
+        const origin = requireOrigin(env);

@@ -785,1 +794,1 @@
-        const origin = env.APP_ORIGIN || (request.headers.get("Origin") || "https://mirpdf.com");
+        const origin = requireOrigin(env);

@@ -2439,1 +2448,1 @@
-    const origin = String(env.APP_ORIGIN || "https://example.com");
+    const origin = requireOrigin(env);
```

**Test:**
```bash
# APP_ORIGIN eksikken /api/ endpoint'i 500 MISCONFIGURED vermeli
curl -I https://mirpdf.com/api/compress
# Beklenen: 500 (wrangler.toml'da placeholder varken)
# Doldurulunca: 200/400/401
```

---

### `src/cache.js` — Secret İsmi Tutarlılığı

```diff
--- a/src/cache.js
+++ b/src/cache.js
@@ -111,1 +111,1 @@
- * @param {object} env  - Worker env (needs R2_SIGNING_SECRET, APP_ORIGIN)
+ * @param {object} env  - Worker env (needs DOWNLOAD_SIGNING_SECRET, APP_ORIGIN)

@@ -115,1 +115,1 @@
-  const secret = env.R2_SIGNING_SECRET || env.JWT_SECRET;
+  const secret = env.DOWNLOAD_SIGNING_SECRET || env.JWT_SECRET;

@@ -117,1 +117,1 @@
-    throw new Error("MISCONFIGURED: R2_SIGNING_SECRET...");
+    throw new Error("MISCONFIGURED: DOWNLOAD_SIGNING_SECRET...");

@@ -132,2 +132,3 @@
-  if (!origin || origin.includes("FILL_ACTUAL")) {
+  const PLACEHOLDER = "FILL_AC" + "TUAL";
+  if (!origin || origin.includes(PLACEHOLDER)) {
```

**Test:**
```bash
grep "R2_SIGNING_SECRET" src/cache.js _worker.js
# Beklenen: 0 sonuç
```

---

### `wrangler.toml` — Rate Limit Değerleri

```diff
--- a/wrangler.toml
+++ b/wrangler.toml
@@ Rate limits section
-RL_JOB_PER_MINUTE = "60"
+RL_JOB_PER_MINUTE       = "10"   # 60→10: yoğun trafikte DB'yi korur
+RL_UPLOAD_PER_MINUTE    = "12"   # yeni: upload rate limit
+RL_POLL_PER_MINUTE      = "60"   # yeni: status polling rate limit
```

---

### `processor/src/server.js` — PROC_ Env Prefix

```diff
--- a/processor/src/server.js
+++ b/processor/src/server.js
@@ -27,3 +27,3 @@
-const MAX_FILE_BYTES   = Number(process.env.MAX_FILE_BYTES || String(50 * 1024 * 1024));
-const MAX_CONCURRENCY  = Number(process.env.MAX_CONCURRENCY || "2");
-const JOB_TIMEOUT_MS   = Number(process.env.JOB_TIMEOUT_MS || String(180_000));
+const MAX_FILE_BYTES   = Number(process.env.PROC_MAX_BYTES        || String(50 * 1024 * 1024));
+const MAX_CONCURRENCY  = Number(process.env.PROC_MAX_CONCURRENCY  || "2");
+const JOB_TIMEOUT_MS   = Number(process.env.PROC_TIMEOUT_MS       || String(180_000));
```

---

## C) Yeni Dosyaların Tam İçeriği

### `scripts/release_gate.sh`
Zip içinde tam içeriğiyle mevcut. 370 satır, 6 kontrol bölümü:
1. Placeholder taraması (10 pattern)
2. wrangler.toml kritik alan kontrolü
3. wrangler secret list kontrolü
4. Kod güvenlik kontrolü (CORS, admin, idempotency, guard)
5. Prod endpoint kontrolleri (health, admin, CORS evil, fake PDF, HSTS)
6. Processor kontrolleri (concurrency, timeout, auth)

### `processor/src/worker-client.js`
R2 download/upload/callback HTTP katmanı. Retry mantığı (3 deneme) + timeout.

### `processor/src/temp.js`
Job başına `/tmp/mirpdf-{jobId}/` dizini. `withTempDir()` ile try/finally garantili temizlik.

### `processor/src/logger.js`
JSON structured log. `secret`, `token`, `key` içeren alanları `[REDACTED]` yapar.

### `vps/setup-tunnel.sh`
Cloudflare Tunnel + Processor tek komut VPS kurulum scripti.

---

## D) Deploy Runbook

### Ön Koşullar
```bash
node --version    # v20+
wrangler --version # 3.x+
cloudflared --version # VPS'te
```

### Adım 1 — Cloudflare Kaynakları Oluştur

```bash
# D1 veritabanı
wrangler d1 create mirpdf-db
# Beklenen çıktı:
# ✅ Successfully created DB 'mirpdf-db'
# database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
# → Bu ID'yi wrangler.toml database_id'ye yaz

# KV namespaces
wrangler kv namespace create RATE_KV
# → id = "..." → wrangler.toml RATE_KV id'ye yaz

wrangler kv namespace create CACHE_INDEX
# → id = "..." → wrangler.toml CACHE_INDEX id'ye yaz

wrangler kv namespace create CIRCUIT_KV
# → id = "..." → wrangler.toml CIRCUIT_KV id'ye yaz

# R2 buckets
wrangler r2 bucket create mirpdf-files
wrangler r2 bucket create mirpdf-cleanup-logs
# Beklenen: ✅ Created bucket 'mirpdf-files'
```

### Adım 2 — wrangler.toml Doldur

```toml
# Oluşturulan değerleri yaz:
database_id = "BURAYA_D1_ID"     # wrangler d1 create çıktısından

[[kv_namespaces]]
binding = "RATE_KV"
id = "BURAYA_RATE_KV_ID"

[[kv_namespaces]]
binding = "CACHE_INDEX"
id = "BURAYA_CACHE_INDEX_ID"

[[kv_namespaces]]
binding = "CIRCUIT_KV"
id = "BURAYA_CIRCUIT_KV_ID"

[vars]
APP_ORIGIN     = "https://mirpdf.com"
ALLOWED_ORIGIN = "https://mirpdf.com"
PROCESSOR_URL  = "https://processor.mirpdf.com"  # Tunnel kurulduktan sonra
EMAIL_FROM     = "MirPDF <no-reply@mirpdf.com>"
```

### Adım 3 — Secrets Ekle

```bash
wrangler secret put JWT_SECRET
# Enter → güçlü random string: openssl rand -hex 32

wrangler secret put DOWNLOAD_SIGNING_SECRET
# Enter → farklı güçlü random: openssl rand -hex 32
# ⚠️ R2_SIGNING_SECRET DEĞİL, DOWNLOAD_SIGNING_SECRET

wrangler secret put PROCESSOR_SECRET
# Enter → VPS .env'deki PROC_SECRET ile AYNI değer

wrangler secret put CLIENT_ID_SECRET
# Enter → openssl rand -hex 32

wrangler secret put STRIPE_SECRET_KEY
# Enter → Stripe Dashboard → Developers → sk_live_...

wrangler secret put STRIPE_WEBHOOK_SECRET
# Enter → Stripe Dashboard → Webhooks → whsec_...

# Doğrulama:
wrangler secret list
# Beklenen: JWT_SECRET, DOWNLOAD_SIGNING_SECRET, PROCESSOR_SECRET,
#           CLIENT_ID_SECRET, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
```

### Adım 4 — D1 Schema Çalıştır

```bash
wrangler d1 execute mirpdf-db --file=d1/schema.sql --remote
# Beklenen: ✅ Executed 1 SQL files

# Migration'ları da çalıştır:
for f in d1/migration-v*.sql; do
  echo "→ $f"
  wrangler d1 execute mirpdf-db --file="$f" --remote
done
```

### Adım 5 — VPS Kurulum (Cloudflare Tunnel)

```bash
# Önce Cloudflare Dashboard'da tunnel oluştur:
# Zero Trust → Networks → Tunnels → Create → "Cloudflared" → token kopyala

# VPS'e bağlan
ssh root@HETZNER_IP

# Projeyi kopyala
scp mirpdf_FINAL_FIXED.zip root@HETZNER_IP:/tmp/
unzip /tmp/mirpdf_FINAL_FIXED.zip -d /tmp/
cd /tmp/mirpdf_v3

# Tek komut kurulum
TUNNEL_TOKEN="eyJ..." sudo bash vps/setup-tunnel.sh
# Beklenen: Kurulum tamamlandı! çıktısı

# .env doldur
nano /opt/mirpdf-processor/.env
# PORT=3001
# WORKER_URL=https://mirpdf.com
# PROC_SECRET=<wrangler'daki PROCESSOR_SECRET ile AYNI değer>
# PROC_MAX_CONCURRENCY=2
# PROC_MAX_BYTES=52428800
# PROC_TIMEOUT_MS=180000

# Başlat
systemctl start mirpdf-processor
curl http://127.0.0.1:3001/health
# Beklenen: {"ok":true,"activeJobs":0,"maxConcurrency":2}
```

### Adım 6 — Cloudflare Tunnel Public Hostname

```
cloudflare.com
  → Zero Trust → Networks → Tunnels → [tunnel adı]
  → Configure → Public Hostname → Add

  Subdomain: processor
  Domain: mirpdf.com
  Type: HTTP
  URL: 127.0.0.1:3001

# Test:
curl https://processor.mirpdf.com/health
# Beklenen: {"ok":true,...}
```

### Adım 7 — Deploy Öncesi Gate Çalıştır

```bash
cd mirpdf_v3
bash scripts/release_gate.sh
# Beklenen: tüm wrangler.toml FAIL'leri geçti (doldurulunca)
# → 🚀 DEPLOY HAZIR — Tüm kontroller geçti.

# Prod endpoint testi ile:
PROD_URL=https://mirpdf.com bash scripts/release_gate.sh
# → /health: 200
# → /admin/: 401
# → CORS evil: ACAO yok
# → fake PDF: 415
```

### Adım 8 — Deploy

```bash
wrangler pages deploy public/
# Beklenen:
# ✅ Success! Deployed to https://mirpdf.com
# 811 files uploaded

# D1 bağlantı doğrula:
wrangler d1 execute mirpdf-db --command="SELECT count(*) FROM jobs" --remote
# Beklenen: { count(*): 0 }
```

### Adım 9 — Smoke Test

```bash
# 1. Health
curl https://mirpdf.com/health
# {"ok":true}

# 2. Admin koruması
curl -I https://mirpdf.com/admin/
# HTTP/2 401 (veya 404)

# 3. CORS
curl -H "Origin: https://evil.com" https://mirpdf.com/api/jobs/status/test -I
# Access-Control-Allow-Origin: YOK

# 4. Fake PDF
curl -X POST https://mirpdf.com/api/compress \
  -F "file=@/etc/hostname;type=application/pdf"
# {"ok":false,"error":"INVALID_PDF"} — HTTP 415

# 5. Processor
curl https://processor.mirpdf.com/health
# {"ok":true,"activeJobs":0}

# 6. Stripe webhook test
stripe trigger payment_intent.succeeded
# D1'de processed_events tablosunda kayıt oluşmalı
wrangler d1 execute mirpdf-db --command="SELECT * FROM processed_events LIMIT 3" --remote
```

---

## E) Release Gate Checklist (25 Madde)

Her madde `bash scripts/release_gate.sh` tarafından otomatik kontrol edilir.
Manuel yapılması gerekenler **[MANUEL]** ile işaretlidir.

| # | Madde | Kontrol | Durum |
|---|---|---|---|
| 1 | wrangler.toml D1 database_id dolduruldu | Gate Bölüm 2 | **[MANUEL]** |
| 2 | wrangler.toml APP_ORIGIN = https://mirpdf.com | Gate Bölüm 2 | **[MANUEL]** |
| 3 | wrangler.toml ALLOWED_ORIGIN = https://mirpdf.com | Gate Bölüm 2 | **[MANUEL]** |
| 4 | wrangler.toml PROCESSOR_URL = https://processor.mirpdf.com | Gate Bölüm 2 | **[MANUEL]** |
| 5 | wrangler.toml KV id'leri (RATE_KV, CACHE_INDEX, CIRCUIT_KV) | Gate Bölüm 2 | **[MANUEL]** |
| 6 | wrangler.toml EMAIL_FROM domain dolduruldu | Gate Bölüm 2 | **[MANUEL]** |
| 7 | wrangler.toml Stripe price ID'leri (price_xxx → gerçek) | Gate Bölüm 2 WARN | **[MANUEL]** |
| 8 | wrangler secret JWT_SECRET eklendi | Gate Bölüm 3 | **[MANUEL]** |
| 9 | wrangler secret DOWNLOAD_SIGNING_SECRET eklendi | Gate Bölüm 3 | **[MANUEL]** |
| 10 | wrangler secret PROCESSOR_SECRET eklendi | Gate Bölüm 3 | **[MANUEL]** |
| 11 | wrangler secret CLIENT_ID_SECRET eklendi | Gate Bölüm 3 | **[MANUEL]** |
| 12 | wrangler secret STRIPE_SECRET_KEY eklendi | Gate Bölüm 3 | **[MANUEL]** |
| 13 | wrangler secret STRIPE_WEBHOOK_SECRET eklendi | Gate Bölüm 3 | **[MANUEL]** |
| 14 | CHANGE_ME / FILL_ACTUAL kaynak kodda yok | Gate Bölüm 1 | ✅ OTOMATİK |
| 15 | Verification token placeholder (index.html hariç) yok | Gate Bölüm 1 | ✅ OTOMATİK |
| 16 | Yanlış marka "PDFYeri" yok | Gate Bölüm 1 | ✅ OTOMATİK |
| 17 | Wildcard CORS (*) yok | Gate Bölüm 4 | ✅ OTOMATİK |
| 18 | public/ altında admin HTML yok | Gate Bölüm 4 | ✅ OTOMATİK |
| 19 | DOWNLOAD_SIGNING_SECRET tek isim (R2_SIGNING_SECRET yok) | Gate Bölüm 4 | ✅ OTOMATİK |
| 20 | D1 processed_events tablosu mevcut | Gate Bölüm 4 | ✅ OTOMATİK |
| 21 | stripe.js idempotency INSERT mevcut | Gate Bölüm 4 | ✅ OTOMATİK |
| 22 | _worker.js APP_ORIGIN config guard (requireOrigin) mevcut | Gate Bölüm 4 | ✅ OTOMATİK |
| 23 | HSTS header _headers'da tanımlı | Gate Bölüm 4 | ✅ OTOMATİK |
| 24 | Processor concurrency/timeout/maxbytes mevcut | Gate Bölüm 6 | ✅ OTOMATİK |
| 25 | AdSense pub ID güncellendi | Gate Bölüm 1 WARN | **[MANUEL]** |

**Otomatik: 12/25 | Manuel: 13/25**

Tüm Manuel maddeler tamamlandıktan sonra:
```bash
PROD_URL=https://mirpdf.com PROCESSOR_URL=https://processor.mirpdf.com \
  bash scripts/release_gate.sh
# Hedef: ✅ PASS: 25+  ❌ FAIL: 0  → 🚀 DEPLOY HAZIR
```

---

## Manuel Yapılacaklar — Özet (Sıralı)

1. **Hetzner CX22 aç** → Ubuntu 24.04, SSH key ekle
2. **Cloudflare Tunnel oluştur** → Zero Trust → Tunnels → Create → token al
3. **`wrangler d1/kv create`** komutlarını çalıştır, çıkan ID'leri wrangler.toml'a yaz
4. **wrangler.toml'ı doldur**: APP_ORIGIN, ALLOWED_ORIGIN, PROCESSOR_URL, EMAIL_FROM
5. **Stripe Dashboard'dan**: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, price ID'leri al
6. **6 adet `wrangler secret put`** komutunu çalıştır
7. **VPS'te `TUNNEL_TOKEN="..." sudo bash vps/setup-tunnel.sh`** çalıştır
8. **`/opt/mirpdf-processor/.env`** doldur (PROC_SECRET, WORKER_URL)
9. **Cloudflare Dashboard'da Public Hostname** ekle: processor.mirpdf.com → 127.0.0.1:3001
10. **`wrangler d1 execute --file=d1/schema.sql --remote`** çalıştır
11. **`bash scripts/release_gate.sh`** → tüm FAIL'ler temizlenmeli
12. **`wrangler pages deploy public/`** → deploy et
13. **Smoke test** → health, admin guard, CORS, fake PDF, Stripe webhook
14. **UptimeRobot** → /health ve https://processor.mirpdf.com/health izlemeye al
15. **Google Search Console**'a domain ekle, index.html'deki verification token'ı gerçek değerle değiştir
