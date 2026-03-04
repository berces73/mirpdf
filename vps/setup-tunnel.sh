#!/bin/bash
# ============================================================
# MirPDF VPS Kurulum — Cloudflare Tunnel (Seçenek A)
# Ubuntu 22.04 / 24.04
#
# Kullanım:
#   TUNNEL_TOKEN="eyJ..." sudo bash setup-tunnel.sh
#
# Tunnel token almak için:
#   cloudflare.com → Zero Trust → Networks → Tunnels
#   → Create a tunnel → Cloudflared → token'ı kopyala
# ============================================================

set -euo pipefail

# ─── Ön kontrol ───────────────────────────────────────────────────────────────

TUNNEL_TOKEN="${TUNNEL_TOKEN:-}"
PROCESSOR_DIR="/opt/mirpdf-processor"

if [[ $EUID -ne 0 ]]; then
  echo "❌  Root olarak çalıştır: sudo bash setup-tunnel.sh"
  exit 1
fi

if [[ -z "$TUNNEL_TOKEN" ]]; then
  echo "❌  TUNNEL_TOKEN eksik."
  echo ""
  echo "    Kullanım:"
  echo "    TUNNEL_TOKEN='eyJ...' sudo bash setup-tunnel.sh"
  echo ""
  echo "    Token almak:"
  echo "    → cloudflare.com → Zero Trust → Networks → Tunnels"
  echo "    → Create a tunnel → Cloudflared seç → token'ı kopyala"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROCESSOR_SRC="$(cd "$SCRIPT_DIR/.." && pwd)/processor"

if [[ ! -f "$PROCESSOR_SRC/src/server.js" ]]; then
  echo "❌  Processor kaynak kodu bulunamadı: $PROCESSOR_SRC/src/server.js"
  echo "    Bu scripti proje kökünden çalıştır."
  exit 1
fi

print_step() { echo ""; echo "════ $1"; }

# ─── 1) Sistem paketleri ──────────────────────────────────────────────────────

print_step "1/7 — Sistem paketleri"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq

apt-get install -y -qq \
  curl wget git ca-certificates gnupg \
  ghostscript \
  tesseract-ocr tesseract-ocr-tur tesseract-ocr-eng \
  libreoffice-writer \
  ufw

echo "→ Node.js 20 LTS"
if ! node --version 2>/dev/null | grep -q "^v2[0-9]"; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs
fi

echo "  Node:        $(node --version)"
echo "  Ghostscript: $(gs --version)"
echo "  Tesseract:   $(tesseract --version 2>&1 | head -1)"
echo "  LibreOffice: $(libreoffice --version 2>/dev/null | head -1 || echo 'kuruldu')"

# ─── 2) cloudflared ───────────────────────────────────────────────────────────

print_step "2/7 — cloudflared"

if ! command -v cloudflared &>/dev/null; then
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
    | gpg --dearmor -o /usr/share/keyrings/cloudflare-main.gpg

  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] \
https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" \
    > /etc/apt/sources.list.d/cloudflared.list

  apt-get update -qq
  apt-get install -y -qq cloudflared
fi

echo "  cloudflared: $(cloudflared --version)"

# ─── 3) Processor dosyaları ───────────────────────────────────────────────────

print_step "3/7 — Processor kurulum"

# Kullanıcı
if ! id mirpdf &>/dev/null; then
  useradd --system --no-create-home --shell /bin/false mirpdf
  echo "  Sistem kullanıcısı oluşturuldu: mirpdf"
fi

mkdir -p "$PROCESSOR_DIR"
cp -r "$PROCESSOR_SRC/." "$PROCESSOR_DIR/"
chown -R mirpdf:mirpdf "$PROCESSOR_DIR"

# .env yoksa örneği kopyala
if [[ ! -f "$PROCESSOR_DIR/.env" ]]; then
  cp "$PROCESSOR_DIR/.env.example" "$PROCESSOR_DIR/.env"
  chmod 600 "$PROCESSOR_DIR/.env"
  chown mirpdf:mirpdf "$PROCESSOR_DIR/.env"
fi

echo "  Processor: $PROCESSOR_DIR"

# ─── 4) Systemd — processor ───────────────────────────────────────────────────

print_step "4/7 — Systemd servisleri"

