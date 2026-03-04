/**
 * PDF3 Ads/Affiliate Slot Loader
 * Uses /api/ab-test?variant=ads_variant to decide what to render.
 * Finds: [data-ad-slot]
 */
(async function(){
  function $(sel){ return document.querySelector(sel); }
  function $all(sel){ return Array.from(document.querySelectorAll(sel)); }

  const slots = $all("[data-ad-slot]");
  if (!slots.length) return;

  // anonymous id for deterministic AB
  const uidKey = "pdf3_anon_id";
  let anon = "";
  try {
    anon = localStorage.getItem(uidKey) || "";
    if (!anon) { anon = (crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(36)+Math.random().toString(36).slice(2))); localStorage.setItem(uidKey, anon); }
  } catch(_) { anon = "anon"; }

  async function getVariant(){
    try{
      const res = await fetch(`/api/ab-test?variant=ads_variant&userId=${encodeURIComponent(anon)}`, { credentials:"same-origin" });
      const j = await res.json().catch(()=>null);
      return j?.variant || "none";
    }catch(_){ return "none"; }
  }

  const variant = await getVariant();

  function renderAffiliate(el){
    const tool = document.querySelector('meta[name="pdf3:tool"]')?.content || "";
    el.innerHTML = `
      <div style="border:1px solid rgba(148,163,184,.25);border-radius:12px;padding:14px;background:rgba(15,23,42,.35)">
        <div style="font-weight:800;margin-bottom:6px">📌 Daha Hızlı Sonuç mu?</div>
        <div style="color:#94a3b8;font-size:.92rem;line-height:1.5">
          Büyük dosyalar için <strong>Pro</strong> plan, daha yüksek limit + öncelikli işlem sunar.
        </div>
        <div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap">
          <a href="/pricing.html" style="display:inline-flex;align-items:center;justify-content:center;padding:10px 14px;border-radius:10px;background:#e63946;color:#fff;font-weight:800;text-decoration:none">Planları Gör</a>
          <a href="/tools/${tool}" style="display:inline-flex;align-items:center;justify-content:center;padding:10px 14px;border-radius:10px;border:1px solid rgba(148,163,184,.25);color:#f1f5f9;text-decoration:none">Araca Dön</a>
        </div>
        <div style="margin-top:8px;color:#94a3b8;font-size:.8rem">Not: Bu alan A/B test ile gösterilir.</div>
      </div>
    `;
  }

  function renderAdsensePlaceholder(el){
    el.innerHTML = `
      <div style="border:1px dashed rgba(148,163,184,.35);border-radius:12px;padding:14px;color:#94a3b8">
        AdSense slot (placeholder). Client/slot id'lerini ekleyince burada çalışır.
      </div>
    `;
  }

  for (const el of slots){
    if (variant === "affiliate") renderAffiliate(el);
    else if (variant === "adsense") renderAdsensePlaceholder(el);
    else el.innerHTML = "";
  }
})();
