// public/assets/js/consume-credit.js
// Same-origin API calls only. No hardcoded domains.

import { openPaywall } from "./paywall.js";

const TIMEOUT_MS = 10_000;
const MAX_RETRIES = 2;

// ── opId generator ───────────────────────────────────────────
export function newOpId() {
  try { return crypto.randomUUID().replace(/-/g, ""); }
  catch { return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`; }
}

// ── Credit display ───────────────────────────────────────────
function updateCreditDisplay(remaining) {
  for (const el of document.querySelectorAll("[data-credit-display]")) {
    el.textContent = String(remaining);
    el.classList.toggle("credit-low", remaining <= 5);
  }
}


function maybeNudgeLowCredits(remaining) {
  if (remaining === undefined || remaining === null) return;
  if (remaining > 1) return;
  const k = "pdf3_nudge_low_credits_shown";
  try {
    if (sessionStorage.getItem(k) === "1") return;
    sessionStorage.setItem(k, "1");
  } catch {}
  // Soft nudge + open paywall
  window.toast?.("Krediniz bitmek üzere. Premium'a geçerek kesintisiz devam edin.", "info", 6000);
  openPaywall({ reason: "low_credits" });
}


// ── Fetch with timeout ───────────────────────────────────────
function fetchTimeout(url, opts, ms = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

// ── Main: consume a credit ───────────────────────────────────
export async function consumeCredit(tool, opId = newOpId()) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetchTimeout("/api/credits/consume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ tool, opId }),
      });

      const data = await resp.json().catch(() => ({}));

      if (resp.ok) {
        if (data.remaining !== undefined) updateCreditDisplay(data.remaining);
      maybeNudgeLowCredits(data.remaining);
        return true;
      }

      const code = data?.error?.code;

      if (resp.status === 402 || code === "CREDIT_EXHAUSTED") {
        window.toast?.("Günlük krediniz doldu.", "warning", 5000);
        openPaywall({ reason: "credits", tier: data?.tier, resetAt: data?.resetAt });
        return false;
      }

      if (resp.status === 429 || code === "RATE_LIMITED") {
        const wait = resp.headers.get("Retry-After") || "?";
        window.toast?.(`Çok fazla istek. ${wait}s bekleyin.`, "warning", 6000);
        openPaywall({ reason: "rate_limit" });
        return false;
      }

      if (resp.status === 409 && code === "OP_PENDING") {
        window.toast?.("İşlem zaten devam ediyor.", "info", 3000);
        return false;
      }

      // 5xx: retry
      if (resp.status >= 500 && attempt < MAX_RETRIES) {
        await sleep(800 * (attempt + 1));
        continue;
      }

      window.toast?.(data?.error?.message || "Bir hata oluştu.", "error", 5000);
      return false;

    } catch (err) {
      if (attempt < MAX_RETRIES) {
        await sleep(800 * (attempt + 1));
        continue;
      }
      console.error("[consume-credit]", err);
      window.toast?.("Bağlantı hatası. Lütfen tekrar deneyin.", "error", 5000);
      openPaywall({ reason: "network" });
      return false;
    }
  }
  return false;
}

export async function finalizeCredit(opId) {
  if (!opId) return;
  try {
    const resp = await fetchTimeout("/api/credits/finalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ opId }),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok && data.remaining !== undefined) updateCreditDisplay(data.remaining);
      maybeNudgeLowCredits(data.remaining);
  } catch (e) {
    console.warn("[finalizeCredit] failed", e);
  }
}

export async function refundCredit(tool, opId) {
  try {
    const resp = await fetchTimeout("/api/credits/refund", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ tool, opId }),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok && data.remaining !== undefined) updateCreditDisplay(data.remaining);
      maybeNudgeLowCredits(data.remaining);
  } catch (e) {
    console.warn("[refundCredit] failed", e);
  }
}

// ── Status refresh ───────────────────────────────────────────
let _refreshing = false;
export async function refreshCreditInfo() {
  if (_refreshing) return null;
  _refreshing = true;
  try {
    const resp = await fetchTimeout("/api/credits/status", {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    }, 5000);
    if (!resp.ok) return null;
    const data = await resp.json().catch(() => ({}));
    if (data.remaining !== undefined) updateCreditDisplay(data.remaining);
      maybeNudgeLowCredits(data.remaining);
    return data;
  } catch { return null; }
  finally { _refreshing = false; }
}

// ── Auto-refresh on page load ─────────────────────────────────
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", refreshCreditInfo, { once: true });
} else {
  refreshCreditInfo();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