cat > /etc/systemd/system/mirpdf-processor.service << 'SERVICE'
[Unit]
Description=MirPDF Processor (Ghostscript / LibreOffice / Tesseract)
After=network.target cloudflared.service
Wants=cloudflared.service

[Service]
Type=simple
User=mirpdf
Group=mirpdf
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
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true

# Sadece /tmp ve /opt/mirpdf-processor yazılabilir
ReadWritePaths=/tmp /opt/mirpdf-processor

# Loglar journald
StandardOutput=journal
StandardError=journal
SyslogIdentifier=mirpdf-processor

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable mirpdf-processor
echo "  mirpdf-processor servisi kayıt edildi"

# ─── 5) Cloudflare Tunnel servisi ─────────────────────────────────────────────

print_step "5/7 — Cloudflare Tunnel"

cloudflared service install "$TUNNEL_TOKEN"
systemctl enable --now cloudflared

sleep 2
if systemctl is-active --quiet cloudflared; then
  echo "  ✅ cloudflared aktif"
else
  echo "  ⚠️  cloudflared başlatılamadı — 'journalctl -u cloudflared' ile kontrol et"
fi

# ─── 6) Geçici dosya temizlik cron'u ──────────────────────────────────────────

print_step "6/7 — Temizlik cron"

cat > /usr/local/bin/mirpdf-cleanup.sh << 'CLEANUP'
#!/bin/bash
# MirPDF geçici dizinlerini temizle (2 saatten eski)
find /tmp -maxdepth 1 -name 'mirpdf-*' -type d -mmin +120 -exec rm -rf {} + 2>/dev/null || true
CLEANUP

chmod +x /usr/local/bin/mirpdf-cleanup.sh

# Her 30 dakikada bir
(crontab -l 2>/dev/null | grep -v mirpdf-cleanup || true
 echo "*/30 * * * * /usr/local/bin/mirpdf-cleanup.sh") | crontab -

echo "  Cron: her 30 dakikada temizlik"

# ─── 7) UFW — minimal firewall ────────────────────────────────────────────────

print_step "7/7 — Güvenlik duvarı (UFW)"

# Tunnel modunda nginx/certbot gerekmez → sadece SSH
ufw --force reset >/dev/null 2>&1
ufw default deny incoming  >/dev/null 2>&1
ufw default allow outgoing >/dev/null 2>&1
ufw allow OpenSSH          >/dev/null 2>&1

# 3001 dışarıya KAPALI (tunnel içeriden bağlanır)
# HTTP/HTTPS de gerekmez (nginx yok)
ufw --force enable >/dev/null 2>&1

echo "  UFW aktif — sadece SSH izinli"
echo "  3001 portu dışarıya kapalı ✅"

# ─── Özet ve sonraki adımlar ──────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════════════════"
echo "  Kurulum tamamlandı!"
echo "════════════════════════════════════════════════════════"
echo ""
echo "  ZORUNLU — Şimdi yapılacaklar:"
echo ""
echo "  1) .env dosyasını düzenle:"
echo "     nano $PROCESSOR_DIR/.env"
echo ""
echo "     PORT=3001"
echo "     WORKER_URL=https://mirpdf.com"
echo "     PROCESSOR_SECRET=$(openssl rand -hex 32 2>/dev/null || echo 'openssl-ile-uret')"
echo "     PROC_MAX_CONCURRENCY=2"
echo ""
echo "  2) Processor'ı başlat:"
echo "     systemctl start mirpdf-processor"
echo "     systemctl status mirpdf-processor"
echo "     curl http://127.0.0.1:3001/health"
echo ""
echo "  3) Cloudflare Dashboard'da Public Hostname ekle:"
echo "     Zero Trust → Networks → Tunnels → [tunnel adı]"
echo "     → Configure → Public Hostname → Add"
echo "       Subdomain : processor"
echo "       Domain    : mirpdf.com"
echo "       Type      : HTTP"
echo "       URL       : 127.0.0.1:3001"
echo ""
echo "  4) wrangler.toml güncelle (deploy öncesi):"
echo "     PROCESSOR_URL = \"https://processor.mirpdf.com\""
echo ""
echo "  5) Worker secret'ı ekle (aynı PROCESSOR_SECRET):"
echo "     wrangler secret put PROCESSOR_SECRET"
echo ""
echo "  Log takibi:"
echo "     journalctl -u mirpdf-processor -f"
echo "     journalctl -u cloudflared -f"
echo ""
