# MirPDF Processor

VPS üzerinde çalışan PDF işleme motoru.  
Cloudflare Worker'dan iş alır → işler → sonucu geri gönderir.

## Mimari

```
Kullanıcı
    │ upload
    ▼
Cloudflare Worker  ──── R2 (geçici depolama) ────┐
    │ POST /process/compress                       │
    │     { jobId, inputKey, outputKey, options }  │
    ▼                                              │
 VPS Processor                                     │
    │ 1) GET /api/temp-download?key=inputKey       │
    │ ◄────────────────────────────────────────────┘
    │ 2) İşle (Ghostscript / LibreOffice / Tesseract)
    │ 3) PUT /api/temp-upload?key=outputKey ───────►  R2
    │ 4) POST /api/jobs/callback { jobId, status, outputKey }
    ▼
Cloudflare Worker → Kullanıcıya indirme linki
```

## Araçlar

| Route | Araç | Bağımlılık |
|---|---|---|
| `POST /process/compress` | PDF sıkıştırma | Ghostscript |
| `POST /process/pdf-to-word` | PDF → DOCX dönüşümü | LibreOffice |
| `POST /process/ocr` | OCR (aranabilir PDF) | Ghostscript + Tesseract |

## Hızlı Başlangıç

```bash
# 1) Kur (Ubuntu 22.04 / 24.04)
chmod +x setup.sh
sudo ./setup.sh

# 2) .env düzenle
nano /opt/mirpdf-processor/.env

# 3) Başlat
sudo systemctl start mirpdf-processor
sudo systemctl status mirpdf-processor

# 4) Test et
curl http://localhost:3001/health
```

## .env Değişkenleri

```ini
PORT=3001
WORKER_URL=https://mirpdf.com
PROCESSOR_SECRET=<wrangler secret put ile aynı değer>
MAX_CONCURRENCY=2     # CX22(4GB)=2, CX32(8GB)=4
MAX_FILE_BYTES=52428800
JOB_TIMEOUT_MS=180000
```

## Önerilen VPS

| Plan | Aylık | Uygun kullanım |
|---|---|---|
| Hetzner CX22 (2vCPU, 4GB) | €4.5 | Başlangıç |
| Hetzner CX32 (4vCPU, 8GB) | €8.5 | Büyüme |

## Log Takibi

```bash
journalctl -u mirpdf-processor -f
```

## Sağlık Kontrolü

```
GET /health
→ { ok: true, activeJobs: 0, maxConcurrency: 2 }
```

UptimeRobot veya BetterStack ile 5 dk'da bir kontrol önerilir.
