/**
 * MirPDF — Ortak İstemci Motoru (VPS gerektirmez)
 * PDF.js thumbnail + pdf-lib işlemler için paylaşılan yardımcılar
 */

// ── CDN Sabitleri ────────────────────────────────────────────────
export const PDFJS_CDN  = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
export const PDFJS_WORK = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
export const PDFLIB_CDN = 'https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js';

// ── Lazy Loaders ────────────────────────────────────────────────
let _pdfjsPromise = null;
export async function loadPdfJs() {
  if (window.pdfjsLib) return window.pdfjsLib;
  if (!_pdfjsPromise) {
    _pdfjsPromise = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = PDFJS_CDN; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    }).then(() => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORK;
      return window.pdfjsLib;
    });
  }
  return _pdfjsPromise;
}

let _pdflibPromise = null;
export async function loadPdfLib() {
  if (window.PDFLib) return window.PDFLib;
  if (!_pdflibPromise) {
    _pdflibPromise = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = PDFLIB_CDN; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    }).then(() => window.PDFLib);
  }
  return _pdflibPromise;
}

// ── Thumbnail Renderer ──────────────────────────────────────────
export async function renderThumb(fileOrAB, canvas, pageNum = 1) {
  try {
    const pdfjs = await loadPdfJs();
    const ab = fileOrAB instanceof ArrayBuffer ? fileOrAB : await fileOrAB.arrayBuffer();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(ab) }).promise;
    const pg  = await doc.getPage(Math.min(pageNum, doc.numPages));
    const vp  = pg.getViewport({ scale: 1 });
    const sc  = Math.min(canvas.width / vp.width, canvas.height / vp.height);
    const vp2 = pg.getViewport({ scale: sc });
    canvas.width  = Math.round(vp2.width);
    canvas.height = Math.round(vp2.height);
    await pg.render({ canvasContext: canvas.getContext('2d'), viewport: vp2 }).promise;
    const n = doc.numPages;
    await doc.destroy();
    return n;
  } catch { return 0; }
}

// ── Dosya Boyutu Biçimi ─────────────────────────────────────────
export function fmtSize(b) {
  return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1024).toFixed(0) + ' KB';
}

// ── İndir (bytes) ───────────────────────────────────────────────
export function dlBytes(bytes, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

// ── Sayfa aralığı ayrıştır ("1,3,5-8" → [0,2,4,5,6,7]) ─────────
export function parsePages(str, total) {
  if (!str || !str.trim()) return [...Array(total)].map((_, i) => i);
  const pages = new Set();
  str.replace(/\s/g, '').split(',').forEach(p => {
    if (p.includes('-')) {
      const [a, b] = p.split('-').map(Number);
      for (let i = a; i <= b && i <= total; i++) pages.add(i - 1);
    } else {
      const n = Number(p);
      if (n >= 1 && n <= total) pages.add(n - 1);
    }
  });
  return [...pages];
}

// ── Thumbnail UI kurulumu ────────────────────────────────────────
/**
 * Tek-dosya drop-zone + thumbnail preview sistemi kurar.
 * @param {object} opts
 *   dropId, fileInputId, thumbPreviewId, thumbCanvasId,
 *   thumbFnameId, thumbMetaId, thumbChangeId, runBtnId,
 *   onFile(file, numPages) — dosya yüklenince çağrılır
 */
export function setupSingleFileDrop(opts) {
  const {
    dropId = 'dropZone',
    fileInputId = 'fileInput',
    thumbPreviewId = 'thumbPreview',
    thumbCanvasId = 'mainThumb',
    thumbFnameId = 'thumbFname',
    thumbMetaId = 'thumbMeta',
    thumbChangeId = 'thumbChange',
    runBtnId = 'runBtn',
    onFile
  } = opts;

  const drop      = document.getElementById(dropId);
  const input     = document.getElementById(fileInputId);
  const thumbPrev = document.getElementById(thumbPreviewId);
  const canvas    = document.getElementById(thumbCanvasId);
  const fname     = document.getElementById(thumbFnameId);
  const meta      = document.getElementById(thumbMetaId);
  const change    = document.getElementById(thumbChangeId);
  const runBtn    = document.getElementById(runBtnId);

  async function loadFile(f) {
    if (!f || f.type !== 'application/pdf') {
      setStatus('❌ Lütfen geçerli bir PDF dosyası seçin.', 'err'); return;
    }
    if (fname) fname.textContent = f.name;
    if (meta)  meta.textContent  = fmtSize(f.size) + ' · yükleniyor...';
    if (thumbPrev) thumbPrev.classList.add('show');
    if (drop)  drop.style.display = 'none';
    if (runBtn) runBtn.disabled = false;
    clearStatus();

    const n = canvas ? await renderThumb(f, canvas, 1) : 0;
    if (meta) meta.textContent = fmtSize(f.size) + (n ? ` · ${n} sayfa` : '');
    onFile && onFile(f, n);
  }

  if (drop) {
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', e => { if (!drop.contains(e.relatedTarget)) drop.classList.remove('over'); });
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });
  }
  if (input) input.addEventListener('change', () => { if (input.files[0]) loadFile(input.files[0]); });
  if (change) change.addEventListener('click', () => input && input.click());
}

// ── Durum Göstergesi ────────────────────────────────────────────
export function setStatus(msg, type = 'info') {
  const el = document.getElementById('status');
  if (!el) return;
  el.className = 'ce-status show ' + type;
  el.innerHTML = type === 'loading'
    ? `<div class="ce-spin"></div>${msg}`
    : msg;
}
export function clearStatus() {
  const el = document.getElementById('status');
  if (el) el.className = 'ce-status';
}

