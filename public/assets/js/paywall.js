// FILE: assets/js/paywall.js
let _state = { isOpen: false };
let _els = null;

function ensureStyles() {
  if (document.getElementById("__paywall_styles")) return;

  const css = `
  .pw-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center;z-index:9999;padding:16px}
  .pw-overlay.pw-show{display:flex}
  .pw-modal{width:min(520px,100%);background:#0f172a;color:#e2e8f0;border:1px solid rgba(255,255,255,.12);border-radius:14px;box-shadow:0 30px 80px rgba(0,0,0,.45);padding:18px}
  .pw-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
  .pw-title{font-size:18px;font-weight:800;line-height:1.2;margin:0}
  .pw-close{background:transparent;border:1px solid rgba(255,255,255,.18);color:#e2e8f0;border-radius:10px;padding:6px 10px;cursor:pointer}
  .pw-body{margin-top:10px;color:rgba(226,232,240,.9);font-size:14px;line-height:1.6}
  .pw-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}
  .pw-btn{border-radius:12px;border:1px solid rgba(255,255,255,.16);padding:10px 12px;cursor:pointer;font-weight:700}
  .pw-primary{background:#ef4444;color:white;border-color:#ef4444}
  .pw-secondary{background:transparent;color:#e2e8f0}
  .pw-note{margin-top:10px;font-size:12px;color:rgba(226,232,240,.7)}
  `;
  const style = document.createElement("style");
  style.id = "__paywall_styles";
  style.textContent = css;
  document.head.appendChild(style);
}

function ensureDOM() {
  ensureStyles();

  let overlay = document.getElementById("__paywall");
  if (overlay) return overlay;

  overlay = document.createElement("div");
  overlay.id = "__paywall";
  overlay.className = "pw-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Paywall");

  overlay.innerHTML = `
    <div class="pw-modal">
      <div class="pw-head">
        <h2 class="pw-title" id="__pw_title">Kullanım limiti</h2>
        <button class="pw-close" id="__pw_close" aria-label="Kapat">✕</button>
      </div>
      <div class="pw-body" id="__pw_body"></div>
      <div class="pw-actions">
        <button class="pw-btn pw-primary" id="__pw_primary">Planları Gör</button>
        <button class="pw-btn pw-secondary" id="__pw_secondary">Kapat</button>
      </div>
      <div class="pw-note" id="__pw_note"></div>
    </div>
  `;

  document.body.appendChild(overlay);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closePaywall();
  });

  document.getElementById("__pw_close")?.addEventListener("click", closePaywall);
  document.getElementById("__pw_secondary")?.addEventListener("click", closePaywall);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && _state.isOpen) closePaywall();
  });

  document.getElementById("__pw_primary")?.addEventListener("click", () => {
    window.location.href = "/#pricing";
  });

  _els = {
    overlay,
    title: document.getElementById("__pw_title"),
    body: document.getElementById("__pw_body"),
    note: document.getElementById("__pw_note"),
  };

  return overlay;
}

function messageForReason(reason, tier, extra = {}) {
  switch (reason) {
    case "credits":
      return {
        title: "Kredi bitti",
        body: `Bu işlem için kredin yetersiz.${tier ? ` Plan: ${tier}` : ""}`.trim(),
        note: extra?.resetAt ? `Sıfırlanma: ${extra.resetAt}` : "Plan yükseltmen gerekebilir.",
      };
    case "rate_limit":
      return {
        title: "Çok hızlı denedin",
        body: "Kısa sürede çok istek gönderdin. Biraz bekleyip tekrar dene.",
        note: extra?.retryAfter ? `Tekrar dene: ~${extra.retryAfter}s` : "Rate limit koruması devrede.",
      };
    case "network":
      return {
        title: "Bağlantı sorunu",
        body: "Sunucuya bağlanılamadı. İnternetini kontrol et ve tekrar dene.",
        note: "Geçici ağ hatası olabilir.",
      };
    default:
      return {
        title: "Bir hata oluştu",
        body: "İşlem tamamlanamadı. Tekrar dene.",
        note: "",
      };
  }
}

export function openPaywall({ reason = "error", tier = null, retryAfter = null, resetAt = null } = {}) {
  ensureDOM();
  const msg = messageForReason(reason, tier, { retryAfter, resetAt });

  _els?.title && (_els.title.textContent = msg.title);
  _els?.body && (_els.body.textContent = msg.body);
  _els?.note && (_els.note.textContent = msg.note || "");

  _els?.overlay?.classList.add("pw-show");
  _state.isOpen = true;
}

export function closePaywall() {
  document.getElementById("__paywall")?.classList.remove("pw-show");
  _state.isOpen = false;
}
