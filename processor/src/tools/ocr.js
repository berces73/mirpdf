// ============================================================
// src/tools/ocr.js
// Tesseract OCR ile PDF → aranabilir (metin katmanlı) PDF
//
// Akış:
//   1) Ghostscript ile PDF sayfaları PNG'ye render et
//   2) Her PNG için Tesseract OCR çalıştır → PDF
//   3) OCR'd PDF'leri tek dosyada birleştir
//
// options.lang: "tur+eng" (varsayılan) | "tur" | "eng" | vb.
// ============================================================

import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs/promises";
import { log } from "../logger.js";

const execFileAsync = promisify(execFile);

const GS_BIN       = process.env.PROC_GS_BIN       || "gs";
const TESS_BIN     = process.env.PROC_TESS_BIN      || "tesseract";
const TOOL_TIMEOUT = Number(process.env.PROC_OCR_TIMEOUT_MS || String(180_000)); // 3 dk
const MAX_PAGES    = Number(process.env.PROC_OCR_MAX_PAGES   || "50");
const PAGE_DPI     = Number(process.env.PROC_OCR_DPI         || "200"); // 150–300 iyi denge

export async function ocr({ inputBuffer, options, tmpDir, jobId }) {
  const lang = sanitizeLang(options.lang || "tur+eng");

  const inputPath = path.join(tmpDir, "input.pdf");
  await fs.writeFile(inputPath, inputBuffer);

  // Magic bytes kontrolü
  if (!inputBuffer.slice(0, 5).toString("ascii").startsWith("%PDF-")) {
    throw new Error("Geçersiz dosya: PDF değil");
  }

  // 1) Sayfa sayısını öğren
  const pageCount = await getPdfPageCount(inputPath);
  if (pageCount > MAX_PAGES) {
    throw new Error(`PDF çok fazla sayfa içeriyor: ${pageCount} (limit: ${MAX_PAGES})`);
  }

  log("debug", "ocr_start", { jobId, lang, pageCount, dpi: PAGE_DPI });

  // 2) Her sayfayı PNG'ye çevir
  const pngPrefix = path.join(tmpDir, "page");
  await execFileAsync(GS_BIN, [
    "-q", "-dNOPAUSE", "-dBATCH", "-dSAFER",
    "-sDEVICE=pnggray",
    `-r${PAGE_DPI}`,
    `-sOutputFile=${pngPrefix}-%04d.png`,
    inputPath,
  ], { timeout: TOOL_TIMEOUT, maxBuffer: 50 * 1024 * 1024 });

  // Üretilen PNG'leri bul
  const allFiles  = await fs.readdir(tmpDir);
  const pngFiles  = allFiles
    .filter(f => f.startsWith("page-") && f.endsWith(".png"))
    .sort();

  if (pngFiles.length === 0) {
    throw new Error("Ghostscript PNG üretemedi — bozuk PDF olabilir");
  }

  // 3) Her PNG'yi Tesseract ile işle → PDF
  const ocrPdfs = [];
  for (const png of pngFiles) {
    const pngPath    = path.join(tmpDir, png);
    const outBase    = path.join(tmpDir, png.replace(".png", "-ocr"));
    const outPdfPath = outBase + ".pdf";

    await execFileAsync(TESS_BIN, [
      pngPath,
      outBase,
      "-l", lang,
      "pdf",
    ], {
      timeout: 60_000,         // sayfa başına 60 sn
      maxBuffer: 20 * 1024 * 1024,
    });

    // Dosya oluştu mu kontrol et
    try {
      const stat = await fs.stat(outPdfPath);
      if (stat.size > 0) ocrPdfs.push(outPdfPath);
    } catch {
      log("warn", "ocr_page_missing", { jobId, png });
    }
  }

  if (ocrPdfs.length === 0) {
    throw new Error("Tesseract hiç OCR PDF üretemedi");
  }

  // 4) Birden fazla sayfa varsa birleştir
  let outputBuffer;
  if (ocrPdfs.length === 1) {
    outputBuffer = await fs.readFile(ocrPdfs[0]);
  } else {
    const mergedPath = path.join(tmpDir, "merged.pdf");
    await execFileAsync(GS_BIN, [
      "-q", "-dNOPAUSE", "-dBATCH", "-dSAFER",
      "-sDEVICE=pdfwrite",
      "-dCompatibilityLevel=1.4",
      `-sOutputFile=${mergedPath}`,
      ...ocrPdfs,
    ], { timeout: 60_000, maxBuffer: 50 * 1024 * 1024 });

    outputBuffer = await fs.readFile(mergedPath);
  }

  if (!outputBuffer || outputBuffer.length === 0) {
    throw new Error("OCR birleştirme boş dosya üretti");
  }

  log("debug", "ocr_done", {
    jobId, lang, pageCount: pngFiles.length, outputBytes: outputBuffer.length,
  });

  return outputBuffer;
}

// ─── Yardımcı ────────────────────────────────────────────────────────────────

async function getPdfPageCount(pdfPath) {
  try {
    const { stdout } = await execFileAsync(GS_BIN, [
      "-q", "-dNODISPLAY", "-dNOSAFER",
      "-c", `(${pdfPath}) (r) file runpdfbegin pdfpagecount = quit`,
    ], { timeout: 15_000, maxBuffer: 64 * 1024 });
    const n = parseInt(stdout.trim(), 10);
    return isNaN(n) ? 999 : n;
  } catch {
    return 999; // bilinmiyorsa limit yokmuş gibi devam et
  }
}

// "tur+eng+fra" → sadece bilinen ISO lang kodları bırak
function sanitizeLang(raw) {
  const allowed = /^[a-z]{3}([+][a-z]{3})*$/i;
  const cleaned = String(raw || "tur+eng").toLowerCase().trim();
  return allowed.test(cleaned) ? cleaned : "tur+eng";
}
