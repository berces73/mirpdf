/**
 * tool-page.js — MirPDF Tool Engine v2.0
 *
 * Smallpdf/ilovePDF kalitesinde:
 * ✅ Drag-and-drop drop zone (görsel, animasyonlu)
 * ✅ PDF thumbnail önizlemesi (pdf.js ile)
 * ✅ Animasyonlu progress bar
 * ✅ Result ekranı (download + related tools)
 * ✅ Tüm eksik fonksiyonlar (detectToolFromPage, ensureStatus, toolProtect, toolUnlock)
 * ✅ Worker-based client-side PDF işleme (zero-copy transfer)
 * ✅ Server-side Pro job pipeline (compress, pdf-to-word, ocr)
 * ✅ Drag-to-reorder sayfa düzeni (merge)
 * ✅ Paywall entegrasyonu
 * ✅ KVKK trust widget
 * ✅ FAQ schema injection
 * ✅ İlgili araçlar SEO linkleri
 */

import { consumeCredit, newOpId, refreshCreditInfo } from "./consume-credit.js";
import { openPaywall } from "./paywall.js";
import { funnelMaybeBlockStart, initExitIntent } from "./funnel.js";

// ─── Config ──────────────────────────────────────────────────
const API_BASE        = "/api";
const PDF_LIB_CDN     = "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js";
const PDFJS_CDN       = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.js";
const PDFJS_WORKER    = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.js";
const JSZIP_CDN       = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
const QRCODE_CDN      = "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js";
const MAX_PDF_BYTES   = 50 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const THUMB_WIDTH     = 120;

// ─── Utilities ────────────────────────────────────────────────

function $(sel, root = document) { return root.querySelector(sel); }
function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }

function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class")  n.className  = v;
    else if (k === "text") n.textContent = v;
    else if (k === "html") n.innerHTML   = v;
    else n.setAttribute(k, v);
  }
  const ch = Array.isArray(children) ? children : [children];
  for (const c of ch) {
    if (c == null) continue;
    n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return n;
}

function bytesToMB(n) { return (n / 1024 / 1024).toFixed(1); }

