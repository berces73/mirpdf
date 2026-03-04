#!/bin/bash
# MirPDF geçici job dizinlerini temizle
# Cron: */30 * * * * /usr/local/bin/mirpdf-cleanup.sh

set -euo pipefail

CLEANED=0

# 2 saatten eski mirpdf-{jobId} dizinleri
while IFS= read -r -d '' dir; do
  rm -rf "$dir" && CLEANED=$((CLEANED + 1))
done < <(find /tmp -maxdepth 1 -name 'mirpdf-*' -type d -mmin +120 -print0 2>/dev/null)

if [[ $CLEANED -gt 0 ]]; then
  echo "$(date -Iseconds) mirpdf-cleanup: $CLEANED dizin silindi"
fi
