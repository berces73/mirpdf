(() => {
  // singleton guard
  if (window.__toastManagerInitialized) return;
  window.__toastManagerInitialized = true;

  class ToastManager {
    constructor() {
      this.container = null;
      this.toastCount = 0;
      this.ensureStyles();
      this.init();
    }

    ensureStyles() {
      if (document.getElementById("toast-styles")) return;

      const style = document.createElement("style");
      style.id = "toast-styles";
      style.textContent = `
        .toast-container{
          position:fixed; top:16px; right:16px;
          display:flex; flex-direction:column; gap:10px;
          z-index:9999;
          width:min(360px, calc(100vw - 32px));
          pointer-events:none;
        }
        .toast{
          pointer-events:auto;
          display:flex; align-items:flex-start; gap:10px;
          padding:12px 14px;
          border-radius:12px;
          border:1px solid rgba(255,255,255,.10);
          background:rgba(22,27,34,.96);
          color:#e6edf3;
          box-shadow:0 10px 30px rgba(0,0,0,.35);
          transform:translateY(-6px);
          opacity:0;
          transition:opacity .2s ease, transform .2s ease;
          backdrop-filter: blur(8px);
        }
        .toast.show{ opacity:1; transform:translateY(0); }
        .toast-icon{
          width:22px;height:22px;border-radius:999px;
          display:flex;align-items:center;justify-content:center;
          font-weight:800;flex:0 0 auto;margin-top:1px;
          background:rgba(255,255,255,.10);
          font-size:14px;
        }
        .toast-message{
          font-size:14px;line-height:1.4;color:#e6edf3;
          word-break:break-word;flex:1 1 auto;
        }
        .toast-close{
          appearance:none;border:none;background:transparent;
          color:#9aa4af;font-size:20px;line-height:1;
          cursor:pointer;padding:4px;margin:-2px -2px 0 0;
          border-radius:8px;transition:all .15s;
        }
        .toast-close:hover{ color:#e6edf3; background:rgba(255,255,255,.06); }
        .toast-close:focus-visible{ outline:2px solid rgba(230,57,70,.9); outline-offset:2px; }

        .toast-success{ border-color: rgba(16,185,129,.35); }
        .toast-success .toast-icon{ background: rgba(16,185,129,.18); color:#10b981; }

        .toast-error{ border-color: rgba(239,68,68,.40); }
        .toast-error .toast-icon{ background: rgba(239,68,68,.18); color:#ef4444; }

        .toast-warning{ border-color: rgba(245,158,11,.45); }
        .toast-warning .toast-icon{ background: rgba(245,158,11,.18); color:#f59e0b; }

        .toast-info{ border-color: rgba(59,130,246,.40); }
        .toast-info .toast-icon{ background: rgba(59,130,246,.18); color:#3b82f6; }
      `;
      document.head.appendChild(style);
    }

    init() {
      this.container = document.getElementById("toast-container");
      if (!this.container) {
        this.container = document.createElement("div");
        this.container.id = "toast-container";
        this.container.className = "toast-container";
        document.body.appendChild(this.container);
      }

      window.addEventListener("app:toast", (e) => {
        const d = e?.detail || {};
        this.show(d.message, d.type, d.timeoutMs);
      });
    }

    show(message, type = "info", timeoutMs = 5000) {
      if (message == null) return;

      // limit
      if (this.toastCount >= 5) return;

      const msg = typeof message === "string" ? message : String(message);
      const safeType = ["success", "error", "warning", "info"].includes(type) ? type : "info";

      const toast = document.createElement("div");
      toast.className = `toast toast-${safeType}`;
      toast.setAttribute("role", "alert");
      toast.setAttribute("aria-live", safeType === "error" ? "assertive" : "polite");

      const iconSpan = document.createElement("span");
      iconSpan.className = "toast-icon";
      iconSpan.setAttribute("aria-hidden", "true");
      iconSpan.textContent = this.getIcon(safeType);

      const msgSpan = document.createElement("span");
      msgSpan.className = "toast-message";
      msgSpan.textContent = msg;

      const closeBtn = document.createElement("button");
      closeBtn.className = "toast-close";
      closeBtn.type = "button";
      closeBtn.setAttribute("aria-label", "Kapat");
      closeBtn.textContent = "×";

      toast.appendChild(iconSpan);
      toast.appendChild(msgSpan);
      toast.appendChild(closeBtn);

      this.container.appendChild(toast);
      this.toastCount++;

      requestAnimationFrame(() => toast.classList.add("show"));

      closeBtn.addEventListener("click", () => this.hide(toast));
      if (timeoutMs > 0) setTimeout(() => this.hide(toast), timeoutMs);
    }

    hide(toast) {
      if (!toast || toast._closing) return;
      toast._closing = true;
      toast.classList.remove("show");
      setTimeout(() => {
        if (toast.parentNode) {
          toast.parentNode.removeChild(toast);
          this.toastCount = Math.max(0, this.toastCount - 1);
        }
      }, 220);
    }

    getIcon(type) {
      const icons = { success: "✓", error: "✕", warning: "⚠", info: "ℹ" };
      return icons[type] || icons.info;
    }
  }

  // global helper
  window.toast = function toast(message, type = "info", timeoutMs = 5000) {
    if (message == null) return;
    window.dispatchEvent(new CustomEvent("app:toast", { detail: { message, type, timeoutMs } }));
  };

  const boot = () => new ToastManager();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
