/*
  Minimal content build for Netlify + Decap CMS.

  - Source: content/articles/*.md (YAML frontmatter)
  - Output: public/articles/<slug>.html

  Frontmatter fields:
    title (required)
    description (optional)
    date (optional, ISO)
    slug (optional; defaults to filename)
    tags (optional)
*/

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { marked } = require('marked');

const ROOT = process.cwd();
const SRC_DIR = path.join(ROOT, 'content', 'articles');
const OUT_DIR = path.join(ROOT, 'public', 'articles');

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function escapeHtml(s = '') {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function toSlug(input) {
  return String(input)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\-\u00C0-\u024F\u1E00-\u1EFF]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function layout({ title, description, canonicalPath, bodyHtml }) {
  const canon = `https://mirpdf.com${canonicalPath}`;
  const safeTitle = escapeHtml(title);
  const safeDesc = escapeHtml(description || 'MirPDF rehberleri ve ipuçları.');

  return `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle} | MirPDF</title>
  <meta name="description" content="${safeDesc}" />
  <link rel="canonical" href="${canon}" />
  <link rel="stylesheet" href="/style.css" />
  <link rel="preload" as="style" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css" crossorigin onload="this.onload=null;this.rel='stylesheet'">
  <noscript><link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css"></noscript>

  <meta property="og:type" content="article" />
  <meta property="og:title" content="${safeTitle}" />
  <meta property="og:description" content="${safeDesc}" />
  <meta property="og:url" content="${canon}" />
  <meta property="og:image" content="https://mirpdf.com/assets/icons/og-image.jpg" />
  <meta property="og:locale" content="tr_TR" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${safeTitle}" />
  <meta name="twitter:description" content="${safeDesc}" />
  <meta name="twitter:image" content="https://mirpdf.com/assets/icons/og-image.jpg" />
</head>
<body>
  <a class="skip-link" href="#main">Ana içeriğe geç</a>

  <header class="header" role="banner">
    <div class="container">
      <div class="header-content">
        <a href="/" class="logo" aria-label="MirPDF - Ana Sayfa">
          <i class="fas fa-file-pdf" aria-hidden="true"></i>
          <span class="logo-text">MirPDF</span>
        </a>
        <button id="mobileMenuToggle" class="mobile-menu-toggle" aria-controls="mainNav" aria-expanded="false" aria-label="Menüyü aç/kapat">
          <i class="fas fa-bars" aria-hidden="true"></i>
        </button>
        <nav id="mainNav" aria-label="Ana Navigasyon">
          <a href="/#tools">Araçlar</a>
          <a href="/articles/">Blog</a>
          <a href="/faq.html">SSS</a>
          <a href="/contact.html">İletişim</a>
        </nav>
      </div>
    </div>
  </header>

  <main id="main">
    <div class="container" style="padding: 3rem 1.25rem; max-width: 920px;">
      <article class="card" style="background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 1.75rem;">
        <h1 style="margin-bottom: .75rem;">${safeTitle}</h1>
        ${description ? `<p style="color: var(--text-muted); margin-bottom: 1.5rem;">${escapeHtml(description)}</p>` : ''}
        <div class="prose" style="line-height: 1.85; font-size: 1rem;">${bodyHtml}</div>
      </article>
    </div>
  </main>

  <footer class="footer" role="contentinfo">
    <div class="container">
      <div class="footer-inner">
        <p>© 2026 MirPDF</p>
        <nav aria-label="Alt Navigasyon" class="footer-links">
          <a href="/legal/privacy.html">Gizlilik</a>
          <a href="/legal/terms.html">Şartlar</a>
          <a href="/legal/kvkk.html">KVKK</a>
        </nav>
      </div>
    </div>
  </footer>

  <script>
    (function() {
      const toggle = document.getElementById('mobileMenuToggle');
      const nav = document.getElementById('mainNav');
      if (!toggle || !nav) return;
      toggle.addEventListener('click', () => {
        const isOpen = nav.classList.toggle('show');
        toggle.setAttribute('aria-expanded', String(isOpen));
      });
      document.addEventListener('click', (e) => {
        if (!toggle.contains(e.target) && !nav.contains(e.target)) {
          nav.classList.remove('show');
          toggle.setAttribute('aria-expanded', 'false');
        }
      });
    })();
  </script>
</body>
</html>`;
}

function build() {
  if (!fs.existsSync(SRC_DIR)) {
    console.log('[build-content] No content/articles folder; skipping.');
    return;
  }
  ensureDir(OUT_DIR);

  const files = fs.readdirSync(SRC_DIR).filter(f => f.endsWith('.md'));
  console.log(`[build-content] Found ${files.length} markdown article(s).`);

  for (const file of files) {
    const full = path.join(SRC_DIR, file);
    const raw = fs.readFileSync(full, 'utf8');
    const parsed = matter(raw);

    const title = parsed.data.title || path.basename(file, '.md');
    const description = parsed.data.description || '';
    const slug = parsed.data.slug ? toSlug(parsed.data.slug) : toSlug(path.basename(file, '.md'));
    const outPath = path.join(OUT_DIR, `${slug}.html`);
    const canonicalPath = `/articles/${slug}.html`;

    const bodyHtml = marked.parse(parsed.content);
    const html = layout({ title, description, canonicalPath, bodyHtml });
    fs.writeFileSync(outPath, html, 'utf8');
    console.log(`[build-content] Wrote ${path.relative(ROOT, outPath)}`);
  }
}

build();