function formatEta(ms) {
  if (!ms || ms < 0) return "";
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}dk ${r}s` : `${m}dk`;
}

function sanitizeFilename(name) {
  return (name || "output")
    .replace(/[^\w.\-]/g, "_")
    .replace(/_{2,}/g, "_")
    .slice(0, 100);
}

function loadScriptOnce(src, globalName) {
  return new Promise((resolve, reject) => {
    if (globalName && window[globalName]) return resolve(window[globalName]);
    const existing = [...document.scripts].find(s => s.src === src);
    if (existing) {
      existing.addEventListener("load", () => resolve(globalName ? window[globalName] : true));
      return;
    }
    const s = document.createElement("script");
    s.src = src; s.async = true;
    s.onload  = () => resolve(globalName ? window[globalName] : true);
    s.onerror = () => reject(new Error("Script yüklenemedi: " + src));
    document.head.appendChild(s);
  });
}

async function loadPdfLib() {
  if (window.PDFLib) return window.PDFLib;
  await loadScriptOnce(PDF_LIB_CDN, "PDFLib");
  return window.PDFLib;
}

async function loadPdfJs() {
  if (window.pdfjsLib) return window.pdfjsLib;
  await loadScriptOnce(PDFJS_CDN, "pdfjsLib");
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  return window.pdfjsLib;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 20_000);
}

// ─── Tool Detection ────────────────────────────────────────────

function detectToolFromPage() {
  return document.body?.getAttribute("data-tool")
    || document.querySelector('meta[name="tool"]')?.getAttribute("content")
    || null;
}

function toolVariant() {
  return document.querySelector('meta[name="tool-variant"]')?.getAttribute("content") || null;
}

const TOOL_LABELS = {
  merge:     "PDF Birleştir",
  split:     "PDF Böl",
  compress:  "PDF Sıkıştır",
  rotate:    "PDF Döndür",
  extract:   "Sayfa Sil",
  reorder:   "Sayfa Sırala",
  watermark: "Filigran / QR Ekle",
  convert:   "Dönüştür",
  protect:   "PDF Kilitle",
  unlock:    "PDF Kilit Aç",
  "jpg-to-pdf": "JPG → PDF",
  "pdf-to-jpg": "PDF → JPG",
  "pdf-to-word": "PDF → Word",
  ocr: "Metin Tanıma (OCR)",
};

function prettyName(tool) {
  return TOOL_LABELS[tool] || tool || "PDF Araç";
}

// ─── Validation ────────────────────────────────────────────────

function validatePdf(file) {
  if (!file) return "Dosya seçilmedi.";
  if (file.size > MAX_PDF_BYTES) return `Dosya çok büyük (maks ${bytesToMB(MAX_PDF_BYTES)} MB).`;
  if (file.type && file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf"))
    return "Lütfen geçerli bir PDF dosyası seçin.";
  return null;
}

function validateImage(file) {
  if (!file) return "Dosya seçilmedi.";
  if (file.size > MAX_IMAGE_BYTES) return `Dosya çok büyük (maks ${bytesToMB(MAX_IMAGE_BYTES)} MB).`;
  if (!["image/jpeg", "image/jpg", "image/png"].includes(file.type))
    return "Lütfen JPG veya PNG dosyası seçin.";
  return null;
}

async function checkPdfMagic(file) {
  const buf = await file.slice(0, 5).arrayBuffer();
  return new TextDecoder().decode(buf).startsWith("%PDF-");
}

// ─── Status / Progress ────────────────────────────────────────

function ensureStatus(container) {
  let s = container.querySelector(".tp-status");
  if (!s) {
    s = el("div", { class: "tp-status tp-status--hidden", role: "status", "aria-live": "polite" });
    container.prepend(s);
  }
  return s;
}

function setStatus(node, msg, kind = "info") {
  if (!node) return;
  node.textContent = msg;
  node.className = `tp-status tp-status--${kind}`;
  node.removeAttribute("hidden");
}

function hideStatus(node) {
  if (!node) return;
  node.className = "tp-status tp-status--hidden";
  node.textContent = "";
}

// Progress bar helper
function ensureProgress(container) {
  let pb = container.querySelector(".tp-progress");
  if (!pb) {
    pb = el("div", { class: "tp-progress tp-progress--hidden", role: "progressbar", "aria-valuenow": "0", "aria-valuemin": "0", "aria-valuemax": "100" });
    const fill = el("div", { class: "tp-progress__fill" });
    const label = el("div", { class: "tp-progress__label" });
    pb.appendChild(fill);
    pb.appendChild(label);
    container.appendChild(pb);
  }
  return pb;
}

function setProgress(pb, pct, label = "") {
  if (!pb) return;
  pb.classList.remove("tp-progress--hidden");
  pb.setAttribute("aria-valuenow", pct);
  const fill = pb.querySelector(".tp-progress__fill");
  const lbl  = pb.querySelector(".tp-progress__label");
  if (fill) fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  if (lbl)  lbl.textContent  = label;
}

function hideProgress(pb) {
  if (!pb) return;
  pb.classList.add("tp-progress--hidden");
}

// ─── Result Screen ────────────────────────────────────────────

function showResultScreen(container, opts = {}) {
  const {
    blob,
    filename = "output.pdf",
    label = "İndiriliyor…",
    tool = detectToolFromPage(),
    sizeOriginal,
    sizeFinal,
  } = opts;

  // Remove previous result
  container.querySelector(".tp-result")?.remove();

  const savings = sizeOriginal && sizeFinal && sizeFinal < sizeOriginal
    ? `${Math.round((1 - sizeFinal / sizeOriginal) * 100)}% daha küçük`
    : null;

  const result = el("div", { class: "tp-result" });
  result.innerHTML = `
    <div class="tp-result__icon">✅</div>
    <div class="tp-result__title">İşlem tamamlandı!</div>
    ${savings ? `<div class="tp-result__savings">🔥 Dosya <strong>${savings}</strong> küçüldü</div>` : ""}
    <button class="tp-result__download" type="button">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      ${label}
    </button>
    <button class="tp-result__again" type="button">Yeni Dosya İşle</button>
  `;

  result.querySelector(".tp-result__download").addEventListener("click", () => {
    if (blob) downloadBlob(blob, filename);
  });

  result.querySelector(".tp-result__again").addEventListener("click", () => {
    result.remove();
    container.querySelector(".tp-dropzone")?.classList.remove("tp-dropzone--hidden");
    container.querySelector(".tp-toolbar")?.classList.remove("tp-toolbar--hidden");
    hideStatus(container.querySelector(".tp-status"));
    hideProgress(container.querySelector(".tp-progress"));
    // Reset any file input
    container.querySelectorAll("input[type=file]").forEach(i => { i.value = ""; });
  });

  container.appendChild(result);

  // Auto-trigger download
  if (blob) {
    setTimeout(() => downloadBlob(blob, filename), 200);
  }
}

// ─── Thumbnail Generator (pdf.js) ─────────────────────────────

async function renderPdfThumbnail(file, pageNum = 1) {
  try {
    const pdfjs = await loadPdfJs();
    const buf = await file.arrayBuffer();
    const doc = await pdfjs.getDocument({ data: buf }).promise;
    if (pageNum > doc.numPages) pageNum = 1;
    const page = await doc.getPage(pageNum);
    const vp   = page.getViewport({ scale: THUMB_WIDTH / page.getViewport({ scale: 1 }).width });
    const cv   = document.createElement("canvas");
    cv.width   = Math.floor(vp.width);
    cv.height  = Math.floor(vp.height);
    await page.render({ canvasContext: cv.getContext("2d"), viewport: vp }).promise;
    const numPages = doc.numPages;
    await doc.destroy();
    return { canvas: cv, numPages };
  } catch (e) {
    console.warn("[thumbnail]", e);
    return null;
  }
}

function createThumbnailEl(file, label = "") {
  const wrap = el("div", { class: "tp-thumb" });
  const placeholder = el("div", { class: "tp-thumb__placeholder" });
  placeholder.innerHTML = `<svg width="28" height="36" viewBox="0 0 28 36"><rect width="28" height="36" rx="3" fill="#e2e8f0"/><path d="M6 14h16M6 19h16M6 24h10" stroke="#94a3b8" stroke-width="2" stroke-linecap="round"/></svg>`;
  wrap.appendChild(placeholder);

  const name = el("div", { class: "tp-thumb__name", text: label || file.name });
  const size = el("div", { class: "tp-thumb__size", text: `${bytesToMB(file.size)} MB` });
  wrap.appendChild(name);
  wrap.appendChild(size);

  // Async load thumbnail
  renderPdfThumbnail(file).then(res => {
    if (!res) return;
    placeholder.innerHTML = "";
    res.canvas.className = "tp-thumb__canvas";
    placeholder.appendChild(res.canvas);
    if (res.numPages > 1) {
      const badge = el("div", { class: "tp-thumb__pages", text: `${res.numPages} sayfa` });
      wrap.appendChild(badge);
    }
  });

  return wrap;
}

// ─── Drop Zone ────────────────────────────────────────────────

function createDropZone(opts = {}) {
  const {
    accept       = ".pdf",
    multiple     = false,
    label        = "PDF dosyanızı buraya sürükleyin",
    sublabel     = "veya tıklayarak seçin",
    icon         = `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="12" x2="12" y2="18"/><line x1="9" y1="15" x2="15" y2="15"/></svg>`,
    maxMb        = 50,
    onFiles      = () => {},
  } = opts;

  const zone = el("div", { class: "tp-dropzone", role: "button", tabindex: "0", "aria-label": label });
  const inp  = el("input", { type: "file", accept, class: "tp-dropzone__input", "aria-hidden": "true" });
  if (multiple) inp.setAttribute("multiple", "");

  zone.innerHTML = `
    <div class="tp-dropzone__icon">${icon}</div>
    <div class="tp-dropzone__label">${label}</div>
    <div class="tp-dropzone__sub">${sublabel} • Maks ${maxMb} MB${multiple ? " • Birden fazla dosya" : ""}</div>
    <div class="tp-dropzone__formats">${accept.replace(/\./g,"").toUpperCase().replace(/,/g," · ")}</div>
  `;
  zone.appendChild(inp);

  // Click → open dialog
  zone.addEventListener("click", (e) => {
    if (e.target === inp) return;
    inp.click();
  });
  zone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); inp.click(); }
  });

  // Drag events
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("tp-dropzone--over");
  });
  zone.addEventListener("dragleave", (e) => {
    if (!zone.contains(e.relatedTarget)) zone.classList.remove("tp-dropzone--over");
  });
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("tp-dropzone--over");
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) onFiles(files);
  });

  inp.addEventListener("change", () => {
    const files = [...(inp.files || [])];
    if (files.length) onFiles(files);
  });

  return { zone, inp };
}

// ─── Web Worker (pdf-lib operations) ─────────────────────────

function createPdfWorkerBlob() {
  const code = `
    importScripts("${PDF_LIB_CDN}");

    const handlers = {
      async merge({ files }) {
        const lib = self.PDFLib;
        const out  = await lib.PDFDocument.create();
        for (const bytes of files) {
          const src   = await lib.PDFDocument.load(bytes, { ignoreEncryption: true });
          const pages = await out.copyPages(src, src.getPageIndices());
          pages.forEach(p => out.addPage(p));
        }
        return out.save();
      },

      async split({ bytes, wantedIndices }) {
        const lib  = self.PDFLib;
        const src  = await lib.PDFDocument.load(bytes, { ignoreEncryption: true });
        const out  = await lib.PDFDocument.create();
        const pages = await out.copyPages(src, wantedIndices);
        pages.forEach(p => out.addPage(p));
        return out.save();
      },

      async rotate({ bytes, degrees }) {
        const lib = self.PDFLib;
        const pdf = await lib.PDFDocument.load(bytes, { ignoreEncryption: true });
        pdf.getPages().forEach(p => {
          p.setRotation(lib.degrees((p.getRotation().angle + degrees) % 360));
        });
        return pdf.save();
      },

      async extract({ bytes, keepIndices }) {
        const lib  = self.PDFLib;
        const src  = await lib.PDFDocument.load(bytes, { ignoreEncryption: true });
        const out  = await lib.PDFDocument.create();
        (await out.copyPages(src, keepIndices)).forEach(p => out.addPage(p));
        return out.save();
      },

      async reorder({ bytes, newOrder }) {
        const lib  = self.PDFLib;
        const src  = await lib.PDFDocument.load(bytes, { ignoreEncryption: true });
        const out  = await lib.PDFDocument.create();
        (await out.copyPages(src, newOrder)).forEach(p => out.addPage(p));
        return out.save();
      },

      async protect({ bytes, password }) {
        const lib = self.PDFLib;
        const pdf = await lib.PDFDocument.load(bytes, { ignoreEncryption: true });
        pdf.encrypt({
          userPassword: password,
          ownerPassword: password + "_owner",
          permissions: {
            printing: "highResolution",
            modifying: false,
            copying: false,
            annotating: false,
            fillingForms: false,
            contentAccessibility: true,
            documentAssembly: false,
          },
        });
        return pdf.save();
      },

      async jpgToPdf({ imageBuffers }) {
        const lib = self.PDFLib;
        const pdf = await lib.PDFDocument.create();
        for (const buf of imageBuffers) {
          const view = new Uint8Array(buf);
          const img = (view[0] === 0x89 && view[1] === 0x50)
            ? await pdf.embedPng(buf)
            : await pdf.embedJpg(buf);
          const page = pdf.addPage([img.width, img.height]);
          page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
        }
        return pdf.save();
      },
    };

    self.onmessage = async ({ data }) => {
      const { id, cmd, payload } = data;
      try {
        if (!handlers[cmd]) throw new Error("Bilinmeyen komut: " + cmd);
        const result = await handlers[cmd](payload);
        self.postMessage(
          { id, ok: true, result },
          result instanceof Uint8Array ? [result.buffer] : []
        );
      } catch (err) {
        self.postMessage({ id, ok: false, error: err.message });
      }
    };
  `;
  return new Blob([code], { type: "application/javascript" });
}

let _worker = null, _workerUrl = null;
const _pending = new Map();
let _pendingId = 0;

function getPdfWorker() {
  if (!_worker) {
    _workerUrl = URL.createObjectURL(createPdfWorkerBlob());
    _worker    = new Worker(_workerUrl);
    _worker.onmessage = ({ data }) => {
      const cb = _pending.get(data.id);
      if (!cb) return;
      _pending.delete(data.id);
      data.ok ? cb.resolve(data.result) : cb.reject(new Error(data.error));
    };
    _worker.onerror = (e) => {
      for (const [id, cb] of _pending) {
        cb.reject(new Error("Worker çöktü: " + e.message));
        _pending.delete(id);
      }
      _worker = null;
      URL.revokeObjectURL(_workerUrl);
    };
  }
  return _worker;
}

function runInWorker(cmd, payload, transferables = []) {
  return new Promise((resolve, reject) => {
    const id = ++_pendingId;
    _pending.set(id, { resolve, reject });
    getPdfWorker().postMessage({ id, cmd, payload }, transferables);
  });
}

// ─── Credit Helper ────────────────────────────────────────────

async function doConsumeOrStop(tool) {
  // Revenue funnel: show offer on 3rd daily attempt
  if (funnelMaybeBlockStart({ tool })) return false;
  return consumeCredit(tool, newOpId());
}
// ─── Pro Job API ──────────────────────────────────────────────

async function submitProJob(toolName, file, opts = {}) {
  const fd = new FormData();
  fd.append("file", file, sanitizeFilename(file.name));
  fd.append("opId", newOpId());

  const endpointMap = {
    "compress-strong": `${API_BASE}/compress`,
    "pdf-to-word":     `${API_BASE}/pdf-to-word`,
    "ocr":             `${API_BASE}/ocr`,
  };

  const endpoint = endpointMap[toolName];
  if (!endpoint) throw new Error("Desteklenmeyen pro tool: " + toolName);

  if (toolName === "compress-strong") fd.append("level", opts.level || "recommended");
  if (toolName === "pdf-to-word")     fd.append("format", opts.format || "docx");
  if (toolName === "ocr")             fd.append("lang", opts.lang || "tur+eng");

  const resp = await fetch(endpoint, { method: "POST", credentials: "same-origin", body: fd });
  const data = await resp.json().catch(() => ({ ok: false, error: { code: "PARSE_ERROR", message: "Sunucu yanıtı okunamadı." } }));
  return { httpStatus: resp.status, data };
}

async function pollJobStatus(jobId, onProgress, signal, opts = {}) {
  const maxMs = Number(opts.maxMs || 10 * 60_000);
  const t0 = Date.now();
  let interval = 1000;

  while (Date.now() - t0 < maxMs) {
    if (signal?.aborted) throw new Error("İptal edildi.");
    await new Promise(r => setTimeout(r, Math.min(6000, interval) + Math.random() * 250));
    interval = Math.min(6000, Math.floor(interval * 1.2));

    const r = await fetch(`${API_BASE}/jobs/${jobId}/status`, { signal, credentials: "same-origin" }).catch(() => null);
    if (!r) continue;
    const d  = await r.json().catch(() => ({}));
    const st = d?.data?.status || d?.status;
    const pct = typeof d?.data?.progress === "number" ? d.data.progress : null;

    onProgress?.({ status: st || "processing", progress: pct, stage: d?.data?.stage, elapsedMs: Date.now() - t0 });

    if (st === "done" || st === "completed") return { ok: true, data: d?.data || {} };
    if (st === "failed" || st === "error") return { ok: false, message: d?.data?.message || "İşlem başarısız." };
  }
  return { ok: false, message: "Zaman aşımı. Lütfen tekrar deneyin." };
}

async function downloadJobResult(jobId) {
  const resp = await fetch(`${API_BASE}/jobs/${jobId}/result`, { credentials: "same-origin", headers: { "Cache-Control": "no-store" } });
  if (!resp.ok) throw new Error("Sonuç indirilemedi.");
  return resp.blob();
}

// ─── Tool: Merge ──────────────────────────────────────────────

async function toolMerge(root, status) {
  const progress = ensureProgress(root);

  const { zone, inp } = createDropZone({
    accept: ".pdf", multiple: true,
    label: "PDF dosyalarını buraya sürükleyin",
    sublabel: "veya tıklayarak birden fazla dosya seçin",
    icon: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="8" height="11" rx="1"/><rect x="14" y="3" width="8" height="11" rx="1"/><path d="M6 14v7M18 14v7M2 21h20"/></svg>`,
  });

  const thumbGrid  = el("div", { class: "tp-thumb-grid tp-thumb-grid--hidden" });
  const goBtn      = el("button", { class: "tp-btn tp-btn--primary tp-btn--hidden", type: "button", html: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12l7 7 7-7"/></svg> Birleştir ve İndir` });

  let fileList = [];

  const refresh = () => {
    thumbGrid.innerHTML = "";
    if (!fileList.length) {
      thumbGrid.classList.add("tp-thumb-grid--hidden");
      goBtn.classList.add("tp-btn--hidden");
      return;
    }
    thumbGrid.classList.remove("tp-thumb-grid--hidden");
    goBtn.classList.remove("tp-btn--hidden");
    fileList.forEach((f, i) => {
      const thumb = createThumbnailEl(f, `${i + 1}. ${f.name}`);
      const removeBtn = el("button", { class: "tp-thumb__remove", type: "button", "aria-label": "Kaldır", text: "×" });
      removeBtn.addEventListener("click", () => {
        fileList.splice(i, 1);
        refresh();
      });
      thumb.appendChild(removeBtn);
      thumbGrid.appendChild(thumb);
    });
  };

  zone.addEventListener("change", () => {});
  const addFiles = (files) => {
    for (const f of files) {
      const err = validatePdf(f);
      if (err) { window.toast?.(err, "error"); continue; }
      fileList.push(f);
    }
    refresh();
  };

  // Re-wire dropzone to addFiles
  inp.addEventListener("change", () => addFiles([...(inp.files || [])]));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("tp-dropzone--over");
    addFiles([...(e.dataTransfer?.files || [])]);
  }, true);

  goBtn.addEventListener("click", async () => {
    if (!fileList.length) return;
    for (const f of fileList) {
      if (!await checkPdfMagic(f)) { setStatus(status, `${f.name} geçerli bir PDF değil.`, "error"); return; }
    }
    if (!await doConsumeOrStop("merge")) return;

    goBtn.disabled = true;
    setStatus(status, "Birleştiriliyor…", "info");
    setProgress(progress, 10, "Dosyalar okunuyor…");

    try {
      const buffers = await Promise.all(fileList.map(f => f.arrayBuffer()));
      setProgress(progress, 40, "Sayfalar birleştiriliyor…");
      const result = await runInWorker("merge", { files: buffers }, buffers);
      setProgress(progress, 90, "Hazırlanıyor…");
      const blob = new Blob([result], { type: "application/pdf" });
      setProgress(progress, 100, "Tamamlandı!");
      hideStatus(status);
      hideProgress(progress);
      zone.classList.add("tp-dropzone--hidden");
      thumbGrid.classList.add("tp-thumb-grid--hidden");
      goBtn.classList.add("tp-btn--hidden");
      showResultScreen(root, { blob, filename: "merged.pdf", label: "merged.pdf İndir", tool: "merge" });
      refreshCreditInfo?.().catch(() => {});
    } catch (e) {
      console.error("[toolMerge]", e);
      setStatus(status, "Başarısız: " + e.message, "error");
      hideProgress(progress);
    } finally {
      goBtn.disabled = false;
    }
  });

  root.append(zone, thumbGrid, goBtn);
}

