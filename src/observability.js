// ============================================================
// OBSERVABILITY & LOG ROTATION — MirPDF v12
// Covers:
//   - Analytics events table pruning (log rotation via D1)
//   - Worker log structured output
//   - Error rate dashboard query
//   - R2 log bucket lifecycle (via scheduled cleanup)
//   - Performance metrics aggregation (for admin dashboard)
// ============================================================

// ─────────────────────────────────────────────────────────────
// 1. D1 Log Rotation
//    Deletes analytics_events older than ANALYTICS_RETENTION_DAYS
//    and deletion_log older than DELETION_LOG_RETENTION_DAYS
//    Called from runCleanup() in scheduled cron.
// ─────────────────────────────────────────────────────────────
export async function rotateAnalyticsLogs(env) {
  const retainDays = Number(env.ANALYTICS_RETENTION_DAYS || "90");
  const cutoff = new Date(Date.now() - retainDays * 86400 * 1000).toISOString();

  // Delete in batches to avoid D1 row limit
  let totalDeleted = 0;
  let batch = 1;
  const batchSize = Number(env.CLEANUP_BATCH || "200");

  while (batch <= 20) { // max 20 iterations = 4000 rows per cron
    const { meta } = await env.DB.prepare(
      `DELETE FROM analytics_events
       WHERE event_id IN (
         SELECT event_id FROM analytics_events
         WHERE created_at < ?1
         LIMIT ?2
       )`
    ).bind(cutoff, batchSize).run();

    const deleted = meta?.changes || 0;
    totalDeleted += deleted;
    if (deleted < batchSize) break;
    batch++;
  }

  // Also prune deletion_log (keep 180 days for KVKK compliance)
  const dlRetainDays = Number(env.DELETION_LOG_RETENTION_DAYS || "180");
  const dlCutoff = new Date(Date.now() - dlRetainDays * 86400 * 1000).toISOString();
  await env.DB.prepare(
    `DELETE FROM deletion_log WHERE created_at < ?1`
  ).bind(dlCutoff).run();

  // Prune old email_tokens and password_resets
  const nowIso = new Date().toISOString();
  await env.DB.prepare(`DELETE FROM email_tokens WHERE expires_at < ?1`).bind(nowIso).run();
  await env.DB.prepare(`DELETE FROM password_resets WHERE expires_at < ?1 AND used_at IS NOT NULL`).bind(nowIso).run();

  log("info", "rotateAnalyticsLogs", { totalDeleted, cutoff });
  return { totalDeleted, cutoff };
}

// ─────────────────────────────────────────────────────────────
// 2. R2 Cleanup Lifecycle
//    Deletes R2 objects for jobs whose TTL has expired.
//    (Cloudflare R2 supports object-level TTL via lifecycle rules
//     in dashboard, but we also handle it here for cleanup grace)
// ─────────────────────────────────────────────────────────────
export async function rotateR2Objects(env) {
  const graceSec = Number(env.CLEANUP_GRACE_SECONDS || "600");
  const batchSize = Number(env.CLEANUP_BATCH || "50");
  const cutoffTs = Math.floor(Date.now() / 1000) - graceSec;
  const cutoffIso = new Date(cutoffTs * 1000).toISOString();

  const { results } = await env.DB.prepare(
    `SELECT job_id, input_key, output_key FROM jobs
     WHERE (created_at + ttl_seconds) < ?1
       AND (input_key IS NOT NULL OR output_key IS NOT NULL)
     LIMIT ?2`
  ).bind(cutoffIso, batchSize).all();

  let deleted = 0;
  const bucket = env.PDF_R2 || env.RESULTS_BUCKET;

  for (const job of results || []) {
    const keys = [job.input_key, job.output_key].filter(Boolean);
    for (const key of keys) {
      try {
        await bucket.delete(key);
        deleted++;
      } catch (e) {
        log("warn", "rotateR2Objects:delete_failed", { key, error: e.message });
      }
    }
    // Null out the keys in D1 so we don't retry
    await env.DB.prepare(
      `UPDATE jobs SET input_key = NULL, output_key = NULL WHERE job_id = ?1`
    ).bind(job.job_id).run();
  }

  log("info", "rotateR2Objects", { deleted, processed: results?.length || 0 });
  return { deleted, processed: results?.length || 0 };
}

