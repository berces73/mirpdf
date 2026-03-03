// public/assets/js/funnel.js
// Revenue funnel triggers (trial -> paid) + exit-intent
import { openPaywall } from "./paywall.js";

function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function getAnonId() {
  const k = "pdfp_anon_id";
  let v = localStorage.getItem(k);
  if (!v) {
    v = (crypto?.randomUUID?.() || (Date.now().toString(36) + Math.random().toString(36).slice(2)));
    localStorage.setItem(k, v);
  }
  return v;
}

function getDailyOps() {
  const k = `pdfp_ops_${todayKey()}`;
  const n = Number(localStorage.getItem(k) || "0");
  return Number.isFinite(n) ? n : 0;
}

function incDailyOps() {
  const k = `pdfp_ops_${todayKey()}`;
  const n = getDailyOps() + 1;
  localStorage.setItem(k, String(n));
  return n;
}

// Show a strong upsell on the 3rd operation attempt of the day (free users commonly churn here).
// Returns true if the caller should BLOCK the operation/navigation (user can retry after closing).
export function funnelMaybeBlockStart({ tool, hardBlock = true } = {}) {
  try {
    // If user already saw today, do nothing.
    const shownKey = `pdfp_offer_shown_${todayKey()}`;
    if (localStorage.getItem(shownKey) === "1") return false;

    const next = incDailyOps(); // 1,2,3...
    // Trigger on 3rd attempt
    if (next >= 3) {
      localStorage.setItem(shownKey, "1");
      openPaywall({
        reason: "credits",
        tier: "credits100"
      });
      return !!hardBlock;
    }
  } catch {}
  return false;
}

// Exit-intent: show a soft offer once per day when user is about to leave.
export function initExitIntent() {
  try {
    const shownKey = `pdfp_exit_offer_${todayKey()}`;
    if (localStorage.getItem(shownKey) === "1") return;

    let armed = true;
    const onMouseLeave = (e) => {
      // Only top edge and only if pointer exits viewport
      if (!armed) return;
      if (e.clientY > 0) return;
      armed = false;
      localStorage.setItem(shownKey, "1");
      openPaywall({
        reason: "credits",
        tier: "credits100"
      });
    };

    const onVisibility = () => {
      if (!armed) return;
      if (document.visibilityState === "hidden") {
        armed = false;
        localStorage.setItem(shownKey, "1");
        openPaywall({
          reason: "credits",
          tier: "sub_pro"
        });
      }
    };

    document.addEventListener("mouseleave", onMouseLeave);
    document.addEventListener("visibilitychange", onVisibility);

    // If user interacts with paywall / buys, we should not nag again today.
    window.addEventListener("pdfp:purchase", () => {
      localStorage.setItem(shownKey, "1");
    });

    // Ensure anon id exists (helps A/B assignment consistency if you add it later)
    getAnonId();
  } catch {}
}
