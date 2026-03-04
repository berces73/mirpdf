#!/usr/bin/env bash
set -euo pipefail

echo "== PDF Platform Quick Setup (Cloudflare) =="

echo "1) Create D1 (if not exists)"
echo "   wrangler d1 create pdf-platform-db"

echo "2) Create KV namespaces"
echo "   wrangler kv namespace create PRO_KV"
echo "   wrangler kv namespace create RATE_KV"

echo "3) Create R2 bucket"
echo "   wrangler r2 bucket create pdf-platform-files"

echo "4) Put secrets"
echo "   wrangler secret put JWT_SECRET"
echo "   wrangler secret put PROCESSOR_SECRET"
echo "   wrangler secret put STRIPE_SECRET_KEY"
echo "   wrangler secret put STRIPE_WEBHOOK_SECRET"
echo "   wrangler secret put RESEND_API_KEY"
echo "   wrangler secret put CLIENT_ID_SECRET"

echo ""
echo "Then update wrangler.toml with the printed IDs, and run:"
echo "   wrangler d1 execute pdf-platform-db --file=schema.sql --remote"
echo "   wrangler deploy"
