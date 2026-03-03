let updateBannerShown = false;

function showUpdateBanner(reg) {
  if (updateBannerShown) return;
  updateBannerShown = true;

  window.toast?.("🎉 Yeni versiyon hazır.", "info", 8000);

  if (document.getElementById("sw-update-bar")) return;

  const bar = document.createElement("div");
  bar.id = "sw-update-bar";
  bar.style.cssText = `
    position:fixed; left:50%; bottom:16px; transform:translateX(-50%);
    z-index:9999; background:#161b22; color:#e6edf3;
    border:1px solid rgba(255,255,255,.12);
    padding:12px 16px; border-radius:12px;
    display:flex; gap:12px; align-items:center;
    box-shadow:0 10px 30px rgba(0,0,0,.35);
  `;

  const text = document.createElement("span");
  text.textContent = "Yeni sürüm hazır";
  text.style.cssText = "font-weight:700; flex:1;";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "Güncelle";
  btn.style.cssText = `
    background:#e63946; color:white; border:none;
    padding:8px 14px; border-radius:8px; cursor:pointer; font-weight:800;
  `;

  const close = document.createElement("button");
  close.type = "button";
  close.setAttribute("aria-label", "Kapat");
  close.textContent = "×";
  close.style.cssText = `
    background:transparent; color:#9aa4af; border:none;
    padding:4px 8px; cursor:pointer; font-size:20px; border-radius:6px;
  `;

  bar.appendChild(text);
  bar.appendChild(btn);
  bar.appendChild(close);
  document.body.appendChild(bar);

  btn.addEventListener("click", () => {
    try {
      reg?.waiting?.postMessage({ type: "SKIP_WAITING" });
    } catch {}
    window.location.reload();
  });

  close.addEventListener("click", () => {
    bar.remove();
    updateBannerShown = false;
  });
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("/assets/js/sw.js");
      console.log("[SW] Registered:", reg.scope);

      reg.addEventListener("updatefound", () => {
        const nw = reg.installing;
        if (!nw) return;

        nw.addEventListener("statechange", () => {
          if (nw.state === "installed" && navigator.serviceWorker.controller) {
            showUpdateBanner(reg);
          }
        });
      });

      // visibility-based update (safer than always-on interval)
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
          reg.update().catch(() => {});
        }
      });

    } catch (e) {
      console.warn("[SW] Registration failed:", e);
    }
  });

  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "SW_UPDATED") {
      console.log("[SW] Updated to:", event.data.version);
    }
  });
}
