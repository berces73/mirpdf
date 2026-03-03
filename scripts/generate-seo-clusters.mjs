#!/usr/bin/env node
/**
 * SEO Cluster Generator
 * - reads scripts/seo-topics.json
 * - generates landing pages into public/tools/<tool>/variants/*.html
 * Usage: node scripts/generate-seo-clusters.mjs
 */
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(process.cwd());
const topicsPath = path.join(root, "scripts", "seo-topics.json");
const topics = JSON.parse(fs.readFileSync(topicsPath, "utf8"));
const tplPath = path.join(root, "scripts", "seo-templates", "variant.html");
const tpl = fs.readFileSync(tplPath, "utf8");

for (const item of topics.items) {
  const outDir = path.join(root, "public", "tools", item.toolPath, "variants");
  fs.mkdirSync(outDir, { recursive: true });
  const html = tpl
    .replaceAll("{{TITLE}}", item.title)
    .replaceAll("{{DESC}}", item.description)
    .replaceAll("{{FNAME}}", item.slug + ".html")
    .replaceAll("{{TOOL_URL}}", item.toolUrl);
  fs.writeFileSync(path.join(outDir, item.slug + ".html"), html, "utf8");
}
console.log("Generated", topics.items.length, "pages");
