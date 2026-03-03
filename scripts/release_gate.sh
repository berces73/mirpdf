#!/usr/bin/env bash
# ============================================================
# scripts/release_gate.sh — MirPDF Release Gate
# Kullanım: bash scripts/release_gate.sh
#           PROD_URL=https://mirpdf.com bash scripts/release_gate.sh
# ============================================================

# pipefail YOK — manual kontrol yapıyoruz
set -uo nounset

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

PASS=0; FAIL=0; WARN=0
declare -a RESULTS=()

pass() { PASS=$((PASS+1));  RESULTS+=("${GREEN}✅ PASS${NC}  $1"); }
fail() { FAIL=$((FAIL+1));  RESULTS+=("${RED}❌ FAIL${NC}  $1"); }
warn() { WARN=$((WARN+1));  RESULTS+=("${YELLOW}⚠️  WARN${NC}  $1"); }
hdr()  { printf "\n${CYAN}${BOLD}══ %s ══${NC}\n" "$1"; }

PROD_URL="${PROD_URL:-}"
PROC_URL="${PROCESSOR_URL:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
THIS_SCRIPT="$(basename "${BASH_SOURCE[0]}")"

printf "${BOLD}MirPDF Release Gate${NC} — %s\n" "$(date '+%Y-%m-%d %H:%M')"
printf "Proje: %s\n" "$ROOT"

# ─── helpers ──────────────────────────────────────────────────────────────────

# Dosyalarda pattern ara — bu scriptin kendisini ve README'yi hariç tut
scan() {
  local pattern="$1"
  find "$ROOT" -type f \( \
    -name "*.toml" -o -name "*.js" -o -name "*.json" -o \
    -name "*.html" -o -name "*.sh" -o -name "*.env" -o -name "*.env.example" \
  \) \
    ! -path "*/node_modules/*" \
    ! -path "*/.git/*" \
    ! -path "*/public/assets/*" \
    ! -path "*/dist/*" \
    ! -name "$THIS_SCRIPT" \
    ! -name "README.md" \
    ! -name "RUNBOOK.md" \
    ! -path "*/frontend/*" \
    2>/dev/null \
  | xargs --no-run-if-empty grep -rl "$pattern" 2>/dev/null \
  | grep -v "^$" || true
}

