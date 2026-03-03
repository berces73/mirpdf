// scripts/generate-seo-pages.js
// Worker-side batch generator for Programmatic SEO pages in D1.
//
// Exports:
//  - priorityTools, secondaryTools
//  - generateSeoPages(env, tools, opts)
//
// Notes:
//  - Uses existing D1 table `seo_pages` (adds columns via migration: keyword, schema_json).
//  - Safe UPSERT by slug.
//  - Generates basic HTML content + optional schema_json (FAQPage + HowTo + SoftwareApplication).

export const priorityTools = {
  'pdf-sikistir': [
    'pdf sıkıştır','pdf boyut küçült','pdf dosyası küçült','pdf sıkıştırma programı','online pdf sıkıştır',
    'pdf boyutunu azalt','pdf mb küçült','pdf sıkıştır ücretsiz','pdf kalite koru sıkıştır','yüksek kalite pdf sıkıştır',
    'pdf sıkıştırma aracı','pdf dosyası nasıl küçültülür','pdf sıkıştırma işlemi','pdf boyut düşürme','pdf kompres et',
    'pdf mb düşür','pdf kb azalt','pdf sıkıştırma sitesi','pdf sıkıştır çevrimiçi','büyük pdf küçült'
  ],
  'word-to-pdf': [
    'word pdf çevir','docx pdf dönüştür','word belgesini pdf yap','word pdf dönüştürücü','online word pdf çevir',
    'word pdf çevir ücretsiz','doc pdf dönüştür','word dosyasını pdf e çevir','word pdf yapma','word pdf çevirici',
    'microsoft word pdf çevir','word den pdf e dönüştür','word belgesi pdf dönüştürme','word pdf kaydet','word uzantılı dosyayı pdf yap',
    'word pdf çevirme sitesi','docx i pdf e çevir','word pdf çevirme aracı','word pdf dönüştürücü online','word pdf indir'
  ],
  'excel-to-pdf': [
    'excel pdf çevir','xlsx pdf dönüştür','excel tablosunu pdf yap','excel pdf dönüştürücü','online excel pdf çevir',
    'excel pdf çevir ücretsiz','xls pdf dönüştür','excel dosyasını pdf e çevir','excel pdf yapma','excel pdf çevirici',
    'microsoft excel pdf çevir','excel den pdf e dönüştür','excel belgesi pdf dönüştürme','excel pdf kaydet','excel sayfasını pdf yap',
    'excel pdf çevirme sitesi','xlsx i pdf e çevir','excel pdf çevirme aracı','excel tablosu pdf dönüştürücü','excel pdf indir'
  ],
  'ppt-to-pdf': [
    'ppt pdf çevir','pptx pdf dönüştür','powerpoint pdf yap','ppt pdf dönüştürücü','online ppt pdf çevir',
    'ppt pdf çevir ücretsiz','ppt den pdf e dönüştür','powerpoint slayt pdf çevir','ppt pdf yapma','ppt pdf çevirici',
    'microsoft powerpoint pdf çevir','ppt belgesini pdf e çevir','powerpoint pdf dönüştürme','ppt pdf kaydet','sunumu pdf yap',
    'ppt pdf çevirme sitesi','pptx i pdf e çevir','ppt pdf çevirme aracı','powerpoint dosyası pdf dönüştür','ppt pdf indir'
  ],
  'ocr': [
    'resimden yazı çıkarma','pdf ocr yap','taranmış pdf düzenlenebilir yap','fotoğraftan yazı okuma','ocr çeviri',
    'resimden metin çıkar','pdf ocr çevir','online ocr','türkçe ocr','ücretsiz ocr',
    'resimden yazı çıkarma programı','pdf ten yazı çıkarma','ocr aracı','resimdeki yazıyı metne çevir','fotoğraftaki yazıyı kopyala',
    'taranmış belgeyi düzenlenebilir yap','ocr pdf dönüştürücü','resimden metin çıkarma sitesi','ocr çeviri aracı','pdf ocr dönüştür'
  ]
};

