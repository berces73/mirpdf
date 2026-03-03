// ============================================================
// src/temp.js
// Her job için izole /tmp/mirpdf-{jobId}/ dizini yönetimi
// ============================================================

import fs from "fs/promises";
import path from "path";
import os from "os";

const TMP_ROOT = process.env.TMP_DIR || os.tmpdir();

/**
 * Job için geçici dizin oluşturur, callback'i çalıştırır, sonra siler.
 * Hata olsa bile temizlik yapılır.
 */
export async function withTempDir(jobId, fn) {
  const tmpDir = path.join(TMP_ROOT, `mirpdf-${jobId}`);
  await fs.mkdir(tmpDir, { recursive: true });
  try {
    return await fn(tmpDir);
  } finally {
    await cleanDir(tmpDir);
  }
}

async function cleanDir(dir) {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // sessizce geç — cron temizler
  }
}

/**
 * 2 saatten eski tüm mirpdf-* temp dizinlerini sil.
 * Cron veya başlangıçta çağrılabilir.
 */
export async function cleanTempDir() {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  let cleaned = 0;
  try {
    const entries = await fs.readdir(TMP_ROOT, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("mirpdf-")) continue;
      const dirPath = path.join(TMP_ROOT, entry.name);
      try {
        const stat = await fs.stat(dirPath);
        if (stat.mtimeMs < cutoff) {
          await fs.rm(dirPath, { recursive: true, force: true });
          cleaned++;
        }
      } catch {}
    }
  } catch {}
  return cleaned;
}