curl_status() { curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$@" 2>/dev/null || echo "000"; }

# ═══════════════════════════════════════════════════════════════════════════════
hdr "1 / 6  Placeholder Taraması"

# Placeholder'lar (bu scriptin kendisi hariç)
declare -A PLACEHOLDERS=(
  ["yourdomain.com"]="domain placeholder"
  ["FILL_ACTUAL"]="FILL_ACTUAL_DOMAIN placeholder"
  ["FILL_FROM"]="wrangler.toml FILL_FROM"
  ["FILL_PROCESSOR_IP"]="wrangler.toml processor IP"
  ["REPLACE_IN_DASHBOARD"]="Stripe placeholder"
  ["senin-domain.com"]="Nginx domain placeholder"
  ["siteniz.com"]="sitemap domain"
  ["price_xxx"]="Stripe price ID"
  # AdSense pub ID kontrolü WARN olarak ayrıca yapılıyor
)

for p in "${!PLACEHOLDERS[@]}"; do
  hits=$(scan "$p")
  if [[ -n "$hits" ]]; then
    files=$(echo "$hits" | sed "s|$ROOT/||g" | tr '\n' ' ')
    fail "Placeholder '${PLACEHOLDERS[$p]}' ($p) → $files"
  fi
done

# frontend/ FILL_ACTUAL_DOMAIN → WARN (build zamanı sed ile doldurulacak)
fe_fill=$(find "$ROOT/frontend" -name "*.html"   -exec grep -ql "FILL_ACTUAL_DOMAIN" {} \; 2>/dev/null | wc -l | tr -d ' ')
[[ "$fe_fill" -eq 0 ]] \
  && pass "frontend/ FILL_ACTUAL_DOMAIN temiz" \
  || warn "frontend/ $fe_fill HTML'de FILL_ACTUAL_DOMAIN var — deploy.sh sed ile dolduracak"

# CHANGE_ME — sadece src/ ve _worker.js'de ara (bu script ve .env.example hariç)
cm_hits=$(find "$ROOT" \( -path "*/src/*.js" -o -name "_worker.js" \) \
  ! -name "$THIS_SCRIPT" 2>/dev/null | \
  xargs --no-run-if-empty grep -l "CHANGE_ME" 2>/dev/null || true)
if [[ -n "$cm_hits" ]]; then
  fail "Kaynak kodda CHANGE_ME fallback: $(echo "$cm_hits" | sed "s|$ROOT/||g" | tr '\n' ' ')"
else
  pass "CHANGE_ME fallback yok (src/ + _worker.js)"
fi

# Verification token — index.html dışında
vt=$(find "$ROOT/public" -name "*.html" ! -name "index.html" \
  -exec grep -ql "GOOGLE_VERIFICATION_TOKEN\|YANDEX_VERIFICATION_TOKEN\|BING_VERIFICATION_TOKEN" {} \; \
  2>/dev/null | wc -l | tr -d ' ')
[[ "$vt" -eq 0 ]] && pass "Verification token placeholder temiz" || \
  fail "Verification token $vt sayfada kaldı (index.html dışında)"

# AdSense pub ID
adsense=$(find "$ROOT/public" -name "*.html"   -exec grep -ql "pub-XXXXXXXXXXXXXXXX" {} \; 2>/dev/null | wc -l | tr -d ' ')
[[ "$adsense" -eq 0 ]] && pass "AdSense pub ID doldurulmuş" ||   warn "AdSense pub ID $adsense HTML'de hâlâ placeholder (public/ads.txt + HTML güncelle)"

# Yanlış marka
brand=$(find "$ROOT/public" -name "*.html" \
  -exec grep -ql "PDFYeri\|pdfyeri" {} \; 2>/dev/null | wc -l | tr -d ' ')
[[ "$brand" -eq 0 ]] && pass "Marka adı temiz (MirPDF)" || \
  fail "Yanlış marka 'PDFYeri' $brand dosyada"

# example.com fallback _worker.js'de
ec=$(grep -o '"https://example\.com"' "$ROOT/_worker.js" 2>/dev/null | wc -l | tr -d ' ' || echo 0)
[[ "$ec" -eq 0 ]] && pass "_worker.js: example.com fallback yok" || \
  fail "_worker.js: example.com fallback $ec yerde (APP_ORIGIN config guard eksik)"

# ═══════════════════════════════════════════════════════════════════════════════
hdr "2 / 6  wrangler.toml Kontrol"

TOML="$ROOT/wrangler.toml"
if [[ ! -f "$TOML" ]]; then
  fail "wrangler.toml bulunamadı"
else
  toml_val() {
    grep "^$1" "$TOML" 2>/dev/null | head -1 \
      | sed 's/[^=]*= *//;s/"//g;s/ *#.*//' | tr -d ' '
  }
  chk_toml() {
    local key="$1" bad_re="$2" label="$3"
    local v; v=$(toml_val "$key")
    if [[ -z "$v" ]] || echo "$v" | grep -qE "$bad_re"; then
      fail "wrangler.toml: $label hâlâ placeholder/boş (val='$v')"
    else
      pass "wrangler.toml: $label = '$v'"
    fi
  }

  chk_toml "database_id" "FILL"  "D1 database_id"
  chk_toml "APP_ORIGIN"  "FILL|example\.com" "APP_ORIGIN"
  chk_toml "ALLOWED_ORIGIN" "FILL|example\.com" "ALLOWED_ORIGIN"
  chk_toml "PROCESSOR_URL" "FILL|127\.0\.0\.1|FILL_PROCESSOR" "PROCESSOR_URL (Tunnel URL'i)"

  kv_fill=$(grep "^id" "$TOML" | grep -c "FILL" || echo 0)
  [[ "$kv_fill" -eq 0 ]] && pass "wrangler.toml: KV id'leri doldurulmuş" || \
    fail "wrangler.toml: $kv_fill KV namespace id'si FILL_FROM_..."

  grep -q "FILL_ACTUAL_DOMAIN" "$TOML" 2>/dev/null && \
    fail "wrangler.toml: EMAIL_FROM domain placeholder" || \
    pass "wrangler.toml: EMAIL_FROM domain ok"

  grep -q "price_xxx" "$TOML" 2>/dev/null && \
    warn "wrangler.toml: Stripe price ID'leri hâlâ price_xxx" || \
    pass "wrangler.toml: Stripe price ID'leri doldurulmuş"
fi

# ═══════════════════════════════════════════════════════════════════════════════
hdr "3 / 6  Wrangler Secret Kontrolü"

REQUIRED_SECRETS=("JWT_SECRET" "DOWNLOAD_SIGNING_SECRET" "PROCESSOR_SECRET"
                   "CLIENT_ID_SECRET" "STRIPE_SECRET_KEY" "STRIPE_WEBHOOK_SECRET")

if ! command -v wrangler &>/dev/null; then
  warn "wrangler CLI yok — secret kontrolü atlandı (CI ortamında normal)"
else
  SECRET_LIST=$(wrangler secret list 2>/dev/null | grep '"name"' | \
    sed 's/.*"name": *"\([^"]*\)".*/\1/' || echo "")
  for s in "${REQUIRED_SECRETS[@]}"; do
    echo "$SECRET_LIST" | grep -q "^$s$" && \
      pass "Secret mevcut: $s" || \
      fail "Secret EKSİK: $s  →  wrangler secret put $s"
  done
fi

# ═══════════════════════════════════════════════════════════════════════════════
hdr "4 / 6  Kod Güvenlik Kontrol"

# Wildcard CORS
wc_cors=$(grep -rn '"Access-Control-Allow-Origin".*"\*"' \
  "$ROOT/_worker.js" "$ROOT/src/cors.js" 2>/dev/null | wc -l | tr -d ' ')
[[ "$wc_cors" -eq 0 ]] && pass "Wildcard CORS yok" || \
  fail "Wildcard CORS (*) $wc_cors yerde"

# Admin public dosyası
adm=$(find "$ROOT/public" -name "*.html" 2>/dev/null | \
  xargs --no-run-if-empty grep -rl "admin" 2>/dev/null | wc -l | tr -d ' ')
# Sadece admin klasöründekiler sorun
adm_dir=$(find "$ROOT/public" -path "*/admin*" -name "*.html" 2>/dev/null | wc -l | tr -d ' ')
[[ "$adm_dir" -eq 0 ]] && pass "public/ altında admin HTML yok" || \
  fail "public/admin/ altında HTML: KRİTİK"

# Secret ismi tutarlılığı
r2_old=$(grep -rn "R2_SIGNING_SECRET" "$ROOT/src/" "$ROOT/_worker.js" 2>/dev/null | wc -l | tr -d ' ')
[[ "$r2_old" -eq 0 ]] && pass "Secret ismi tutarlı (DOWNLOAD_SIGNING_SECRET)" || \
  fail "R2_SIGNING_SECRET eski ismi $r2_old yerde kaldı"

# Stripe idempotency
grep -q "processed_events" "$ROOT/d1/schema.sql" 2>/dev/null && \
  pass "D1 processed_events tablosu mevcut" || \
  fail "D1: processed_events tablosu eksik"

grep -q "processed_events" "$ROOT/src/stripe.js" 2>/dev/null && \
  pass "stripe.js: idempotency mevcut" || \
  fail "stripe.js: idempotency eksik"

# requireOrigin guard
grep -q "requireOrigin" "$ROOT/_worker.js" 2>/dev/null && \
  pass "_worker.js: APP_ORIGIN config guard mevcut" || \
  fail "_worker.js: APP_ORIGIN config guard eksik"

# HSTS header
grep -q "Strict-Transport-Security" "$ROOT/public/_headers" 2>/dev/null && \
  pass "HSTS header tanımlı" || \
  warn "HSTS _headers'da bulunamadı"

# ═══════════════════════════════════════════════════════════════════════════════
hdr "5 / 6  Prod Endpoint Kontrolleri"

if [[ -z "$PROD_URL" ]]; then
  warn "PROD_URL tanımlı değil — endpoint testleri atlandı"
  warn "→ PROD_URL=https://mirpdf.com bash scripts/release_gate.sh"
else
  printf "  Hedef: ${CYAN}%s${NC}\n" "$PROD_URL"

  s=$(curl_status "$PROD_URL/health")
  [[ "$s" == "200" ]] && pass "GET /health → 200" || fail "GET /health → $s"

  s=$(curl_status "$PROD_URL/admin/")
  case "$s" in
    401|403|404) pass "GET /admin/ → $s (erişim yok ✅)";;
    200) fail "GET /admin/ → 200 ❌ KRİTİK: Admin herkese açık!";;
    *) warn "GET /admin/ → $s";;
  esac

  # CORS evil origin
  acao=$(curl -s -o /dev/null -w "%{header_json}" --max-time 10 \
    -H "Origin: https://evil.example.com" \
    "$PROD_URL/api/jobs/status/test" 2>/dev/null | \
    python3 -c "
import sys,json
try:
  h=json.load(sys.stdin)
  print(h.get('access-control-allow-origin',[''])[0])
except:
  print('')
" 2>/dev/null || echo "")
  [[ "$acao" == "*" ]] && fail "CORS: evil origin wildcard ACAO alıyor ❌" || \
  [[ -z "$acao" ]] && pass "CORS: evil origin ACAO yok ✅" || \
  warn "CORS: evil origin ACAO='$acao'"

  # Fake PDF → 415
  s=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 \
    -X POST "$PROD_URL/api/compress" \
    -F "file=@/etc/hostname;type=application/pdf" 2>/dev/null || echo "000")
  [[ "$s" == "415" ]] && pass "POST /api/compress fake PDF → 415 ✅" || \
  [[ "$s" =~ ^(400|401|429)$ ]] && warn "POST /api/compress fake PDF → $s (415 bekleniyor)" || \
  fail "POST /api/compress fake PDF → $s (beklenen 415)"

  # HSTS prod'da var mı
  hsts=$(curl -s -I --max-time 10 "$PROD_URL" 2>/dev/null | \
    grep -i "strict-transport-security" | head -1 || echo "")
  [[ -n "$hsts" ]] && pass "HSTS aktif prod'da" || warn "HSTS prod'da bulunamadı"