export const secondaryTools = {
  'jpg-to-pdf': [
    'jpg pdf çevir','resim pdf yap','fotoğraf pdf çevir','jpeg pdf dönüştür','online resim pdf çevir',
    'jpg pdf birleştir','birden fazla jpg yi pdf yap','resimleri pdf yapma','jpg pdf çevirici','jpg pdf dönüştürücü'
  ],
  'pdf-to-jpg': [
    'pdf jpg çevir','pdf resim yap','pdf i resime çevir','pdf ten fotoğraf çıkar','pdf jpg dönüştürücü',
    'online pdf jpg çevir','pdf sayfalarını resim yap','pdf jpg çevir ücretsiz','pdf ten resim çıkarma','pdf jpg indir'
  ],
  'pdf-birlestir': [
    'pdf birleştir','pdf leri birleştir','iki pdf birleştir','pdf birleştirme programı','online pdf birleştir',
    'pdf birleştir ücretsiz','birden fazla pdf i birleştir','pdf dosyalarını birleştir'
  ],
  'pdf-bol': [
    'pdf böl','pdf ayır','pdf sayfalarına ayır','pdf bölme programı','online pdf böl',
    'pdf böl ücretsiz','pdf i sayfalara ayır','pdf den sayfa çıkar'
  ],
  'pdf-duzenle': [
    'pdf düzenle','pdf metin ekle','pdf üzerine yazı yaz','pdf düzenleme programı','online pdf düzenle',
    'pdf düzenle ücretsiz','pdf imza ekle','pdf resim ekle'
  ]
};

const TOOL_DISPLAY = {
  'pdf-sikistir': 'PDF Sıkıştır',
  'word-to-pdf': "Word'den PDF'e",
  'excel-to-pdf': "Excel'den PDF'e",
  'ppt-to-pdf': "PPT'den PDF'e",
  'ocr': 'OCR',
  'jpg-to-pdf': "JPG'den PDF'e",
  'pdf-to-jpg': "PDF'ten JPG'ye",
  'pdf-birlestir': 'PDF Birleştir',
  'pdf-bol': 'PDF Böl',
  'pdf-duzenle': 'PDF Düzenle'
};

