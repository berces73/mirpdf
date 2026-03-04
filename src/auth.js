
// JWT (HS256) + PBKDF2 password hashing for Cloudflare Workers

function b64urlEncode(bytes) {
  const str = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
async function hmacSha256(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const sig = await crypto.subtle.sign("HMAC", key, dataBytes);
  return new Uint8Array(sig);
}

export async function signJWT(env, payload) {
  const secret = env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET env eksik");
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const exp = now + Number(env.JWT_TTL_SECONDS || 24*3600);
  const p = { ...payload, iat: now, exp };

  const h = b64urlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const b = b64urlEncode(new TextEncoder().encode(JSON.stringify(p)));
  const msg = new TextEncoder().encode(`${h}.${b}`);
  const sig = await hmacSha256(new TextEncoder().encode(secret), msg);
  return `${h}.${b}.${b64urlEncode(sig)}`;
}

export async function verifyJWT(env, token) {
  const secret = env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET env eksik");
  const parts = String(token||"").split(".");
  if (parts.length !== 3) return null;

  const [h,b,s] = parts;
  const msg = new TextEncoder().encode(`${h}.${b}`);
  const sig = b64urlDecode(s);
  const expSig = await hmacSha256(new TextEncoder().encode(secret), msg);

  // timing-safe compare
  if (sig.length !== expSig.length) return null;
  let diff = 0;
  for (let i=0;i<sig.length;i++) diff |= (sig[i] ^ expSig[i]);
  if (diff !== 0) return null;

  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(b)));
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now > payload.exp) return null;
  return payload;
}

export async function requireAuth(request, env) {
  const h = request.headers.get("Authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  const payload = await verifyJWT(env, token);
  if (!payload?.sub) {
    const e = new Error("Unauthorized");
    e.status = 401;
    throw e;
  }
  return payload;
}

// Password hashing (PBKDF2-SHA256)
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 120_000, hash: "SHA-256" },
    key,
    256
  );
  const hash = new Uint8Array(bits);
  return {
    saltB64: b64urlEncode(salt),
    hashB64: b64urlEncode(hash),
  };
}

export async function verifyPassword(password, saltB64, hashB64) {
  const salt = b64urlDecode(saltB64);
  const expected = b64urlDecode(hashB64);

  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 120_000, hash: "SHA-256" },
    key,
    256
  );
  const got = new Uint8Array(bits);

  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i=0;i<got.length;i++) diff |= (got[i] ^ expected[i]);
  return diff === 0;
}
