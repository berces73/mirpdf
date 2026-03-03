// ============================================================
// Alerts (Cron)
// - Check recent error rate / circuit state
// - Notify via env.ALERT_WEBHOOK_URL (Discord/Slack compatible)
// ============================================================

function nowIso() { return new Date().toISOString(); }

async function postWebhook(env, payload) {
  if (!env.ALERT_WEBHOOK_URL) return;
  try {
    await fetch(env.ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {}
}

export async function runAlertCheck(env) {
  const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  // Count errors in monitoring_events (severity='error') in last 5 min
  const { results } = await env.DB.prepare(
    `SELECT COUNT(*) as c
     FROM monitoring_events
     WHERE severity='error' AND created_at >= ?1`
  ).bind(since).all();
  const errCount = Number(results?.[0]?.c || 0);

  // Circuit breaker status (KV)
  let circuit = null;
  try {
    if (env?.CIRCUIT_KV) {
      const raw = await env.CIRCUIT_KV.get("circuit_state");
      circuit = raw ? JSON.parse(raw) : null;
    }
  } catch {}

  // Thresholds (can be tuned)
  const threshold = Number(env.ALERT_ERROR_THRESHOLD || 20);
  if (errCount >= threshold || (circuit && circuit.state === "OPEN")) {
    await postWebhook(env, {
      username: "MirPDF Monitor",
      content: `🚨 Alert @ ${nowIso()}\nErrors (5m): ${errCount}\nCircuit: ${circuit ? circuit.state : "unknown"}`
    });
  }
}