// ── İç link bloğu inşa et ───────────────────────────────────────
const ALL_TOOLS = [
  { slug:'pdf-birlestir',        icon:'🔗', label:'PDF Birleştir' },
  { slug:'pdf-bol',              icon:'✂️', label:'PDF Böl' },
  { slug:'sayfa-sil',            icon:'🗑️', label:'Sayfa Sil' },
  { slug:'sayfa-sirala',         icon:'↕️', label:'Sayfa Sırala' },
  { slug:'pdf-dondur',           icon:'🔄', label:'PDF Döndür' },
  { slug:'pdf-sikistir',         icon:'📦', label:'PDF Sıkıştır' },
  { slug:'pdf-to-word',          icon:'📝', label:'PDF → Word' },
  { slug:'pdf-duzenle',          icon:'✏️', label:'PDF Düzenle' },
  { slug:'pdf-kilitle',          icon:'🔒', label:'PDF Kilitle' },
  { slug:'pdf-kilit-ac',         icon:'🔓', label:'Kilit Aç' },
  { slug:'jpg-den-pdf',          icon:'🖼️', label:'JPG → PDF' },
  { slug:'pdf-den-jpg',          icon:'📷', label:'PDF → JPG' },
  { slug:'filigran-ekle',        icon:'💧', label:'Filigran Ekle' },
  { slug:'qr-kod-ekle',          icon:'📱', label:'QR Kod Ekle' },
  { slug:'ocr',                  icon:'🔍', label:'OCR (Metin Tanı)' },
  { slug:'pdf-imzala',           icon:'✍️', label:'PDF İmzala' },
  { slug:'pdf-metadata-duzenle', icon:'🏷️', label:'Metadata Düzenle' },
  { slug:'pdf-sayfa-kirp',       icon:'✂️', label:'Sayfa Kırp' },
  { slug:'pdf-arka-plan-ekle',   icon:'🎨', label:'Arka Plan Ekle' },
  { slug:'pdf-sayfa-kopyala',    icon:'📋', label:'Sayfa Kopyala' },
  { slug:'pdf-sayfa-ayikla',     icon:'📤', label:'Sayfa Ayıkla' },
];

export function renderRelatedTools(containerId, currentSlug, count = 6) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const others = ALL_TOOLS.filter(t => t.slug !== currentSlug);
  // Önce tematik olarak ilişkili olanlar
  const picks = others.slice(0, count);
  el.innerHTML = picks.map(t => `
    <a href="/tools/${t.slug}.html" class="rt-card">
      <span class="rt-icon">${t.icon}</span>
      <span class="rt-label">${t.label}</span>
    </a>`).join('');
}

// ── Ortak CSS enjeksiyonu ────────────────────────────────────────
export function injectEngineCSS() {
  if (document.getElementById('ce-styles')) return;
  const style = document.createElement('style');
  style.id = 'ce-styles';
  style.textContent = `
/* ── Engine: Thumbnail Preview ── */
.ce-thumb-preview{display:none;align-items:center;gap:12px;background:rgba(0,0,0,.18);border:1px solid rgba(255,255,255,.10);border-radius:14px;padding:12px 16px;margin-bottom:14px}
.ce-thumb-preview.show{display:flex}
.ce-thumb-wrap{width:52px;height:68px;border-radius:8px;overflow:hidden;background:rgba(0,0,0,.3);flex-shrink:0;border:1px solid rgba(255,255,255,.12);display:flex;align-items:center;justify-content:center}
.ce-thumb-wrap canvas{width:100%;height:100%;display:block}
.ce-skel{width:100%;height:100%;background:linear-gradient(90deg,#1e2a3a 25%,#253347 50%,#1e2a3a 75%);background-size:200% 100%;animation:ce-skel 1.2s infinite}
@keyframes ce-skel{0%{background-position:200% 0}100%{background-position:-200% 0}}
.ce-thumb-info{flex:1;min-width:0}
.ce-thumb-fname{font-weight:700;font-size:.88rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#eaf2ff}
.ce-thumb-meta{font-size:.75rem;color:#9fb2c8;margin-top:2px}
.ce-thumb-change{font-size:.75rem;color:#06b6d4;text-decoration:underline;cursor:pointer;margin-top:4px;display:inline-block;background:none;border:none;font-family:inherit;padding:0}
/* ── Engine: Status ── */
.ce-status{display:none;align-items:center;gap:8px;padding:10px 14px;border-radius:10px;font-size:.85rem;margin-top:10px;font-weight:600}
.ce-status.show{display:flex}
.ce-status.loading{background:rgba(6,182,212,.12);border:1px solid rgba(6,182,212,.3);color:#7dd3fc}
.ce-status.ok{background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.3);color:#86efac}
.ce-status.err{background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);color:#fca5a5}
.ce-spin{width:16px;height:16px;border:2.5px solid rgba(255,255,255,.2);border-top-color:#06b6d4;border-radius:50%;animation:ce-spin .7s linear infinite;flex-shrink:0}
@keyframes ce-spin{to{transform:rotate(360deg)}}
/* ── Engine: Related Tools Grid ── */
.rt-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;margin-top:8px}
.rt-card{display:flex;flex-direction:column;align-items:center;gap:5px;padding:12px 8px;border-radius:12px;border:1px solid rgba(255,255,255,.09);background:rgba(255,255,255,.04);text-decoration:none;color:#eaf2ff;font-size:.78rem;font-weight:600;text-align:center;transition:border-color .15s,background .15s}
.rt-card:hover{border-color:rgba(6,182,212,.5);background:rgba(6,182,212,.08);color:#06b6d4}
.rt-icon{font-size:1.4rem}
`;
  document.head.appendChild(style);
}