// ─── Tool: Split ───────────────────────────────────────────────

async function toolSplit(root, status) {
  const progress = ensureProgress(root);
  let currentFile = null;

  const { zone } = createDropZone({ accept: ".pdf", label: "PDF dosyasını sürükleyin" });
  const thumbWrap = el("div", { class: "tp-single-thumb tp-single-thumb--hidden" });
  const optBox    = el("div", { class: "tp-optbox tp-optbox--hidden" });
  const rangeInp  = el("input", { type: "text", class: "tp-input", placeholder: "Sayfa aralığı (örn: 1-3,5,7) — boş = hepsi" });
  const goBtn     = el("button", { class: "tp-btn tp-btn--primary tp-btn--hidden", type: "button", html: "✂️ Böl ve İndir" });

  optBox.appendChild(el("label", { class: "tp-label", text: "Sayfa Aralığı" }));
  optBox.appendChild(rangeInp);

  const onFile = async (file) => {
    const err = validatePdf(file);
    if (err) { window.toast?.(err, "error"); return; }
    if (!await checkPdfMagic(file)) { window.toast?.("Geçerli bir PDF değil.", "error"); return; }
    currentFile = file;
    thumbWrap.innerHTML = "";
    thumbWrap.classList.remove("tp-single-thumb--hidden");
    thumbWrap.appendChild(createThumbnailEl(file));
    optBox.classList.remove("tp-optbox--hidden");
    goBtn.classList.remove("tp-btn--hidden");
    zone.classList.add("tp-dropzone--compact");
  };

  zone.addEventListener("drop", (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) onFile(f);
  }, true);
  zone.querySelector("input").addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    if (f) onFile(f);
  });

  goBtn.addEventListener("click", async () => {
    if (!currentFile) return;
    if (!await doConsumeOrStop("split")) return;

    goBtn.disabled = true;
    setStatus(status, "İşleniyor…", "info");
    setProgress(progress, 10, "PDF yükleniyor…");

    try {
      const PDFLib = await loadPdfLib();
      const buf    = await currentFile.arrayBuffer();
      const src    = await PDFLib.PDFDocument.load(new Uint8Array(buf.slice(0)), { ignoreEncryption: true });
      const max    = src.getPageCount();
      const text   = rangeInp.value.trim();
      let indices  = [];

      if (!text) {
        indices = [...Array(max)].map((_, i) => i);
      } else {
        const set = new Set();
        for (const p of text.split(",").map(s => s.trim()).filter(Boolean)) {
          const m = p.match(/^(\d+)\s*-\s*(\d+)$/);
          if (m) {
            let [a, b] = [+m[1], +m[2]];
            if (a > b) [a, b] = [b, a];
            for (let i = a; i <= b; i++) if (i >= 1 && i <= max) set.add(i - 1);
          } else if (/^\d+$/.test(p)) {
            const n = +p;
            if (n >= 1 && n <= max) set.add(n - 1);
          }
        }
        indices = [...set].sort((a, b) => a - b);
      }

      if (!indices.length) { setStatus(status, "Geçerli sayfa aralığı girin.", "error"); goBtn.disabled = false; return; }

      setProgress(progress, 50, `${indices.length} sayfa ayrılıyor…`);
      const bytes  = await currentFile.arrayBuffer();
      const result = await runInWorker("split", { bytes, wantedIndices: indices }, [bytes]);
      setProgress(progress, 100, "Tamamlandı!");
      hideStatus(status);
      hideProgress(progress);
      zone.classList.add("tp-dropzone--hidden");
      thumbWrap.classList.add("tp-single-thumb--hidden");
      optBox.classList.add("tp-optbox--hidden");
      goBtn.classList.add("tp-btn--hidden");
      showResultScreen(root, { blob: new Blob([result], { type: "application/pdf" }), filename: "split.pdf", label: "split.pdf İndir" });
      refreshCreditInfo?.().catch(() => {});
    } catch (e) {
      console.error("[toolSplit]", e);
      setStatus(status, "Başarısız: " + e.message, "error");
      hideProgress(progress);
    } finally {
      goBtn.disabled = false;
    }
  });

  root.append(zone, thumbWrap, optBox, goBtn);
}

// ─── Tool: Rotate ──────────────────────────────────────────────

async function toolRotate(root, status) {
  const progress = ensureProgress(root);
  let currentFile = null;

  const { zone } = createDropZone({ accept: ".pdf", label: "PDF dosyasını sürükleyin" });
  const thumbWrap = el("div", { class: "tp-single-thumb tp-single-thumb--hidden" });
  const optBox    = el("div", { class: "tp-optbox tp-optbox--hidden" });
  const sel       = el("select", { class: "tp-select" }, [
    el("option", { value: "90", text: "90° Saat Yönünde" }),
    el("option", { value: "180", text: "180° (Çevir)" }),
    el("option", { value: "270", text: "270° (Saat Tersi 90°)" }),
  ]);
  const goBtn = el("button", { class: "tp-btn tp-btn--primary tp-btn--hidden", type: "button", html: "🔄 Döndür ve İndir" });

  optBox.appendChild(el("label", { class: "tp-label", text: "Döndürme Açısı" }));
  optBox.appendChild(sel);

  const onFile = async (file) => {
    const err = validatePdf(file);
    if (err) { window.toast?.(err, "error"); return; }
    currentFile = file;
    thumbWrap.innerHTML = "";
    thumbWrap.classList.remove("tp-single-thumb--hidden");
    thumbWrap.appendChild(createThumbnailEl(file));
    optBox.classList.remove("tp-optbox--hidden");
    goBtn.classList.remove("tp-btn--hidden");
    zone.classList.add("tp-dropzone--compact");
  };

  zone.addEventListener("drop", (e) => { const f = e.dataTransfer?.files?.[0]; if (f) onFile(f); }, true);
  zone.querySelector("input").addEventListener("change", (e) => { const f = e.target.files?.[0]; if (f) onFile(f); });

  goBtn.addEventListener("click", async () => {
    if (!currentFile || !await doConsumeOrStop("rotate")) return;
    goBtn.disabled = true;
    setStatus(status, "Döndürülüyor…", "info");
    setProgress(progress, 20);
    try {
      const bytes  = await currentFile.arrayBuffer();
      setProgress(progress, 50, "İşleniyor…");
      const result = await runInWorker("rotate", { bytes, degrees: Number(sel.value) }, [bytes]);
      setProgress(progress, 100, "Tamamlandı!");
      hideProgress(progress); hideStatus(status);
      zone.classList.add("tp-dropzone--hidden"); thumbWrap.classList.add("tp-single-thumb--hidden"); optBox.classList.add("tp-optbox--hidden"); goBtn.classList.add("tp-btn--hidden");
      showResultScreen(root, { blob: new Blob([result], { type: "application/pdf" }), filename: "rotated.pdf", label: "rotated.pdf İndir" });
      refreshCreditInfo?.().catch(() => {});
    } catch (e) { setStatus(status, "Başarısız: " + e.message, "error"); hideProgress(progress); }
    finally { goBtn.disabled = false; }
  });

  root.append(zone, thumbWrap, optBox, goBtn);
}

