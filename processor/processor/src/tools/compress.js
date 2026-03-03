// ============================================================
// src/tools/compress.js
// Ghostscript ile PDF sıkıştırma
//
// compression_level: "screen" | "ebook" | "printer" | "prepress" | "recommended"
// "recommended" → /ebook  (iyi denge, varsayılan)
// ============================================================

import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs/promises";
import { log } from "../logger.js";

const execFileAsync = promisify(execFile);

// Ghostscript PDFSETTINGS mapping
const GS_SETTINGS = {
  screen:     "/screen",
  ebook:      "/ebook",
  printer:    "/printer",
  prepress:   "/prepress",
  recommended: "/ebook",
};

// Ghostscript'in path'i (Ubuntu: gs)
const GS_BIN = process.env.PROC_GS_BIN || "gs";

// Maksimum işlem süresi (ms)
const TOOL_TIMEOUT = Number(process.env.PROC_COMPRESS_TIMEOUT_MS || String(90_000));

export async function compress({ inputBuffer, options, tmpDir, jobId }) {
  const level = GS_SETTINGS[options.compression_level] || "/ebook";

  const inputPath  = path.join(tmpDir, "input.pdf");
  const outputPath = path.join(tmpDir, "output.pdf");

  // Girdi dosyasını yaz
  await fs.writeFile(inputPath, inputBuffer);

  // Magic bytes kontrolü — %PDF- ile başlamalı
  if (!inputBuffer.slice(0, 5).toString("ascii").startsWith("%PDF-")) {
    throw new Error("Geçersiz dosya: PDF değil");
  }

  const args = [
    "-q",
    "-dNOPAUSE",
    "-dBATCH",
    "-dSAFER",               // güvenli mod
    "-dNOPROMPT",
    "-sDEVICE=pdfwrite",
    `-dPDFSETTINGS=${level}`,
    "-dCompatibilityLevel=1.4",
    "-dDetectDuplicateImages=true",
    "-dCompressFonts=true",
    "-dColorImageDownsampleType=/Bicubic",
    "-dGrayImageDownsampleType=/Bicubic",
    `-sOutputFile=${outputPath}`,
    inputPath,
  ];

  log("debug", "gs_compress_start", { jobId, level, inputBytes: inputBuffer.length });

  const { stderr } = await execFileAsync(GS_BIN, args, {
    timeout: TOOL_TIMEOUT,
    maxBuffer: 10 * 1024 * 1024,
  });

  if (stderr && stderr.trim()) {
    log("warn", "gs_stderr", { jobId, stderr: stderr.slice(0, 500) });
  }

  const outputBuffer = await fs.readFile(outputPath);

  if (outputBuffer.length === 0) {
    throw new Error("Ghostscript boş dosya üretti");
  }

  log("debug", "gs_compress_done", {
    jobId,
    inputBytes: inputBuffer.length,
    outputBytes: outputBuffer.length,
    ratio: (outputBuffer.length / inputBuffer.length).toFixed(2),
  });

  return outputBuffer;
}
