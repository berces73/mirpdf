// ============================================================
// src/tools/pdf-to-word.js
// LibreOffice headless ile PDF → DOCX dönüşümü
//
// options.format: "docx" (varsayılan) | "odt"
// ============================================================

import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs/promises";
import { log } from "../logger.js";

const execFileAsync = promisify(execFile);

const LO_BIN = process.env.PROC_LO_BIN || "libreoffice";
const TOOL_TIMEOUT = Number(process.env.PROC_WORD_TIMEOUT_MS || String(120_000)); // 2 dk

export async function pdfToWord({ inputBuffer, options, tmpDir, jobId }) {
  const format = options.format === "odt" ? "odt" : "docx";

  const inputPath = path.join(tmpDir, "input.pdf");
  await fs.writeFile(inputPath, inputBuffer);

  // Magic bytes kontrolü
  if (!inputBuffer.slice(0, 5).toString("ascii").startsWith("%PDF-")) {
    throw new Error("Geçersiz dosya: PDF değil");
  }

  // LibreOffice çıktı formatı filtresi
  const filterName = format === "odt"
    ? "writer8"
    : "MS Word 2007 XML";

  log("debug", "lo_convert_start", { jobId, format, inputBytes: inputBuffer.length });

  // LibreOffice --headless --convert-to
  const { stdout, stderr } = await execFileAsync(
    LO_BIN,
    [
      "--headless",
      "--norestore",
      "--nofirststartwizard",
      "--convert-to",
      `${format}:"${filterName}"`,
      "--outdir",
      tmpDir,
      inputPath,
    ],
    {
      timeout: TOOL_TIMEOUT,
      maxBuffer: 20 * 1024 * 1024,
      env: {
        ...process.env,
        // LibreOffice HOME sorununu önle
        HOME: tmpDir,
        // Ekran gerektiren işlemleri engelle
        DISPLAY: "",
      },
    }
  );

  if (stderr && stderr.trim()) {
    log("warn", "lo_stderr", { jobId, stderr: stderr.slice(0, 500) });
  }

  // LibreOffice çıktı dosyasının adını tahmin et: input.docx veya input.odt
  const outputFileName = `input.${format}`;
  const outputPath = path.join(tmpDir, outputFileName);

  let outputBuffer;
  try {
    outputBuffer = await fs.readFile(outputPath);
  } catch {
    // LibreOffice bazen farklı isimlendiriyor, dizini tara
    const files = await fs.readdir(tmpDir);
    const match = files.find(f => f !== "input.pdf" && (f.endsWith(".docx") || f.endsWith(".odt")));
    if (!match) {
      throw new Error(`LibreOffice çıktı dosyası bulunamadı. stdout: ${stdout?.slice(0, 300)}`);
    }
    outputBuffer = await fs.readFile(path.join(tmpDir, match));
  }

  if (!outputBuffer || outputBuffer.length === 0) {
    throw new Error("LibreOffice boş dosya üretti");
  }

  log("debug", "lo_convert_done", {
    jobId,
    format,
    inputBytes: inputBuffer.length,
    outputBytes: outputBuffer.length,
  });

  return outputBuffer;
}
