
export function json(obj, status=200, env=null, req=null, headers={}){
  const h = { "Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store", ...headers };
  // CORS
  if (env?.ALLOWED_ORIGIN) {
    const origin = req?.headers?.get?.("Origin") || "";
    if (!origin || origin === env.ALLOWED_ORIGIN) {
      h["Access-Control-Allow-Origin"] = env.ALLOWED_ORIGIN;
      h["Access-Control-Allow-Credentials"] = "true";
      h["Vary"] = "Origin";
    }
  }
  return new Response(JSON.stringify(obj), { status, headers: h });
}

export function err(code, message, status=400, env=null, req=null, extra={}){
  return json({ ok:false, error: code, message, ...extra }, status, env, req);
}
