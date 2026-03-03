// ============================================================
// Monitoring & Alerting
// - Lightweight checks suitable for Cloudflare Workers
// - Writes monitoring_events into D1
// - Optional alert delivery via webhook (Slack/Discord) or email (Resend)
// ============================================================

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 3000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    clearTimeout(t);
    return res;
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

export async function recordMonitoringEvent(env, { kind, severity, message, metadata }) {
  try {
    await env.DB.prepare(
      `INSERT INTO monitoring_events (id, kind, severity, message, metadata, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    )
      .bind(
        crypto.randomUUID(),
        kind,
        severity,
        message,
        metadata ? JSON.stringify(metadata) : null,
        nowIso()
      )
      .run();
  } catch (err) {
    console.error("monitoring_events insert failed", err);
  }
}

async function maybeAlert(env, { kind, severity, message, metadata }) {
  const webhook = env.ALERT_WEBHOOK_URL;
  const email = env.ALERT_EMAIL;
  const resend = env.RESEND_API_KEY;

  // Debounce duplicates: don't alert same kind more than once per 10 minutes
  if (env.RATE_KV) {
    const k = `alert:dedupe:${kind}`;
    const seen = await env.RATE_KV.get(k);
    if (seen) return;
    await env.RATE_KV.put(k, "1", { expirationTtl: 600 });
  }

  if (webhook) {
    try {
      await fetch(webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, severity, message, metadata, ts: nowIso() }),
      });
    } catch (err) {
      console.error("alert webhook failed", err);
    }
  }

  // Email alert (optional)
  if (email && resend) {
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${resend}`,
        },
        body: JSON.stringify({
          from: env.ALERT_EMAIL_FROM || "MirPDF <alerts@pdf-platform.com>",
          to: [email],
          subject: `[${severity.toUpperCase()}] ${kind}`,
          text: `${message}\n\n${metadata ? JSON.stringify(metadata, null, 2) : ""}`,
        }),
      });
    } catch (err) {
      console.error("alert email failed", err);
    }
  }
}

export async function runMonitoringChecks(env) {
  if (!env.DB) return;

  const checks = [];

  // 1) Processor health
  checks.push(
    (async () => {
      if (!env.PROCESSOR_URL) return;
      try {
        const res = await fetchWithTimeout(`${env.PROCESSOR_URL.replace(/\/$/, "")}/health`, {}, 3000);
        if (!res.ok) {
          const msg = `Processor health check failed: HTTP ${res.status}`;
          await recordMonitoringEvent(env, {
            kind: "processor_unhealthy",
            severity: "critical",
            message: msg,
            metadata: { status: res.status },
          });
          await maybeAlert(env, {
            kind: "processor_unhealthy",
            severity: "critical",
            message: msg,
            metadata: { status: res.status },
          });
        }
      } catch (err) {
        const msg = `Processor health check error: ${err.message || String(err)}`;
        await recordMonitoringEvent(env, {
          kind: "processor_down",
          severity: "critical",
          message: msg,
        });
        await maybeAlert(env, {
          kind: "processor_down",
          severity: "critical",
          message: msg,
        });
      }
    })()
  );

  // 2) Backlog / stuck processing
  checks.push(
    (async () => {
      const backlogThreshold = Number(env.ALERT_BACKLOG_THRESHOLD || "50");
      const stuckMinutes = Number(env.ALERT_STUCK_MINUTES || "10");

      const stuckCutoff = new Date(Date.now() - stuckMinutes * 60 * 1000).toISOString();
      const { results } = await env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM jobs WHERE status = 'pending') AS pending,
           (SELECT COUNT(*) FROM jobs WHERE status = 'processing' AND updated_at < ?1) AS stuck
        `
      )
        .bind(stuckCutoff)
        .all();

      const pending = results?.[0]?.pending || 0;
      const stuck = results?.[0]?.stuck || 0;

      if (pending >= backlogThreshold) {
        const msg = `Queue backlog high: pending=${pending}`;
        await recordMonitoringEvent(env, {
          kind: "backlog_high",
          severity: pending > backlogThreshold * 2 ? "critical" : "warning",
          message: msg,
          metadata: { pending },
        });
        await maybeAlert(env, {
          kind: "backlog_high",
          severity: pending > backlogThreshold * 2 ? "critical" : "warning",
          message: msg,
          metadata: { pending },
        });
      }

      if (stuck > 0) {
        const msg = `Stuck jobs detected: stuck=${stuck} (>${stuckMinutes}m)`;
        await recordMonitoringEvent(env, {
          kind: "stuck_jobs",
          severity: stuck > 10 ? "critical" : "warning",
          message: msg,
          metadata: { stuck, stuckMinutes },
        });
        await maybeAlert(env, {
          kind: "stuck_jobs",
          severity: stuck > 10 ? "critical" : "warning",
          message: msg,
          metadata: { stuck, stuckMinutes },
        });
      }
    })()
  );

  // 3) Stripe webhook failures (last hour)
  checks.push(
    (async () => {
      const threshold = Number(env.ALERT_WEBHOOK_FAILURES_PER_HOUR || "5");
      const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
      const { results } = await env.DB.prepare(
        `SELECT COUNT(*) AS c FROM webhook_failures WHERE created_at >= ?1`
      )
        .bind(oneHourAgo)
        .all();
      const c = results?.[0]?.c || 0;
      if (c >= threshold) {
        const msg = `Stripe webhook failures high: ${c}/hour`;
        await recordMonitoringEvent(env, {
          kind: "stripe_webhook_failures_high",
          severity: c > threshold * 2 ? "critical" : "warning",
          message: msg,
          metadata: { count: c },
        });
        await maybeAlert(env, {
          kind: "stripe_webhook_failures_high",
          severity: c > threshold * 2 ? "critical" : "warning",
          message: msg,
          metadata: { count: c },
        });
      }
    })()
  );

  // 4) Batch/job failure rate (last hour)
  checks.push(
    (async () => {
      const thresholdPct = Number(env.ALERT_FAILURE_RATE_PCT || "20");
      const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
      const { results } = await env.DB.prepare(
        `SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM jobs
         WHERE created_at >= ?1`
      )
        .bind(oneHourAgo)
        .all();
      const total = results?.[0]?.total || 0;
      const failed = results?.[0]?.failed || 0;
      if (total >= 20) {
        const pct = total ? (failed / total) * 100 : 0;
        if (pct >= thresholdPct) {
          const msg = `Job failure rate high: ${pct.toFixed(1)}% (failed=${failed}, total=${total})`;
          await recordMonitoringEvent(env, {
            kind: "failure_rate_high",
            severity: pct > thresholdPct * 2 ? "critical" : "warning",
            message: msg,
            metadata: { failed, total, pct },
          });
          await maybeAlert(env, {
            kind: "failure_rate_high",
            severity: pct > thresholdPct * 2 ? "critical" : "warning",
            message: msg,
            metadata: { failed, total, pct },
          });
        }
      }
    })()
  );

  // Run concurrently (but don't stampede)
  await Promise.allSettled(checks);
  await sleep(1);
}

export async function listMonitoringEvents(env, { limit = 100 } = {}) {
  const { results } = await env.DB.prepare(
    `SELECT kind, severity, message, metadata, created_at
     FROM monitoring_events
     ORDER BY created_at DESC
     LIMIT ?1`
  )
    .bind(limit)
    .all();
  return results || [];
}
