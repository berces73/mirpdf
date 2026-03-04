/** frontend/public/assets/js/ab-test.js
 * Minimal client helper for A/B tests.
 */
export async function getVariant(experimentName, userId) {
  const u = new URL("/api/ab-test", window.location.origin);
  u.searchParams.set("variant", experimentName);
  u.searchParams.set("userId", userId || "anonymous");
  const res = await fetch(u.toString(), { method: "GET" });
  const data = await res.json().catch(()=>null);
  if (!res.ok || !data?.ok) return null;
  return data.variant;
}
