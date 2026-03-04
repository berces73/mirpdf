
import { json } from "./http.js";

// K4: CORS — Never fall back to wildcard.
// If ALLOWED_ORIGIN is not set or is "*", no ACAO header is emitted (browser blocks cross-origin).
// Set ALLOWED_ORIGIN to your Pages domain in wrangler.toml.

export function handleOptions(request, env){
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGIN || "").trim();
  const h = {
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Stripe-Signature",
    "Access-Control-Max-Age": "86400",
  };
  if (allowed && allowed !== "*" && (!origin || origin === allowed)) {
    h["Access-Control-Allow-Origin"] = allowed;
    h["Access-Control-Allow-Credentials"] = "true";
    h["Vary"] = "Origin";
  }
  // If ALLOWED_ORIGIN is not set or origin doesn't match: no ACAO header = browser blocks (correct)
  return new Response(null, { status: 204, headers: h });
}

export function cors(env, req, headers={}){
  const allowed = (env.ALLOWED_ORIGIN || "").trim();
  const origin = req?.headers?.get?.("Origin") || "";
  if (allowed && allowed !== "*" && (!origin || origin === allowed)) {
    return { ...headers, "Access-Control-Allow-Origin": allowed, "Access-Control-Allow-Credentials": "true", "Vary": "Origin" };
  }
  return headers; // No ACAO header if not configured or origin mismatch
}
