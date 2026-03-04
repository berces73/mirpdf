/**
 * src/internalLinksAI.js
 * Crawl Budget + Internal Linking automation (monthly cron).
 *
 * Strategy:
 * - Build topical clusters via a hand-curated tool→related tools matrix.
 * - For each /seo page, inject/refresh a dedicated related-links block.
 * - Uses an HTML marker so updates are idempotent.
 *
 * Notes:
 * - Keep it deterministic and lightweight: no external AI calls.
 * - If you later want "AI", swap `toolRelations` with embeddings/reranker.
 */

const MARKER_START = "<!--internal-links:start-->";
const MARKER_END   = "<!--internal-links:end-->";

export const toolRelations = {
  "pdf-sikistir":   ["word-to-pdf","jpg-to-pdf","pdf-birlestir","pdf-bol"],
  "word-to-pdf":    ["pdf-sikistir","excel-to-pdf","ppt-to-pdf"],
  "excel-to-pdf":   ["word-to-pdf","ppt-to-pdf"],
  "ppt-to-pdf":     ["excel-to-pdf","pdf-sikistir"],
  "ocr":            ["pdf-duzenle","pdf-birlestir","pdf-to-jpg"],
  "jpg-to-pdf":     ["pdf-sikistir","pdf-birlestir"],
  "pdf-to-jpg":     ["jpg-to-pdf","ocr"],
  "pdf-birlestir":  ["pdf-bol","pdf-sikistir","ocr"],
  "pdf-bol":        ["pdf-birlestir","pdf-sikistir"],
  "pdf-duzenle":    ["ocr","pdf-birlestir"],
};

function safeText(s) {
  return String(s || "").replace(/[<>&"]/g, (c) => ({ "<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;" }[c]));
}

function buildRelatedBlock(domain, page, relatedEntries) {
  // relatedEntries: [{slug, keyword}]
  if (!relatedEntries.length) return "";
  const items = relatedEntries.map(r => `<li><a href="/seo/${encodeURIComponent(r.slug)}">${safeText(r.keyword)}</a></li>`).join("");
  return `${MARKER_START}
<section class="content-section" aria-label="İlgili aramalar ve araçlar">
  <h2>İlgili Sayfalar</h2>
  <p>Benzer işlemler için aşağıdaki rehberleri de kullanabilirsiniz:</p>
  <ul>${items}</ul>
</section>
${MARKER_END}`;
}

function upsertBlock(html, block) {
  const s = html.indexOf(MARKER_START);
  const e = html.indexOf(MARKER_END);
  if (s !== -1 && e !== -1 && e > s) {
    return html.slice(0, s) + block + html.slice(e + MARKER_END.length);
  }
  return html + "\n" + block;
}

export async function updateInternalLinksAI(env) {
  const db = env.DB;
  const pages = await db.prepare("SELECT id, slug, tool_name, keyword, content FROM seo_pages").all();
  const all = pages.results || [];
  if (!all.length) return { ok: true, updated: 0 };

  // Preload by tool for fast lookup
  const byTool = new Map();
  for (const p of all) {
    const t = String(p.tool_name || "");
    if (!byTool.has(t)) byTool.set(t, []);
    byTool.get(t).push({ slug: p.slug, keyword: p.keyword });
  }

  let updated = 0;
  for (const p of all) {
    const relTools = toolRelations[String(p.tool_name || "")] || [];
    const related = [];
    for (const rt of relTools) {
      const arr = byTool.get(rt) || [];
      for (let i = 0; i < Math.min(3, arr.length); i++) {
        related.push(arr[i]);
      }
    }
    // De-dup by slug
    const seen = new Set();
    const uniq = related.filter(x => (seen.has(x.slug) ? false : (seen.add(x.slug), true)));
    const block = buildRelatedBlock("", p, uniq.slice(0, 12));
    if (!block) continue;

    const newContent = upsertBlock(String(p.content || ""), block);
    if (newContent !== String(p.content || "")) {
      await db.prepare("UPDATE seo_pages SET content=?1, last_updated=unixepoch() WHERE id=?2").bind(newContent, p.id).run();
      updated++;
    }
  }

  return { ok: true, updated };
}