// ─────────────────────────────────────────────────────────────
// 3. Structured Logger
//    Outputs JSON lines for Workers Logs / Logpush ingestion
// ─────────────────────────────────────────────────────────────
export function log(level, event, data = {}) {
  const entry = {
    level,
    event,
    ts: new Date().toISOString(),
    ...data,
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

// ─────────────────────────────────────────────────────────────
// 4. Error Rate Dashboard (for /api/admin/observability)
// ─────────────────────────────────────────────────────────────
export async function getObservabilityReport(env) {
  const now = new Date();
  const buckets = [
    { label: "15m",  since: new Date(Date.now() - 15 * 60 * 1000).toISOString() },
    { label: "1h",   since: new Date(Date.now() - 3600 * 1000).toISOString() },
    { label: "6h",   since: new Date(Date.now() - 6 * 3600 * 1000).toISOString() },
    { label: "24h",  since: new Date(Date.now() - 86400 * 1000).toISOString() },
  ];

  const timeSeries = await Promise.all(
    buckets.map(async (b) => {
      const { results } = await env.DB.prepare(
        `SELECT
           COUNT(*) as total_events,
           SUM(CASE WHEN event='worker_error' THEN 1 ELSE 0 END) as errors,
           SUM(CASE WHEN event='job_completed' THEN 1 ELSE 0 END) as jobs_done,
           SUM(CASE WHEN event='job_failed' THEN 1 ELSE 0 END) as jobs_failed,
           SUM(CASE WHEN event='purchase' THEN 1 ELSE 0 END) as purchases
         FROM analytics_events
         WHERE created_at >= ?1`
      ).bind(b.since).all();
      return { window: b.label, ...results?.[0] };
    })
  );

  // Top error paths in last 1h
  const { results: topErrors } = await env.DB.prepare(
    `SELECT tool as path, COUNT(*) as cnt,
            GROUP_CONCAT(DISTINCT json_extract(metadata, '$.status')) as statuses
     FROM analytics_events
     WHERE event = 'worker_error'
       AND created_at >= ?1
     GROUP BY tool
     ORDER BY cnt DESC
     LIMIT 10`
  ).bind(buckets[1].since).all();

  // Job throughput per tool in last 24h
  const { results: toolStats } = await env.DB.prepare(
    `SELECT tool,
            COUNT(*) as total,
            SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed,
            SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed,
            AVG(CASE WHEN status='completed'
                     THEN CAST((julianday(updated_at) - julianday(created_at)) * 86400 AS INTEGER)
                     END) as avg_duration_s
     FROM jobs
     WHERE created_at >= ?1
     GROUP BY tool
     ORDER BY total DESC`
  ).bind(buckets[3].since).all();

  // D1 row counts (rough storage health)
  const { results: rowCounts } = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM analytics_events) as analytics_rows,
       (SELECT COUNT(*) FROM jobs) as job_rows,
       (SELECT COUNT(*) FROM deletion_log) as deletion_log_rows`
  ).all();

  return {
    ts: now.toISOString(),
    timeSeries,
    topErrors: topErrors || [],
    toolStats: toolStats || [],
    tableHealth: rowCounts?.[0] || {},
    retentionPolicy: {
      analytics_days: Number(env.ANALYTICS_RETENTION_DAYS || "90"),
      deletion_log_days: Number(env.DELETION_LOG_RETENTION_DAYS || "180"),
      jobs_ttl_seconds: Number(env.JOB_TTL_SECONDS || "3600"),
    },
  };
}

// ─────────────────────────────────────────────────────────────
// 5. Performance Metrics (Web Vitals aggregation from D1)
// ─────────────────────────────────────────────────────────────
export async function getPerformanceMetrics(env) {
  const since = new Date(Date.now() - 86400 * 1000).toISOString();

  // Vitals events are tracked via /api/track with event='web_vital'
  const { results } = await env.DB.prepare(
    `SELECT
       tool as page,
       json_extract(metadata, '$.name') as metric,
       AVG(CAST(json_extract(metadata, '$.value') AS REAL)) as avg_value,
       COUNT(*) as samples
     FROM analytics_events
     WHERE event = 'web_vital'
       AND created_at >= ?1
     GROUP BY tool, json_extract(metadata, '$.name')
     ORDER BY tool, metric`
  ).bind(since).all();

  return {
    since,
    webVitals: results || [],
    note: "Track web vitals via POST /api/track { event:'web_vital', tool:'page-name', metadata:{name:'LCP',value:1200} }",
  };
}
