#!/bin/bash
# ============================================================
# MirPDF Processor — setup.sh
# Ubuntu 22.04 / 24.04 VPS için tek komutla kurulum
#
# Kullanım:
#   chmod +x setup.sh
#   sudo ./setup.sh
# ============================================================

set -euo pipefail

echo "════════════════════════════════════════"
echo "  MirPDF Processor Kurulum Başlıyor"
echo "════════════════════════════════════════"

# ─── 1) Sistem paketleri ───────────────────────────────────────────────────────

echo ""
echo "→ Sistem paketleri güncelleniyor..."
apt-get update -qq
apt-get install -y -qq \
  curl wget git unzip ca-certificates \
  nginx certbot python3-certbot-nginx \
  ghostscript \
  tesseract-ocr tesseract-ocr-tur tesseract-ocr-eng \
  libreoffice-writer libreoffice-impress libreoffice-calc \
  ufw

echo "→ Node.js 20 LTS kuruluyor..."
if ! command -v node &>/dev/null || [[ "$(node -e 'process.exit(+process.version.slice(1)<20)')" ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs
fi

echo "  Node: $(node -v)"
echo "  npm:  $(npm -v)"
echo "  Ghostscript: $(gs --version)"
echo "  Tesseract: $(tesseract --version 2>&1 | head -1)"

# ─── 2) Proje dizini ───────────────────────────────────────────────────────────

echo ""
echo "→ /opt/mirpdf-processor hazırlanıyor..."
mkdir -p /opt/mirpdf-processor
cp -r . /opt/mirpdf-processor/
cd /opt/mirpdf-processor

# .env yoksa örneği kopyala
if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo "⚠️  .env dosyası oluşturuldu. Düzenle:"
  echo "   nano /opt/mirpdf-processor/.env"
  echo "   (PROCESSOR_SECRET ve WORKER_URL zorunlu)"
fi

echo "→ npm bağımlılıkları kuruluyor..."
npm ci --omit=dev

# ─── 3) Systemd servisi ────────────────────────────────────────────────────────

echo ""
echo "→ Systemd servisi kuruluyor..."
cat > /etc/systemd/system/mirpdf-processor.service << 'SERVICE'
[Unit]
Description=MirPDF Processor (Ghostscript / LibreOffice / Tesseract)
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/mirpdf-processor
EnvironmentFile=/opt/mirpdf-processor/.env
ExecStart=/usr/bin/node /opt/mirpdf-processor/src/server.js
Restart=always
RestartSec=3

# Güvenlik sertleştirme
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/tmp /opt/mirpdf-processor

# Loglar journald'a gider
StandardOutput=journal
StandardError=journal
SyslogIdentifier=mirpdf-processor

[Install]
WantedBy=multi-user.target
SERVICE

# Dosya sahipliği
chown -R www-data:www-data /opt/mirpdf-processor

systemctl daemon-reload
systemctl enable mirpdf-processor

echo "  Servis kaydedildi (henüz başlatılmadı — .env düzeltilince: systemctl start mirpdf-processor)"

# ─── 4) Nginx ─────────────────────────────────────────────────────────────────

echo ""
echo "→ Nginx yapılandırılıyor..."
cat > /etc/nginx/sites-available/mirpdf-processor.conf << 'NGINX'
# Rate limit zone
limit_req_zone $binary_remote_addr zone=proc_rl:10m rate=20r/m;

server {
    listen 80;
    server_name _;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location /health {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
    }

    location / {
        return 444; # Diğer her şeyi kes (HTTP redirect bile yapma)
    }
}
NGINX

# HTTPS versiyonu (certbot sonrası elle eklenecek)
cat > /etc/nginx/sites-available/mirpdf-processor-ssl.conf.template << 'NGINX_SSL'
# HTTPS yapılandırması — certbot çalıştıktan sonra etkinleştir:
#   sudo certbot --nginx -d SENIN_DOMAIN_ADRESI
#   sudo ln -sf /etc/nginx/sites-available/mirpdf-processor-ssl.conf /etc/nginx/sites-enabled/
#   sudo systemctl reload nginx

limit_req_zone $binary_remote_addr zone=proc_rl:10m rate=20r/m;

server {
    listen 443 ssl http2;
    server_name SENIN_DOMAIN_ADRESI;

    # Certbot bu iki satırı otomatik dolduracak:
    # ssl_certificate /etc/letsencrypt/live/DOMAIN/fullchain.pem;
    # ssl_certificate_key /etc/letsencrypt/live/DOMAIN/privkey.pem;

    # Güvenlik başlıkları
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;
    add_header Referrer-Policy same-origin always;

    # Upload limit (MAX_FILE_BYTES + biraz üst)
    client_max_body_size 60m;

    # Sadece PROCESSOR_SECRET içeren istekler geçer (app katmanında)
    location /process/ {
        limit_req zone=proc_rl burst=10 nodelay;

        proxy_pass         http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_read_timeout 200s;
        proxy_send_timeout 200s;
    }

    location /health {
        proxy_pass http://127.0.0.1:3001;
    }

    location / {
        return 404;
    }
}
NGINX_SSL

ln -sf /etc/nginx/sites-available/mirpdf-processor.conf /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
echo "  Nginx hazır"

# ─── 5) Geçici dosya temizlik cron'u ──────────────────────────────────────────

echo ""
echo "→ Temp temizlik cron'u ekleniyor..."
cat > /usr/local/bin/mirpdf-cleanup.sh << 'CLEANUP'
#!/bin/bash
# 2 saatten eski mirpdf temp dizinlerini sil
find /tmp -maxdepth 1 -name 'mirpdf-*' -type d -mmin +120 -exec rm -rf {} + 2>/dev/null
CLEANUP
chmod +x /usr/local/bin/mirpdf-cleanup.sh

# Her 30 dakikada bir
(crontab -l 2>/dev/null | grep -v mirpdf-cleanup; echo "*/30 * * * * /usr/local/bin/mirpdf-cleanup.sh") | crontab -
echo "  Cron eklendi (her 30 dk)"

# ─── 6) UFW güvenlik duvarı ────────────────────────────────────────────────────

echo ""
echo "→ UFW yapılandırılıyor..."
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null
# 3001 portu dışarıya KAPALI — sadece nginx üzerinden erişilir
ufw --force enable >/dev/null
echo "  UFW aktif (SSH + Nginx Full izinli, 3001 kapalı)"

# ─── 7) Özet ──────────────────────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════"
echo "  Kurulum tamamlandı!"
echo "════════════════════════════════════════"
echo ""
echo "Sonraki adımlar:"
echo ""
echo "  1) .env dosyasını düzenle:"
echo "     nano /opt/mirpdf-processor/.env"
echo "     (PROCESSOR_SECRET ve WORKER_URL zorunlu)"
echo ""
echo "  2) Servisi başlat:"
echo "     systemctl start mirpdf-processor"
echo "     systemctl status mirpdf-processor"
echo ""
echo "  3) HTTPS için:"
echo "     certbot --nginx -d SENIN_DOMAININ"
echo "     (ardından nginx-processor-ssl.conf.template'i aktif et)"
echo ""
echo "  4) Sağlık kontrolü:"
echo "     curl http://localhost:3001/health"
echo ""
echo "  5) Cloudflare Worker'a ekle:"
echo "     wrangler secret put PROCESSOR_SECRET"
echo "     # wrangler.toml: PROCESSOR_URL=https://SENIN_DOMAININ"
