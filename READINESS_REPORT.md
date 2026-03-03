# MirPDF — Teknik Yayına Hazırlık Raporu
Tarih: 2026-03-02 | Kapsam: VPS + Domain hariç, tüm kod tabanı

---

## ÖZET

**Kod tabanı yayına alınabilir. 4 kritik, 6 orta, 5 düşük öncelikli madde var.**

---

## 🔴 KRİTİK (Deploy öncesi zorunlu)

### K1 — wrangler.toml placeholder'lar doldurulmamış
Gate çalıştırıldığında 11 FAIL veriyor. Bunların tamamı senden manuel giriş bekliyor:

```
database_id      → wrangler d1 create mirpdf-db
APP_ORIGIN       → https://mirpdf.com
ALLOWED_ORIGIN   → https://mirpdf.com
PROCESSOR_URL    → https://processor.mirpdf.com (Tunnel kurulduktan sonra)
KV id × 3        → wrangler kv namespace create × 3
EMAIL_FROM       → no-reply@mirpdf.com
STRIPE_*         → Stripe Dashboard'dan
```

**Test:** `bash scripts/release_gate.sh` → FAIL: 0 görene kadar devam et.

---

### K2 — 6 adet wrangler secret eklenmemiş
```bash
wrangler secret put JWT_SECRET
wrangler secret put DOWNLOAD_SIGNING_SECRET
wrangler secret put PROCESSOR_SECRET
wrangler secret put CLIENT_ID_SECRET
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_WEBHOOK_SECRET
```
Eksik secret → 500 veya kredi sistemi çalışmıyor.

---

### K3 — D1 schema çalıştırılmamış
```bash
wrangler d1 execute mirpdf-db --file=d1/schema.sql --remote
for f in d1/migration-v*.sql; do
  wrangler d1 execute mirpdf-db --file="$f" --remote
done
```
Çalıştırılmazsa tüm job/user/payment işlemleri 500 verir.

---

### K4 — ads.txt ve Google/Yandex doğrulama dosyaları placeholder
```
public/ads.txt                              → pub-XXXXXXXXXXXXXXXX gerçek AdSense ID ile
public/google-site-verification-PLACEHOLDER.html → Search Console'dan indirilen gerçek dosya
public/yandex-verification-PLACEHOLDER.html     → Yandex Webmaster'dan gerçek dosya
```
SEO için zorunlu değil ama AdSense geliri istiyorsan K4.

---

## 🟠 ORTA ÖNCELİK (İlk haftada düzeltilmeli)

### O1 — 6 araç tool sayfası frontend/tools'da, public/tools'da yok
```
filigran-ekle, jpg-den-pdf, pdf-den-jpg, pdf-duzenle, pdf-imzala, pdf-kilit-ac
```
Bu araçlar client-side (pdf-lib) çalışıyor — sunucu kodu doğru. Ama:
- `frontend/tools/` dosyaları `public/tools/` klasörüne kopyalanmalı
- Ya da bu araçların client-side JS'i public'e taşınmalı
- _redirects'te bazıları var ama hedef dosyalar yok → 404 verir

**Hızlı düzeltme:**
```bash
cp frontend/tools/filigran-ekle.html public/tools/
cp frontend/tools/jpg-den-pdf.html public/tools/
cp frontend/tools/pdf-den-jpg.html public/tools/
cp frontend/tools/pdf-duzenle.html public/tools/
cp frontend/tools/pdf-imzala.html public/tools/
cp frontend/tools/pdf-kilit-ac.html public/tools/
```
Ama bu sayfaların FILL_ACTUAL_DOMAIN placeholder'larını da sed ile doldur:
```bash
find public/tools -name "*.html" -exec sed -i 's|FILL_ACTUAL_DOMAIN|mirpdf.com|g' {} \;
```

---

### O2 — Queue consumer max_concurrency tanımlı değil
wrangler.toml'daki `[[queues.consumers]]` bloğunda `max_concurrency` eksik:
```toml
# Şu an:
[[queues.consumers]]
queue = "pdf_jobs"

# Olması gereken:
[[queues.consumers]]
queue = "pdf_jobs"
max_concurrency = 2      # Processor'ın PROC_MAX_CONCURRENCY ile eşit tut
max_retries = 3
dead_letter_queue = "pdf_jobs_dlq"  # opsiyonel ama önerilir
```
Eksikse Cloudflare default değerleri kullanır (çoğu zaman sorun çıkmaz ama yüksek trafikte kontrol dışı olur).

---

### O3 — CreditCounter alarm handler yok
Günlük kredi reset `_ensureDailyCredits()` lazy (istek geldiğinde) çalışıyor — bu yeterli.
Ama `alarm()` handler eksik, yani Durable Object'in storage'ını proaktif boşaltma yok.
Kullanıcı giriş yapmazsa eski storage büyüyebilir. İlk 3 ayda sorun çıkarmaz.

---

### O4 — Stripe price ID'leri price_xxx
wrangler.toml'da Stripe plan fiyat ID'leri placeholder. Ödeme akışı çalışmaz:
```toml
STRIPE_PRICE_BASIC     = "price_xxx"   → Stripe Dashboard → Products → price_live_...
STRIPE_PRICE_PRO       = "price_xxx"
STRIPE_PRICE_CREDITS100 = "price_xxx"
STRIPE_PRICE_CREDITS500 = "price_xxx"
STRIPE_SUB_PRICE_BASIC  = "price_xxx"
STRIPE_SUB_PRICE_PRO    = "price_xxx"
```
Ücretsiz kullanım (FREE_MODE) çalışır, ama ödeme butonu çalışmaz.