fi

# ═══════════════════════════════════════════════════════════════════════════════
hdr "6 / 6  Processor Kontrolü"

PROC_SRC="$ROOT/processor/src/server.js"
[[ ! -f "$PROC_SRC" ]] && PROC_SRC="/opt/mirpdf-processor/src/server.js"

if [[ -z "$PROC_URL" ]]; then
  if [[ -f "$PROC_SRC" ]]; then
    grep -q "PROC_MAX_CONCURRENCY\|MAX_CONCURRENCY" "$PROC_SRC" 2>/dev/null && \
      pass "Processor: concurrency limit mevcut" || fail "Processor: concurrency limit YOK"
    grep -q "PROC_TIMEOUT_MS\|JOB_TIMEOUT_MS" "$PROC_SRC" 2>/dev/null && \
      pass "Processor: global timeout mevcut" || fail "Processor: global timeout YOK"
    grep -q "PROC_MAX_BYTES\|MAX_FILE_BYTES" "$PROC_SRC" 2>/dev/null && \
      pass "Processor: max bytes kontrolü mevcut" || fail "Processor: max bytes YOK"
    grep -q "timingSafeEqual\|safeEqual" "$PROC_SRC" 2>/dev/null && \
      pass "Processor: timing-safe auth mevcut" || fail "Processor: timing-safe auth YOK"
  else
    warn "Processor src bulunamadı — VPS'te ise PROCESSOR_URL tanımla:"
    warn "→ PROCESSOR_URL=http://127.0.0.1:3001 bash scripts/release_gate.sh"
  fi
