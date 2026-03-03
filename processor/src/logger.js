// ============================================================
// src/logger.js
// JSON structured logging — journald / stdout
// PII/secret içermeyen güvenli loglama
// ============================================================

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL = LEVELS[process.env.LOG_LEVEL?.toLowerCase() || "info"] ?? 1;

export function log(level, event, data = {}) {
  if ((LEVELS[level] ?? 1) < MIN_LEVEL) return;

  // Secret/token sızıntısını önle
  const safe = sanitize(data);

  const entry = {
    level,
    event,
    ts: new Date().toISOString(),
    ...safe,
  };

  const line = JSON.stringify(entry);
  if (level === "error" || level === "warn") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

const SENSITIVE_KEYS = new Set([
  "authorization", "secret", "token", "password", "key",
  "processor_secret", "jwt_secret", "signing_secret",
]);

function sanitize(obj, depth = 0) {
  if (depth > 5 || obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(v => sanitize(v, depth + 1));

  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const lk = k.toLowerCase();
    if (SENSITIVE_KEYS.has(lk) || lk.includes("secret") || lk.includes("token")) {
      out[k] = "[REDACTED]";
    } else {
      out[k] = sanitize(v, depth + 1);
    }
  }
  return out;
}
