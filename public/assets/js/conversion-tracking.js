/** frontend/public/assets/js/conversion-tracking.js
 * Lightweight funnel event sender (no PII).
 */
export async function track(event, properties = {}) {
  try {
    await fetch("/api/analytics/collect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event, properties }),
      keepalive: true,
    });
  } catch (_) {}
}
