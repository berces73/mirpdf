# VPS Kurulum — Cloudflare Tunnel (Seçenek A)

## Neden Tunnel?

```
Klasik yaklaşım (Seçenek B):
  Worker → Internet → Nginx 443 → 127.0.0.1:3001

Tunnel yaklaşımı (Seçenek A — Önerilen):
  Worker → Cloudflare ağı → cloudflared (VPS'te) → 127.0.0.1:3001
```

**Farkı:** Tunnel'da VPS'e gelen hiçbir port internete açık değil.
`cloudflared` servisi VPS'ten Cloudflare'e giden kalıcı bağlantı kurar.
Dışarıdan VPS'e ulaşmak imkânsız — 3001'i, 443'ü açman gerekmez.

## Kurulum (3 adım)

### Adım 1 — Cloudflare Dashboard'da tunnel oluştur

```
cloudflare.com
  → Zero Trust
  → Networks → Tunnels
  → Create a tunnel
  → "Cloudflared" seç
  → Tunnel'a isim ver (ör: mirpdf-processor)
  → Token'ı kopyala  ← bu token'ı bir yere kaydet
```

### Adım 2 — VPS'te tek komutla kur

```bash
# Projeyi VPS'e kopyala
scp -r mirpdf_FINAL_FIXED.zip root@VPS_IP:/tmp/
ssh root@VPS_IP

cd /tmp
unzip mirpdf_FINAL_FIXED.zip
cd mirpdf_v3

# Kurulum (token'ı tırnak içine al)
TUNNEL_TOKEN="eyJ..." sudo bash vps/setup-tunnel.sh
```

Kurulum şunları yapar:
- Ghostscript, Tesseract, LibreOffice, Node.js 20 kurar
- Processor'ı `/opt/mirpdf-processor/` altına koyar
- `mirpdf-processor` systemd servisi oluşturur
- `cloudflared` servisi kurar ve başlatır
- UFW: sadece SSH açık, 3001 dışarıya kapalı
- 30 dakikada bir temp temizlik cron'u ekler

### Adım 3 — .env doldur ve başlat

```bash
nano /opt/mirpdf-processor/.env
```

```ini
PORT=3001
WORKER_URL=https://mirpdf.com
PROCESSOR_SECRET=<openssl rand -hex 32 ile üret>
MAX_CONCURRENCY=2
MAX_FILE_BYTES=52428800
JOB_TIMEOUT_MS=180000
```

```bash
systemctl start mirpdf-processor
systemctl status mirpdf-processor

# Sağlık kontrolü (localhost'tan)
curl http://127.0.0.1:3001/health
```

### Adım 4 — Dashboard'da Public Hostname ekle

```
Zero Trust → Networks → Tunnels → [tunnel adın]
  → Configure → Public Hostname → Add a public hostname

  Subdomain : processor
  Domain    : mirpdf.com
  Type      : HTTP
  URL       : 127.0.0.1:3001
```

Kaydedince `https://processor.mirpdf.com` aktif olur.
Cloudflare otomatik SSL sertifikası verir.

### Adım 5 — Worker'ı bağla

```bash
# wrangler.toml güncelle
PROCESSOR_URL = "https://processor.mirpdf.com"

# Secret'ı ekle (.env'deki PROCESSOR_SECRET ile aynı değer)
wrangler secret put PROCESSOR_SECRET
```

## Tüm secret'lar (tek liste)

```bash
wrangler secret put JWT_SECRET
wrangler secret put DOWNLOAD_SIGNING_SECRET
wrangler secret put PROCESSOR_SECRET
wrangler secret put CLIENT_ID_SECRET
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_WEBHOOK_SECRET
```

## Log takibi

```bash
# Processor logları
journalctl -u mirpdf-processor -f

# Tunnel logları
journalctl -u cloudflared -f

# Her ikisi birden
journalctl -u mirpdf-processor -u cloudflared -f
```

## Sağlık izleme

`curl https://processor.mirpdf.com/health` — tunnel üzerinden (dışarıdan erişilebilir)
`curl http://127.0.0.1:3001/health` — doğrudan (VPS içinden)

UptimeRobot veya BetterStack ile 5 dk'da bir `/health` kontrolü önerilir.

## Önerilen Hetzner planı

| Plan | vCPU | RAM | Aylık |
|------|------|-----|-------|
| CX22 | 2 | 4 GB | €4.51 |
| CX32 | 4 | 8 GB | €8.54 |

CX22 ile başla, günlük 500+ işlem aşınca CX32'ye geç.

## Domain (.com) gerçek maliyet

Cloudflare Registrar "at-cost" satar:
- `.com`: ~$10.44/yıl
- `.net`: ~$11.45/yıl
- `.io`:  ~$32.50/yıl
