// ============================================================
// src/worker-client.js
// Worker ↔ Processor HTTP iletişimi
// ============================================================

/**
 * Worker'ın R2'sindeki dosyayı indir
 * GET {workerUrl}/api/temp-download?key={inputKey}
 */
export async function downloadFromWorker(workerUrl, secret, key, maxBytes) {
  const url = `${workerUrl}/api/temp-download?key=${encodeURIComponent(key)}`;
  const resp = await fetch(url, {
    headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(60_000),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`temp-download başarısız (${resp.status}): ${body.slice(0, 200)}`);
  }

  // Boyut kontrolü — decompression bomb / aşırı büyük dosya
  const contentLength = Number(resp.headers.get("content-length") || "0");
  if (contentLength > maxBytes) {
    throw new Error(`Dosya çok büyük: ${contentLength} byte (limit: ${maxBytes})`);
  }

  const arrayBuffer = await resp.arrayBuffer();
  if (arrayBuffer.byteLength > maxBytes) {
    throw new Error(`İndirilen dosya çok büyük: ${arrayBuffer.byteLength} byte (limit: ${maxBytes})`);
  }

  return Buffer.from(arrayBuffer);
}

/**
 * İşlenmiş dosyayı Worker'ın R2'sine yükle
 * PUT {workerUrl}/api/temp-upload?key={outputKey}
 */
export async function uploadToWorker(workerUrl, secret, key, buffer) {
  const url = `${workerUrl}/api/temp-upload?key=${encodeURIComponent(key)}`;
  const resp = await fetch(url, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/octet-stream",
      "content-length": String(buffer.length),
    },
    body: buffer,
    signal: AbortSignal.timeout(120_000),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`temp-upload başarısız (${resp.status}): ${body.slice(0, 200)}`);
  }
}

/**
 * Worker'a iş sonucunu bildir
 * POST {workerUrl}/api/jobs/callback
 * { jobId, status: "done"|"failed", outputKey?, outputBytes?, errorMessage? }
 */
export async function callbackWorker(workerUrl, secret, payload) {
  const url = `${workerUrl}/api/jobs/callback`;

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`callback başarısız (${resp.status}): ${body.slice(0, 200)}`);
      }
      return; // başarı

    } catch (err) {
      lastErr = err;
      if (attempt < 3) await sleep(attempt * 1000);
    }
  }
  throw lastErr;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
