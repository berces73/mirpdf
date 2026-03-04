// ============================================================
// MirPDF Processor — src/server.js
// Sıfır bağımlılık, sadece Node.js stdlib.
//
// Akış:
//   Worker  → POST /process/{compress|pdf-to-word|ocr}
//           { jobId, inputKey, outputKey, options }
//   202 döner → arka planda işler → Worker'a callback atar
// ============================================================

import http   from "http";
import { URL } from "url";
import { timingSafeEqual } from "crypto";

import { compress }  from "./tools/compress.js";
import { pdfToWord } from "./tools/pdf-to-word.js";
import { ocr }       from "./tools/ocr.js";
import { downloadFromWorker, uploadToWorker, callbackWorker } from "./worker-client.js";
import { withTempDir } from "./temp.js";
import { log }        from "./logger.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT             = Number(process.env.PORT           || "3001");
const PROCESSOR_SECRET = process.env.PROCESSOR_SECRET      || "";
const WORKER_URL       = (process.env.WORKER_URL           || "").replace(/\/$/, "");
const MAX_FILE_BYTES   = Number(process.env.PROC_MAX_BYTES || String(50 * 1024 * 1024));
const MAX_CONCURRENCY  = Number(process.env.PROC_MAX_CONCURRENCY|| "2");
const JOB_TIMEOUT_MS   = Number(process.env.PROC_TIMEOUT_MS || String(180_000));

if (!PROCESSOR_SECRET) { console.error("FATAL: PROCESSOR_SECRET tanımlı değil"); process.exit(1); }
if (!WORKER_URL)        { console.error("FATAL: WORKER_URL tanımlı değil");        process.exit(1); }

// ─── Route tablosu ────────────────────────────────────────────────────────────

const TOOLS = {
  "/process/compress":    compress,
  "/process/pdf-to-word": pdfToWord,
  "/process/ocr":         ocr,
};

// ─── Concurrency ──────────────────────────────────────────────────────────────

let activeJobs = 0;
const acquireSlot = () => { if (activeJobs >= MAX_CONCURRENCY) return false; activeJobs++; return true; };
const releaseSlot = () => { if (activeJobs > 0) activeJobs--; };

// ─── Auth ─────────────────────────────────────────────────────────────────────

function checkAuth(req) {
  const token = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  try {
    const A = Buffer.from(token, "utf8");
    const B = Buffer.from(PROCESSOR_SECRET, "utf8");
    if (A.length !== B.length) { timingSafeEqual(Buffer.alloc(1), Buffer.alloc(1)); return false; }
    return timingSafeEqual(A, B);
  } catch { return false; }
}

// ─── HTTP yardımcıları ────────────────────────────────────────────────────────

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", chunk => {
      total += chunk.length;
      if (total > 64 * 1024) { reject(new Error("Gövde çok büyük")); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Error("Geçersiz JSON")); }
    });
    req.on("error", reject);
  });
}

// ─── Ana handler ──────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://localhost`);
  const path      = parsedUrl.pathname;

  // Health — auth gerektirmez
  if (path === "/health" && req.method === "GET") {
    return send(res, 200, { ok: true, service: "mirpdf-processor", activeJobs, maxConcurrency: MAX_CONCURRENCY, ts: new Date().toISOString() });
  }

  // Auth
  if (!checkAuth(req)) {
    log("warn", "auth_failed", { ip: req.socket.remoteAddress, path });
    return send(res, 401, { ok: false, error: "UNAUTHORIZED" });
  }

  // Tool route
  const toolFn = TOOLS[path];
  if (toolFn && req.method === "POST") {
    let body;
    try { body = await readBody(req); }
    catch (e) { return send(res, 400, { ok: false, error: "BAD_JSON", message: e.message }); }

    const { jobId, inputKey, outputKey, options } = body || {};
    if (!jobId || !inputKey || !outputKey) {
      return send(res, 400, { ok: false, error: "BAD_REQUEST", message: "jobId, inputKey, outputKey zorunlu" });
    }

    if (!acquireSlot()) {
      log("warn", "too_busy", { jobId, activeJobs });
      return send(res, 503, { ok: false, error: "TOO_BUSY", message: "İşlemci meşgul" });
    }

    send(res, 202, { ok: true, jobId, status: "accepted" });

    runJob({ jobId, inputKey, outputKey, options: options || {}, toolFn, toolName: path.split("/").pop() })
      .catch(err => log("error", "unhandled", { jobId, err: err.message }))
      .finally(releaseSlot);

    return;
  }

  send(res, 404, { ok: false, error: "NOT_FOUND" });
});

// ─── Job runner ───────────────────────────────────────────────────────────────

async function runJob({ jobId, inputKey, outputKey, options, toolFn, toolName }) {
  const t0 = Date.now();
  log("info", "job_start", { jobId, toolName, inputKey });

  let timedOut = false;
  const timer = setTimeout(async () => {
    timedOut = true;
    log("error", "job_timeout", { jobId, toolName, timeoutMs: JOB_TIMEOUT_MS });
    await callbackWorker(WORKER_URL, PROCESSOR_SECRET, {
      jobId, status: "failed",
      errorMessage: `Zaman aşımı: işlem ${JOB_TIMEOUT_MS / 1000} saniyede tamamlanamadı`,
    }).catch(() => {});
  }, JOB_TIMEOUT_MS);

  try {
    const inputBuffer = await downloadFromWorker(WORKER_URL, PROCESSOR_SECRET, inputKey, MAX_FILE_BYTES);
    if (timedOut) return;

    let outputBuffer;
    await withTempDir(jobId, async (tmpDir) => {
      outputBuffer = await toolFn({ inputBuffer, options, tmpDir, jobId });
    });
    if (timedOut) return;

    if (!outputBuffer?.length) throw new Error("Araç boş çıktı üretti");

    await uploadToWorker(WORKER_URL, PROCESSOR_SECRET, outputKey, outputBuffer);
    if (timedOut) return;

    clearTimeout(timer);
    await callbackWorker(WORKER_URL, PROCESSOR_SECRET, {
      jobId, status: "done", outputKey, outputBytes: outputBuffer.length,
    });

    log("info", "job_done", { jobId, toolName, ms: Date.now() - t0, outputBytes: outputBuffer.length });

  } catch (err) {
    clearTimeout(timer);
    if (timedOut) return;
    const msg = String(err?.message || err).slice(0, 400);
    log("error", "job_failed", { jobId, toolName, err: msg, ms: Date.now() - t0 });
    await callbackWorker(WORKER_URL, PROCESSOR_SECRET, { jobId, status: "failed", errorMessage: msg }).catch(() => {});
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, "127.0.0.1", () => {
  log("info", "server_start", { port: PORT, maxConcurrency: MAX_CONCURRENCY, workerUrl: WORKER_URL });
});

process.on("SIGTERM", () => { log("info", "shutdown", { activeJobs }); process.exit(0); });