// ─── Tool: Extract (Sayfa Sil) ────────────────────────────────

async function toolExtract(root, status) {
  const progress = ensureProgress(root);
  let currentFile = null;

  const { zone } = createDropZone({ accept: ".pdf", label: "PDF dosyasını sürükleyin" });
  const thumbWrap = el("div", { class: "tp-single-thumb tp-single-thumb--hidden" });
  const optBox    = el("div", { class: "tp-optbox tp-optbox--hidden" });
  const delInp    = el("input", { type: "text", class: "tp-input", placeholder: "Silinecek sayfalar (örn: 2,4-6)" });
  const goBtn     = el("button", { class: "tp-btn tp-btn--primary tp-btn--hidden", type: "button", html: "🗑️ Sayfaları Sil ve İndir" });

  optBox.appendChild(el("label", { class: "tp-label", text: "Silinecek Sayfalar" }));
  optBox.appendChild(delInp);

  const onFile = async (file) => {
    const err = validatePdf(file);
    if (err) { window.toast?.(err, "error"); return; }
    currentFile = file;
    thumbWrap.innerHTML = "";
    thumbWrap.classList.remove("tp-single-thumb--hidden");
    thumbWrap.appendChild(createThumbnailEl(file));
    optBox.classList.remove("tp-optbox--hidden");
    goBtn.classList.remove("tp-btn--hidden");
    zone.classList.add("tp-dropzone--compact");
  };

  zone.addEventListener("drop", (e) => { const f = e.dataTransfer?.files?.[0]; if (f) onFile(f); }, true);
  zone.querySelector("input").addEventListener("change", (e) => { const f = e.target.files?.[0]; if (f) onFile(f); });

  goBtn.addEventListener("click", async () => {
    if (!currentFile || !await doConsumeOrStop("extract")) return;
    goBtn.disabled = true;
    setStatus(status, "İşleniyor…", "info");
    setProgress(progress, 10);
    try {
      const PDFLib = await loadPdfLib();
      const buf0   = await currentFile.arrayBuffer();
      const src    = await PDFLib.PDFDocument.load(new Uint8Array(buf0), { ignoreEncryption: true });
      const max    = src.getPageCount();
      const delSet = new Set();
      for (const p of (delInp.value || "").split(",").map(s => s.trim()).filter(Boolean)) {
        const m = p.match(/^(\d+)\s*-\s*(\d+)$/);
        if (m) { let [a,b]=[+m[1],+m[2]]; if(a>b)[a,b]=[b,a]; for(let i=a;i<=b;i++) if(i>=1&&i<=max) delSet.add(i); }
        else if (/^\d+$/.test(p)) { const n=+p; if(n>=1&&n<=max) delSet.add(n); }
      }
      const keep = [];
      for (let i=1;i<=max;i++) if(!delSet.has(i)) keep.push(i-1);
      if (!keep.length) { setStatus(status, "En az bir sayfa kalmalı.", "error"); goBtn.disabled=false; hideProgress(progress); return; }
      setProgress(progress, 50, "Sayfalar kaldırılıyor…");
      const bytes  = await currentFile.arrayBuffer();
      const result = await runInWorker("extract", { bytes, keepIndices: keep }, [bytes]);
      setProgress(progress, 100, "Tamamlandı!");
      hideProgress(progress); hideStatus(status);
      zone.classList.add("tp-dropzone--hidden"); thumbWrap.classList.add("tp-single-thumb--hidden"); optBox.classList.add("tp-optbox--hidden"); goBtn.classList.add("tp-btn--hidden");
      showResultScreen(root, { blob: new Blob([result], { type: "application/pdf" }), filename: "pages-removed.pdf", label: "pages-removed.pdf İndir" });
      refreshCreditInfo?.().catch(() => {});
    } catch (e) { setStatus(status, "Başarısız: " + e.message, "error"); hideProgress(progress); }
    finally { goBtn.disabled = false; }
  });

  root.append(zone, thumbWrap, optBox, goBtn);
}

// ─── Tool: Protect (PDF Kilitle) ──────────────────────────────

async function toolProtect(root, status) {
  const progress = ensureProgress(root);
  let currentFile = null;

  const { zone } = createDropZone({ accept: ".pdf", label: "Kilitlemek istediğiniz PDF'i sürükleyin" });
  const thumbWrap = el("div", { class: "tp-single-thumb tp-single-thumb--hidden" });
  const optBox    = el("div", { class: "tp-optbox tp-optbox--hidden" });
  const pwInp     = el("input", { type: "password", class: "tp-input", placeholder: "Şifre girin (en az 4 karakter)", autocomplete: "new-password" });
  const pw2Inp    = el("input", { type: "password", class: "tp-input", placeholder: "Şifreyi tekrar girin", autocomplete: "new-password" });
  const goBtn     = el("button", { class: "tp-btn tp-btn--primary tp-btn--hidden", type: "button", html: "🔒 PDF'i Kilitle ve İndir" });

  const infoBox = el("div", { class: "tp-info-box", html: `<strong>⚠️ Önemli:</strong> Şifrenizi kaydedin. Dosya kilitlenince şifre olmadan açılamaz. İşlem tarayıcınızda gerçekleşir, sunucuya gönderilmez.` });

  optBox.appendChild(el("label", { class: "tp-label", text: "Şifre" }));
  optBox.appendChild(pwInp);
  optBox.appendChild(el("label", { class: "tp-label", text: "Şifre (Tekrar)" }));
  optBox.appendChild(pw2Inp);

  const onFile = async (file) => {
    const err = validatePdf(file);
    if (err) { window.toast?.(err, "error"); return; }
    currentFile = file;
    thumbWrap.innerHTML = "";
    thumbWrap.classList.remove("tp-single-thumb--hidden");
    thumbWrap.appendChild(createThumbnailEl(file));
    optBox.classList.remove("tp-optbox--hidden");
    goBtn.classList.remove("tp-btn--hidden");
    zone.classList.add("tp-dropzone--compact");
  };

  zone.addEventListener("drop", (e) => { const f = e.dataTransfer?.files?.[0]; if (f) onFile(f); }, true);
  zone.querySelector("input").addEventListener("change", (e) => { const f = e.target.files?.[0]; if (f) onFile(f); });

  goBtn.addEventListener("click", async () => {
    if (!currentFile) return;
    const pw = pwInp.value;
    const pw2 = pw2Inp.value;
    if (!pw || pw.length < 4) { window.toast?.("En az 4 karakter şifre girin.", "error"); return; }
    if (pw !== pw2) { window.toast?.("Şifreler eşleşmiyor.", "error"); return; }
    if (!await doConsumeOrStop("protect")) return;

    goBtn.disabled = true;
    setStatus(status, "PDF kilitleniyor…", "info");
    setProgress(progress, 20);

    try {
      const bytes  = await currentFile.arrayBuffer();
      setProgress(progress, 50, "Şifre uygulanıyor…");
      const result = await runInWorker("protect", { bytes, password: pw }, [bytes]);
      setProgress(progress, 100, "Tamamlandı!");
      hideProgress(progress); hideStatus(status);
      zone.classList.add("tp-dropzone--hidden"); thumbWrap.classList.add("tp-single-thumb--hidden"); optBox.classList.add("tp-optbox--hidden"); goBtn.classList.add("tp-btn--hidden");
      showResultScreen(root, { blob: new Blob([result], { type: "application/pdf" }), filename: sanitizeFilename(currentFile.name.replace(/\.pdf$/i, "") + "-locked.pdf"), label: "Kilitli PDF'i İndir" });
      refreshCreditInfo?.().catch(() => {});
    } catch (e) {
      setStatus(status, "Başarısız: " + e.message, "error");
      hideProgress(progress);
    } finally {
      goBtn.disabled = false;
    }
  });

  root.append(zone, thumbWrap, optBox, infoBox, goBtn);
}

// ─── Tool: Unlock (PDF Kilit Aç) ──────────────────────────────

async function toolUnlock(root, status) {
  const progress = ensureProgress(root);
  let currentFile = null;

  const { zone } = createDropZone({ accept: ".pdf", label: "Kilitli PDF'i sürükleyin" });
  const thumbWrap = el("div", { class: "tp-single-thumb tp-single-thumb--hidden" });
  const optBox    = el("div", { class: "tp-optbox tp-optbox--hidden" });
  const pwInp     = el("input", { type: "password", class: "tp-input", placeholder: "Mevcut şifreyi girin", autocomplete: "current-password" });
  const goBtn     = el("button", { class: "tp-btn tp-btn--primary tp-btn--hidden", type: "button", html: "🔓 Kilidi Aç ve İndir" });

  const infoBox = el("div", { class: "tp-info-box", html: `<strong>ℹ️ Not:</strong> Bu araç yalnızca kullanıcı parolası bilinen PDF'lerin kilidini açar. Sahipsiz şifre kırma desteklenmez.` });

  optBox.appendChild(el("label", { class: "tp-label", text: "PDF Şifresi" }));
  optBox.appendChild(pwInp);

  const onFile = async (file) => {
    const err = validatePdf(file);
    if (err) { window.toast?.(err, "error"); return; }
    currentFile = file;
    thumbWrap.innerHTML = "";
    thumbWrap.classList.remove("tp-single-thumb--hidden");
    thumbWrap.appendChild(createThumbnailEl(file));
    optBox.classList.remove("tp-optbox--hidden");
    goBtn.classList.remove("tp-btn--hidden");
    zone.classList.add("tp-dropzone--compact");
  };

  zone.addEventListener("drop", (e) => { const f = e.dataTransfer?.files?.[0]; if (f) onFile(f); }, true);
  zone.querySelector("input").addEventListener("change", (e) => { const f = e.target.files?.[0]; if (f) onFile(f); });

  goBtn.addEventListener("click", async () => {
    if (!currentFile || !await doConsumeOrStop("unlock")) return;
    const pw = pwInp.value;
    goBtn.disabled = true;
    setStatus(status, "Kilit açılıyor…", "info");
    setProgress(progress, 20);
    try {
      const PDFLib = await loadPdfLib();
      const bytes  = new Uint8Array(await currentFile.arrayBuffer());
      setProgress(progress, 50, "İşleniyor…");
      // Load with password
      let pdf;
      try {
        pdf = await PDFLib.PDFDocument.load(bytes, { password: pw, ignoreEncryption: false });
      } catch (e) {
        if (e.message?.includes("password") || e.message?.includes("encrypted")) {
          setStatus(status, "Hatalı şifre veya bu PDF formatı desteklenmiyor.", "error");
          hideProgress(progress); goBtn.disabled = false; return;
        }
        throw e;
      }
      const outBytes = await pdf.save();
      setProgress(progress, 100, "Tamamlandı!");
      hideProgress(progress); hideStatus(status);
      zone.classList.add("tp-dropzone--hidden"); thumbWrap.classList.add("tp-single-thumb--hidden"); optBox.classList.add("tp-optbox--hidden"); goBtn.classList.add("tp-btn--hidden");
      showResultScreen(root, { blob: new Blob([outBytes], { type: "application/pdf" }), filename: sanitizeFilename(currentFile.name.replace(/\.pdf$/i, "") + "-unlocked.pdf"), label: "Kilidi Açık PDF'i İndir" });
      refreshCreditInfo?.().catch(() => {});
    } catch (e) {
      setStatus(status, "Başarısız: " + e.message, "error");
      hideProgress(progress);
    } finally {
      goBtn.disabled = false;
    }
  });

  root.append(zone, thumbWrap, optBox, infoBox, goBtn);
}