else
  s=$(curl_status "$PROC_URL/health")
  if [[ "$s" == "200" ]]; then
    body=$(curl -s --max-time 5 "$PROC_URL/health" 2>/dev/null || echo "{}")
    active=$(echo "$body" | python3 -c \
      "import sys,json; d=json.load(sys.stdin); print(d.get('activeJobs',0))" 2>/dev/null || echo "?")
    pass "Processor /health → 200 (activeJobs=$active)"
  else
    fail "Processor /health → $s"
  fi

  s=$(curl_status -X POST -H "Content-Type: application/json" -d '{"test":true}' \
    "$PROC_URL/process/compress")
  [[ "$s" == "401" ]] && pass "Processor: auth olmadan 401 ✅" || \
    fail "Processor: auth olmadan $s (beklenen 401)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
printf "\n${BOLD}══════════════════════════════════════${NC}\n"
printf "${BOLD}  RELEASE GATE SONUÇLARI${NC}\n"
printf "${BOLD}══════════════════════════════════════${NC}\n\n"

for r in "${RESULTS[@]}"; do
  printf "  %b\n" "$r"
done

printf "\n  ${GREEN}✅ PASS: %d${NC}   ${RED}❌ FAIL: %d${NC}   ${YELLOW}⚠️  WARN: %d${NC}\n\n" \
  "$PASS" "$FAIL" "$WARN"

if [[ "$FAIL" -gt 0 ]]; then
  printf "  ${RED}${BOLD}🚫 DEPLOY ETME — %d kritik sorun var.${NC}\n\n" "$FAIL"
  exit 1
elif [[ "$WARN" -gt 0 ]]; then
  printf "  ${YELLOW}${BOLD}⚠️  %d uyarı var. Gözden geçir, sonra deploy et.${NC}\n\n" "$WARN"
  exit 0
else
  printf "  ${GREEN}${BOLD}🚀 DEPLOY HAZIR — Tüm kontroller geçti.${NC}\n\n"
  exit 0
fi