function createSlug(text) {
  const map = { 'ğ':'g','ü':'u','ş':'s','ı':'i','ö':'o','ç':'c','Ğ':'g','Ü':'u','Ş':'s','İ':'i','Ö':'o','Ç':'c' };
  return String(text || '')
    .toLowerCase()
    .replace(/[ğüşıöçĞÜŞİÖÇ]/g, c => map[c] || c)
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function cap1(s) {
  s = String(s || '');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function generateContent(tool, keyword) {
  const toolDisplay = TOOL_DISPLAY[tool] || tool;
  const h2 = cap1(keyword);
  return `
<section class="seo-intro">
  <p><strong>${h2}</strong> işlemini hızlı ve güvenli şekilde yapın. PDF3 ile belgelerinizi kolayca dönüştürün.</p>
</section>
<section class="seo-how">
  <h2>${h2} Nasıl Yapılır?</h2>
  <ol class="steps">
    <li><strong>Dosyanızı yükleyin</strong><p>Dosyanızı sürükle-bırak ile ekleyin veya “Dosya Seç” butonunu kullanın.</p></li>
    <li><strong>Dönüştürün</strong><p>Ayarlarınızı seçip “Başlat”a tıklayın. İşlem genelde saniyeler içinde biter.</p></li>
    <li><strong>İndirin</strong><p>Sonuç dosyanızı indirin. Dosyalarınız gizlilik için kısa süre içinde silinir.</p></li>
  </ol>
  <p><a class="btn-primary" href="/tools/${tool}">${toolDisplay} aracını kullan</a></p>
</section>
<section class="seo-faq">
  <h2>Sık Sorulan Sorular</h2>
  <div class="faq-item"><h3>${h2} ücretsiz mi?</h3><p>Evet, temel kullanım ücretsizdir.</p></div>
  <div class="faq-item"><h3>Dosyalarım güvende mi?</h3><p>Evet. Aktarım HTTPS ile yapılır; dosyalarınız belirli bir süre sonra otomatik silinir.</p></div>
  <div class="faq-item"><h3>Hangi formatlar destekleniyor?</h3><p>Yaygın PDF ve ofis formatları desteklenir.</p></div>
</section>`;
}

function generateSchema(keyword, toolLabel) {
  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": [
      { "@type": "Question", "name": `${cap1(keyword)} ücretsiz mi?`, "acceptedAnswer": { "@type": "Answer", "text": "Evet, temel kullanım ücretsizdir." } },
      { "@type": "Question", "name": "Dosyalarım güvende mi?", "acceptedAnswer": { "@type": "Answer", "text": "Evet. HTTPS ile aktarılır ve kısa süre içinde silinir." } }
    ]
  };
  const howToSchema = {
    "@context": "https://schema.org",
    "@type": "HowTo",
    "name": `${cap1(keyword)} Nasıl Yapılır?`,
    "step": [
      { "@type": "HowToStep", "text": "Dosyanızı yükleyin." },
      { "@type": "HowToStep", "text": "Dönüştürme işlemini başlatın." },
      { "@type": "HowToStep", "text": "Sonucu indirin." }
    ],
    "tool": { "@type": "HowToTool", "name": "PDF3 Online Araçları" }
  };
  const softwareSchema = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "name": `PDF3 — ${cap1(keyword)}`,
    "operatingSystem": "All",
    "applicationCategory": "UtilityApplication",
    "offers": { "@type": "Offer", "price": "0", "priceCurrency": "TRY" }
  };
  return JSON.stringify([faqSchema, howToSchema, softwareSchema]);
}

export async function generateSeoPages(env, tools, phaseName = "batch") {
  const db = env.DB;
  let inserted = 0;

  const now = Math.floor(Date.now() / 1000);
  for (const [tool, keywords] of Object.entries(tools)) {
    for (const keyword of keywords) {
      const slug = createSlug(keyword);
      const title = `${cap1(keyword)} — Ücretsiz Online PDF Aracı | PDF3`;
      const description = `${keyword} işlemini saniyeler içinde yapın. Üyelik gerektirmez. Hemen deneyin!`;
      const h1 = cap1(keyword);
      const content = generateContent(tool, keyword);
      const toolLabel = TOOL_DISPLAY[tool] || tool;
      const schemaJson = generateSchema(keyword, toolLabel);

      // Supports both old and new seo_pages schema:
      // id TEXT or INTEGER; last_updated TEXT or INTEGER.
      await db.prepare(`
        INSERT INTO seo_pages (id, slug, title, description, h1, content, tool_name, keyword, schema_json, last_updated)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        ON CONFLICT(slug) DO UPDATE SET
          title=excluded.title,
          description=excluded.description,
          h1=excluded.h1,
          content=excluded.content,
          tool_name=excluded.tool_name,
          keyword=excluded.keyword,
          schema_json=excluded.schema_json,
          last_updated=excluded.last_updated
      `).bind(
        crypto.randomUUID(),
        slug, title, description, h1, content, tool, keyword, schemaJson, String(now)
      ).run();

      inserted++;
    }
  }

  return { ok: true, phase: phaseName, inserted };
}

export function getToolCounts() {
  const sum = (obj) => Object.values(obj).reduce((a, arr) => a + (arr?.length || 0), 0);
  return {
    priority: sum(priorityTools),
    secondary: sum(secondaryTools),
    total: sum(priorityTools) + sum(secondaryTools),
  };
}