// ─── Tool: Compress (Hibrit) ──────────────────────────────────

async function toolCompress(root, status) {
  const progress = ensureProgress(root);
  let currentFile = null;

  const { zone } = createDropZone({ accept: ".pdf", label: "PDF dosyasını sürükleyin" });
  const thumbWrap = el("div", { class: "tp-single-thumb tp-single-thumb--hidden" });
  const optBox    = el("div", { class: "tp-optbox tp-optbox--hidden" });

  const modeWrap  = el("div", { class: "tp-mode-toggle" });
  const freeModeBtn  = el("button", { class: "tp-mode-btn tp-mode-btn--active", type: "button", html: `<span class="tp-mode-badge">⚡ Ücretsiz</span><span class="tp-mode-title">Hızlı Sıkıştırma</span><span class="tp-mode-sub">Tarayıcıda · Sunucuya gönderilmez</span>` });
  const proModeBtn   = el("button", { class: "tp-mode-btn", type: "button", html: `<span class="tp-mode-badge tp-mode-badge--pro">🔥 Pro</span><span class="tp-mode-title">Güçlü Sıkıştırma</span><span class="tp-mode-sub">Ghostscript · %70'e kadar küçülme</span>` });

  let proMode = false;
  freeModeBtn.addEventListener("click", () => { proMode = false; freeModeBtn.classList.add("tp-mode-btn--active"); proModeBtn.classList.remove("tp-mode-btn--active"); });
  proModeBtn.addEventListener("click",  () => { proMode = true;  proModeBtn.classList.add("tp-mode-btn--active"); freeModeBtn.classList.remove("tp-mode-btn--active"); });

  modeWrap.append(freeModeBtn, proModeBtn);
  optBox.appendChild(modeWrap);

  const proNote = el("p", { class: "tp-note", html: `🔒 Güçlü mod: Dosya yalnızca işlem için sunucuya gönderilir ve 1 saat içinde silinir (KVKK uyumlu).` });
  optBox.appendChild(proNote);

  const goBtn = el("button", { class: "tp-btn tp-btn--primary tp-btn--hidden", type: "button", html: "📦 Sıkıştır ve İndir" });
  let abortCtrl = null;

  const onFile = async (file) => {
    const err = validatePdf(file);
    if (err) { window.toast?.(err, "error"); return; }
    if (!await checkPdfMagic(file)) { window.toast?.("Geçerli bir PDF değil.", "error"); return; }
    currentFile = file;
    thumbWrap.innerHTML = "";
    thumbWrap.classList.remove("tp-single-thumb--hidden");
    thumbWrap.appendChild(createThumbnailEl(file));
    optBox.classList.remove("tp-optbox--hidden");
    goBtn.classList.remove("tp-btn--hidden");
    zone.classList.add("tp-dropzone--compact");
  };

  zone.addEventListener("drop", (e) => { const f = e.dataTransfer?.files?.[0]; if (f) onFile(f); }, true);
  zone.querySelector("input").addEventListener("change", (e) => { const f = e.target.files?.[0]; if (f) onFile(f); });

  goBtn.addEventListener("click", async () => {
    if (!currentFile) return;
    goBtn.disabled = true;
    abortCtrl = new AbortController();

    if (!proMode) {
      // Free: client-side
      setStatus(status, "Sıkıştırılıyor…", "info");
      setProgress(progress, 30, "PDF optimizasyonu…");
      try {
        const PDFLib   = await loadPdfLib();
        const origSize = currentFile.size;
        const pdf      = await PDFLib.PDFDocument.load(new Uint8Array(await currentFile.arrayBuffer()), { ignoreEncryption: true });
        setProgress(progress, 70, "Kaydediliyor…");
        const outBytes = await pdf.save({ useObjectStreams: true, addDefaultPage: false });
        setProgress(progress, 100, "Tamamlandı!");
        const blob = new Blob([outBytes], { type: "application/pdf" });
        hideProgress(progress); hideStatus(status);
        zone.classList.add("tp-dropzone--hidden"); thumbWrap.classList.add("tp-single-thumb--hidden"); optBox.classList.add("tp-optbox--hidden"); goBtn.classList.add("tp-btn--hidden");
        showResultScreen(root, {
          blob,
          filename: sanitizeFilename(currentFile.name.replace(/\.pdf$/i, "") + "-compressed.pdf"),
          label: "Sıkıştırılmış PDF İndir",
          sizeOriginal: origSize,
          sizeFinal: outBytes.length,
        });
        refreshCreditInfo?.().catch(() => {});
      } catch (e) {
        setStatus(status, "Başarısız: " + e.message, "error");
        hideProgress(progress);
      } finally {
        goBtn.disabled = false;
      }
    } else {
      // Pro: server-side
      // (server-side tool) credit consumed on upload endpoint
setStatus(status, "Dosya gönderiliyor…", "info");
      setProgress(progress, 10, "Yükleniyor…");
      try {
        const origSize = currentFile.size;
        const { httpStatus, data } = await submitProJob("compress-strong", currentFile, { level: "recommended" });
        if (!data.ok) {
          if (httpStatus === 402) openPaywall?.({ reason: "credits" });
          setStatus(status, data?.error?.message || "Görev gönderilemedi.", "error");
          hideProgress(progress); goBtn.disabled = false; return;
        }
        const jobId = data.data?.jobId;
        if (!jobId) { setStatus(status, "Job ID alınamadı.", "error"); goBtn.disabled = false; return; }

        setProgress(progress, 20, "Sunucuda işleniyor…");
        const result = await pollJobStatus(jobId, (p) => {
          const pct = p.progress != null ? Math.round(p.progress) : 0;
          const eta = p.elapsedMs > 5000 ? ` · ~${formatEta((p.elapsedMs / Math.max(1, pct)) * (100 - pct))}` : "";
          setProgress(progress, 20 + pct * 0.7, (p.stage || "İşleniyor…") + eta);
          setStatus(status, p.stage || "Sunucuda sıkıştırılıyor…", "info");
        }, abortCtrl.signal);

        if (!result.ok) { setStatus(status, result.message, "error"); hideProgress(progress); goBtn.disabled = false; return; }

        setProgress(progress, 95, "Sonuç indiriliyor…");
        const blob  = await downloadJobResult(jobId);
        setProgress(progress, 100, "Tamamlandı!");
        hideProgress(progress); hideStatus(status);
        zone.classList.add("tp-dropzone--hidden"); thumbWrap.classList.add("tp-single-thumb--hidden"); optBox.classList.add("tp-optbox--hidden"); goBtn.classList.add("tp-btn--hidden");
        showResultScreen(root, {
          blob,
          filename: sanitizeFilename(currentFile.name.replace(/\.pdf$/i, "") + "-strong.pdf"),
          label: "Sıkıştırılmış PDF İndir",
          sizeOriginal: origSize,
          sizeFinal: blob.size,
        });
        refreshCreditInfo?.().catch(() => {});
      } catch (e) {
        if (e.message === "İptal edildi.") setStatus(status, "İptal edildi.", "info");
        else { setStatus(status, "Başarısız: " + e.message, "error"); }
        hideProgress(progress);
      } finally {
        goBtn.disabled = false;
        abortCtrl = null;
      }
    }
  });

  root.append(zone, thumbWrap, optBox, goBtn);
}

// ─── Tool: PDF → Word ─────────────────────────────────────────