---

### O5 — ADMIN_SECRET_TOKEN boş
wrangler.toml'da `ADMIN_SECRET_TOKEN = ""`. Admin paneli teknik olarak korumalı ama boş token ile `Authorization: Bearer ` ile erişilebilir. 

```bash
wrangler secret put ADMIN_SECRET_TOKEN
# openssl rand -hex 32
```

---

### O6 — RESEND_API_KEY boş → email gönderilemez
Email doğrulama, şifre sıfırlama çalışmaz. Resend.com'dan API key al:
```
wrangler.toml: RESEND_API_KEY = "re_xxxx..."
```
Ya da Resend hesabı yoksa `REQUIRE_EMAIL_VERIFIED = "0"` yap (geçici).

---

## 🟡 DÜŞÜK ÖNCELİK (Fırsatta düzeltilmeli)

### D1 — package.json'da proje adı hâlâ "pdf-platform"
```json
"name": "pdf-platform"  →  "name": "mirpdf"
```
Deploy'u etkilemez ama tutarlılık için.

---

### D2 — Stripe Webhook URL Cloudflare'de tanımlı değil
Stripe Dashboard'da webhook endpoint tanımlanmamış. Ödeme callback'leri gelmez:
```
Stripe Dashboard → Developers → Webhooks → Add endpoint
URL: https://mirpdf.com/api/billing/webhook
Events: checkout.session.completed, customer.subscription.*, invoice.payment_*
```

---

### D3 — netlify.toml dosyası projede mevcut
```
netlify.toml  ← Cloudflare Pages projesi için gereksiz, kafa karıştırır
```
```bash
rm netlify.toml
```

---

### D4 — UptimeRobot / BetterStack kurulu değil
Prod çöktüğünde nasıl haberdar olacaksın? İlk deploy öncesi:
- `https://mirpdf.com/health` → 5 dk kontrol
- `https://processor.mirpdf.com/health` → 5 dk kontrol
- Email alert ekle

---

### D5 — Turnstile (bot koruması) pasif
```toml
TURNSTILE_SITE_KEY = ""   # doldurulmamış
```
Rate limiting var, Turnstile opsiyonel. Ama yoğun bot trafiği gelirse ilk savunma hattı zayıf.
Cloudflare Dashboard → Turnstile → Create Widget → site key al.

---

## ✅ HAZIR OLAN HER ŞEY

| Kategori | Durum |
|---|---|
| Worker kod yapısı (_worker.js) | ✅ |
| APP_ORIGIN config guard (requireOrigin) | ✅ |
| CORS — wildcard yok, evil origin bloke | ✅ |
| Admin route — çift katman koruma | ✅ |
| PDF magic bytes doğrulaması (415) | ✅ |
| Rate limiting (upload/job/poll/login/register) | ✅ |
| Circuit breaker (KV bazlı) | ✅ |
| Stripe webhook idempotency (D1 processed_events) | ✅ |
| JWT + signed cookie auth | ✅ |
| DOWNLOAD_SIGNING_SECRET tek isim | ✅ |
| HSTS + security headers (_headers) | ✅ |
| D1 schema (15 tablo, 32 index) | ✅ |
| Cleanup cron (D1 + R2 TTL) | ✅ |
| Processor concurrency (PROC_MAX_CONCURRENCY) | ✅ |
| Processor global timeout (PROC_TIMEOUT_MS) | ✅ |
| Processor max bytes (PROC_MAX_BYTES) | ✅ |
| Processor timing-safe auth | ✅ |
| Processor tmp dizin cleanup | ✅ |
| Ghostscript -dSAFER flag | ✅ |
| OCR lang injection koruması | ✅ |
| R2 download/upload retry mantığı | ✅ |
| Cloudflare Tunnel setup scripti | ✅ |
| Release gate scripti | ✅ |
| Scheduled cron (cleanup + monitoring) | ✅ |
| Queue consumer (pdf_jobs) | ✅ |

---

## Öncelikli Yapılacaklar Sırası

```
Bugün (deploy bloklayan):
  1. wrangler d1/kv/r2 create → ID al → wrangler.toml doldur
  2. 6 × wrangler secret put
  3. wrangler d1 execute schema.sql
  4. Stripe Dashboard'dan price ID al → wrangler.toml
  5. ADMIN_SECRET_TOKEN secret'a al
  6. frontend/tools/*.html → public/tools/ kopyala + sed FILL_ACTUAL_DOMAIN
  7. bash scripts/release_gate.sh → FAIL: 0
  8. wrangler pages deploy public/

Bu hafta:
  9.  Resend API key → email verify aktif
  10. Stripe Webhook URL tanımla
  11. wrangler.toml queues.consumers max_concurrency = 2 ekle
  12. UptimeRobot /health izleme kur
  13. AdSense pub ID güncelle
  14. netlify.toml sil

Sonra:
  15. Turnstile site key
  16. package.json name güncelle
  17. CreditCounter alarm handler (opsiyonel)
```