async function toolPdfToWord(root, status) {
  const progress = ensureProgress(root);
  let currentFile = null;
  let abortCtrl   = null;

  const { zone } = createDropZone({ accept: ".pdf", label: "PDF dosyasını sürükleyin" });
  const thumbWrap = el("div", { class: "tp-single-thumb tp-single-thumb--hidden" });
  const goBtn     = el("button", { class: "tp-btn tp-btn--primary tp-btn--hidden", type: "button", html: "📄 Word'e Dönüştür (Sunucu)" });
  const note      = el("p", { class: "tp-note", html: `🔒 İşlem sunucuda yapılır, dosya 1 saat içinde silinir (KVKK uyumlu).` });

  const onFile = async (file) => {
    const err = validatePdf(file);
    if (err) { window.toast?.(err, "error"); return; }
    if (!await checkPdfMagic(file)) { window.toast?.("Geçerli bir PDF değil.", "error"); return; }
    currentFile = file;
    thumbWrap.innerHTML = "";
    thumbWrap.classList.remove("tp-single-thumb--hidden");
    thumbWrap.appendChild(createThumbnailEl(file));
    goBtn.classList.remove("tp-btn--hidden");
    zone.classList.add("tp-dropzone--compact");
  };

  zone.addEventListener("drop", (e) => { const f = e.dataTransfer?.files?.[0]; if (f) onFile(f); }, true);
  zone.querySelector("input").addEventListener("change", (e) => { const f = e.target.files?.[0]; if (f) onFile(f); });

  goBtn.addEventListener("click", async () => {
    if (!currentFile) return;
goBtn.disabled = true;
    abortCtrl = new AbortController();
    setStatus(status, "Dosya gönderiliyor…", "info");
    setProgress(progress, 10, "Yükleniyor…");
    try {
      const { httpStatus, data } = await submitProJob("pdf-to-word", currentFile, { format: "docx" });
      if (!data.ok) {
        if (httpStatus === 402) openPaywall?.({ reason: "credits" });
        setStatus(status, data?.error?.message || "Görev gönderilemedi.", "error");
        hideProgress(progress); goBtn.disabled = false; return;
      }
      const jobId = data.data?.jobId;
      if (!jobId) { setStatus(status, "Job ID alınamadı.", "error"); goBtn.disabled = false; return; }

      setProgress(progress, 20, "Sunucuda dönüştürülüyor…");
      const result = await pollJobStatus(jobId, (p) => {
        const pct = p.progress != null ? Math.round(p.progress) : 0;
        setProgress(progress, 20 + pct * 0.7, p.stage || "Dönüştürülüyor…");
        setStatus(status, p.stage || "Sunucuda işleniyor…", "info");
      }, abortCtrl.signal);

      if (!result.ok) { setStatus(status, result.message, "error"); hideProgress(progress); goBtn.disabled = false; return; }

      setProgress(progress, 95, "Sonuç indiriliyor…");
      const blob = await downloadJobResult(jobId);
      setProgress(progress, 100, "Tamamlandı!");
      hideProgress(progress); hideStatus(status);
      zone.classList.add("tp-dropzone--hidden"); thumbWrap.classList.add("tp-single-thumb--hidden"); goBtn.classList.add("tp-btn--hidden");
      showResultScreen(root, { blob, filename: sanitizeFilename(currentFile.name.replace(/\.pdf$/i, "") + ".docx"), label: "Word Dosyasını İndir" });
      refreshCreditInfo?.().catch(() => {});
    } catch (e) {
      if (e.message === "İptal edildi.") setStatus(status, "İptal edildi.", "info");
      else setStatus(status, "Başarısız: " + e.message, "error");
      hideProgress(progress);
    } finally {
      goBtn.disabled = false;
      abortCtrl = null;
    }
  });

  root.append(zone, thumbWrap, note, goBtn);
}

// ─── Tool: OCR ────────────────────────────────────────────────

async function toolOcr(root, status) {
  const progress = ensureProgress(root);
  let currentFile = null;
  let abortCtrl   = null;

  const { zone } = createDropZone({ accept: ".pdf", label: "PDF dosyasını sürükleyin" });
  const thumbWrap = el("div", { class: "tp-single-thumb tp-single-thumb--hidden" });
  const optBox    = el("div", { class: "tp-optbox tp-optbox--hidden" });
  const langSel   = el("select", { class: "tp-select" }, [
    el("option", { value: "tur+eng", text: "Türkçe + İngilizce" }),
    el("option", { value: "tur", text: "Sadece Türkçe" }),
    el("option", { value: "eng", text: "Sadece İngilizce" }),
  ]);
  const goBtn = el("button", { class: "tp-btn tp-btn--primary tp-btn--hidden", type: "button", html: "🔍 Metin Tanı (Sunucu)" });
  const note  = el("p", { class: "tp-note", html: `🔒 İşlem sunucuda yapılır (Tesseract), dosya 1 saat içinde silinir.` });

  optBox.appendChild(el("label", { class: "tp-label", text: "OCR Dili" }));
  optBox.appendChild(langSel);

  const onFile = async (file) => {
    const err = validatePdf(file);
    if (err) { window.toast?.(err, "error"); return; }
    if (!await checkPdfMagic(file)) { window.toast?.("Geçerli bir PDF değil.", "error"); return; }
    currentFile = file;
    thumbWrap.innerHTML = "";
    thumbWrap.classList.remove("tp-single-thumb--hidden");
    thumbWrap.appendChild(createThumbnailEl(file));
    optBox.classList.remove("tp-optbox--hidden");
    goBtn.classList.remove("tp-btn--hidden");
    zone.classList.add("tp-dropzone--compact");
  };

  zone.addEventListener("drop", (e) => { const f = e.dataTransfer?.files?.[0]; if (f) onFile(f); }, true);
  zone.querySelector("input").addEventListener("change", (e) => { const f = e.target.files?.[0]; if (f) onFile(f); });

  goBtn.addEventListener("click", async () => {
    if (!currentFile) return;
goBtn.disabled = true;
    abortCtrl = new AbortController();
    setStatus(status, "Dosya gönderiliyor…", "info");
    setProgress(progress, 10);
    try {
      const { httpStatus, data } = await submitProJob("ocr", currentFile, { lang: langSel.value });
      if (!data.ok) {
        if (httpStatus === 402) openPaywall?.({ reason: "credits" });
        setStatus(status, data?.error?.message || "Görev gönderilemedi.", "error");
        hideProgress(progress); goBtn.disabled = false; return;
      }
      const jobId = data.data?.jobId;
      if (!jobId) { setStatus(status, "Job ID alınamadı.", "error"); goBtn.disabled = false; return; }

      setProgress(progress, 20, "OCR yapılıyor…");
      const result = await pollJobStatus(jobId, (p) => {
        const pct = p.progress != null ? Math.round(p.progress) : 0;
        setProgress(progress, 20 + pct * 0.7, p.stage || "Metin tanınıyor…");
        setStatus(status, p.stage || "Sunucuda OCR…", "info");
      }, abortCtrl.signal);

      if (!result.ok) { setStatus(status, result.message, "error"); hideProgress(progress); goBtn.disabled = false; return; }

      setProgress(progress, 95, "Sonuç indiriliyor…");
      const blob = await downloadJobResult(jobId);
      setProgress(progress, 100, "Tamamlandı!");
      hideProgress(progress); hideStatus(status);
      zone.classList.add("tp-dropzone--hidden"); thumbWrap.classList.add("tp-single-thumb--hidden"); optBox.classList.add("tp-optbox--hidden"); goBtn.classList.add("tp-btn--hidden");
      showResultScreen(root, { blob, filename: sanitizeFilename(currentFile.name.replace(/\.pdf$/i, "") + ".txt"), label: "Metin Dosyasını İndir" });
      refreshCreditInfo?.().catch(() => {});
    } catch (e) {
      if (e.message === "İptal edildi.") setStatus(status, "İptal edildi.", "info");
      else setStatus(status, "Başarısız: " + e.message, "error");
      hideProgress(progress);
    } finally {
      goBtn.disabled = false;
      abortCtrl = null;
    }
  });

  root.append(zone, thumbWrap, optBox, note, goBtn);
}

// ─── Tool: JPG → PDF ─────────────────────────────────────────

async function toolJpgToPdf(root, status) {
  const progress = ensureProgress(root);
  const { zone, inp } = createDropZone({
    accept: "image/jpeg,image/png",
    multiple: true,
    label: "JPG veya PNG dosyalarını sürükleyin",
    sublabel: "veya tıklayarak birden fazla görsel seçin",
    icon: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`,
  });
  const thumbGrid = el("div", { class: "tp-thumb-grid tp-thumb-grid--hidden" });
  const goBtn     = el("button", { class: "tp-btn tp-btn--primary tp-btn--hidden", type: "button", html: "🖼️ PDF Oluştur ve İndir" });

  let fileList = [];

  const addFiles = (files) => {
    for (const f of files) {
      const err = validateImage(f);
      if (err) { window.toast?.(err, "error"); continue; }
      fileList.push(f);
    }
    refresh();
  };

  const refresh = () => {
    thumbGrid.innerHTML = "";
    if (!fileList.length) { thumbGrid.classList.add("tp-thumb-grid--hidden"); goBtn.classList.add("tp-btn--hidden"); return; }
    thumbGrid.classList.remove("tp-thumb-grid--hidden");
    goBtn.classList.remove("tp-btn--hidden");
    fileList.forEach((f, i) => {
      const thumb = el("div", { class: "tp-thumb" });
      const img   = document.createElement("img");
      img.className = "tp-thumb__canvas";
      img.style.objectFit = "cover";
      img.src = URL.createObjectURL(f);
      const nameEl    = el("div", { class: "tp-thumb__name", text: f.name });
      const removeBtn = el("button", { class: "tp-thumb__remove", type: "button", "aria-label": "Kaldır", text: "×" });
      removeBtn.addEventListener("click", () => { URL.revokeObjectURL(img.src); fileList.splice(i, 1); refresh(); });
      thumb.append(img, nameEl, removeBtn);
      thumbGrid.appendChild(thumb);
    });
  };

  inp.addEventListener("change", () => addFiles([...(inp.files || [])]));
  zone.addEventListener("drop", (e) => { e.preventDefault(); zone.classList.remove("tp-dropzone--over"); addFiles([...(e.dataTransfer?.files || [])]); }, true);

  goBtn.addEventListener("click", async () => {
    if (!fileList.length || !await doConsumeOrStop("convert")) return;
    goBtn.disabled = true;
    setStatus(status, "PDF oluşturuluyor…", "info");
    setProgress(progress, 10);
    try {
      const buffers = await Promise.all(fileList.map(f => f.arrayBuffer()));
      setProgress(progress, 50, "Görseller ekleniyor…");
      const result = await runInWorker("jpgToPdf", { imageBuffers: buffers }, buffers);
      setProgress(progress, 100, "Tamamlandı!");
      hideProgress(progress); hideStatus(status);
      zone.classList.add("tp-dropzone--hidden"); thumbGrid.classList.add("tp-thumb-grid--hidden"); goBtn.classList.add("tp-btn--hidden");
      showResultScreen(root, { blob: new Blob([result], { type: "application/pdf" }), filename: "images.pdf", label: "PDF'i İndir" });
      refreshCreditInfo?.().catch(() => {});
    } catch (e) {
      setStatus(status, "Başarısız: " + e.message, "error");
      hideProgress(progress);
    } finally {
      goBtn.disabled = false;
    }
  });

  root.append(zone, thumbGrid, goBtn);
}

// ─── Tool: PDF → JPG ─────────────────────────────────────────

async function toolPdfToJpg(root, status) {
  const progress = ensureProgress(root);
  let currentFile = null;

  const { zone } = createDropZone({ accept: ".pdf", label: "PDF dosyasını sürükleyin" });
  const thumbWrap = el("div", { class: "tp-single-thumb tp-single-thumb--hidden" });
  const goBtn     = el("button", { class: "tp-btn tp-btn--primary tp-btn--hidden", type: "button", html: "🖼️ Tüm Sayfaları JPG Yap (ZIP)" });

  const onFile = async (file) => {
    const err = validatePdf(file);
    if (err) { window.toast?.(err, "error"); return; }
    if (!await checkPdfMagic(file)) { window.toast?.("Geçerli bir PDF değil.", "error"); return; }
    currentFile = file;
    thumbWrap.innerHTML = "";
    thumbWrap.classList.remove("tp-single-thumb--hidden");
    thumbWrap.appendChild(createThumbnailEl(file));
    goBtn.classList.remove("tp-btn--hidden");
    zone.classList.add("tp-dropzone--compact");
  };

  zone.addEventListener("drop", (e) => { const f = e.dataTransfer?.files?.[0]; if (f) onFile(f); }, true);
  zone.querySelector("input").addEventListener("change", (e) => { const f = e.target.files?.[0]; if (f) onFile(f); });

  goBtn.addEventListener("click", async () => {
    if (!currentFile || !await doConsumeOrStop("convert")) return;
    goBtn.disabled = true;
    setProgress(progress, 5, "pdf.js yükleniyor…");
    setStatus(status, "Hazırlanıyor…", "info");
    try {
      const pdfjs = await loadPdfJs();
      await loadScriptOnce(JSZIP_CDN, "JSZip");
      const doc = await pdfjs.getDocument({ data: await currentFile.arrayBuffer() }).promise;
      const total = doc.numPages;
      const zip   = new window.JSZip();

      for (let i = 1; i <= total; i++) {
        setProgress(progress, Math.round(5 + (i / total) * 85), `Sayfa ${i}/${total}…`);
        const page = await doc.getPage(i);
        const vp   = page.getViewport({ scale: 2 });
        const cv   = document.createElement("canvas");
        cv.width = Math.floor(vp.width); cv.height = Math.floor(vp.height);
        await page.render({ canvasContext: cv.getContext("2d"), viewport: vp }).promise;
        const bin = await fetch(cv.toDataURL("image/jpeg", 0.92)).then(r => r.arrayBuffer());
        zip.file(`page-${String(i).padStart(3, "0")}.jpg`, bin);
      }

      setProgress(progress, 95, "ZIP hazırlanıyor…");
      const blob = await zip.generateAsync({ type: "blob" });
      setProgress(progress, 100, "Tamamlandı!");
      hideProgress(progress); hideStatus(status);
      zone.classList.add("tp-dropzone--hidden"); thumbWrap.classList.add("tp-single-thumb--hidden"); goBtn.classList.add("tp-btn--hidden");
      showResultScreen(root, { blob, filename: sanitizeFilename(currentFile.name.replace(/\.pdf$/i, "")) + "-jpg.zip", label: "ZIP İndir (JPG'ler)" });
      refreshCreditInfo?.().catch(() => {});
    } catch (e) {
      setStatus(status, "Başarısız: " + e.message, "error");
      hideProgress(progress);
    } finally {
      goBtn.disabled = false;
    }
  });

  root.append(zone, thumbWrap, goBtn);
}

// ─── Tool: Watermark ──────────────────────────────────────────

async function toolWatermark(root, status) {
  const variant = toolVariant();
  const progress = ensureProgress(root);
  let currentFile = null;

  const { zone } = createDropZone({ accept: ".pdf", label: "PDF dosyasını sürükleyin" });
  const thumbWrap = el("div", { class: "tp-single-thumb tp-single-thumb--hidden" });
  const optBox    = el("div", { class: "tp-optbox tp-optbox--hidden" });

  const textInp = el("input", { type: "text", class: "tp-input", placeholder: "Filigran metni (örn: ÖRNEK, GİZLİ)" });
  const qrInp   = el("input", { type: "text", class: "tp-input", placeholder: "QR içeriği (URL veya metin)" });
  const pos     = el("select", { class: "tp-select" }, [
    el("option", { value: "br", text: "Sağ Alt Köşe" }),
    el("option", { value: "bl", text: "Sol Alt Köşe" }),
    el("option", { value: "tr", text: "Sağ Üst Köşe" }),
    el("option", { value: "tl", text: "Sol Üst Köşe" }),
  ]);

  if (variant === "qr") {
    optBox.appendChild(el("label", { class: "tp-label", text: "QR Kodu İçeriği" }));
    optBox.appendChild(qrInp);
    optBox.appendChild(el("label", { class: "tp-label", text: "Konum" }));
    optBox.appendChild(pos);
    loadScriptOnce(QRCODE_CDN, "QRCode").catch(() => {});
  } else {
    optBox.appendChild(el("label", { class: "tp-label", text: "Filigran Metni" }));
    optBox.appendChild(textInp);
  }

  const goBtn = el("button", { class: "tp-btn tp-btn--primary tp-btn--hidden", type: "button", html: variant === "qr" ? "📷 QR Ekle ve İndir" : "💧 Filigran Ekle ve İndir" });

  const onFile = async (file) => {
    const err = validatePdf(file);
    if (err) { window.toast?.(err, "error"); return; }
    currentFile = file;
    thumbWrap.innerHTML = "";
    thumbWrap.classList.remove("tp-single-thumb--hidden");
    thumbWrap.appendChild(createThumbnailEl(file));
    optBox.classList.remove("tp-optbox--hidden");
    goBtn.classList.remove("tp-btn--hidden");
    zone.classList.add("tp-dropzone--compact");
  };

  zone.addEventListener("drop", (e) => { const f = e.dataTransfer?.files?.[0]; if (f) onFile(f); }, true);
  zone.querySelector("input").addEventListener("change", (e) => { const f = e.target.files?.[0]; if (f) onFile(f); });

  goBtn.addEventListener("click", async () => {
    if (!currentFile || !await doConsumeOrStop("watermark")) return;
    goBtn.disabled = true;
    setStatus(status, "Ekleniyor…", "info");
    setProgress(progress, 20);
    try {
      const PDFLib = await loadPdfLib();
      const bytes  = new Uint8Array(await currentFile.arrayBuffer());
      const pdf    = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
      const pages  = pdf.getPages();
      setProgress(progress, 50, "Sayfalar işleniyor…");

      if (variant === "qr" && window.QRCode) {
        const qrContent = (qrInp.value || location.href).trim();
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 120;
        await new Promise((res, rej) => {
          try {
            new window.QRCode(canvas, { text: qrContent, width: 120, height: 120, correctLevel: window.QRCode.CorrectLevel.M });
            setTimeout(res, 300);
          } catch (e) { rej(e); }
        });
        const pngData = await fetch(canvas.toDataURL("image/png")).then(r => r.arrayBuffer());
        const img = await pdf.embedPng(new Uint8Array(pngData));
        const dim = 80, margin = 20;
        for (const p of pages) {
          const { width, height } = p.getSize();
          const posMap = { br: { x: width-dim-margin, y: margin }, bl: { x: margin, y: margin }, tr: { x: width-dim-margin, y: height-dim-margin }, tl: { x: margin, y: height-dim-margin } };
          const { x, y } = posMap[pos.value] || posMap.br;
          p.drawImage(img, { x, y, width: dim, height: dim });
        }
      } else {
        const font = await pdf.embedFont(PDFLib.StandardFonts.HelveticaBold);
        const wm   = (textInp.value || "MirPDF").slice(0, 80);
        for (const p of pages) {
          const { width, height } = p.getSize();
          p.drawText(wm, { x: 40, y: height / 2, size: 36, font, rotate: PDFLib.degrees(35), opacity: 0.15 });
        }
      }

      const outBytes = await pdf.save();
      setProgress(progress, 100, "Tamamlandı!");
      hideProgress(progress); hideStatus(status);
      zone.classList.add("tp-dropzone--hidden"); thumbWrap.classList.add("tp-single-thumb--hidden"); optBox.classList.add("tp-optbox--hidden"); goBtn.classList.add("tp-btn--hidden");
      showResultScreen(root, { blob: new Blob([outBytes], { type: "application/pdf" }), filename: "watermarked.pdf", label: "Filigran Ekli PDF İndir" });
      refreshCreditInfo?.().catch(() => {});
    } catch (e) {
      setStatus(status, "Başarısız: " + e.message, "error");
      hideProgress(progress);
    } finally {
      goBtn.disabled = false;
    }
  });

  root.append(zone, thumbWrap, optBox, goBtn);
}

// ─── Tool: Reorder ────────────────────────────────────────────

async function toolReorder(root, status) {
  const progress = ensureProgress(root);
  let currentFile = null;

  const { zone } = createDropZone({ accept: ".pdf", label: "PDF dosyasını sürükleyin" });
  const thumbWrap = el("div", { class: "tp-single-thumb tp-single-thumb--hidden" });
  const optBox    = el("div", { class: "tp-optbox tp-optbox--hidden" });
  const orderInp  = el("input", { type: "text", class: "tp-input", placeholder: "Yeni sıra (örn: 3,1,2,4)" });
  const goBtn     = el("button", { class: "tp-btn tp-btn--primary tp-btn--hidden", type: "button", html: "🔀 Yeniden Sırala ve İndir" });

  optBox.appendChild(el("label", { class: "tp-label", text: "Sayfa Sırası (virgülle ayır)" }));
  optBox.appendChild(orderInp);

  const onFile = async (file) => {
    const err = validatePdf(file);
    if (err) { window.toast?.(err, "error"); return; }
    currentFile = file;
    thumbWrap.innerHTML = "";
    thumbWrap.classList.remove("tp-single-thumb--hidden");
    thumbWrap.appendChild(createThumbnailEl(file));
    optBox.classList.remove("tp-optbox--hidden");
    goBtn.classList.remove("tp-btn--hidden");
    zone.classList.add("tp-dropzone--compact");
  };

  zone.addEventListener("drop", (e) => { const f = e.dataTransfer?.files?.[0]; if (f) onFile(f); }, true);
  zone.querySelector("input").addEventListener("change", (e) => { const f = e.target.files?.[0]; if (f) onFile(f); });

  goBtn.addEventListener("click", async () => {
    if (!currentFile || !await doConsumeOrStop("reorder")) return;
    goBtn.disabled = true;
    setStatus(status, "Sıralanıyor…", "info");
    setProgress(progress, 20);
    try {
      const PDFLib = await loadPdfLib();
      const buf    = await currentFile.arrayBuffer();
      const src    = await PDFLib.PDFDocument.load(new Uint8Array(buf), { ignoreEncryption: true });
      const max    = src.getPageCount();
      const nums   = (orderInp.value || "")
        .split(",")
        .map(s => +s.trim())
        .filter(n => Number.isInteger(n) && n >= 1 && n <= max);
      if (!nums.length) { setStatus(status, `Geçerli sıra girin (1-${max}).`, "error"); goBtn.disabled=false; hideProgress(progress); return; }
      setProgress(progress, 50, "Sayfalar yeniden düzenleniyor…");
      const bytes  = await currentFile.arrayBuffer();
      const result = await runInWorker("reorder", { bytes, newOrder: nums.map(n => n - 1) }, [bytes]);
      setProgress(progress, 100, "Tamamlandı!");
      hideProgress(progress); hideStatus(status);
      zone.classList.add("tp-dropzone--hidden"); thumbWrap.classList.add("tp-single-thumb--hidden"); optBox.classList.add("tp-optbox--hidden"); goBtn.classList.add("tp-btn--hidden");
      showResultScreen(root, { blob: new Blob([result], { type: "application/pdf" }), filename: "reordered.pdf", label: "Yeni Sıralı PDF İndir" });
      refreshCreditInfo?.().catch(() => {});
    } catch (e) {
      setStatus(status, "Başarısız: " + e.message, "error");
      hideProgress(progress);
    } finally {
      goBtn.disabled = false;
    }
  });

  root.append(zone, thumbWrap, optBox, goBtn);
}

// ─── FAQ Schema ───────────────────────────────────────────────

const TOOL_FAQ = {
  compress: [
    ["PDF sıkıştırma kaliteyi bozar mı?", "Orta seviye sıkıştırmada minimal kayıp olur. Güçlü sıkıştırmada görseller biraz netlik kaybedebilir."],
    ["Dosyalarım sunucuya gönderilir mi?", "Ücretsiz (hızlı) modda hayır, tarayıcıda işlenir. Pro modda yalnızca işlem için gönderilir ve 1 saat içinde silinir."],
    ["Outlook için PDF boyutu kaç MB olmalı?", "Outlook 25MB sınırı koyar. PDF'inizi sıkıştırarak 10-15MB altına indirmenizi öneririz."],
  ],
  "pdf-to-word": [
    ["PDF Word'e çevrilince format bozulur mu?", "Metin tabanlı PDF'lerde sonuç iyidir. Tarama PDF'lerde OCR gerekebilir."],
    ["Türkçe içerik destekleniyor mu?", "Evet, Türkçe dahil tüm diller desteklenir."],
    ["Dosyam ne kadar süre saklanır?", "1 saat içinde otomatik olarak silinir, KVKK uyumludur."],
  ],
  ocr: [
    ["OCR nedir?", "Görüntü tabanlı PDF'lerdeki yazıları makine tarafından okunabilir metne çevirir."],
    ["Türkçe OCR desteği var mı?", "Evet. Tesseract ile Türkçe+İngilizce desteklenir."],
    ["Neden eksik metin çıkıyor?", "Düşük çözünürlük, eğik sayfa veya çok sıkıştırılmış taramalar OCR kalitesini etkiler."],
  ],
  merge: [
    ["Kaç PDF birleştirebilirim?", "Pratik olarak sınırsız, ancak toplam boyut 50MB'ı geçmemeli."],
    ["Sayfa sırası değiştirilebilir mi?", "Evet, dosyaları ekledikten sonra sırayı değiştirebilirsiniz."],
    ["Ücretsiz mi?", "Evet, temel kullanım için ücretsizdir."],
  ],
  split: [
    ["Tek bir sayfayı çıkarabilir miyim?", "Evet. '5' yazarak 5. sayfayı ayrı PDF olarak alabilirsiniz."],
    ["Sayfa aralığı nasıl girilir?", "'1-3,5,7' biçiminde: 1'den 3'e, 5. ve 7. sayfalar."],
    ["Kalite düşer mi?", "Hayır. Sayfalar yeniden kodlanmadan ayrılır."],
  ],
  protect: [
    ["Şifrem kaybolursa ne olur?", "Şifreli PDF'i açamaz hale gelirsiniz. Şifrenizi güvenli bir yerde saklayın."],
    ["Her PDF şifrelenebilir mi?", "Evet, tüm PDF sürümleri desteklenir."],
    ["Dosyam sunucuya gönderilir mi?", "Hayır. Şifreleme tamamen tarayıcınızda gerçekleşir."],
  ],
  unlock: [
    ["Şifremi bilmeden kilit açılabilir mi?", "Hayır. Yalnızca bilinen şifre ile kilit açılabilir."],
    ["Her tür kilitli PDF açılabilir mi?", "Kullanıcı şifresi bilinen PDF'ler açılabilir."],
  ],
};

function injectFaqSchema(tool) {
  const faqs = TOOL_FAQ[tool];
  if (!faqs?.length) return;
  if (document.querySelector('script[data-faq-schema="1"]')) return;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map(([q, a]) => ({
      "@type": "Question",
      name: q,
      acceptedAnswer: { "@type": "Answer", text: a },
    })),
  };
  const s = document.createElement("script");
  s.type = "application/ld+json";
  s.setAttribute("data-faq-schema", "1");
  s.textContent = JSON.stringify(jsonLd);
  document.head.appendChild(s);
}

// ─── Trust Widget ──────────────────────────────────────────────

function renderTrustWidget(root, tool) {
  if (root.querySelector(".tp-trust")) return;

  const RELATED = {
    compress:     [{ href: "/articles/pdf-kucultme-outlook-icin.html", label: "Outlook için PDF Küçültme" }, { href: "/articles/pdf-sikistirma.html", label: "PDF Sıkıştırma Rehberi" }],
    merge:        [{ href: "/articles/pdf-birlestirme-mobil.html", label: "Telefonda PDF Birleştirme" }],
    "jpg-to-pdf": [{ href: "/articles/jpg-pdf-yapma-ucretsiz.html", label: "JPG → PDF Ücretsiz Rehber" }],
    "pdf-to-word":[{ href: "/articles/telefonda-word-pdf-yapma.html", label: "Telefonda Word → PDF" }],
    ocr:          [{ href: "/articles/kvkk-uyumlu-pdf-araci.html", label: "KVKK Uyumlu PDF Aracı" }],
    protect:      [{ href: "/articles/pdf-sifreleme.html", label: "PDF Şifreleme Rehberi" }],
  };

  const links = RELATED[tool] || [];
  const trust = el("section", { class: "tp-trust" });
  trust.innerHTML = `
    <div class="tp-trust__row">
      <div class="tp-trust__text">
        <div class="tp-trust__title">🔒 Gizlilik & Güven</div>
        <div class="tp-trust__desc">Dosyalar yalnızca işlem için kullanılır ve otomatik silinir. Kurumsal kullanım için KVKK uyumlu belgeler hazır.</div>
        <div class="tp-trust__actions">
          <a class="tp-trust__link" href="/legal/kvkk.html">KVKK</a>
          <a class="tp-trust__link" href="/legal/security.html">Güvenlik</a>
          <a class="tp-trust__link" href="/legal/dpa.html">DPA</a>
          <a class="tp-trust__link" href="/kurumsal/">Kurumsal</a>
        </div>
      </div>
      ${links.length ? `<div class="tp-trust__links">
        <div class="tp-trust__links-title">İlgili Rehberler</div>
        ${links.map(l => `<a href="${l.href}" class="tp-trust__lnk">${l.label}</a>`).join("")}
      </div>` : ""}
    </div>
  `;
  root.appendChild(trust);
}

// ─── Main ──────────────────────────────────────────────────────

function main() {
  initExitIntent();
  const tool = detectToolFromPage();
  if (!tool) return; // Not a tool page

  const root = $("#tool-app") || $("#app") || document.querySelector("main > .container") || document.body;

  // Inject status node at top of root
  const status = ensureStatus(root);

  // FAQ schema
  injectFaqSchema(tool);

  // Run tool
  let runPromise;
  switch (tool) {
    case "merge":        runPromise = toolMerge(root, status);       break;
    case "split":        runPromise = toolSplit(root, status);        break;
    case "rotate":       runPromise = toolRotate(root, status);       break;
    case "extract":      runPromise = toolExtract(root, status);      break;
    case "reorder":      runPromise = toolReorder(root, status);      break;
    case "watermark":    runPromise = toolWatermark(root, status);    break;
    case "protect":      runPromise = toolProtect(root, status);      break;
    case "unlock":       runPromise = toolUnlock(root, status);       break;
    case "jpg-to-pdf":   runPromise = toolJpgToPdf(root, status);    break;
    case "pdf-to-jpg":   runPromise = toolPdfToJpg(root, status);    break;
    case "compress":     runPromise = toolCompress(root, status);     break;
    case "pdf-to-word":  runPromise = toolPdfToWord(root, status);   break;
    case "ocr":          runPromise = toolOcr(root, status);          break;
    default:
      setStatus(status, `"${tool}" aracı yakında aktif olacak.`, "info");
      runPromise = Promise.resolve();
  }

  Promise.resolve(runPromise)
    .catch((e) => {
      console.error("[tool-page main]", e);
      window.toast?.("Bir hata oluştu. Lütfen sayfayı yenileyin.", "error");
    })
    .finally(() => {
      renderTrustWidget(root, tool);
    });
}

// Boot
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main, { once: true });
} else {
  main();
}